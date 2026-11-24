/**
 * Dual-Seeded Live Simulation Runner & Synchronized Snapshot Stream (sim/runner.ts).
 * Owned by Simulation (Satwik Ray — Impact Feature: Side-by-Side Live Replay).
 *
 * Implements:
 *  - DualSimulationRunner: runs two identical seeded BMTCHoldingEnv instances side by side
 *    (same corridor, hour, RNG seed, passenger arrival stream, link speeds, and live disruptions)
 *    under a Left Policy (default: Schedule-Based Holding) vs Right Policy (default: MAPPO + Predictor).
 *  - LiveSnapshotFeed: satisfies the frozen Week-1 SnapshotFeed.stream(steps) contract
 *    using the real digital twin, calibrated predictor, and active holding policy.
 *  - Mid-run live disruption injection (Monsoon Rain & Bus Breakdown) applied identically to both lanes.
 *  - Dispatcher manual hold overrides (Accept / Override hook for Step 9 Dashboard).
 */

import { DEFAULT_CONFIG, type ProjectConfig } from '../common/config';
import {
  computeCorridorKpis,
  estimateCommuterImpact,
  type CorridorKpiReport,
} from '../common/kpis';
import type {
  BunchingPredictor,
  BusObservation,
  BusState,
  HoldingPolicy,
  Prediction,
  Snapshot,
  SnapshotFeed,
} from '../common/schemas';
import {
  createBaselinePolicy,
  type BaselinePolicyId,
} from '../control/baselines';
import {
  getTrainedMarlSuite,
  MappoHoldingPolicy,
  type MarlVariantId,
} from '../control/mappo';
import type { CorridorDefinition } from '../data/corridors';
import { getProductionPredictor } from '../predict/predictor';
import {
  BMTCHoldingEnv,
  type StopArrivalEvent,
} from './corridorEnv';
import {
  makeScenario,
  type DisruptionEventLog,
  type ScenarioName,
} from './scenarios';

export type RunnerPolicyId = BaselinePolicyId | MarlVariantId;

export const RUNNER_POLICY_OPTIONS: Array<{
  id: RunnerPolicyId;
  label: string;
  group: 'Baseline' | 'MARL';
}> = [
  { id: 'no_control', label: 'No Control', group: 'Baseline' },
  { id: 'schedule', label: 'Schedule-Based Holding (Current Practice)', group: 'Baseline' },
  { id: 'daganzo', label: 'Headway-Based (Daganzo 2009)', group: 'Baseline' },
  { id: 'two_headway', label: 'Two-Headway Holding', group: 'Baseline' },
  { id: 'ippo', label: 'IPPO (No Central Critic)', group: 'MARL' },
  { id: 'mappo_nopred', label: 'MAPPO w/o Predictions', group: 'MARL' },
  { id: 'mappo_pred', label: 'MAPPO + Calibrated Predictor', group: 'MARL' },
];

export interface EarlyWarningAlert {
  id: string;
  t: number;
  bus_id: string;
  stop_idx: number;
  stop_name: string;
  p_bunch: number;
  horizon_stops: number;
  recommended_hold_s: number;
  applied_hold_s: number;
  status: 'pending' | 'accepted' | 'overridden';
  message: string;
}

export interface DispatcherIntervention {
  id: string;
  t: number;
  bus_id: string;
  stop_idx: number;
  stop_name: string;
  action: 'accepted' | 'overridden';
  policy_hold_s: number;
  executed_hold_s: number;
}

export interface TelemetryPoint {
  t_min: number;
  left_cv: number;
  right_cv: number;
  left_bunched_pct: number;
  right_bunched_pct: number;
  left_wait_min: number;
  right_wait_min: number;
  max_p_bunch: number;
}

export interface LaneFrameState {
  policy_id: RunnerPolicyId;
  policy_name: string;
  snapshot: Snapshot;
  kpis: CorridorKpiReport;
  arrival_count: number;
  events: StopArrivalEvent[];
  disruption_events: DisruptionEventLog[];
}

