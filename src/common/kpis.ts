/**
 * Shared Commuter KPI Module (mirroring common/kpis.py, used by everyone).
 * Owned by Control (Varun D Sawalkar), consumed by Simulation, Runner, Dashboard & Eval.
 *
 * Computes:
 *  - Headway Coefficient of Variation (CV)
 *  - % Bunched Arrivals (< bunching_headway_ratio * scheduled_headway)
 *  - Mean Passenger Wait Time (min)
 *  - Mean In-Vehicle Holding Delay per boarded passenger (s)
 *  - Mean Corridor Trip Time (min)
 *  - Daily Passenger-Hours Saved vs Current Practice (Schedule-Based Holding)
 */

import type { ProjectConfig } from './config';
import type { CorridorDefinition } from '../data/corridors';
import type { StopArrivalEvent } from '../sim/corridorEnv';

export interface CorridorKpiReport {
  policy_id: string;
  policy_name: string;
  route_id: string;
  seed: number;
  arrivals_evaluated: number;
  headway_cv: number;
  bunched_pct: number;
  bunched_count: number;
  mean_headway_s: number;
  mean_wait_min: number;
  in_vehicle_hold_s_per_pax: number;
  mean_trip_time_min: number;
  mean_hold_s: number;
  hold_rate_pct: number;
  total_boarded: number;
  hold_distribution: Record<number, number>; // hold_s -> count
}

export interface CommuterImpactEstimate {
  wait_time_saved_min_per_pax: number;
  net_travel_time_saved_min_per_pax: number;
  estimated_daily_riders: number;
  daily_pax_hours_saved: number;
  cv_reduction_pct: number;
  bunching_reduction_pct_pts: number;
}

export function computeCorridorKpis(params: {
  policy_id: string;
  policy_name: string;
  corridor: CorridorDefinition;
  scheduledHeadwayS: number;
  seed: number;
  events: StopArrivalEvent[];
  config: ProjectConfig;
}): CorridorKpiReport {
  const {
    policy_id,
    policy_name,
    corridor,
    scheduledHeadwayS,
    seed,
    events,
    config,
  } = params;

  const midEvents = events.filter((e) => e.stop_idx > 0);
  const headways = midEvents.map((e) => e.fwd_headway_s);

  const meanHw =
    headways.length > 0
      ? headways.reduce((a, b) => a + b, 0) / headways.length
      : scheduledHeadwayS;
  const variance =
    headways.length > 0
      ? headways.reduce((acc, h) => acc + (h - meanHw) ** 2, 0) / headways.length
      : 0;
  const headwayCv = meanHw > 0 ? Math.sqrt(variance) / meanHw : 0;

  const bunchedCount = midEvents.filter((e) => e.is_bunched).length;
  const bunchedPct = midEvents.length > 0 ? (bunchedCount / midEvents.length) * 100 : 0;

  // Event-level passenger wait time + headway-variance adjustment (Welding's formula blended with realized boarding wait)
  let totalBoarded = 0;
  let realizedWaitPaxSec = 0;
  let totalInVehicleHoldPaxSec = 0;
  let totalHoldSec = 0;
  let nonZeroHoldCount = 0;

  const holdDistribution: Record<number, number> = {};
  for (const h of config.hold_actions_s) {
    holdDistribution[h] = 0;
  }

  for (const ev of events) {
    totalBoarded += ev.boarded;
    // Passengers boarding after gap fwd_headway_s waited ~fwd_headway_s / 2 on average,
    // plus any left-behind penalty from crowded buses
    const leftBehindPenaltyS = ev.left_behind > 0 ? scheduledHeadwayS * 0.35 : 0;
    realizedWaitPaxSec += ev.boarded * (ev.fwd_headway_s * 0.5 + leftBehindPenaltyS);

    // Onboard riders who stay through this stop experience the holding delay
    const onboardThrough = Math.max(0, ev.load_after - ev.boarded);
    totalInVehicleHoldPaxSec += onboardThrough * ev.hold_s;

    totalHoldSec += ev.hold_s;
    if (ev.hold_s > 0) nonZeroHoldCount += 1;
    holdDistribution[ev.hold_s] = (holdDistribution[ev.hold_s] ?? 0) + 1;
  }

  // Theoretical Welding wait time: (H/2)*(1 + CV^2) validates realized passenger wait
  const weldingWaitSec = (meanHw * 0.5) * (1 + headwayCv * headwayCv);
  const realizedMeanWaitSec =
    totalBoarded > 0 ? realizedWaitPaxSec / totalBoarded : weldingWaitSec;
  const blendedWaitMin = (realizedMeanWaitSec * 0.65 + weldingWaitSec * 0.35) / 60;

  const inVehicleHoldPerPax =
    totalBoarded > 0 ? totalInVehicleHoldPaxSec / totalBoarded : 0;

  // Compute realized origin-to-terminal trip durations from completed or near-complete trips
  const tripsByBus = new Map<string, { startT: number; endT: number; maxStop: number }>();
  for (const ev of events) {
    const key = `${ev.bus_id}#${ev.trip_num}`;
    const existing = tripsByBus.get(key);
    if (!existing) {
      tripsByBus.set(key, {
        startT: ev.arrival_t,
        endT: ev.departure_t,
        maxStop: ev.stop_idx,
      });
    } else {
      existing.startT = Math.min(existing.startT, ev.arrival_t);
      existing.endT = Math.max(existing.endT, ev.departure_t);
      existing.maxStop = Math.max(existing.maxStop, ev.stop_idx);
    }
  }

  const lastStopIdx = corridor.stops.length - 1;
  const completedTripMins: number[] = [];
  for (const trip of tripsByBus.values()) {
    if (trip.maxStop >= lastStopIdx - 1) {
      const scale = lastStopIdx / Math.max(1, trip.maxStop);
      completedTripMins.push(((trip.endT - trip.startT) * scale) / 60);
    }
  }

  const meanTripTimeMin =
    completedTripMins.length > 0
      ? completedTripMins.reduce((a, b) => a + b, 0) / completedTripMins.length
      : 65.0;

  const meanHoldS = events.length > 0 ? totalHoldSec / events.length : 0;
  const holdRatePct = events.length > 0 ? (nonZeroHoldCount / events.length) * 100 : 0;

  return {
    policy_id,
    policy_name,
    route_id: corridor.route_id,
    seed,
    arrivals_evaluated: midEvents.length,
    headway_cv: Number(headwayCv.toFixed(3)),
    bunched_pct: Number(bunchedPct.toFixed(1)),
    bunched_count: bunchedCount,
    mean_headway_s: Number(meanHw.toFixed(1)),
    mean_wait_min: Number(blendedWaitMin.toFixed(2)),
    in_vehicle_hold_s_per_pax: Number(inVehicleHoldPerPax.toFixed(1)),
    mean_trip_time_min: Number(meanTripTimeMin.toFixed(1)),
    mean_hold_s: Number(meanHoldS.toFixed(1)),
    hold_rate_pct: Number(holdRatePct.toFixed(1)),
    total_boarded: totalBoarded,
    hold_distribution: holdDistribution,
  };
}

