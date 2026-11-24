/**
 * Stochastic Bengaluru BMTC Corridor Digital Twin (sim/corridorEnv.ts).
 * Implements the frozen PettingZoo Parallel HoldingEnv contract.
 *
 * Physics calibrated to Step 2 data:
 *  - Real Bengaluru stop sequences & road distances (data/corridors.ts)
 *  - CNI 2022 GPS hourly mixed-traffic speeds (data/gpsCalibration.ts)
 *  - Poisson passenger arrivals per stop scaled by time of day & hub weight
 *  - Boarding dwell feedback: dwell_s = dwell_fixed_s + dwell_per_boarding_s * boarded
 *    (makes late buses pick up more passengers -> longer dwell -> natural bunching)
 */

import { DEFAULT_CONFIG, type ProjectConfig } from '../common/config';
import type {
  BusObservation,
  BusState,
  EnvResetOptions,
  EnvStepResult,
  HoldingEnv,
  Prediction,
  Snapshot,
} from '../common/schemas';
import { createSeededRng } from '../common/stubs';
import { getCorridor, type CorridorDefinition } from '../data/corridors';
import { getHourlyTrafficProfile, type HourlyTrafficProfile } from '../data/gpsCalibration';
import {
  makeScenario,
  type DisruptionEventLog,
  type ScenarioOverrides,
  type ScenarioSpec,
} from './scenarios';

export interface CorridorEnvOptions extends EnvResetOptions {
  hour?: number;             // 7 .. 19 IST (default 9 AM peak)
  dwellFeedback?: boolean;   // default true; toggle false to verify feedback causes bunching
  fleetSizeOverride?: number;
  demandScale?: number;
  scenarioSpec?: ScenarioSpec;
  scenarioOverrides?: ScenarioOverrides;
}

export interface StopArrivalEvent {
  event_idx: number;
  bus_id: string;
  bus_num: number;
  trip_num: number;
  route_id: string;
  stop_idx: number;
  stop_name: string;
  cum_dist_km: number;
  arrival_t: number;
  departure_t: number;
  dwell_s: number;
  hold_s: number;
  fwd_headway_s: number;
  bwd_headway_s: number;
  sched_dev_s: number;
  boarded: number;
  alighted: number;
  load_after: number;
  waiting_before: number;
  left_behind: number;
  is_bunched: boolean;
}

interface InternalBus {
  bus_id: string;
  bus_num: number;
  trip_num: number;
  stop_idx: number;
  next_event_t: number;       // scheduled arrival time at next stop
  last_arrival_t: number;
  last_departure_t: number;
  scheduled_t: number;
  load: number;
  fwd_headway_s: number;
  bwd_headway_s: number;
  sched_dev_s: number;
  waiting_at_stop: number;
  last_dwell_s: number;
  last_hold_s: number;
  broken_until_t: number;     // for Step 7 breakdown scenario hook
  finished_trips: number;
}

/** Box-Muller standard normal sample using seeded RNG */
function sampleNormal(rng: () => number): number {
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Knuth / Normal approximation Poisson sampler using seeded RNG */
function samplePoisson(lambda: number, rng: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda < 30) {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k += 1;
      p *= rng();
    } while (p > L);
    return k - 1;
  }
  const n = Math.round(lambda + Math.sqrt(lambda) * sampleNormal(rng));
  return Math.max(0, n);
}

export class BMTCHoldingEnv implements HoldingEnv {
  readonly name = 'BMTCHoldingEnv (Stochastic Digital Twin)';
  private config: ProjectConfig;
  private corridor: CorridorDefinition;
  private hourProfile: HourlyTrafficProfile;
  private rng: () => number = createSeededRng(42);

  private scenario: 'normal' | 'rain' | 'breakdown' = 'normal';
  private scenarioSpec: ScenarioSpec = makeScenario('normal', 42);
  private breakdownTriggered = false;
  private rainOnsetLogged = false;
  private disruptionEvents: DisruptionEventLog[] = [];
  private hour = 9;
  private dwellFeedback = true;
  private demandScale = 1.0;

