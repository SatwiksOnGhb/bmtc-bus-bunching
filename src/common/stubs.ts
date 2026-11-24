/**
 * Week-1 / Gate 1 contract stubs (Rule #1):
 * Every contract ships a working stub in Step 1 so the full loop runs end-to-end
 * and real components replace stubs one at a time in Steps 2–10.
 */

import { DEFAULT_CONFIG, type ProjectConfig } from './config';
import type {
  BunchingPredictor,
  BusObservation,
  BusState,
  EnvResetOptions,
  EnvStepResult,
  HoldingEnv,
  HoldingPolicy,
  Prediction,
  Snapshot,
  SnapshotFeed,
} from './schemas';

/** Seeded Mulberry32 PRNG for reproducible runs across all modules */
export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stub 1: Minimal Gate-1 PettingZoo-style parallel environment.
 * Replaced by full dwell-feedback corridor simulator in Step 3.
 */
export class StubHoldingEnv implements HoldingEnv {
  readonly name = 'StubHoldingEnv (Gate 1)';
  private config: ProjectConfig;
  private rng: () => number = createSeededRng(42);
  private t = 0;
  private scenario: 'normal' | 'rain' | 'breakdown' = 'normal';
  private routeId = '500D';
  private buses: BusState[] = [];
  private lastHolds: Record<string, number> = {};
  private lastPredictions: Prediction[] = [];

  constructor(config: ProjectConfig = DEFAULT_CONFIG) {
    this.config = config;
  }

  reset(seed: number, options?: EnvResetOptions) {
    this.rng = createSeededRng(seed);
    this.t = 0;
    this.scenario = options?.scenario ?? 'normal';
    this.routeId = options?.route_id ?? this.config.routes[0].route_id;
    const route =
      this.config.routes.find((r) => r.route_id === this.routeId) ?? this.config.routes[0];

    this.buses = Array.from({ length: route.fleet_size }, (_, i) => ({
      bus_id: `${route.route_id}-B${String(i + 1).padStart(2, '0')}`,
      route_id: route.route_id,
      t: 0,
      stop_idx: i % route.stop_count,
      lat: Number((route.anchor_lat + (i - route.fleet_size / 2) * 0.004).toFixed(5)),
      lon: Number((route.anchor_lon + (i - route.fleet_size / 2) * 0.003).toFixed(5)),
      fwd_headway_s: route.scheduled_headway_s,
      bwd_headway_s: route.scheduled_headway_s,
      sched_dev_s: 0,
      load: Math.floor(10 + this.rng() * 18),
      waiting_at_stop: Math.floor(3 + this.rng() * 10),
    }));

    this.lastHolds = {};
    this.lastPredictions = [];

    // Event-driven contract: only buses arriving at a stop appear in obs
    const activeBus = this.buses[0];
    return {
      observations: { [activeBus.bus_id]: this.toObservation(activeBus, 0.15) },
      infos: { [activeBus.bus_id]: { ...activeBus } },
    };
  }

  step(actions: Record<string, number>): EnvStepResult {
    const route =
      this.config.routes.find((r) => r.route_id === this.routeId) ?? this.config.routes[0];
    this.t += 45;
    this.lastHolds = {};

    // Apply discrete hold indices
    for (const [busId, actionIdx] of Object.entries(actions)) {
      const clampedIdx = Math.max(
        0,
        Math.min(this.config.hold_actions_s.length - 1, Math.round(actionIdx)),
      );
      const holdSec = this.config.hold_actions_s[clampedIdx];
      this.lastHolds[busId] = holdSec;
      const bus = this.buses.find((b) => b.bus_id === busId);
      if (bus) {
        bus.sched_dev_s = Number((bus.sched_dev_s + holdSec * 0.35).toFixed(1));
      }
    }

    // Advance buses one synthetic step and emit 1–2 arriving buses
    const arrivingIdx = Math.floor(this.t / 45) % this.buses.length;
    const observations: Record<string, BusObservation> = {};
    const rewards: Record<string, number> = {};
    const terminations: Record<string, boolean> = {};
    const truncations: Record<string, boolean> = {};
    const infos: Record<string, BusState> = {};

    this.buses = this.buses.map((b, idx) => {
      const jitter = (this.rng() - 0.5) * 40;
      const nextFwd = Math.max(30, Math.round(b.fwd_headway_s + jitter));
      const nextBwd = Math.max(30, Math.round(route.scheduled_headway_s * 2 - nextFwd));
      const updated: BusState = {
        ...b,
        t: this.t,
        stop_idx: idx === arrivingIdx ? (b.stop_idx + 1) % route.stop_count : b.stop_idx,
        fwd_headway_s: nextFwd,
        bwd_headway_s: nextBwd,
        sched_dev_s: Number((b.sched_dev_s + jitter * 0.4).toFixed(1)),
        load: Math.min(this.config.bus_capacity, Math.max(0, b.load + Math.round((this.rng() - 0.45) * 6))),
        waiting_at_stop: Math.max(0, Math.round(4 + this.rng() * 14)),
      };
      if (idx === arrivingIdx) {
        const imbalance = Math.abs(updated.fwd_headway_s - updated.bwd_headway_s) / route.scheduled_headway_s;
        const holdSec = this.lastHolds[updated.bus_id] ?? 0;
        const reward = -(imbalance + this.config.mappo_hold_penalty_lambda * holdSec * updated.load * 0.01);
        observations[updated.bus_id] = this.toObservation(updated, 0.15);
        rewards[updated.bus_id] = Number(reward.toFixed(4));
        terminations[updated.bus_id] = false;
        truncations[updated.bus_id] = false;
        infos[updated.bus_id] = { ...updated };
      }
      return updated;
    });

    return { observations, rewards, terminations, truncations, infos };
  }

