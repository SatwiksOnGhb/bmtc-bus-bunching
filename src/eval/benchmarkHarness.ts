/**
 * Multi-Seed Ablation Harness, Zero-Shot Transfer & Impact Report (eval/benchmarkHarness.ts).
 * Owned by Control (Varun D Sawalkar — Gate 4 Proof & Impact Evaluation).
 *
 * Evaluates all 7 policies across 3 deterministic seeds [42, 108, 256] and all 3 scenarios
 * (normal, rain, breakdown), computes mean ± std, runs zero-shot transfer on held-out G-4
 * and varied fleet sizes {7, 9, 12, 15}, and serializes CSV / JSON impact reports.
 */

import { DEFAULT_CONFIG, type ProjectConfig } from '../common/config';
import { estimateCommuterImpact, type CorridorKpiReport } from '../common/kpis';
import {
  ALL_BASELINE_IDS,
  createBaselinePolicy,
  evaluatePolicyEpisode,
  type BaselinePolicyId,
} from '../control/baselines';
import {
  getTrainedMarlSuite,
  runIntegratedMarlEpisode,
  type MarlVariantId,
} from '../control/mappo';
import { getCorridor } from '../data/corridors';
import { getHourlyTrafficProfile } from '../data/gpsCalibration';
import { getProductionPredictor } from '../predict/predictor';
import { makeScenario, type ScenarioName } from '../sim/scenarios';

export const BENCHMARK_SEEDS = [42, 108, 256] as const;
export const BENCHMARK_SCENARIOS: readonly ScenarioName[] = ['normal', 'rain', 'breakdown'];
export const TRANSFER_FLEET_SIZES = [7, 9, 12, 15] as const;

export type EvalPolicyId = BaselinePolicyId | MarlVariantId;

export interface PolicyMeta {
  id: EvalPolicyId;
  name: string;
  shortName: string;
  category: 'Baseline' | 'MARL Ablation' | 'Full System';
}

export const EVAL_POLICIES: PolicyMeta[] = [
  { id: 'no_control', name: 'No Control', shortName: 'No Ctrl', category: 'Baseline' },
  { id: 'schedule', name: 'Schedule-Based Holding', shortName: 'Schedule', category: 'Baseline' },
  { id: 'daganzo', name: 'Headway-Based (Daganzo 2009)', shortName: 'Daganzo', category: 'Baseline' },
  { id: 'two_headway', name: 'Two-Headway Holding', shortName: 'Two-HW', category: 'Baseline' },
  { id: 'ippo', name: 'IPPO (No Central Critic)', shortName: 'IPPO', category: 'MARL Ablation' },
  { id: 'mappo_nopred', name: 'MAPPO w/o Predictions', shortName: 'MAPPO (No Pred)', category: 'MARL Ablation' },
  { id: 'mappo_pred', name: 'MAPPO + Predictions', shortName: 'MAPPO + Pred', category: 'Full System' },
];

export interface MetricStats {
  mean: number;
  std: number;
}

export interface AggregatedPolicyRow {
  policy_id: EvalPolicyId;
  policy_name: string;
  short_name: string;
  category: PolicyMeta['category'];
  scenario: ScenarioName | 'all';
  seeds_count: number;
  headway_cv: MetricStats;
  bunched_pct: MetricStats;
  mean_wait_min: MetricStats;
  mean_hold_s: MetricStats;
  in_vehicle_hold_min: MetricStats;
  mean_trip_time_min: MetricStats;
  daily_pax_hours_saved: MetricStats;
}

export interface FleetScalingPoint {
  fleet_size: number;
  route_id: string;
  schedule_cv: number;
  daganzo_cv: number;
  mappo_nopred_cv: number;
  mappo_pred_cv: number;
  schedule_bunched_pct: number;
  mappo_pred_bunched_pct: number;
  daily_pax_hours_saved: number;
}

export interface MultiSeedBenchmarkReport {
  route_id: string;
  corridor_name: string;
  seeds: readonly number[];
  byScenario: Record<ScenarioName, AggregatedPolicyRow[]>;
  overallAverage: AggregatedPolicyRow[];
  headline: {
    schedule_cv_mean: number;
    mappo_nopred_cv_mean: number;
    mappo_pred_cv_mean: number;
    cv_reduction_vs_schedule_pct: number;
    pred_ablation_cv_gain_pct: number;
    bunched_drop_vs_schedule_pp: number;
    daily_pax_hours_saved_vs_schedule: number;
  };
}

export interface ZeroShotTransferReport {
  route_id: string;
  corridor_name: string;
  seeds: readonly number[];
  rows: AggregatedPolicyRow[];
  fleetScaling: FleetScalingPoint[];
  cv_reduction_vs_schedule_pct: number;
  daily_pax_hours_saved: number;
}