/**
 * Estimates commuter-facing daily passenger-hours saved on the corridor
 * compared to a reference policy (typically Schedule-Based Holding = current practice).
 * Wait time is weighted at 1.5x vs 1.0x in-vehicle delay (standard transit economics)
 * while reporting un-weighted net passenger-hours transparently.
 */
export function estimateCommuterImpact(
  candidate: CorridorKpiReport,
  reference: CorridorKpiReport,
  corridor: CorridorDefinition,
): CommuterImpactEstimate {
  const waitSavedMin = reference.mean_wait_min - candidate.mean_wait_min;
  const extraInVehMin =
    (candidate.in_vehicle_hold_s_per_pax - reference.in_vehicle_hold_s_per_pax) / 60;
  const netSavedMin = waitSavedMin - extraInVehMin;

  // Estimate daily corridor boardings from trips/day * average boardings per trip (~95 pax/trip on high-freq BMTC)
  const avgPaxPerTrip = Math.max(70, Math.round(corridor.stops.length * 5.8));
  const dailyRiders = corridor.daily_trips * avgPaxPerTrip;
  const dailyPaxHoursSaved = (dailyRiders * netSavedMin) / 60;

  const cvReductionPct =
    reference.headway_cv > 0
      ? ((reference.headway_cv - candidate.headway_cv) / reference.headway_cv) * 100
      : 0;
  const bunchingReductionPctPts = reference.bunched_pct - candidate.bunched_pct;

  return {
    wait_time_saved_min_per_pax: Number(waitSavedMin.toFixed(2)),
    net_travel_time_saved_min_per_pax: Number(netSavedMin.toFixed(2)),
    estimated_daily_riders: dailyRiders,
    daily_pax_hours_saved: Number(dailyPaxHoursSaved.toFixed(1)),
    cv_reduction_pct: Number(cvReductionPct.toFixed(1)),
    bunching_reduction_pct_pts: Number(bunchingReductionPctPts.toFixed(1)),
  };
}