export interface DualTelemetryDiff {
  headway_cv_delta: number;       // right - left (negative = right better)
  headway_cv_reduction_pct: number;
  bunched_pct_delta: number;      // right - left (negative = right better)
  mean_wait_delta_min: number;    // right - left (negative = right better)
  mean_hold_delta_s: number;
  daily_pax_hours_saved: number;  // positive = right saves commuter time
}

export interface DualSnapshotFrame {
  tick: number;
  clock_t: number;
  horizon_s: number;
  done: boolean;
  seed: number;
  route_id: string;
  hour: number;
  scenario: ScenarioName;
  corridor: CorridorDefinition;
  scheduled_headway_s: number;
  left: LaneFrameState;
  right: LaneFrameState;
  diff: DualTelemetryDiff;
  alerts: EarlyWarningAlert[];
  pending_overrides: Record<string, number>;
  override_history: DispatcherIntervention[];
  telemetry_series: TelemetryPoint[];
  live_disruptions: Array<{ t_min: number; type: 'rain' | 'breakdown'; label: string }>;
}

export interface DualRunnerOptions {
  config?: ProjectConfig;
  routeId?: string;
  hour?: number;
  seed?: number;
  scenario?: ScenarioName;
  leftPolicyId?: RunnerPolicyId;
  rightPolicyId?: RunnerPolicyId;
  horizonMinutes?: number;
  tickSeconds?: number;
  alertThreshold?: number;
}

interface LaneRuntime {
  policyId: RunnerPolicyId;
  policy: HoldingPolicy;
  usesPredictorInPolicy: boolean;
  env: BMTCHoldingEnv;
  observations: Record<string, BusObservation>;
  infos: Record<string, BusState>;
  busHistories: Map<string, BusState[]>;
  latestPredictionsByBus: Map<string, Prediction>;
  currentT: number;
}

function buildPolicyInstance(
  policyId: RunnerPolicyId,
  scheduledHeadwayS: number,
  config: ProjectConfig,
  seed: number,
): { policy: HoldingPolicy; usesPredictorInPolicy: boolean } {
  if (
    policyId === 'no_control' ||
    policyId === 'schedule' ||
    policyId === 'daganzo' ||
    policyId === 'two_headway'
  ) {
    return {
      policy: createBaselinePolicy(policyId, scheduledHeadwayS, config),
      usesPredictorInPolicy: false,
    };
  }
  const suite = getTrainedMarlSuite(config);
  const policy = new MappoHoldingPolicy({
    variant: policyId,
    weights: suite[policyId].weights,
    scheduledHeadwayS,
    config,
    deterministic: true,
    seed,
  });
  return {
    policy,
    usesPredictorInPolicy: policyId === 'mappo_pred',
  };
}

/**
 * Dual-Seeded Live Runner driving two identical corridor twins side by side.
 */
export class DualSimulationRunner {
  private config: ProjectConfig;
  private routeId: string;
  private hour: number;
  private seed: number;
  private scenario: ScenarioName;
  private leftPolicyId: RunnerPolicyId;
  private rightPolicyId: RunnerPolicyId;
  private horizonS: number;
  private tickS: number;
  private alertThreshold: number;
  private predictor: BunchingPredictor;

  private left!: LaneRuntime;
  private right!: LaneRuntime;
  private clockT = 0;
  private tickCount = 0;
  private alerts: EarlyWarningAlert[] = [];
  private manualHoldOverrides = new Map<string, { holdS: number; mode: 'accepted' | 'overridden' }>();
  private overrideHistory: DispatcherIntervention[] = [];
  private telemetrySeries: TelemetryPoint[] = [];
  private liveDisruptions: Array<{ t_min: number; type: 'rain' | 'breakdown'; label: string }> = [];