  private t = 0;
  private buses: InternalBus[] = [];
  private activeBusIds: string[] = [];
  private stopQueues: number[] = [];
  private stopLastServedT: number[] = [];
  private lastArrivalByStop: number[] = [];
  private arrivalLog: StopArrivalEvent[] = [];
  private lastHolds: Record<string, number> = {};
  private lastPredictions: Prediction[] = [];
  private scheduledHeadwayS = 360;
  private baseLinkTimesS: number[] = [];

  // Running accumulators for commuter KPIs
  private totalPaxBoarded = 0;
  private totalPaxWaitSec = 0;
  private totalInVehicleHoldPaxSec = 0;
  private bunchedArrivalsCount = 0;

  constructor(config: ProjectConfig = DEFAULT_CONFIG) {
    this.config = config;
    this.corridor = getCorridor(config.routes[0].route_id);
    this.hourProfile = getHourlyTrafficProfile(this.corridor.route_id)[2];
  }

  reset(seed: number, options?: CorridorEnvOptions) {
    this.rng = createSeededRng(seed);
    this.scenario = options?.scenario ?? 'normal';
    this.hour = options?.hour ?? 9;
    this.dwellFeedback = options?.dwellFeedback ?? true;
    this.demandScale = options?.demandScale ?? 1.0;

    const routeId = options?.route_id ?? this.config.routes[0].route_id;
    this.corridor = getCorridor(routeId);
    this.scenarioSpec =
      options?.scenarioSpec ??
      makeScenario(this.scenario, seed, {
        ...options?.scenarioOverrides,
        route_id: routeId,
      });
    this.scenario = this.scenarioSpec.name;
    this.breakdownTriggered = false;
    this.rainOnsetLogged = false;
    this.disruptionEvents = [];

    const profiles = getHourlyTrafficProfile(routeId);
    this.hourProfile =
      profiles.find((p) => p.hour === this.hour) ?? profiles[2];

    const fleetSize = options?.fleetSizeOverride ?? this.corridor.fleet_size;
    this.scheduledHeadwayS = this.hourProfile.scheduled_headway_s;

    // Precompute expected link travel times (s) from GPS calibrated speed
    const meanSpeedMps = (this.hourProfile.gps_mean_kmh * 1000) / 3600;
    this.baseLinkTimesS = this.corridor.stops.map((s, idx) => {
      if (idx === 0) return 0;
      return Math.max(45, s.link_dist_m / meanSpeedMps);
    });

    this.t = 0;
    this.arrivalLog = [];
    this.lastHolds = {};
    this.lastPredictions = [];
    this.totalPaxBoarded = 0;
    this.totalPaxWaitSec = 0;
    this.totalInVehicleHoldPaxSec = 0;
    this.bunchedArrivalsCount = 0;

    const stopCount = this.corridor.stops.length;
    this.stopQueues = Array(stopCount).fill(0);
    this.stopLastServedT = Array(stopCount).fill(0);
    this.lastArrivalByStop = Array(stopCount).fill(-this.scheduledHeadwayS);

    // Dispatch fleet sequentially from Stop 0 every scheduled_headway_s
    // with small initial dispatch perturbation (~±18s) matching real BMTC depots
    this.buses = Array.from({ length: fleetSize }, (_, i) => {
      const schedDispatch = i * this.scheduledHeadwayS;
      const jitter = i === 0 ? 0 : sampleNormal(this.rng) * 18;
      const dispatchT = Math.max(0, schedDispatch + jitter);
      return {
        bus_id: `${this.corridor.route_id}-B${String(i + 1).padStart(2, '0')}`,
        bus_num: i + 1,
        trip_num: 1,
        stop_idx: 0,
        next_event_t: dispatchT,
        last_arrival_t: dispatchT,
        last_departure_t: dispatchT,
        scheduled_t: schedDispatch,
        load: 0,
        fwd_headway_s: this.scheduledHeadwayS,
        bwd_headway_s: this.scheduledHeadwayS,
        sched_dev_s: Number((dispatchT - schedDispatch).toFixed(1)),
        waiting_at_stop: 0,
        last_dwell_s: 0,
        last_hold_s: 0,
        broken_until_t: -1,
        finished_trips: 0,
      };
    });

    // Advance immediately to the first bus stop-arrival event
    const { observations, infos } = this.advanceToNextArrival();
    return { observations, infos };
  }

