/**
 * Executable Contract Verification Suite (mirroring tests/test_contracts.py).
 * Rule #2: Contract tests run before every merge; each env, predictor, and policy
 * is checked against the frozen schemas in common/schemas.ts.
 */

import { DEFAULT_CONFIG, validateConfig, type ProjectConfig } from './config';
import {
  validateBusState,
  validatePrediction,
  validateSnapshot,
  type Snapshot,
} from './schemas';
import {
  ConstantPredictor,
  FakeSnapshotFeed,
  RandomPolicy,
  StubHoldingEnv,
} from './stubs';

import { estimateCommuterImpact } from './kpis';
import {
  ALL_BASELINE_IDS,
  createBaselinePolicy,
  runAllBaselinesComparison,
} from '../control/baselines';
import {
  getTrainedMarlSuite,
  MappoHoldingPolicy,
  runIntegratedMarlEpisode,
} from '../control/mappo';
import { CORRIDOR_LIST, getCorridor } from '../data/corridors';
import { getHourlyTrafficProfile } from '../data/gpsCalibration';
import { runGtfsCleaningPipeline } from '../data/gtfsCleaner';
import {
  buildAndEvaluatePredictorSuite,
  getProductionPredictor,
} from '../predict/predictor';
import {
  runMultiSeedBenchmark,
  runZeroShotTransferStudy,
  serializeEvaluationCsv,
  serializeEvaluationJson,
} from '../eval/benchmarkHarness';
import { BMTCHoldingEnv, runCorridorEpisode } from '../sim/corridorEnv';
import { DualSimulationRunner, LiveSnapshotFeed } from '../sim/runner';
import { makeScenario } from '../sim/scenarios';

export interface ContractTestResult {
  id: string;
  contract: 'Schemas' | 'Config' | 'Data' | 'Environment' | 'Predictor' | 'Policy' | 'SnapshotFeed';
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
}

export interface ContractSuiteReport {
  ranAt: string;
  total: number;
  passed: number;
  failed: number;
  results: ContractTestResult[];
  sampleSnapshot: Snapshot;
}