  constructor(options: DualRunnerOptions = {}) {
    this.config = options.config ?? DEFAULT_CONFIG;
    this.routeId = options.routeId ?? '500D';
    this.hour = options.hour ?? 9;
    this.seed = options.seed ?? this.config.default_seed;
    this.scenario = options.scenario ?? 'normal';
    this.leftPolicyId = options.leftPolicyId ?? 'schedule';
    this.rightPolicyId = options.rightPolicyId ?? 'mappo_pred';
    this.horizonS = (options.horizonMinutes ?? 110) * 60;
    this.tickS = options.tickSeconds ?? 60;
    this.alertThreshold = options.alertThreshold ?? 0.48;
    this.predictor = getProductionPredictor(this.config, 5);

    this.reset();
  }

  reset(overrides?: Partial<DualRunnerOptions>): DualSnapshotFrame {
    if (overrides?.routeId) this.routeId = overrides.routeId;
    if (overrides?.hour !== undefined) this.hour = overrides.hour;
    if (overrides?.seed !== undefined) this.seed = overrides.seed;
    if (overrides?.scenario) this.scenario = overrides.scenario;
    if (overrides?.leftPolicyId) this.leftPolicyId = overrides.leftPolicyId;
    if (overrides?.rightPolicyId) this.rightPolicyId = overrides.rightPolicyId;
    if (overrides?.horizonMinutes !== undefined) this.horizonS = overrides.horizonMinutes * 60;
    if (overrides?.tickSeconds !== undefined) this.tickS = overrides.tickSeconds;

    this.clockT = 0;
    this.tickCount = 0;
    this.alerts = [];
    this.manualHoldOverrides.clear();
    this.overrideHistory = [];
    this.telemetrySeries = [];
    this.liveDisruptions = [];

    // Identical seeded ScenarioSpec for both twins
    const specLeft = makeScenario(this.scenario, this.seed, { route_id: this.routeId });
    const specRight = makeScenario(this.scenario, this.seed, { route_id: this.routeId });

    this.left = this.initLane(this.leftPolicyId, specLeft);
    this.right = this.initLane(this.rightPolicyId, specRight);

    // Advance an initial warmup window (6 minutes) so buses are actively on corridor at t=6m
    return this.stepClock(360);
  }

  private initLane(policyId: RunnerPolicyId, scenarioSpec: ReturnType<typeof makeScenario>): LaneRuntime {
    const env = new BMTCHoldingEnv(this.config);
    const { observations, infos } = env.reset(this.seed, {
      route_id: this.routeId,
      hour: this.hour,
      scenario: this.scenario,
      scenarioSpec,
      dwellFeedback: true,
    });
    const schedHw = env.getScheduledHeadwayS();
    const { policy, usesPredictorInPolicy } = buildPolicyInstance(
      policyId,
      schedHw,
      this.config,
      this.seed,
    );

    const busHistories = new Map<string, BusState[]>();
    const latestPredictionsByBus = new Map<string, Prediction>();
    const initPreds: Prediction[] = [];

    for (const [busId, state] of Object.entries(infos)) {
      busHistories.set(busId, [state]);
      const pred = this.predictor.predict([state]);
      latestPredictionsByBus.set(busId, pred);
      initPreds.push(pred);
    }
    env.setPredictions(initPreds);

    return {
      policyId,
      policy,
      usesPredictorInPolicy,
      env,
      observations,
      infos,
      busHistories,
      latestPredictionsByBus,
      currentT: env.snapshot(policy.name).t,
    };
  }

  /**
   * Advances both synchronized simulation twins to clockT + deltaSeconds
   * and returns the paired DualSnapshotFrame.
   */
  stepClock(deltaSeconds = this.tickS): DualSnapshotFrame {
    if (this.clockT >= this.horizonS) {
      return this.getFrame();
    }

    this.clockT = Math.min(this.horizonS, this.clockT + deltaSeconds);
    this.tickCount += 1;

    this.advanceLaneToClock(this.left, this.clockT, false);
    this.advanceLaneToClock(this.right, this.clockT, true);

    const frame = this.getFrame();
    const maxPBunch = frame.right.snapshot.predictions.reduce(
      (max, p) => Math.max(max, p.p_bunch),
      0,
    );

    this.telemetrySeries.push({
      t_min: Number((this.clockT / 60).toFixed(1)),
      left_cv: frame.left.kpis.headway_cv,
      right_cv: frame.right.kpis.headway_cv,
      left_bunched_pct: frame.left.kpis.bunched_pct,
      right_bunched_pct: frame.right.kpis.bunched_pct,
      left_wait_min: frame.left.kpis.mean_wait_min,
      right_wait_min: frame.right.kpis.mean_wait_min,
      max_p_bunch: Number(maxPBunch.toFixed(3)),
    });

    return this.getFrame();
  }