function meanStd(values: number[], digits = 3): MetricStats {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return {
    mean: Number(mean.toFixed(digits)),
    std: Number(Math.sqrt(variance).toFixed(digits)),
  };
}

function runSinglePolicyEpisode(params: {
  policyId: EvalPolicyId;
  routeId: string;
  scenario: ScenarioName;
  seed: number;
  config: ProjectConfig;
  fleetSizeOverride?: number;
  horizonMinutes?: number;
}): CorridorKpiReport {
  const { policyId, routeId, scenario, seed, config, fleetSizeOverride, horizonMinutes = 100 } = params;
  const spec = makeScenario(scenario, seed, { route_id: routeId });

  if ((ALL_BASELINE_IDS as readonly string[]).includes(policyId)) {
    const corridor = getCorridor(routeId);
    const profiles = getHourlyTrafficProfile(routeId);
    const schedHw =
      profiles.find((p) => p.hour === 9)?.scheduled_headway_s ?? corridor.scheduled_headway_s;
    const policy = createBaselinePolicy(policyId as BaselinePolicyId, schedHw, config);
    const res = evaluatePolicyEpisode({
      policyId,
      policyDescription: policy.description,
      policy,
      config,
      seed,
      options: {
        route_id: routeId,
        hour: 9,
        scenario,
        scenarioSpec: spec,
        dwellFeedback: true,
        fleetSizeOverride,
      },
      horizonMinutes,
    });
    return res.kpis;
  }

  const suite = getTrainedMarlSuite(config);
  const predictor = getProductionPredictor(config, 5);
  const variant = policyId as MarlVariantId;
  const res = runIntegratedMarlEpisode({
    variant,
    weights: suite[variant].weights,
    predictor,
    config,
    seed,
    options: {
      route_id: routeId,
      hour: 9,
      scenario,
      scenarioSpec: spec,
      dwellFeedback: true,
      fleetSizeOverride,
    },
    horizonMinutes,
  });
  return res.kpis;
}

function aggregateRuns(
  policyMeta: PolicyMeta,
  scenario: ScenarioName | 'all',
  runs: CorridorKpiReport[],
  scheduleRuns: CorridorKpiReport[],
  routeId: string,
): AggregatedPolicyRow {
  const corridor = getCorridor(routeId);
  const paxSavedList = runs.map((r, i) => {
    const ref = scheduleRuns[i] ?? scheduleRuns[0];
    if (!ref) return 0;
    return estimateCommuterImpact(r, ref, corridor).daily_pax_hours_saved;
  });

  return {
    policy_id: policyMeta.id,
    policy_name: policyMeta.name,
    short_name: policyMeta.shortName,
    category: policyMeta.category,
    scenario,
    seeds_count: runs.length,
    headway_cv: meanStd(runs.map((r) => r.headway_cv), 3),
    bunched_pct: meanStd(runs.map((r) => r.bunched_pct), 1),
    mean_wait_min: meanStd(runs.map((r) => r.mean_wait_min), 2),
    mean_hold_s: meanStd(runs.map((r) => r.mean_hold_s), 1),
    in_vehicle_hold_min: meanStd(runs.map((r) => r.in_vehicle_hold_s_per_pax / 60), 2),
    mean_trip_time_min: meanStd(runs.map((r) => r.mean_trip_time_min), 1),
    daily_pax_hours_saved: meanStd(paxSavedList, 0),
  };
}

const benchmarkCache = new Map<string, MultiSeedBenchmarkReport>();
const transferCache = new Map<string, ZeroShotTransferReport>();

/**
 * Runs the 3-seed x 3-scenario x 7-policy evaluation matrix on a Bengaluru corridor.
 */