  step(actions: Record<string, number>): EnvStepResult {
    this.lastHolds = {};
    const rewards: Record<string, number> = {};
    const terminations: Record<string, boolean> = {};
    const truncations: Record<string, boolean> = {};

    // Apply holding actions for currently stopped buses & dispatch them to next stop
    for (const busId of this.activeBusIds) {
      const bus = this.buses.find((b) => b.bus_id === busId);
      if (!bus) continue;

      const rawIdx = actions[busId] ?? 0;
      const clampedIdx = Math.max(
        0,
        Math.min(this.config.hold_actions_s.length - 1, Math.round(rawIdx)),
      );
      const holdSec = this.config.hold_actions_s[clampedIdx];
      this.lastHolds[busId] = holdSec;
      bus.last_hold_s = holdSec;

      // Record hold in-vehicle passenger delay
      this.totalInVehicleHoldPaxSec += holdSec * bus.load;

      // Update latest arrival event log entry for this bus with chosen hold
      for (let k = this.arrivalLog.length - 1; k >= 0; k--) {
        if (this.arrivalLog[k].bus_id === busId && this.arrivalLog[k].stop_idx === bus.stop_idx) {
          this.arrivalLog[k].hold_s = holdSec;
          this.arrivalLog[k].departure_t = Number(
            (this.arrivalLog[k].arrival_t + this.arrivalLog[k].dwell_s + holdSec).toFixed(1),
          );
          break;
        }
      }

      // Compute step reward: -(headway imbalance) - lambda * hold * onboard load
      const imbalance =
        Math.abs(bus.fwd_headway_s - bus.bwd_headway_s) / Math.max(60, this.scheduledHeadwayS);
      const holdPenalty =
        this.config.mappo_hold_penalty_lambda * holdSec * (bus.load / this.config.bus_capacity);
      rewards[busId] = Number((-(imbalance + holdPenalty)).toFixed(4));
      terminations[busId] = false;
      truncations[busId] = false;

      // Dispatch bus to next stop along the corridor (including any breakdown immobilization stall)
      const breakdownStallS =
        bus.broken_until_t > this.t ? bus.broken_until_t - this.t : 0;
      const departureT = this.t + bus.last_dwell_s + holdSec + breakdownStallS;
      bus.last_departure_t = departureT;
      if (breakdownStallS > 0) {
        this.disruptionEvents.push({
          t: Number(departureT.toFixed(1)),
          type: 'breakdown_cleared',
          bus_id: bus.bus_id,
          stop_idx: bus.stop_idx,
          stop_name: this.corridor.stops[bus.stop_idx]?.name,
          summary: `${bus.bus_id} cleared immobilization and resumed service at ${Math.round(departureT / 60)}m`,
        });
        bus.broken_until_t = -1;
      }

      const lastStopIdx = this.corridor.stops.length - 1;
      if (bus.stop_idx >= lastStopIdx) {
        // Completed corridor trip -> turnaround layover (3 min) and start next trip at Stop 0
        bus.finished_trips += 1;
        bus.trip_num += 1;
        bus.stop_idx = 0;
        bus.load = 0;
        bus.next_event_t = departureT + 180;
        bus.scheduled_t = bus.next_event_t;
      } else {
        const nextStopIdx = bus.stop_idx + 1;
        const linkTravelS = this.sampleLinkTravelTime(nextStopIdx, departureT);
        bus.stop_idx = nextStopIdx;
        bus.next_event_t = departureT + linkTravelS;
        bus.scheduled_t += this.baseLinkTimesS[nextStopIdx] + this.config.dwell_fixed_s + 12;
      }
    }

    const { observations, infos } = this.advanceToNextArrival();
    return {
      observations,
      rewards,
      terminations,
      truncations,
      infos,
    };
  }