  private advanceLaneToClock(lane: LaneRuntime, targetT: number, trackAlerts: boolean): void {
    let guard = 0;
    while (lane.currentT <= targetT && guard < 120) {
      guard += 1;

      const enrichedObs: Record<string, BusObservation> = {};
      for (const [busId, rawObs] of Object.entries(lane.observations)) {
        const state = lane.infos[busId];
        if (state) {
          const hist = lane.busHistories.get(busId) ?? [];
          hist.push(state);
          if (hist.length > this.config.history_window_stops) hist.shift();
          lane.busHistories.set(busId, hist);
        }

        const hist = lane.busHistories.get(busId) ?? (state ? [state] : []);
        const pred = this.predictor.predict(hist);
        lane.latestPredictionsByBus.set(busId, pred);

        enrichedObs[busId] = {
          ...rawObs,
          p_bunch: lane.usesPredictorInPolicy ? pred.p_bunch : 0.0,
        };
      }

      lane.env.setPredictions(Array.from(lane.latestPredictionsByBus.values()));
      const actions = lane.policy.act(enrichedObs);

      // Apply any dispatcher manual override on the active right lane & emit early warnings
      if (trackAlerts) {
        const corridor = lane.env.getCorridorDefinition();
        for (const [busId, obs] of Object.entries(enrichedObs)) {
          const pred = lane.latestPredictionsByBus.get(busId);
          const recIdx = actions[busId] ?? 0;
          const recHoldS = this.config.hold_actions_s[recIdx] ?? 0;
          let appliedHoldS = recHoldS;
          let status: EarlyWarningAlert['status'] = 'pending';

          if (this.manualHoldOverrides.has(busId)) {
            const queued = this.manualHoldOverrides.get(busId)!;
            this.manualHoldOverrides.delete(busId);
            const nearestIdx = this.nearestHoldIndex(queued.holdS);
            actions[busId] = nearestIdx;
            appliedHoldS = this.config.hold_actions_s[nearestIdx];
            status = queued.mode;
            const stopName = corridor.stops[obs.stop_idx]?.name ?? `Stop #${obs.stop_idx + 1}`;
            this.overrideHistory.unshift({
              id: `int-${busId}-${Math.round(lane.currentT)}-${this.overrideHistory.length}`,
              t: lane.currentT,
              bus_id: busId,
              stop_idx: obs.stop_idx,
              stop_name: stopName,
              action: queued.mode,
              policy_hold_s: recHoldS,
              executed_hold_s: appliedHoldS,
            });
            if (this.overrideHistory.length > 30) {
              this.overrideHistory.length = 30;
            }
          }

          if (pred && pred.p_bunch >= this.alertThreshold && obs.stop_idx > 0) {
            const stopName = corridor.stops[obs.stop_idx]?.name ?? `Stop #${obs.stop_idx + 1}`;
            const alertId = `${busId}-${obs.stop_idx}-${Math.round(lane.currentT)}`;
            const holdActionText =
              recHoldS > 0 ? `hold ${recHoldS}s at ${stopName}` : `dispatch on-time from ${stopName}`;
            this.alerts.unshift({
              id: alertId,
              t: lane.currentT,
              bus_id: busId,
              stop_idx: obs.stop_idx,
              stop_name: stopName,
              p_bunch: pred.p_bunch,
              horizon_stops: pred.horizon_stops,
              recommended_hold_s: recHoldS,
              applied_hold_s: appliedHoldS,
              status,
              message: `Bus ${busId} likely to bunch within ${pred.horizon_stops} stops (p=${(pred.p_bunch * 100).toFixed(0)}%); ${holdActionText}`,
            });
            if (this.alerts.length > 24) {
              this.alerts.length = 24;
            }
          }
        }
      }

      const res = lane.env.step(actions);
      lane.observations = res.observations;
      lane.infos = res.infos;
      lane.currentT = lane.env.snapshot(lane.policy.name).t;
    }
  }