function runTest(
  id: string,
  contract: ContractTestResult['contract'],
  name: string,
  fn: () => string,
): ContractTestResult {
  const start = performance.now();
  try {
    const details = fn();
    return {
      id,
      contract,
      name,
      passed: true,
      durationMs: Number((performance.now() - start).toFixed(2)),
      details,
    };
  } catch (err) {
    return {
      id,
      contract,
      name,
      passed: false,
      durationMs: Number((performance.now() - start).toFixed(2)),
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

export function runContractTestSuite(config: ProjectConfig = DEFAULT_CONFIG): ContractSuiteReport {
  const results: ContractTestResult[] = [];
  let capturedSnapshot: Snapshot | null = null;

  results.push(
    runTest('cfg-01', 'Config', 'Single config invariants (routes, actions, thresholds)', () => {
      const errors = validateConfig(config);
      assert(errors.length === 0, `Config validation failed: ${errors.join('; ')}`);
      return `${config.routes.length} BMTC routes (2 train + 1 held-out), ${config.hold_actions_s.length} discrete holds [${config.hold_actions_s.join(', ')}]s`;
    }),
  );

  results.push(
    runTest('env-01', 'Environment', 'PettingZoo Parallel reset(seed, options) returns stop-arriving buses only', () => {
      const env = new StubHoldingEnv(config);
      const { observations, infos } = env.reset(config.default_seed, { scenario: 'normal' });
      const obsKeys = Object.keys(observations);
      const infoKeys = Object.keys(infos);
      assert(obsKeys.length >= 1, 'Expected at least 1 arriving bus on reset');
      assert(obsKeys.length < config.routes[0].fleet_size, 'Only buses at a stop may appear in obs');
      assert(obsKeys.join(',') === infoKeys.join(','), 'obs keys must match info[bus_id] BusState keys');
      for (const busId of infoKeys) {
        const issues = validateBusState(infos[busId]);
        assert(issues.length === 0, `Invalid BusState for ${busId}: ${issues.map((i) => i.message).join(', ')}`);
      }
      return `Verified ${obsKeys.length} arriving bus obs matching BusState schema (${obsKeys[0]})`;
    }),
  );

  results.push(
    runTest('env-02', 'Environment', 'Deterministic seeding produces identical trajectories', () => {
      const envA = new StubHoldingEnv(config);
      const envB = new StubHoldingEnv(config);
      const rA = envA.reset(108, { scenario: 'rain' });
      const rB = envB.reset(108, { scenario: 'rain' });
      assert(JSON.stringify(rA) === JSON.stringify(rB), 'Reset outputs diverged for identical seed 108');
      const busId = Object.keys(rA.observations)[0];
      const sA = envA.step({ [busId]: 2 });
      const sB = envB.step({ [busId]: 2 });
      assert(JSON.stringify(sA) === JSON.stringify(sB), 'Step outputs diverged for identical seed and action');
      return 'Identical reset() and step() state vectors verified for seed=108 under scenario="rain"';
    }),
  );

  results.push(
    runTest('pred-01', 'Predictor', 'predict(history) returns calibrated Prediction within [0, 1]', () => {
      const env = new StubHoldingEnv(config);
      const { infos } = env.reset(config.default_seed);
      const busState = Object.values(infos)[0];
      const predictor = new ConstantPredictor(0.18, config.prediction_horizons_stops[1] ?? 5);
      const pred = predictor.predict([busState]);
      const issues = validatePrediction(pred, config.prediction_horizons_stops);
      assert(issues.length === 0, `Prediction contract failed: ${issues.map((i) => i.message).join(', ')}`);
      assert(pred.bus_id === busState.bus_id, 'Prediction bus_id must match input history bus_id');
      return `Returned p_bunch=${pred.p_bunch.toFixed(2)} for ${pred.bus_id} at k=${pred.horizon_stops} stops`;
    }),
  );

  results.push(
    runTest('pol-01', 'Policy', 'act(obs) maps every active bus_id to valid discrete hold index', () => {
      const env = new StubHoldingEnv(config);
      const { observations } = env.reset(config.default_seed);
      const policy = new RandomPolicy(config.hold_actions_s.length, config.default_seed);
      const actions = policy.act(observations);
      for (const busId of Object.keys(observations)) {
        const idx = actions[busId];
        assert(
          Number.isInteger(idx) && idx >= 0 && idx < config.hold_actions_s.length,
          `Invalid hold index ${idx} for ${busId}`,
        );
      }
      const sampleId = Object.keys(actions)[0];
      const sec = config.hold_actions_s[actions[sampleId]];
      return `Mapped ${sampleId} -> action_idx=${actions[sampleId]} (${sec}s hold)`;
    }),
  );

  results.push(
    runTest('feed-01', 'SnapshotFeed', 'End-to-end Gate 1 loop yields schema-valid Snapshots', () => {
      const feed = new FakeSnapshotFeed(config, config.default_seed, 'normal');
      const snapshots = Array.from(feed.stream(5));
      assert(snapshots.length === 5, 'Expected 5 streamed snapshots');
      for (const snap of snapshots) {
        const issues = validateSnapshot(
          snap,
          config.hold_actions_s,
          config.prediction_horizons_stops,
        );
        assert(issues.length === 0, `Snapshot invalid at t=${snap.t}: ${issues.map((i) => i.message).join(', ')}`);
      }
      capturedSnapshot = snapshots[snapshots.length - 1];
      return `Streamed 5 consecutive snapshots (t=45s..${capturedSnapshot.t}s), all BusStates, Predictions & holds valid`;
    }),
  );

  results.push(
    runTest('sch-01', 'Schemas', 'Negative check rejects uncalibrated p_bunch > 1.0 and invalid hold', () => {
      const badPredIssues = validatePrediction(
        { bus_id: '500D-B01', p_bunch: 1.42, horizon_stops: 5 },
        config.prediction_horizons_stops,
      );
      assert(badPredIssues.length > 0, 'Validator must reject p_bunch > 1.0');
      const baseSnap = capturedSnapshot ?? new StubHoldingEnv(config).snapshot();
      const badSnapIssues = validateSnapshot(
        { ...baseSnap, holds: { '500D-B01': 73 } },
        config.hold_actions_s,
        config.prediction_horizons_stops,
      );
      assert(badSnapIssues.length > 0, 'Validator must reject hold 73s outside discrete action space');
      return 'Correctly rejected out-of-range probability (1.42) and illegal hold duration (73s)';
    }),
  );

  results.push(
    runTest('data-01', 'Data', 'Cleaned GTFS corridors have monotonic stop distances & Bengaluru coordinates', () => {
      const report = runGtfsCleaningPipeline();
      assert(report.cleanedRoutesCount >= 3, 'Expected at least 3 clean high-frequency routes');
      assert(report.droppedNonOperational > 0 && report.droppedBrokenTimetable > 0, 'Cleaner must filter inactive and broken routes');
      let totalStops = 0;
      for (const c of CORRIDOR_LIST) {
        assert(c.stops.length >= 10, `Corridor ${c.route_id} has too few stops`);
        for (let i = 0; i < c.stops.length; i++) {
          const s = c.stops[i];
          assert(s.lat >= 12.75 && s.lat <= 13.25 && s.lon >= 77.4 && s.lon <= 77.85, `Stop ${s.stop_id} out of Bengaluru bounds`);
          if (i > 0) {
            assert(s.cum_dist_km > c.stops[i - 1].cum_dist_km, `Non-monotonic distance at ${s.stop_id}`);
          }
          totalStops += 1;
        }
      }
      return `Verified ${CORRIDOR_LIST.length} corridors (${totalStops} stops) and ${report.droppedRoutes.length} dropped GTFS anomalies`;
    }),
  );

  results.push(
    runTest('data-02', 'Data', 'CNI 2022 GPS hourly speed profiles cover 07:00–19:00 with valid IQR bounds', () => {
      for (const c of CORRIDOR_LIST) {
        const profile = getHourlyTrafficProfile(c.route_id);
        assert(profile.length === 13, `Expected 13 hourly buckets (07:00..19:00) for ${c.route_id}`);
        for (const h of profile) {
          assert(h.gps_p25_kmh > 0 && h.gps_p25_kmh < h.gps_mean_kmh && h.gps_mean_kmh < h.gps_p75_kmh, `Invalid IQR ordering at ${c.route_id} ${h.label}`);
          const mixSum =
            h.mixed_traffic_share.two_wheelers_pct +
            h.mixed_traffic_share.cars_pct +
            h.mixed_traffic_share.autos_pct +
            h.mixed_traffic_share.buses_pct;
          assert(mixSum === 100, `Mixed traffic share must sum to 100% (got ${mixSum})`);
        }
      }
      return 'All 3 corridors verified across 13 hours (07:00–19:00 IST) with P25 < mean < P75 and 100% vClass mix';
    }),
  );

  results.push(
    runTest('sim-01', 'Environment', 'BMTCHoldingEnv satisfies frozen HoldingEnv contract & snapshot validation', () => {
      const env = new BMTCHoldingEnv(config);
      const { observations, infos } = env.reset(config.default_seed, {
        route_id: '500D',
        hour: 9,
        scenario: 'normal',
      });
      assert(Object.keys(observations).length >= 1, 'Expected at least 1 stop-arriving bus');
      for (const state of Object.values(infos)) {
        const issues = validateBusState(state);
        assert(issues.length === 0, `Invalid BusState from BMTCHoldingEnv: ${issues.map((i) => i.message).join(', ')}`);
      }
      const actions: Record<string, number> = {};
      for (const id of Object.keys(observations)) actions[id] = 2; // 30s hold
      env.step(actions);
      const snap = env.snapshot('ContractTest');
      const snapIssues = validateSnapshot(snap, config.hold_actions_s, config.prediction_horizons_stops);
      assert(snapIssues.length === 0, `Invalid Snapshot from BMTCHoldingEnv: ${snapIssues.map((i) => i.message).join(', ')}`);
      return `Verified BMTCHoldingEnv step & Snapshot at t=${snap.t}s (${snap.buses.length} buses on 500D)`;
    }),
  );

  results.push(
    runTest('sim-02', 'Environment', 'Gate 2: Dwell feedback produces natural bus bunching under No Control', () => {
      const withFeedback = runCorridorEpisode(config, {
        route_id: '500D',
        hour: 9,
        seed: config.default_seed,
        dwellFeedback: true,
        horizonMinutes: 110,
      });
      const withoutFeedback = runCorridorEpisode(config, {
        route_id: '500D',
        hour: 9,
        seed: config.default_seed,
        dwellFeedback: false,
        horizonMinutes: 110,
      });
      const cvWith = withFeedback.finalSnapshot.kpis.headway_cv;
      const cvWithout = withoutFeedback.finalSnapshot.kpis.headway_cv;
      const bunchPct = withFeedback.finalSnapshot.kpis.bunched_pct;
      assert(bunchPct > 0, 'Expected natural bunching arrivals (> 0%) with dwell feedback at 09:00 peak');
      assert(cvWith > cvWithout, `Expected dwell feedback CV (${cvWith}) > fixed dwell CV (${cvWithout})`);
      return `Confirmed Gate 2 bunching: ${bunchPct.toFixed(1)}% bunched, CV=${cvWith.toFixed(3)} (vs ${cvWithout.toFixed(3)} fixed dwell)`;
    }),
  );

  results.push(
    runTest('pol-02', 'Policy', 'All 4 rule-based baselines satisfy HoldingPolicy.act(obs) discrete bounds', () => {
      const env = new BMTCHoldingEnv(config);
      const { observations } = env.reset(config.default_seed, { route_id: '500D', hour: 9 });
      const schedHw = env.getScheduledHeadwayS();
      for (const id of ALL_BASELINE_IDS) {
        const policy = createBaselinePolicy(id, schedHw, config);
        const actions = policy.act(observations);
        for (const busId of Object.keys(observations)) {
          const idx = actions[busId];
          assert(
            Number.isInteger(idx) && idx >= 0 && idx < config.hold_actions_s.length,
            `Policy ${id} emitted invalid hold index ${idx}`,
          );
        }
      }
      return `Verified ${ALL_BASELINE_IDS.length} baseline policies (No Control, Schedule, Daganzo 2009, Two-Headway)`;
    }),
  );

  results.push(
    runTest('kpi-01', 'Policy', 'Headway-based baselines reduce Headway CV & bunched arrivals vs No Control', () => {
      const evals = runAllBaselinesComparison({
        config,
        routeId: '500D',
        hour: 9,
        seed: config.default_seed,
        horizonMinutes: 110,
      });
      const noCtrl = evals.find((e) => e.policy_id === 'no_control')!;
      const sched = evals.find((e) => e.policy_id === 'schedule')!;
      const daganzo = evals.find((e) => e.policy_id === 'daganzo')!;
      const twoHw = evals.find((e) => e.policy_id === 'two_headway')!;

      assert(daganzo.kpis.headway_cv < noCtrl.kpis.headway_cv, 'Daganzo (2009) must reduce headway CV vs No Control');
      assert(twoHw.kpis.headway_cv < noCtrl.kpis.headway_cv, 'Two-Headway must reduce headway CV vs No Control');
      const impact = estimateCommuterImpact(twoHw.kpis, sched.kpis, getCorridor('500D'));
      assert(Number.isFinite(impact.daily_pax_hours_saved), 'Commuter impact must be finite');
      return `500D Peak CV: NoCtrl ${noCtrl.kpis.headway_cv.toFixed(3)} -> Daganzo ${daganzo.kpis.headway_cv.toFixed(3)}, Two-Headway ${twoHw.kpis.headway_cv.toFixed(3)} (${impact.daily_pax_hours_saved >= 0 ? '+' : ''}${impact.daily_pax_hours_saved.toFixed(0)} pax-hrs/day vs Schedule)`;
    }),
  );

  results.push(
    runTest('pred-02', 'Predictor', 'TemporalBunchingPredictor serves calibrated Prediction across k ∈ {3, 5, 8}', () => {
      const suite = buildAndEvaluatePredictorSuite(config);
      const sample = suite.dataset.samples.find((s) => s.split === 'val');
      assert(Boolean(sample), 'Expected validation sequence sample');
      for (const k of config.prediction_horizons_stops) {
        const predictor = suite.byHorizon[k].servingPredictor;
        const pred = predictor.predict(sample!.history);
        const issues = validatePrediction(pred, config.prediction_horizons_stops);
        assert(issues.length === 0, `Invalid prediction at k=${k}: ${issues.map((i) => i.message).join(', ')}`);
      }
      const p5 = suite.byHorizon[5]?.servingPredictor.predict(sample!.history);
      return `Verified calibrated TCN/LSTM serving across k={${config.prediction_horizons_stops.join(',')}} (k=5 sample p_bunch=${(p5?.p_bunch ?? 0).toFixed(3)})`;
    }),
  );

  results.push(
    runTest('pred-03', 'Predictor', 'Leak-free episode splits have zero overlap & sequence model beats Threshold PR-AUC', () => {
      const suite = buildAndEvaluatePredictorSuite(config);
      const trainEps = new Set(suite.dataset.episodeSplits.train);
      const valEps = new Set(suite.dataset.episodeSplits.val);
      const testEps = new Set(suite.dataset.episodeSplits.test_transfer);
      for (const ep of valEps) {
        assert(!trainEps.has(ep), `Data leakage: episode ${ep} in both train and val`);
      }
      for (const ep of testEps) {
        assert(!trainEps.has(ep) && !valEps.has(ep), `Data leakage: episode ${ep} overlaps train/val`);
      }
      const h5 = suite.byHorizon[5] ?? Object.values(suite.byHorizon)[0];
      const thresh = h5.models.find((m) => m.model_id === 'threshold')!;
      const seq = h5.models.find((m) => m.model_id === 'tcn_lstm')!;
      assert(
        seq.val_metrics.pr_auc >= thresh.val_metrics.pr_auc,
        `Expected TCN/LSTM PR-AUC (${seq.val_metrics.pr_auc}) >= Threshold (${thresh.val_metrics.pr_auc})`,
      );
      return `0 episode overlaps (${suite.dataset.stats.totalSamples} seqs) · k=5 PR-AUC: TCN/LSTM ${seq.val_metrics.pr_auc.toFixed(3)} vs Threshold ${thresh.val_metrics.pr_auc.toFixed(3)} (ECE ${seq.val_metrics.ece.toFixed(3)})`;
    }),
  );

  results.push(
    runTest('marl-01', 'Policy', 'Shared-actor MAPPO satisfies HoldingPolicy contract & transfers zero-shot to G-4', () => {
      const suite = getTrainedMarlSuite(config);
      const env = new BMTCHoldingEnv(config);
      const { observations } = env.reset(config.default_seed, {
        route_id: 'G-4',
        hour: 9,
        fleetSizeOverride: 7,
      });
      const policy = new MappoHoldingPolicy({
        variant: 'mappo_pred',
        weights: suite.mappo_pred.weights,
        scheduledHeadwayS: env.getScheduledHeadwayS(),
        config,
      });
      const actions = policy.act(observations);
      for (const busId of Object.keys(observations)) {
        const idx = actions[busId];
        assert(
          Number.isInteger(idx) && idx >= 0 && idx < config.hold_actions_s.length,
          `MAPPO emitted invalid hold index ${idx}`,
        );
      }
      return 'Verified shared-actor MAPPO zero-shot execution on held-out G-4 with 7-bus fleet override';
    }),
  );

  results.push(
    runTest('marl-02', 'Policy', 'Gate 3 Full Loop: MAPPO + Predictor cuts Headway CV & bunching vs Schedule baseline', () => {
      const suite = getTrainedMarlSuite(config);
      const predictor = getProductionPredictor(config, 5);
      const baselines = runAllBaselinesComparison({
        config,
        routeId: '500D',
        hour: 9,
        seed: config.default_seed,
        horizonMinutes: 110,
      });
      const sched = baselines.find((b) => b.policy_id === 'schedule')!;
      const mappo = runIntegratedMarlEpisode({
        variant: 'mappo_pred',
        weights: suite.mappo_pred.weights,
        predictor,
        config,
        seed: config.default_seed,
        options: { route_id: '500D', hour: 9, scenario: 'normal', dwellFeedback: true },
        horizonMinutes: 110,
      });
      assert(
        mappo.kpis.headway_cv < sched.kpis.headway_cv,
        `Expected MAPPO CV (${mappo.kpis.headway_cv}) < Schedule CV (${sched.kpis.headway_cv})`,
      );
      return `Gate 3 passed on 500D: Schedule CV ${sched.kpis.headway_cv.toFixed(3)} (${sched.kpis.bunched_pct}% bunched) -> MAPPO+Pred CV ${mappo.kpis.headway_cv.toFixed(3)} (${mappo.kpis.bunched_pct}% bunched)`;
    }),
  );

  results.push(
    runTest('scen-01', 'Environment', 'makeScenario(name, seed) deterministically generates rain & breakdown physics', () => {
      const normal = makeScenario('normal', config.default_seed, { route_id: '500D' });
      const rainA = makeScenario('rain', config.default_seed, { route_id: '500D' });
      const rainB = makeScenario('rain', config.default_seed, { route_id: '500D' });
      const bdA = makeScenario('breakdown', config.default_seed, { route_id: '500D' });
      const bdB = makeScenario('breakdown', config.default_seed, { route_id: '500D' });

      assert(normal.getSpeedMultiplier(1800, 3) === 1.0 && normal.rain === null && normal.breakdown === null, 'Normal scenario must have unit multipliers');
      assert(JSON.stringify(rainA.rain) === JSON.stringify(rainB.rain), 'Rain scenario must be deterministic for identical seed');
      assert(JSON.stringify(bdA.breakdown) === JSON.stringify(bdB.breakdown), 'Breakdown scenario must be deterministic for identical seed');

      const midRainT = (rainA.rain!.onset_s + rainA.rain!.end_s) / 2;
      const rainSpeed = rainA.getSpeedMultiplier(midRainT, 4);
      const rainVar = rainA.getVarianceMultiplier(midRainT);
      const rainDem = rainA.getDemandMultiplier(midRainT);
      assert(rainSpeed < 0.85 && rainSpeed >= 0.45, `Rain speed multiplier out of bounds: ${rainSpeed}`);
      assert(rainVar > 1.1 && rainDem > 1.05, `Rain variance (${rainVar}) and demand (${rainDem}) must increase during storm`);
      assert(bdA.breakdown !== null && bdA.breakdown.duration_s >= 600, 'Breakdown must define valid immobilization duration');
      return `Seeded rain (speed ×${rainSpeed.toFixed(2)}, var ×${rainVar.toFixed(2)}, demand ×${rainDem.toFixed(2)}) & breakdown (B${String(bdA.breakdown!.target_bus_idx).padStart(2, '0')} for ${Math.round(bdA.breakdown!.duration_s / 60)}m) verified`;
    }),
  );

  results.push(
    runTest('scen-02', 'Environment', 'Disruption resilience: MAPPO + Predictor beats Schedule under Rain & Breakdown', () => {
      const suite = getTrainedMarlSuite(config);
      const predictor = getProductionPredictor(config, 5);
      const summaries: string[] = [];

      for (const scenName of ['rain', 'breakdown'] as const) {
        const spec = makeScenario(scenName, config.default_seed, { route_id: '500D' });
        const baselines = runAllBaselinesComparison({
          config,
          routeId: '500D',
          hour: 9,
          seed: config.default_seed,
          scenario: scenName,
          scenarioSpec: spec,
          horizonMinutes: 110,
        });
        const sched = baselines.find((b) => b.policy_id === 'schedule')!;
        const mappo = runIntegratedMarlEpisode({
          variant: 'mappo_pred',
          weights: suite.mappo_pred.weights,
          predictor,
          config,
          seed: config.default_seed,
          options: {
            route_id: '500D',
            hour: 9,
            scenario: scenName,
            scenarioSpec: spec,
            dwellFeedback: true,
          },
          horizonMinutes: 110,
        });

        assert(
          mappo.disruptionEvents.length > 0,
          `Expected logged disruption events during ${scenName} episode`,
        );
        assert(
          mappo.kpis.headway_cv < sched.kpis.headway_cv,
          `Under ${scenName}, expected MAPPO CV (${mappo.kpis.headway_cv}) < Schedule CV (${sched.kpis.headway_cv})`,
        );
        summaries.push(
          `${scenName}: Sched ${sched.kpis.headway_cv.toFixed(3)} -> MAPPO ${mappo.kpis.headway_cv.toFixed(3)}`,
        );
      }

      return `Disruption resilience verified on 500D (${summaries.join(' · ')})`;
    }),
  );

  results.push(
    runTest('run-01', 'SnapshotFeed', 'LiveSnapshotFeed replaces Gate 1 stub with validated real Snapshot stream', () => {
      const feed = new LiveSnapshotFeed({
        config,
        routeId: '500D',
        hour: 9,
        seed: config.default_seed,
        scenario: 'normal',
        leftPolicyId: 'schedule',
        rightPolicyId: 'mappo_pred',
        tickSeconds: 60,
      });
      const snaps = Array.from(feed.stream(6));
      assert(snaps.length === 6, `Expected 6 live snapshots, got ${snaps.length}`);
      for (const snap of snaps) {
        const issues = validateSnapshot(
          snap,
          config.hold_actions_s,
          config.prediction_horizons_stops,
        );
        assert(
          issues.length === 0,
          `LiveSnapshotFeed invalid at t=${snap.t}: ${issues.map((i) => i.message).join(', ')}`,
        );
      }
      const last = snaps[snaps.length - 1];
      return `Streamed 6 real validated Snapshots (t=${snaps[0].t}s..${last.t}s, ${last.buses.length} buses, ${last.predictions.length} preds)`;
    }),
  );

  results.push(
    runTest('run-02', 'SnapshotFeed', 'DualSimulationRunner synchronizes identical twins & dual live disruption injection', () => {
      const runner = new DualSimulationRunner({
        config,
        routeId: '500D',
        hour: 9,
        seed: config.default_seed,
        scenario: 'normal',
        leftPolicyId: 'schedule',
        rightPolicyId: 'mappo_pred',
        tickSeconds: 120,
      });
      const initial = runner.getFrame();
      assert(
        initial.left.snapshot.buses.length === initial.right.snapshot.buses.length,
        'Left and Right twins must share identical fleet size',
      );
      const mid = Array.from(runner.streamPairs(8)).pop()!;
      const afterRain = runner.injectLiveRain(32);
      assert(
        afterRain.left.snapshot.scenario === 'rain' && afterRain.right.snapshot.scenario === 'rain',
        'Live rain injection must apply identically to both Left and Right twins',
      );
      const end = Array.from(runner.streamPairs(10)).pop()!;
      assert(
        end.clock_t > mid.clock_t && Number.isFinite(end.diff.daily_pax_hours_saved),
        'Synchronized clock and commuter impact diff must remain monotonic and finite',
      );
      return `Synchronized twins through t=${Math.round(end.clock_t / 60)}m with live rain · CV Left ${end.left.kpis.headway_cv.toFixed(3)} vs Right ${end.right.kpis.headway_cv.toFixed(3)}`;
    }),
  );

  results.push(
    runTest('dash-01', 'SnapshotFeed', 'Dispatcher Accept & Override actions genuinely modify executed bus holds in live sim', () => {
      const runner = new DualSimulationRunner({
        config,
        routeId: '500D',
        hour: 9,
        seed: config.default_seed,
        scenario: 'normal',
        leftPolicyId: 'schedule',
        rightPolicyId: 'mappo_pred',
        tickSeconds: 120,
        alertThreshold: 0.45,
      });
      const targetBusId = runner.getFrame().right.snapshot.buses[0].bus_id;
      const queued = runner.queueBusHoldOverride(targetBusId, 90);
      assert(queued.pending_overrides[targetBusId] === 90, 'Manual 90s hold override must appear in pending_overrides');

      let afterFrame = queued;
      for (let i = 0; i < 8; i++) {
        afterFrame = runner.stepClock(120);
        if (afterFrame.override_history.length > 0) break;
      }

      assert(
        afterFrame.override_history.length >= 1,
        'Queued dispatcher override must execute on next bus arrival and appear in override_history',
      );
      const executed = afterFrame.override_history.find((h) => h.bus_id === targetBusId);
      assert(Boolean(executed) && executed!.executed_hold_s === 90, 'Executed hold duration must equal overridden 90s');
      const matchingLog = afterFrame.right.events.find(
        (e) => e.bus_id === targetBusId && e.hold_s === 90,
      );
      assert(Boolean(matchingLog), 'Arrival log must record the executed 90s manual hold override');
      return `Verified live override on ${targetBusId} (Policy ${executed!.policy_hold_s}s -> Executed ${executed!.executed_hold_s}s at ${executed!.stop_name})`;
    }),
  );

  results.push(
    runTest('dash-02', 'SnapshotFeed', 'Dashboard map coordinates & dual Time-Space trajectories stay valid across all 3 corridors', () => {
      let totalEvents = 0;
      for (const c of CORRIDOR_LIST) {
        const runner = new DualSimulationRunner({
          config,
          routeId: c.route_id,
          hour: 9,
          seed: config.default_seed,
          scenario: 'normal',
          tickSeconds: 180,
        });
        const frame = Array.from(runner.streamPairs(5)).pop()!;
        assert(frame.left.events.length > 0 && frame.right.events.length > 0, `Empty trajectories on ${c.route_id}`);
        for (const b of frame.right.snapshot.buses) {
          assert(b.lat >= 12.75 && b.lat <= 13.25 && b.lon >= 77.4 && b.lon <= 77.85, `Bus ${b.bus_id} out of Bengaluru map bounds`);
        }
        totalEvents += frame.left.events.length + frame.right.events.length;
      }
      return `Verified geospatial pins & dual Time-Space streams across 500D, 335E, and held-out G-4 (${totalEvents} live arrival points)`;
    }),
  );

  results.push(
    runTest('eval-01', 'Policy', '3-seed x 3-scenario benchmark proves MAPPO + Predictions beats Schedule across all regimes', () => {
      const bench = runMultiSeedBenchmark('500D', config);
      assert(bench.overallAverage.length === 7, 'Benchmark matrix must evaluate all 7 controllers');
      for (const sc of ['normal', 'rain', 'breakdown'] as const) {
        const rows = bench.byScenario[sc];
        const sched = rows.find((r) => r.policy_id === 'schedule')!;
        const mappo = rows.find((r) => r.policy_id === 'mappo_pred')!;
        assert(
          mappo.headway_cv.mean < sched.headway_cv.mean,
          `Scenario ${sc}: expected MAPPO+Pred CV (${mappo.headway_cv.mean}) < Schedule CV (${sched.headway_cv.mean})`,
        );
      }
      return `3-seed 500D avg: Schedule CV ${bench.headline.schedule_cv_mean.toFixed(3)} -> MAPPO+Pred ${bench.headline.mappo_pred_cv_mean.toFixed(3)} (−${bench.headline.cv_reduction_vs_schedule_pct.toFixed(1)}%, +${bench.headline.daily_pax_hours_saved_vs_schedule.toFixed(0)} pax-hrs/day)`;
    }),
  );

  results.push(
    runTest('eval-02', 'Policy', 'Zero-shot transfer on held-out G-4 (7–15 buses) & CSV/JSON report serialization succeed', () => {
      const bench = runMultiSeedBenchmark('500D', config);
      const transfer = runZeroShotTransferStudy(config);
      assert(transfer.fleetScaling.length === 4, 'Expected 4 fleet-size scaling points on G-4');
      for (const pt of transfer.fleetScaling) {
        assert(
          pt.mappo_pred_cv < pt.schedule_cv,
          `G-4 fleet=${pt.fleet_size}: expected MAPPO+Pred CV (${pt.mappo_pred_cv}) < Schedule CV (${pt.schedule_cv})`,
        );
      }
      const csv = serializeEvaluationCsv(bench, transfer);
      const json = serializeEvaluationJson(bench, transfer);
      const parsed = JSON.parse(json) as { disclaimer?: string };
      assert(csv.split('\n').length >= 25, 'CSV export must contain header + all aggregated rows');
      assert(Boolean(parsed.disclaimer), 'JSON export must include honest calibrated-simulation disclaimer');
      return `Zero-shot G-4 transfer −${transfer.cv_reduction_vs_schedule_pct.toFixed(1)}% CV across 7–15 buses · CSV (${csv.split('\n').length} lines) & JSON verified`;
    }),
  );

  const passed = results.filter((r) => r.passed).length;
  return {
    ranAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
    sampleSnapshot: capturedSnapshot ?? new StubHoldingEnv(config).snapshot(),
  };
}