  private sampleLinkTravelTime(targetStopIdx: number, currentT: number): number {
    const baseSec = this.baseLinkTimesS[targetStopIdx] ?? 120;
    const iqrSpread =
      (this.hourProfile.gps_p75_kmh - this.hourProfile.gps_p25_kmh) /
      Math.max(1, this.hourProfile.gps_mean_kmh);
    const varianceMult = this.scenarioSpec.getVarianceMultiplier(currentT);
    const sigma = Math.max(0.14, iqrSpread * 0.48 * varianceMult);
    const shock = sampleNormal(this.rng) * sigma;

    const scenarioSpeedFactor = this.scenarioSpec.getSpeedMultiplier(currentT, targetStopIdx);
    const stop = this.corridor.stops[targetStopIdx];
    const hubFriction = stop.is_major_hub ? 1.08 : 1.0;

    const mult = Math.max(0.62, Math.min(2.6, ((1 + shock) * hubFriction) / Math.max(0.4, scenarioSpeedFactor)));
    return Math.max(35, baseSec * mult);
  }

  private advanceToNextArrival(): {
    observations: Record<string, BusObservation>;
    infos: Record<string, BusState>;
  } {
    // Pick the bus with the earliest next_event_t
    let earliestT = Infinity;
    for (const b of this.buses) {
      if (b.next_event_t < earliestT) {
        earliestT = b.next_event_t;
      }
    }

    this.t = Number(earliestT.toFixed(1));
    const arriving = this.buses.filter((b) => Math.abs(b.next_event_t - earliestT) < 0.25);
    this.activeBusIds = arriving.map((b) => b.bus_id);

    const observations: Record<string, BusObservation> = {};
    const infos: Record<string, BusState> = {};

    for (const bus of arriving) {
      this.processStopArrival(bus);
      const busState = this.toBusState(bus);
      infos[bus.bus_id] = busState;
      observations[bus.bus_id] = {
        bus_id: busState.bus_id,
        route_id: busState.route_id,
        stop_idx: busState.stop_idx,
        fwd_headway_s: busState.fwd_headway_s,
        bwd_headway_s: busState.bwd_headway_s,
        sched_dev_s: busState.sched_dev_s,
        load: busState.load,
        waiting_at_stop: busState.waiting_at_stop,
        p_bunch: 0,
      };
    }

    return { observations, infos };
  }