  private nearestHoldIndex(holdSeconds: number): number {
    let bestIdx = 0;
    let bestDiff = Infinity;
    this.config.hold_actions_s.forEach((h, idx) => {
      const diff = Math.abs(h - holdSeconds);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = idx;
      }
    });
    return bestIdx;
  }

  /**
   * Injects identical Bengaluru Monsoon Rain into both Left and Right environments mid-run.
   */
  injectLiveRain(speedDropPct = 34): DualSnapshotFrame {
    this.scenario = 'rain';
    this.left.env.injectLiveRain(speedDropPct);
    this.right.env.injectLiveRain(speedDropPct);
    this.liveDisruptions.push({
      t_min: Number((this.clockT / 60).toFixed(1)),
      type: 'rain',
      label: `Monsoon Rain (−${speedDropPct}% speed)`,
    });
    return this.getFrame();
  }

  /**
   * Injects identical mid-corridor Bus Breakdown into both Left and Right environments mid-run.
   */
  injectLiveBreakdown(durationMin = 18, busNum = 4): DualSnapshotFrame {
    this.scenario = 'breakdown';
    this.left.env.injectLiveBreakdown(durationMin, busNum);
    this.right.env.injectLiveBreakdown(durationMin, busNum);
    this.liveDisruptions.push({
      t_min: Number((this.clockT / 60).toFixed(1)),
      type: 'breakdown',
      label: `Bus B${String(busNum).padStart(2, '0')} Breakdown (${durationMin}m)`,
    });
    return this.getFrame();
  }

  /**
   * Queues a human-in-the-loop dispatcher override (or acceptance) for a bus's next hold decision
   * on the active Right lane and updates the matching alert record.
   */
  applyAlertAction(alertId: string, action: 'accept' | 'override', overrideHoldS?: number): DualSnapshotFrame {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (!alert) return this.getFrame();

    if (action === 'accept') {
      alert.status = 'accepted';
      alert.applied_hold_s = alert.recommended_hold_s;
      this.manualHoldOverrides.set(alert.bus_id, {
        holdS: alert.recommended_hold_s,
        mode: 'accepted',
      });
    } else {
      const targetS = overrideHoldS ?? 0;
      const clamped = this.config.hold_actions_s[this.nearestHoldIndex(targetS)];
      alert.status = 'overridden';
      alert.applied_hold_s = clamped;
      this.manualHoldOverrides.set(alert.bus_id, {
        holdS: clamped,
        mode: 'overridden',
      });
    }
    return this.getFrame();
  }

  /**
   * Queues a direct manual hold override for any bus selected on the Bengaluru corridor map.
   * Takes effect on that bus's very next stop arrival inside BMTCHoldingEnv.
   */
  queueBusHoldOverride(busId: string, holdSeconds: number): DualSnapshotFrame {
    const clamped = this.config.hold_actions_s[this.nearestHoldIndex(holdSeconds)];
    this.manualHoldOverrides.set(busId, {
      holdS: clamped,
      mode: 'overridden',
    });
    return this.getFrame();
  }

  /**
   * Generator emitting synchronized DualSnapshotFrames (used by tests & batch playback).
   */
  *streamPairs(steps: number): Generator<DualSnapshotFrame, void, unknown> {
    for (let i = 0; i < steps; i++) {
      yield this.stepClock(this.tickS);
      if (this.clockT >= this.horizonS) break;
    }
  }

  getFrame(): DualSnapshotFrame {
    const corridor = this.right.env.getCorridorDefinition();
    const schedHw = this.right.env.getScheduledHeadwayS();

    const leftSnap = this.left.env.snapshot(this.left.policy.name);
    const rightSnap = this.right.env.snapshot(this.right.policy.name);

    const leftEvents = this.left.env.getArrivalLog();
    const rightEvents = this.right.env.getArrivalLog();

    const leftKpis = computeCorridorKpis({
      policy_id: this.left.policyId,
      policy_name: this.left.policy.name,
      corridor,
      scheduledHeadwayS: schedHw,
      seed: this.seed,
      events: leftEvents,
      config: this.config,
    });

    const rightKpis = computeCorridorKpis({
      policy_id: this.right.policyId,
      policy_name: this.right.policy.name,
      corridor,
      scheduledHeadwayS: schedHw,
      seed: this.seed,
      events: rightEvents,
      config: this.config,
    });

    const impact = estimateCommuterImpact(rightKpis, leftKpis, corridor);
    const cvDelta = Number((rightKpis.headway_cv - leftKpis.headway_cv).toFixed(4));
    const cvRedPct =
      leftKpis.headway_cv > 0
        ? Number((((leftKpis.headway_cv - rightKpis.headway_cv) / leftKpis.headway_cv) * 100).toFixed(1))
        : 0;

    return {
      tick: this.tickCount,
      clock_t: this.clockT,
      horizon_s: this.horizonS,
      done: this.clockT >= this.horizonS,
      seed: this.seed,
      route_id: this.routeId,
      hour: this.hour,
      scenario: this.scenario,
      corridor,
      scheduled_headway_s: schedHw,
      left: {
        policy_id: this.left.policyId,
        policy_name: this.left.policy.name,
        snapshot: leftSnap,
        kpis: leftKpis,
        arrival_count: leftEvents.length,
        events: leftEvents,
        disruption_events: this.left.env.getDisruptionEvents(),
      },
      right: {
        policy_id: this.right.policyId,
        policy_name: this.right.policy.name,
        snapshot: rightSnap,
        kpis: rightKpis,
        arrival_count: rightEvents.length,
        events: rightEvents,
        disruption_events: this.right.env.getDisruptionEvents(),
      },
      diff: {
        headway_cv_delta: cvDelta,
        headway_cv_reduction_pct: cvRedPct,
        bunched_pct_delta: Number((rightKpis.bunched_pct - leftKpis.bunched_pct).toFixed(1)),
        mean_wait_delta_min: Number((rightKpis.mean_wait_min - leftKpis.mean_wait_min).toFixed(2)),
        mean_hold_delta_s: Number((rightKpis.mean_hold_s - leftKpis.mean_hold_s).toFixed(1)),
        daily_pax_hours_saved: impact.daily_pax_hours_saved,
      },
      alerts: this.alerts.slice(0, 14),
      pending_overrides: Object.fromEntries(
        Array.from(this.manualHoldOverrides.entries()).map(([busId, v]) => [busId, v.holdS]),
      ),
      override_history: this.overrideHistory.slice(0, 15),
      telemetry_series: [...this.telemetrySeries],
      live_disruptions: [...this.liveDisruptions],
    };
  }
}

/**
 * Frozen Contract #5 implementation: real SnapshotFeed backed by DualSimulationRunner.
 * Replaces Gate 1's FakeSnapshotFeed with synchronized BMTCHoldingEnv + Predictor + MAPPO snapshots.
 */
export class LiveSnapshotFeed implements SnapshotFeed {
  readonly name = 'LiveSnapshotFeed (DualSimulationRunner)';
  private runner: DualSimulationRunner;

  constructor(options: DualRunnerOptions = {}) {
    this.runner = new DualSimulationRunner(options);
  }

  *stream(steps: number): Generator<Snapshot, void, unknown> {
    for (const pair of this.runner.streamPairs(steps)) {
      yield pair.right.snapshot;
    }
  }
}