export function runMultiSeedBenchmark(
  routeId = '500D',
  config: ProjectConfig = DEFAULT_CONFIG,
): MultiSeedBenchmarkReport {
  const cacheKey = `${routeId}-${config.mappo_hold_penalty_lambda}-${config.bunching_headway_ratio}-${config.default_seed}`;
  const cached = benchmarkCache.get(cacheKey);
  if (cached) return cached;

  const corridor = getCorridor(routeId);
  const rawByScenarioAndPolicy: Record<ScenarioName, Record<EvalPolicyId, CorridorKpiReport[]>> = {
    normal: {} as Record<EvalPolicyId, CorridorKpiReport[]>,
    rain: {} as Record<EvalPolicyId, CorridorKpiReport[]>,
    breakdown: {} as Record<EvalPolicyId, CorridorKpiReport[]>,
  };

  for (const scenario of BENCHMARK_SCENARIOS) {
    for (const pm of EVAL_POLICIES) {
      rawByScenarioAndPolicy[scenario][pm.id] = BENCHMARK_SEEDS.map((seed) =>
        runSinglePolicyEpisode({
          policyId: pm.id,
          routeId,
          scenario,
          seed,
          config,
          horizonMinutes: 100,
        }),
      );
    }
  }

  const byScenario: Record<ScenarioName, AggregatedPolicyRow[]> = {
    normal: [],
    rain: [],
    breakdown: [],
  };

  for (const scenario of BENCHMARK_SCENARIOS) {
    const schedRuns = rawByScenarioAndPolicy[scenario].schedule;
    byScenario[scenario] = EVAL_POLICIES.map((pm) =>
      aggregateRuns(pm, scenario, rawByScenarioAndPolicy[scenario][pm.id], schedRuns, routeId),
    );
  }

  // Overall average across all 9 (3 seeds x 3 scenarios) runs per policy
  const allSchedRuns = BENCHMARK_SCENARIOS.flatMap((sc) => rawByScenarioAndPolicy[sc].schedule);
  const overallAverage: AggregatedPolicyRow[] = EVAL_POLICIES.map((pm) => {
    const allRuns = BENCHMARK_SCENARIOS.flatMap((sc) => rawByScenarioAndPolicy[sc][pm.id]);
    return aggregateRuns(pm, 'all', allRuns, allSchedRuns, routeId);
  });

  const schedRow = overallAverage.find((r) => r.policy_id === 'schedule')!;
  const noPredRow = overallAverage.find((r) => r.policy_id === 'mappo_nopred')!;
  const predRow = overallAverage.find((r) => r.policy_id === 'mappo_pred')!;

  const cvRedVsSched =
    schedRow.headway_cv.mean > 0
      ? Number((((schedRow.headway_cv.mean - predRow.headway_cv.mean) / schedRow.headway_cv.mean) * 100).toFixed(1))
      : 0;
  const predGainPct =
    noPredRow.headway_cv.mean > 0
      ? Number((((noPredRow.headway_cv.mean - predRow.headway_cv.mean) / noPredRow.headway_cv.mean) * 100).toFixed(1))
      : 0;

  const report: MultiSeedBenchmarkReport = {
    route_id: routeId,
    corridor_name: corridor.corridor_name,
    seeds: BENCHMARK_SEEDS,
    byScenario,
    overallAverage,
    headline: {
      schedule_cv_mean: schedRow.headway_cv.mean,
      mappo_nopred_cv_mean: noPredRow.headway_cv.mean,
      mappo_pred_cv_mean: predRow.headway_cv.mean,
      cv_reduction_vs_schedule_pct: cvRedVsSched,
      pred_ablation_cv_gain_pct: predGainPct,
      bunched_drop_vs_schedule_pp: Number((schedRow.bunched_pct.mean - predRow.bunched_pct.mean).toFixed(1)),
      daily_pax_hours_saved_vs_schedule: predRow.daily_pax_hours_saved.mean,
    },
  };

  benchmarkCache.set(cacheKey, report);
  return report;
}

/**
 * Evaluates Zero-Shot Transfer on held-out BMTC route G-4 (unseen during MAPPO training)
 * and across arbitrary fleet sizes {7, 9, 12, 15} with zero retraining.
 */