  private processStopArrival(bus: InternalBus): void {
    const stopIdx = bus.stop_idx;
    const stop = this.corridor.stops[stopIdx];
    const stopCount = this.corridor.stops.length;

    // 1. Compute forward headway at this stop (time since previous bus reached this stop)
    const prevServed = this.lastArrivalByStop[stopIdx];
    const rawFwd = prevServed < 0 ? this.scheduledHeadwayS : Math.max(5, this.t - prevServed);
    this.lastArrivalByStop[stopIdx] = this.t;

    // 2. Estimate backward headway from closest trailing bus along the corridor
    const estimatedBwd = this.estimateBackwardHeadway(bus);

    bus.fwd_headway_s = Number(rawFwd.toFixed(1));
    bus.bwd_headway_s = Number(estimatedBwd.toFixed(1));
    bus.last_arrival_t = this.t;
    bus.sched_dev_s = Number((this.t - bus.scheduled_t).toFixed(1));

    // 3. Generate Poisson passenger arrivals at this stop since it was last served
    const elapsedSinceServed = Math.max(
      0,
      Math.min(this.scheduledHeadwayS * 3, this.t - this.stopLastServedT[stopIdx]),
    );
    this.stopLastServedT[stopIdx] = this.t;

    const isTerminal = stopIdx === stopCount - 1;
    // Log rain onset once simulation crosses storm start time
    if (this.scenarioSpec.rain && !this.rainOnsetLogged && this.t >= this.scenarioSpec.rain.onset_s) {
      this.rainOnsetLogged = true;
      this.disruptionEvents.push({
        t: this.t,
        type: 'rain_onset',
        summary: `Monsoon rain onset at ${Math.round(this.t / 60)}m (link speeds dropping to ${Math.round(this.scenarioSpec.rain.min_speed_factor * 100)}%)`,
      });
    }

    const baseRatePerSec =
      0.024 * stop.demand_weight * this.hourProfile.pax_arrival_mult * this.demandScale;
    const scenarioDemandBoost = this.scenarioSpec.getDemandMultiplier(this.t);

    if (!isTerminal) {
      const effectiveElapsed =
        this.dwellFeedback ? elapsedSinceServed : this.scheduledHeadwayS;
      const expectedArrivals = baseRatePerSec * scenarioDemandBoost * effectiveElapsed;
      const newPax = samplePoisson(expectedArrivals, this.rng);
      this.stopQueues[stopIdx] += newPax;
    }

    const waitingBefore = this.stopQueues[stopIdx];
    bus.waiting_at_stop = waitingBefore;

    // Check if seeded or live bus breakdown occurs on this bus at this stop
    const bd = this.scenarioSpec.breakdown;
    const triggersBreakdown =
      bd !== null &&
      !this.breakdownTriggered &&
      bus.bus_num === bd.target_bus_idx &&
      !isTerminal &&
      stopIdx >= Math.min(bd.target_stop_idx, stopCount - 3) &&
      this.t >= bd.trigger_t_s * 0.65;

    let boarded = 0;
    let alighted = 0;
    let leftBehind = 0;

    if (triggersBreakdown && bd) {
      this.breakdownTriggered = true;
      const strandedPax = bus.load;
      // Stranded onboard passengers disembark into the stop queue for the trailing bus
      this.stopQueues[stopIdx] += strandedPax;
      alighted = strandedPax;
      boarded = 0;
      leftBehind = this.stopQueues[stopIdx];
      bus.load = 0;
      bus.broken_until_t = this.t + bd.duration_s;
      bus.last_dwell_s = this.config.dwell_fixed_s;

      this.disruptionEvents.push({
        t: this.t,
        type: 'breakdown_start',
        bus_id: bus.bus_id,
        stop_idx: stopIdx,
        stop_name: stop.name,
        duration_s: bd.duration_s,
        stranded_pax: strandedPax,
        summary: `${bus.bus_id} broke down at ${stop.name} (${Math.round(this.t / 60)}m): ${strandedPax} riders offloaded to stop queue, immobilized ${Math.round(bd.duration_s / 60)} min`,
      });
    } else {
      // 4. Alighting passengers (everyone alights at terminal; progressive alighting mid-corridor)
      const progress = stopIdx / Math.max(1, stopCount - 1);
      const alightFrac = isTerminal ? 1.0 : stopIdx === 0 ? 0.0 : 0.12 + progress * 0.22;
      alighted = isTerminal ? bus.load : Math.min(bus.load, Math.round(bus.load * alightFrac));
      const loadAfterAlight = Math.max(0, bus.load - alighted);

      // 5. Boarding up to bus capacity
      const freeCapacity = Math.max(0, this.config.bus_capacity - loadAfterAlight);
      boarded = isTerminal ? 0 : Math.min(waitingBefore, freeCapacity);
      leftBehind = isTerminal ? 0 : Math.max(0, waitingBefore - boarded);
      this.stopQueues[stopIdx] = leftBehind;
      bus.load = loadAfterAlight + boarded;

      // Accumulate commuter wait time
      if (boarded > 0) {
        this.totalPaxBoarded += boarded;
        this.totalPaxWaitSec += boarded * (rawFwd * 0.5);
      }

      // 6. Boarding dwell time (positive feedback loop!)
      const dwellS = this.dwellFeedback
        ? this.config.dwell_fixed_s + this.config.dwell_per_boarding_s * boarded
        : this.config.dwell_fixed_s + this.config.dwell_per_boarding_s * 6;
      bus.last_dwell_s = Number(dwellS.toFixed(1));
    }

    // 7. Bunching check: fwd_headway < threshold_ratio * scheduled_headway (after origin)
    const bunchThresholdS = this.config.bunching_headway_ratio * this.scheduledHeadwayS;
    const isBunched = stopIdx > 0 && rawFwd < bunchThresholdS;
    if (isBunched) {
      this.bunchedArrivalsCount += 1;
    }

    this.arrivalLog.push({
      event_idx: this.arrivalLog.length,
      bus_id: bus.bus_id,
      bus_num: bus.bus_num,
      trip_num: bus.trip_num,
      route_id: this.corridor.route_id,
      stop_idx: stopIdx,
      stop_name: stop.name,
      cum_dist_km: stop.cum_dist_km,
      arrival_t: this.t,
      departure_t: Number((this.t + bus.last_dwell_s).toFixed(1)),
      dwell_s: bus.last_dwell_s,
      hold_s: 0,
      fwd_headway_s: bus.fwd_headway_s,
      bwd_headway_s: bus.bwd_headway_s,
      sched_dev_s: bus.sched_dev_s,
      boarded,
      alighted,
      load_after: bus.load,
      waiting_before: waitingBefore,
      left_behind: leftBehind,
      is_bunched: isBunched,
    });
  }