  setPredictions(predictions: Prediction[]) {
    this.lastPredictions = predictions;
  }

  snapshot(policyName = 'RandomPolicy (Stub)'): Snapshot {
    const headways = this.buses.map((b) => b.fwd_headway_s);
    const meanHw = headways.reduce((a, b) => a + b, 0) / Math.max(1, headways.length);
    const variance =
      headways.reduce((acc, h) => acc + (h - meanHw) ** 2, 0) / Math.max(1, headways.length);
    const cv = meanHw > 0 ? Math.sqrt(variance) / meanHw : 0;

    return {
      t: this.t,
      policy: policyName,
      scenario: this.scenario,
      buses: this.buses.map((b) => ({ ...b })),
      predictions: this.lastPredictions.map((p) => ({ ...p })),
      holds: { ...this.lastHolds },
      kpis: {
        headway_cv: Number(cv.toFixed(4)),
        mean_headway_s: Number(meanHw.toFixed(1)),
        active_buses: this.buses.length,
      },
    };
  }

  private toObservation(bus: BusState, pBunch: number): BusObservation {
    return {
      bus_id: bus.bus_id,
      route_id: bus.route_id,
      stop_idx: bus.stop_idx,
      fwd_headway_s: bus.fwd_headway_s,
      bwd_headway_s: bus.bwd_headway_s,
      sched_dev_s: bus.sched_dev_s,
      load: bus.load,
      waiting_at_stop: bus.waiting_at_stop,
      p_bunch: pBunch,
    };
  }
}

/** Stub 2: Constant Predictor (Gate 1 — returns calibrated constant probability) */
export class ConstantPredictor implements BunchingPredictor {
  readonly name = 'ConstantPredictor (Stub)';
  private constantProb: number;
  private horizonStops: number;

  constructor(constantProb = 0.18, horizonStops = 5) {
    this.constantProb = constantProb;
    this.horizonStops = horizonStops;
  }

  predict(history: BusState[]): Prediction {
    const latest = history[history.length - 1];
    return {
      bus_id: latest ? latest.bus_id : 'UNKNOWN',
      p_bunch: this.constantProb,
      horizon_stops: this.horizonStops,
    };
  }
}

/** Stub 3: Random Policy (Gate 1 — returns valid discrete action indices) */
export class RandomPolicy implements HoldingPolicy {
  readonly name = 'RandomPolicy (Stub)';
  private numActions: number;
  private rng: () => number;

  constructor(numActions = DEFAULT_CONFIG.hold_actions_s.length, seed = 42) {
    this.numActions = numActions;
    this.rng = createSeededRng(seed);
  }

  act(observations: Record<string, BusObservation>): Record<string, number> {
    const actions: Record<string, number> = {};
    for (const busId of Object.keys(observations)) {
      actions[busId] = Math.floor(this.rng() * this.numActions);
    }
    return actions;
  }
}

/** Stub 4: Fake Snapshot Feed (Gate 1 — drives env + predictor + policy end to end) */
export class FakeSnapshotFeed implements SnapshotFeed {
  readonly name = 'FakeSnapshotFeed (Gate 1)';
  private env: StubHoldingEnv;
  private predictor: BunchingPredictor;
  private policy: HoldingPolicy;
  private seed: number;
  private scenario: 'normal' | 'rain' | 'breakdown';

  constructor(
    config: ProjectConfig = DEFAULT_CONFIG,
    seed = config.default_seed,
    scenario: 'normal' | 'rain' | 'breakdown' = 'normal',
  ) {
    this.env = new StubHoldingEnv(config);
    this.predictor = new ConstantPredictor(0.18, config.prediction_horizons_stops[1] ?? 5);
    this.policy = new RandomPolicy(config.hold_actions_s.length, seed);
    this.seed = seed;
    this.scenario = scenario;
  }

  *stream(steps: number): Generator<Snapshot, void, unknown> {
    let { observations, infos } = this.env.reset(this.seed, { scenario: this.scenario });

    for (let i = 0; i < steps; i++) {
      const predictions: Prediction[] = [];
      const enrichedObs: Record<string, BusObservation> = {};

      for (const [busId, obs] of Object.entries(observations)) {
        const state = infos[busId];
        const pred = this.predictor.predict(state ? [state] : []);
        predictions.push(pred);
        enrichedObs[busId] = { ...obs, p_bunch: pred.p_bunch };
      }

      const actions = this.policy.act(enrichedObs);
      const result = this.env.step(actions);
      this.env.setPredictions(predictions);
      observations = result.observations;
      infos = result.infos;

      yield this.env.snapshot(this.policy.name);
    }
  }
}