export function runZeroShotTransferStudy(
  config: ProjectConfig = DEFAULT_CONFIG,
): ZeroShotTransferReport {
  const cacheKey = `G-4-${config.mappo_hold_penalty_lambda}-${config.bunching_headway_ratio}-${config.default_seed}`;
  const cached = transferCache.get(cacheKey);
  if (cached) return cached;

  const routeId = 'G-4';
  const corridor = getCorridor(routeId);

  const rawByPolicy = {} as Record<EvalPolicyId, CorridorKpiReport[]>;
  for (const pm of EVAL_POLICIES) {
    rawByPolicy[pm.id] = BENCHMARK_SEEDS.map((seed) =>
      runSinglePolicyEpisode({
        policyId: pm.id,
        routeId,
        scenario: 'normal',
        seed,
        config,
        horizonMinutes: 100,
      }),
    );
  }

  const schedRuns = rawByPolicy.schedule;
  const rows: AggregatedPolicyRow[] = EVAL_POLICIES.map((pm) =>
    aggregateRuns(pm, 'normal', rawByPolicy[pm.id], schedRuns, routeId),
  );

  // Fleet-size generalization sweep on held-out G-4 (seed 42 & 108 avg)
  const fleetScaling: FleetScalingPoint[] = TRANSFER_FLEET_SIZES.map((fleetSize) => {
    const sweepSeeds = [42, 108];
    const evalAvg = (pid: EvalPolicyId) => {
      const list = sweepSeeds.map((s) =>
        runSinglePolicyEpisode({
          policyId: pid,
          routeId,
          scenario: 'normal',
          seed: s,
          config,
          fleetSizeOverride: fleetSize,
          horizonMinutes: 95,
        }),
      );
      return {
        cv: Number((list.reduce((a, r) => a + r.headway_cv, 0) / list.length).toFixed(3)),
        bunched: Number((list.reduce((a, r) => a + r.bunched_pct, 0) / list.length).toFixed(1)),
        runs: list,
      };
    };

    const sched = evalAvg('schedule');
    const dag = evalAvg('daganzo');
    const nopred = evalAvg('mappo_nopred');
    const pred = evalAvg('mappo_pred');

    const saved =
      pred.runs.reduce(
        (acc, r, idx) => acc + estimateCommuterImpact(r, sched.runs[idx], corridor).daily_pax_hours_saved,
        0,
      ) / pred.runs.length;

    return {
      fleet_size: fleetSize,
      route_id: routeId,
      schedule_cv: sched.cv,
      daganzo_cv: dag.cv,
      mappo_nopred_cv: nopred.cv,
      mappo_pred_cv: pred.cv,
      schedule_bunched_pct: sched.bunched,
      mappo_pred_bunched_pct: pred.bunched,
      daily_pax_hours_saved: Math.round(saved),
    };
  });

  const schedRow = rows.find((r) => r.policy_id === 'schedule')!;
  const predRow = rows.find((r) => r.policy_id === 'mappo_pred')!;
  const cvRed =
    schedRow.headway_cv.mean > 0
      ? Number((((schedRow.headway_cv.mean - predRow.headway_cv.mean) / schedRow.headway_cv.mean) * 100).toFixed(1))
      : 0;

  const result: ZeroShotTransferReport = {
    route_id: routeId,
    corridor_name: corridor.corridor_name,
    seeds: BENCHMARK_SEEDS,
    rows,
    fleetScaling,
    cv_reduction_vs_schedule_pct: cvRed,
    daily_pax_hours_saved: predRow.daily_pax_hours_saved.mean,
  };

  transferCache.set(cacheKey, result);
  return result;
}

/** Exports the full multi-seed benchmark + zero-shot transfer tables as a clean CSV string */
export function serializeEvaluationCsv(
  benchmark: MultiSeedBenchmarkReport,
  transfer: ZeroShotTransferReport,
): string {
  const header = [
    'study',
    'route_id',
    'scenario',
    'policy_id',
    'policy_name',
    'seeds',
    'headway_cv_mean',
    'headway_cv_std',
    'bunched_pct_mean',
    'bunched_pct_std',
    'mean_wait_min_mean',
    'mean_wait_min_std',
    'mean_hold_s_mean',
    'in_vehicle_hold_min_mean',
    'mean_trip_time_min_mean',
    'daily_pax_hours_saved_vs_schedule',
  ].join(',');

  const lines: string[] = [header];

  const pushRows = (study: string, routeId: string, rows: AggregatedPolicyRow[]) => {
    for (const r of rows) {
      lines.push(
        [
          study,
          routeId,
          r.scenario,
          r.policy_id,
          `"${r.policy_name}"`,
          r.seeds_count,
          r.headway_cv.mean,
          r.headway_cv.std,
          r.bunched_pct.mean,
          r.bunched_pct.std,
          r.mean_wait_min.mean,
          r.mean_wait_min.std,
          r.mean_hold_s.mean,
          r.in_vehicle_hold_min.mean,
          r.mean_trip_time_min.mean,
          r.daily_pax_hours_saved.mean,
        ].join(','),
      );
    }
  };

  pushRows('multi_seed_overall', benchmark.route_id, benchmark.overallAverage);
  for (const sc of BENCHMARK_SCENARIOS) {
    pushRows(`multi_seed_${sc}`, benchmark.route_id, benchmark.byScenario[sc]);
  }
  pushRows('zero_shot_transfer', transfer.route_id, transfer.rows);

  return lines.join('\n');
}

/** Exports complete structured evaluation JSON artifact */
export function serializeEvaluationJson(
  benchmark: MultiSeedBenchmarkReport,
  transfer: ZeroShotTransferReport,
): string {
  return JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      disclaimer:
        'All metrics are measured in a calibrated digital-twin simulation of Bengaluru BMTC routes (GTFS ODbL + CNI 2022 GPS speed profiles) across deterministic seeds [42, 108, 256].',
      benchmark,
      zero_shot_transfer: transfer,
    },
    null,
    2,
  );
}