  private estimateBackwardHeadway(bus: InternalBus): number {
    const busPosKm = this.corridor.stops[bus.stop_idx].cum_dist_km;
    const speedKmh = Math.max(8, this.hourProfile.gps_mean_kmh);
    let minGapSec = Infinity;

    for (const other of this.buses) {
      if (other.bus_id === bus.bus_id) continue;
      if (other.stop_idx <= bus.stop_idx) {
        const distKm = Math.max(0.05, busPosKm - this.corridor.stops[other.stop_idx].cum_dist_km);
        const estSec = (distKm / speedKmh) * 3600 + Math.max(0, other.next_event_t - this.t);
        if (estSec < minGapSec) {
          minGapSec = estSec;
        }
      }
    }

    return Number.isFinite(minGapSec)
      ? Math.max(15, Math.min(this.scheduledHeadwayS * 3, minGapSec))
      : this.scheduledHeadwayS;
  }

  private toBusState(bus: InternalBus): BusState {
    const stop = this.corridor.stops[bus.stop_idx];
    return {
      bus_id: bus.bus_id,
      route_id: this.corridor.route_id,
      t: this.t,
      stop_idx: bus.stop_idx,
      lat: stop.lat,
      lon: stop.lon,
      fwd_headway_s: bus.fwd_headway_s,
      bwd_headway_s: bus.bwd_headway_s,
      sched_dev_s: bus.sched_dev_s,
      load: bus.load,
      waiting_at_stop: bus.waiting_at_stop,
    };
  }

  setPredictions(predictions: Prediction[]) {
    this.lastPredictions = predictions;
  }

  getArrivalLog(): StopArrivalEvent[] {
    return this.arrivalLog;
  }

  getCorridorDefinition(): CorridorDefinition {
    return this.corridor;
  }

  getScheduledHeadwayS(): number {
    return this.scheduledHeadwayS;
  }

  getScenarioSpec(): ScenarioSpec {
    return this.scenarioSpec;
  }

  getDisruptionEvents(): DisruptionEventLog[] {
    return this.disruptionEvents;
  }

  /** Live injection hook for Steps 8–9 Dispatcher Dashboard */
  injectLiveRain(speedDropPct = 32): void {
    const onsetMin = Math.max(1, Math.floor(this.t / 60));
    this.scenarioSpec = makeScenario('rain', 999, {
      route_id: this.corridor.route_id,
      rain_onset_min: onsetMin,
      rain_speed_drop_pct: speedDropPct,
    });
    this.scenario = 'rain';
    this.rainOnsetLogged = true;
    this.disruptionEvents.push({
      t: this.t,
      type: 'rain_onset',
      summary: `Live Monsoon Rain triggered at ${Math.round(this.t / 60)}m (−${speedDropPct}% link speed)`,
    });
  }

  /** Live injection hook for Steps 8–9 Dispatcher Dashboard */
  injectLiveBreakdown(durationMin = 18, busNum?: number): void {
    const candidate =
      (busNum ? this.buses.find((b) => b.bus_num === busNum) : null) ??
      this.buses.find((b) => b.stop_idx >= 3 && b.stop_idx <= this.corridor.stops.length - 4) ??
      this.buses[2] ??
      this.buses[0];
    if (!candidate) return;
    this.scenarioSpec = makeScenario('breakdown', 999, {
      route_id: this.corridor.route_id,
      breakdown_trigger_min: Math.max(1, Math.floor(this.t / 60)),
      breakdown_duration_min: durationMin,
      breakdown_bus_num: candidate.bus_num,
    });
    this.scenario = 'breakdown';
    this.breakdownTriggered = false;
  }

  snapshot(policyName = 'No Control'): Snapshot {
    const midArrivals = this.arrivalLog.filter((e) => e.stop_idx > 0);
    const headways = midArrivals.map((e) => e.fwd_headway_s);
    const meanHw =
      headways.length > 0
        ? headways.reduce((a, b) => a + b, 0) / headways.length
        : this.scheduledHeadwayS;
    const variance =
      headways.length > 0
        ? headways.reduce((acc, h) => acc + (h - meanHw) ** 2, 0) / headways.length
        : 0;
    const cv = meanHw > 0 ? Math.sqrt(variance) / meanHw : 0;
    const bunchPct =
      midArrivals.length > 0 ? (this.bunchedArrivalsCount / midArrivals.length) * 100 : 0;
    const meanWaitMin =
      this.totalPaxBoarded > 0 ? this.totalPaxWaitSec / this.totalPaxBoarded / 60 : 0;
    const maxQueue = Math.max(0, ...this.stopQueues);

    return {
      t: this.t,
      policy: policyName,
      scenario: this.scenario,
      buses: this.buses.map((b) => this.toBusState(b)),
      predictions: this.lastPredictions.map((p) => ({ ...p })),
      holds: { ...this.lastHolds },
      kpis: {
        headway_cv: Number(cv.toFixed(4)),
        bunched_pct: Number(bunchPct.toFixed(2)),
        mean_wait_min: Number(meanWaitMin.toFixed(2)),
        total_boarded: this.totalPaxBoarded,
        max_stop_queue: maxQueue,
      },
    };
  }
}

export interface CorridorEpisodeSummary {
  corridor: CorridorDefinition;
  scheduledHeadwayS: number;
  events: StopArrivalEvent[];
  finalSnapshot: Snapshot;
  cvByStop: Array<{
    stop_idx: number;
    stop_name: string;
    cum_dist_km: number;
    headway_cv: number;
    bunched_pct: number;
    mean_dwell_s: number;
  }>;
}

/** Runs a full seeded corridor episode (default: no control) to inspect bunching dynamics */
export function runCorridorEpisode(
  config: ProjectConfig,
  options: CorridorEnvOptions & { seed: number; horizonMinutes?: number },
): CorridorEpisodeSummary {
  const env = new BMTCHoldingEnv(config);
  const horizonSec = (options.horizonMinutes ?? 110) * 60;
  let { observations } = env.reset(options.seed, options);

  let guard = 0;
  while (guard < 1200) {
    guard += 1;
    // Zero-hold (no control) action for every arriving bus
    const actions: Record<string, number> = {};
    for (const busId of Object.keys(observations)) {
      actions[busId] = 0;
    }
    const res = env.step(actions);
    observations = res.observations;
    const snap = env.snapshot('No Control');
    if (snap.t >= horizonSec) {
      break;
    }
  }

  const events = env.getArrivalLog();
  const corridor = env.getCorridorDefinition();
  const finalSnapshot = env.snapshot('No Control');

  // Compute headway CV & bunching rate stop-by-stop from origin to terminal
  const cvByStop = corridor.stops.map((stop) => {
    const stopEvents = events.filter((e) => e.stop_idx === stop.stop_idx);
    const hws = stopEvents.map((e) => e.fwd_headway_s);
    const mean = hws.length > 0 ? hws.reduce((a, b) => a + b, 0) / hws.length : env.getScheduledHeadwayS();
    const variance =
      hws.length > 0 ? hws.reduce((acc, v) => acc + (v - mean) ** 2, 0) / hws.length : 0;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    const bunchedCount = stopEvents.filter((e) => e.is_bunched).length;
    const meanDwell =
      stopEvents.length > 0
        ? stopEvents.reduce((acc, e) => acc + e.dwell_s, 0) / stopEvents.length
        : 0;

    return {
      stop_idx: stop.stop_idx,
      stop_name: stop.name,
      cum_dist_km: stop.cum_dist_km,
      headway_cv: Number(cv.toFixed(3)),
      bunched_pct: stopEvents.length > 0 ? Number(((bunchedCount / stopEvents.length) * 100).toFixed(1)) : 0,
      mean_dwell_s: Number(meanDwell.toFixed(1)),
    };
  });

  return {
    corridor,
    scheduledHeadwayS: env.getScheduledHeadwayS(),
    events,
    finalSnapshot,
    cvByStop,
  };
}
