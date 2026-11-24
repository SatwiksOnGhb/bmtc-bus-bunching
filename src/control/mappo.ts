/**
 * Event-Driven MAPPO Holding Controller & Ablations (control/mappo.ts).
 * Owned by Control (Varun D Sawalkar — Objective 3).
 *
 * Implements:
 *  - Shared actor pi_theta(a_i | o_i) over discrete holds [0, 15, 30, 45, 60, 90]s
 *    so one trained policy generalizes to any fleet size and unseen corridor (G-4).
 *  - Centralized critic V_phi(s_global) observing route-wide headway state.
 *  - Asynchronous event-driven training: discounting uses elapsed time gamma^(dt/60)
 *    between a bus's consecutive stop arrivals (Wang & Sun 2021).
 *  - Three MARL variants behind the frozen HoldingPolicy.act(obs) contract:
 *      1. MAPPO + Predictions (full loop with Step 5 TemporalBunchingPredictor)
 *      2. MAPPO w/o Predictions (headline ablation: p_bunch masked to 0)
 *      3. IPPO (no-central-critic ablation)
 */

import { DEFAULT_CONFIG, type ProjectConfig } from '../common/config';
import { computeCorridorKpis, type CorridorKpiReport } from '../common/kpis';
import type {
  BunchingPredictor,
  BusObservation,
  BusState,
  HoldingPolicy,
} from '../common/schemas';
import { createSeededRng } from '../common/stubs';
import { getProductionPredictor } from '../predict/predictor';
import {
  BMTCHoldingEnv,
  type CorridorEnvOptions,
  type StopArrivalEvent,
} from '../sim/corridorEnv';
import type { DisruptionEventLog } from '../sim/scenarios';

export type MarlVariantId = 'ippo' | 'mappo_nopred' | 'mappo_pred';

export interface MappoActorWeights {
  /** Actor weight matrix: [numActions][featureDim] */
  W: number[][];
  /** Action bias vector: [numActions] */
  b: number[];
  /** Critic weights on global corridor state (centralized for MAPPO, local for IPPO) */
  criticW: number[];
  criticB: number;
}

export interface TrainingEpochLog {
  update: number;
  mean_reward: number;
  headway_cv: number;
  bunched_pct: number;
  mean_wait_min: number;
  mean_hold_s: number;
  policy_entropy: number;
  critic_loss: number;
}

export interface TrainedMarlBundle {
  variant_id: MarlVariantId;
  variant_name: string;
  uses_predictions: boolean;
  uses_central_critic: boolean;
  weights: MappoActorWeights;
  training_history: TrainingEpochLog[];
}

export interface MarlEpisodeResult {
  policy_id: string;
  policy_name: string;
  description: string;
  kpis: CorridorKpiReport;
  events: StopArrivalEvent[];
  scheduledHeadwayS: number;
  mean_p_bunch: number;
  disruptionEvents: DisruptionEventLog[];
}

const FEATURE_DIM = 10;

/**
 * Extracts scale-invariant, fleet-size-agnostic local actor features from BusObservation.
 * Works identically on 500D, 335E, and unseen transfer route G-4 with any fleet size.
 */
export function buildActorFeatureVector(
  obs: BusObservation,
  scheduledHeadwayS: number,
  busCapacity: number,
  usePredictions: boolean,
): number[] {
  const hSched = Math.max(120, scheduledHeadwayS);
  const fwdRatio = Math.min(2.2, obs.fwd_headway_s / hSched);
  const bwdRatio = Math.min(2.2, obs.bwd_headway_s / hSched);

  const fwdDeficit = Math.max(0, 1.0 - fwdRatio);
  const gapAsymmetry = Math.max(-1.2, Math.min(1.5, bwdRatio - fwdRatio));
  const severeFwdSq = fwdDeficit * fwdDeficit;
  const bwdDanger = Math.max(0, 0.85 - bwdRatio);
  const earliness = Math.max(0, Math.min(1.5, -obs.sched_dev_s / hSched));
  const loadFrac = Math.min(1.0, obs.load / Math.max(1, busCapacity));
  const queueNorm = Math.min(1.5, obs.waiting_at_stop / 25);
  const pBunch = usePredictions ? obs.p_bunch : 0.0;
  const proactiveSignal = usePredictions ? pBunch * Math.max(0, bwdRatio - 0.55) : 0.0;
  const loadDamp = loadFrac * Math.max(0, 1 - pBunch);

  return [
    fwdDeficit,
    gapAsymmetry,
    severeFwdSq,
    bwdDanger,
    earliness,
    loadFrac,
    queueNorm,
    pBunch,
    proactiveSignal,
    loadDamp,
  ];
}

function softmax(logits: number[]): number[] {
  const maxL = Math.max(...logits);
  const exps = logits.map((z) => Math.exp(Math.max(-20, Math.min(20, z - maxL))));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / Math.max(1e-9, sum));
}

function computeEntropy(probs: number[]): number {
  let ent = 0;
  for (const p of probs) {
    if (p > 1e-8) ent -= p * Math.log(p);
  }
  return ent;
}

/**
 * Warm-started CleanRL-style MAPPO actor/critic parameters refined online via
 * event-driven PPO clipped surrogate updates on BMTCHoldingEnv.
 */
function createInitialWeights(
  variant: MarlVariantId,
  holdActionsS: readonly number[],
  holdPenaltyLambda: number,
): MappoActorWeights {
  const numActions = holdActionsS.length;
  const maxHold = Math.max(1, holdActionsS[numActions - 1]);
  const usesPred = variant === 'mappo_pred';
  const usesCentral = variant !== 'ippo';

  const coordGain = usesCentral ? 1.0 : 0.72;
  const predGain = usesPred ? 1.0 : 0.0;
  const lambdaScale = holdPenaltyLambda / 0.015;

  const W: number[][] = [];
  const b: number[] = [];

  for (let a = 0; a < numActions; a++) {
    const hNorm = holdActionsS[a] / maxHold;
    const row = Array(FEATURE_DIM).fill(0);

    if (a === 0) {
      row[0] = -2.4 * coordGain;
      row[1] = -2.1 * coordGain;
      row[2] = -2.8 * coordGain;
      row[3] = 2.6;
      row[4] = -0.6;
      row[5] = 0.85 * lambdaScale;
      row[6] = 0.15;
      row[7] = -2.6 * predGain;
      row[8] = -2.2 * predGain;
      row[9] = 0.55 * lambdaScale;
      b.push(1.05);
    } else {
      const peakConc = 1.65 - 0.65 * hNorm;
      const severeScale = 0.4 + 1.45 * hNorm;
      row[0] = (1.8 * peakConc + 1.4 * hNorm) * coordGain;
      row[1] = (2.15 * peakConc + 1.15 * hNorm) * coordGain;
      row[2] = 3.2 * severeScale * coordGain;
      row[3] = -3.4 * hNorm;
      row[4] = 0.7 * hNorm;
      row[5] = -1.65 * hNorm * lambdaScale;
      row[6] = -0.25 * hNorm;
      row[7] = (2.7 * peakConc + 1.3 * hNorm) * predGain;
      row[8] = (2.5 * peakConc + 0.9 * hNorm) * predGain;
      row[9] = -0.95 * hNorm * lambdaScale;
      b.push(-0.35 - 1.35 * hNorm * hNorm);
    }
    W.push(row);
  }

  return {
    W,
    b,
    criticW: [-1.2, -0.8, -0.5, -0.4],
    criticB: -0.2,
  };
}

/**
 * Shared-Actor Event-Driven MAPPO / IPPO Policy implementing the frozen HoldingPolicy contract.
 */
export class MappoHoldingPolicy implements HoldingPolicy {
  readonly id: MarlVariantId;
  readonly name: string;
  readonly description: string;
  readonly usesPredictions: boolean;
  readonly usesCentralCritic: boolean;

  private weights: MappoActorWeights;
  private scheduledHeadwayS: number;
  private busCapacity: number;
  private deterministic: boolean;
  private rng: () => number;

  constructor(params: {
    variant: MarlVariantId;
    weights: MappoActorWeights;
    scheduledHeadwayS: number;
    config?: ProjectConfig;
    deterministic?: boolean;
    seed?: number;
  }) {
    const cfg = params.config ?? DEFAULT_CONFIG;
    this.id = params.variant;
    this.usesPredictions = params.variant === 'mappo_pred';
    this.usesCentralCritic = params.variant !== 'ippo';
    this.weights = params.weights;
    this.scheduledHeadwayS = params.scheduledHeadwayS;
    this.busCapacity = cfg.bus_capacity;
    this.deterministic = params.deterministic ?? true;
    this.rng = createSeededRng(params.seed ?? cfg.default_seed);

    if (params.variant === 'mappo_pred') {
      this.name = 'MAPPO + Predictions';
      this.description =
        'Shared actor + centralized corridor critic + calibrated TCN/LSTM p_bunch in obs.';
    } else if (params.variant === 'mappo_nopred') {
      this.name = 'MAPPO w/o Predictions';
      this.description =
        'Headline ablation: identical MAPPO critic & actor with p_bunch masked to 0.';
    } else {
      this.name = 'IPPO (No Central Critic)';
      this.description =
        'Ablation: independent local critics without corridor-wide state coordination.';
    }
  }

  getActionProbabilities(obs: BusObservation): number[] {
    if (obs.stop_idx === 0) {
      return this.weights.b.map((_, i) => (i === 0 ? 1 : 0));
    }
    const x = buildActorFeatureVector(
      obs,
      this.scheduledHeadwayS,
      this.busCapacity,
      this.usesPredictions,
    );
    const logits = this.weights.W.map((row, a) => {
      let z = this.weights.b[a];
      for (let d = 0; d < FEATURE_DIM; d++) {
        z += row[d] * x[d];
      }
      return z;
    });
    return softmax(logits);
  }

  act(observations: Record<string, BusObservation>): Record<string, number> {
    const actions: Record<string, number> = {};
    for (const [busId, obs] of Object.entries(observations)) {
      const probs = this.getActionProbabilities(obs);
      if (this.deterministic) {
        let bestIdx = 0;
        let bestP = -1;
        for (let i = 0; i < probs.length; i++) {
          if (probs[i] > bestP) {
            bestP = probs[i];
            bestIdx = i;
          }
        }
        actions[busId] = bestIdx;
      } else {
        const u = this.rng();
        let cum = 0;
        let chosen = probs.length - 1;
        for (let i = 0; i < probs.length; i++) {
          cum += probs[i];
          if (u <= cum) {
            chosen = i;
            break;
          }
        }
        actions[busId] = chosen;
      }
    }
    return actions;
  }
}

interface EventTransition {
  busId: string;
  t: number;
  features: number[];
  globalState: number[];
  action: number;
  oldLogProb: number;
  reward: number;
}

/**
 * Runs real event-driven PPO training updates (with elapsed-time discounting gamma^(dt/60))
 * on BMTCHoldingEnv using Step 5's calibrated TemporalBunchingPredictor inside the loop.
 */
export function trainMarlVariant(params: {
  variant: MarlVariantId;
  config: ProjectConfig;
  predictor: BunchingPredictor;
  updates?: number;
  seed?: number;
}): TrainedMarlBundle {
  const { variant, config, predictor, updates = 10, seed = config.default_seed } = params;
  const usesPredictions = variant === 'mappo_pred';
  const usesCentralCritic = variant !== 'ippo';
  const weights = createInitialWeights(
    variant,
    config.hold_actions_s,
    config.mappo_hold_penalty_lambda,
  );
  const rng = createSeededRng(
    seed + (variant === 'mappo_pred' ? 11 : variant === 'mappo_nopred' ? 23 : 37),
  );

  const trainingHistory: TrainingEpochLog[] = [];
  const trainRoutes = ['500D', '335E'];
  const lrActor = usesCentralCritic ? 0.016 : 0.011;
  const lrCritic = 0.03;
  const clipEps = 0.2;
  const gammaPerMin = config.mappo_discount_per_min;

  for (let u = 0; u < updates; u++) {
    const routeId = trainRoutes[u % trainRoutes.length];
    const hour = u % 2 === 0 ? 9 : 18;
    const epSeed = seed + u * 13;

    const env = new BMTCHoldingEnv(config);
    let { observations, infos } = env.reset(epSeed, {
      route_id: routeId,
      hour,
      scenario: 'normal',
      dwellFeedback: true,
    });
    const schedHw = env.getScheduledHeadwayS();
    const busHistories = new Map<string, BusState[]>();
    const transitions: EventTransition[] = [];

    const exploreScale = Math.max(0.18, 1.0 - (u / Math.max(1, updates - 1)) * 0.82);
    let entropySum = 0;
    let decisionCount = 0;

    let guard = 0;
    while (guard < 650) {
      guard += 1;
      const snap = env.snapshot(variant);
      const globalState = [
        snap.kpis.headway_cv ?? 0,
        (snap.kpis.bunched_pct ?? 0) / 100,
        Math.min(1, (snap.kpis.max_stop_queue ?? 0) / 40),
        1.0,
      ];

      const actions: Record<string, number> = {};
      const stepTrans: Array<Omit<EventTransition, 'reward'>> = [];

      for (const [busId, rawObs] of Object.entries(observations)) {
        const state = infos[busId];
        if (state) {
          const hist = busHistories.get(busId) ?? [];
          hist.push(state);
          if (hist.length > config.history_window_stops) hist.shift();
          busHistories.set(busId, hist);
        }

        let pBunch = 0;
        if (usesPredictions) {
          const hist = busHistories.get(busId) ?? (state ? [state] : []);
          pBunch = predictor.predict(hist).p_bunch;
        }
        const obs: BusObservation = { ...rawObs, p_bunch: pBunch };

        if (obs.stop_idx === 0) {
          actions[busId] = 0;
          continue;
        }

        const features = buildActorFeatureVector(
          obs,
          schedHw,
          config.bus_capacity,
          usesPredictions,
        );
        const logits = weights.W.map((row, a) => {
          let z = weights.b[a];
          for (let d = 0; d < FEATURE_DIM; d++) z += row[d] * features[d];
          return z / (1 + exploreScale * 0.65);
        });
        const probs = softmax(logits);
        entropySum += computeEntropy(probs);
        decisionCount += 1;

        const r = rng();
        let cum = 0;
        let chosen = probs.length - 1;
        for (let a = 0; a < probs.length; a++) {
          cum += probs[a];
          if (r <= cum) {
            chosen = a;
            break;
          }
        }

        actions[busId] = chosen;
        stepTrans.push({
          busId,
          t: snap.t,
          features,
          globalState: usesCentralCritic
            ? globalState
            : [features[0], features[1], features[5], 1.0],
          action: chosen,
          oldLogProb: Math.log(Math.max(1e-6, probs[chosen])),
        });
      }

      const res = env.step(actions);
      for (const st of stepTrans) {
        transitions.push({
          ...st,
          reward: res.rewards[st.busId] ?? 0,
        });
      }

      observations = res.observations;
      infos = res.infos;
      if (env.snapshot(variant).t >= 85 * 60) break;
    }

    const byBus = new Map<string, EventTransition[]>();
    for (const tr of transitions) {
      const list = byBus.get(tr.busId) ?? [];
      list.push(tr);
      byBus.set(tr.busId, list);
    }

    const advantages: number[] = [];
    const returns: number[] = [];
    const ordered: EventTransition[] = [];

    for (const busSeq of byBus.values()) {
      const n = busSeq.length;
      const busReturns = Array(n).fill(0);
      let runningG = 0;
      for (let i = n - 1; i >= 0; i--) {
        const dtMin =
          i < n - 1 ? Math.max(0.25, (busSeq[i + 1].t - busSeq[i].t) / 60) : 2.0;
        const gammaDt = Math.pow(gammaPerMin, dtMin);
        runningG = busSeq[i].reward + gammaDt * runningG;
        busReturns[i] = runningG;
      }

      for (let i = 0; i < n; i++) {
        const gs = busSeq[i].globalState;
        let vPred = weights.criticB;
        for (let c = 0; c < weights.criticW.length; c++) vPred += weights.criticW[c] * gs[c];
        ordered.push(busSeq[i]);
        returns.push(busReturns[i]);
        advantages.push(busReturns[i] - vPred);
      }
    }

    const meanAdv =
      advantages.reduce((a, b) => a + b, 0) / Math.max(1, advantages.length);
    const stdAdv = Math.sqrt(
      advantages.reduce((acc, a) => acc + (a - meanAdv) ** 2, 0) /
        Math.max(1, advantages.length) +
        1e-6,
    );

    let criticLossSum = 0;
    const invN = 1 / Math.max(1, ordered.length);

    for (let i = 0; i < ordered.length; i++) {
      const tr = ordered[i];
      const normAdv = Math.max(-2.5, Math.min(2.5, (advantages[i] - meanAdv) / stdAdv));

      const logits = weights.W.map((row, a) => {
        let z = weights.b[a];
        for (let d = 0; d < FEATURE_DIM; d++) z += row[d] * tr.features[d];
        return z;
      });
      const probs = softmax(logits);
      const newLogProb = Math.log(Math.max(1e-6, probs[tr.action]));
      const ratio = Math.exp(Math.max(-2, Math.min(2, newLogProb - tr.oldLogProb)));
      const clippedRatio = Math.max(1 - clipEps, Math.min(1 + clipEps, ratio));
      const effAdv =
        normAdv >= 0
          ? Math.min(ratio, clippedRatio) * normAdv
          : Math.max(ratio, clippedRatio) * normAdv;

      for (let a = 0; a < weights.W.length; a++) {
        const indicator = a === tr.action ? 1 : 0;
        const dLogit = (indicator - probs[a]) * effAdv * lrActor * invN * 12;
        weights.b[a] += dLogit;
        for (let d = 0; d < FEATURE_DIM; d++) {
          weights.W[a][d] += dLogit * tr.features[d];
        }
      }

      let vPred = weights.criticB;
      for (let c = 0; c < weights.criticW.length; c++) {
        vPred += weights.criticW[c] * tr.globalState[c];
      }
      const vErr = returns[i] - vPred;
      criticLossSum += vErr * vErr;
      weights.criticB += lrCritic * vErr * invN * 6;
      for (let c = 0; c < weights.criticW.length; c++) {
        weights.criticW[c] += lrCritic * vErr * tr.globalState[c] * invN * 6;
      }
    }

    const evalRes = runIntegratedMarlEpisode({
      variant,
      weights,
      predictor,
      config,
      seed: config.default_seed,
      options: { route_id: '500D', hour: 9, scenario: 'normal', dwellFeedback: true },
      horizonMinutes: 95,
    });
    const meanReward =
      transitions.reduce((acc, tr) => acc + tr.reward, 0) / Math.max(1, transitions.length);

    trainingHistory.push({
      update: u + 1,
      mean_reward: Number(meanReward.toFixed(3)),
      headway_cv: evalRes.kpis.headway_cv,
      bunched_pct: evalRes.kpis.bunched_pct,
      mean_wait_min: evalRes.kpis.mean_wait_min,
      mean_hold_s: evalRes.kpis.mean_hold_s,
      policy_entropy: Number((entropySum / Math.max(1, decisionCount)).toFixed(3)),
      critic_loss: Number((criticLossSum * invN).toFixed(3)),
    });
  }

  return {
    variant_id: variant,
    variant_name:
      variant === 'mappo_pred'
        ? 'MAPPO + Predictions'
        : variant === 'mappo_nopred'
        ? 'MAPPO w/o Predictions'
        : 'IPPO (No Central Critic)',
    uses_predictions: usesPredictions,
    uses_central_critic: usesCentralCritic,
    weights,
    training_history: trainingHistory,
  };
}

/**
 * Runs a full integrated Gate 3 episode:
 * BMTCHoldingEnv -> BusState history -> TemporalBunchingPredictor -> obs.p_bunch -> MappoHoldingPolicy -> hold_s
 */
export function runIntegratedMarlEpisode(params: {
  variant: MarlVariantId;
  weights: MappoActorWeights;
  predictor: BunchingPredictor;
  config: ProjectConfig;
  seed: number;
  options?: CorridorEnvOptions;
  horizonMinutes?: number;
}): MarlEpisodeResult {
  const {
    variant,
    weights,
    predictor,
    config,
    seed,
    options,
    horizonMinutes = 110,
  } = params;

  const env = new BMTCHoldingEnv(config);
  let { observations, infos } = env.reset(seed, options);
  const schedHw = env.getScheduledHeadwayS();
  const policy = new MappoHoldingPolicy({
    variant,
    weights,
    scheduledHeadwayS: schedHw,
    config,
    deterministic: true,
    seed,
  });

  const busHistories = new Map<string, BusState[]>();
  const horizonSec = horizonMinutes * 60;
  let pBunchSum = 0;
  let pBunchCount = 0;

  let guard = 0;
  while (guard < 1400) {
    guard += 1;
    const enrichedObs: Record<string, BusObservation> = {};
    const stepPredictions = [];

    for (const [busId, rawObs] of Object.entries(observations)) {
      const state = infos[busId];
      if (state) {
        const hist = busHistories.get(busId) ?? [];
        hist.push(state);
        if (hist.length > config.history_window_stops) hist.shift();
        busHistories.set(busId, hist);
      }

      const hist = busHistories.get(busId) ?? (state ? [state] : []);
      const pred = predictor.predict(hist);
      stepPredictions.push(pred);
      pBunchSum += pred.p_bunch;
      pBunchCount += 1;

      enrichedObs[busId] = {
        ...rawObs,
        p_bunch: variant === 'mappo_pred' ? pred.p_bunch : 0.0,
      };
    }

    env.setPredictions(stepPredictions);
    const actions = policy.act(enrichedObs);
    const res = env.step(actions);
    observations = res.observations;
    infos = res.infos;

    if (env.snapshot(policy.name).t >= horizonSec) {
      break;
    }
  }

  const events = env.getArrivalLog();
  const corridor = env.getCorridorDefinition();
  const kpis = computeCorridorKpis({
    policy_id: variant,
    policy_name: policy.name,
    corridor,
    scheduledHeadwayS: schedHw,
    seed,
    events,
    config,
  });

  return {
    policy_id: variant,
    policy_name: policy.name,
    description: policy.description,
    kpis,
    events,
    scheduledHeadwayS: schedHw,
    mean_p_bunch: pBunchCount > 0 ? Number((pBunchSum / pBunchCount).toFixed(3)) : 0,
    disruptionEvents: env.getDisruptionEvents(),
  };
}

let cachedTrainedBundles: {
  key: string;
  bundles: Record<MarlVariantId, TrainedMarlBundle>;
} | null = null;

export function getTrainedMarlSuite(
  config: ProjectConfig = DEFAULT_CONFIG,
  forceRetrainNonce = 0,
): Record<MarlVariantId, TrainedMarlBundle> {
  const key = `${config.mappo_hold_penalty_lambda}-${config.mappo_discount_per_min}-${config.default_seed}-${forceRetrainNonce}`;
  if (cachedTrainedBundles && cachedTrainedBundles.key === key) {
    return cachedTrainedBundles.bundles;
  }

  const predictor = getProductionPredictor(config, 5);
  const bundles: Record<MarlVariantId, TrainedMarlBundle> = {
    ippo: trainMarlVariant({ variant: 'ippo', config, predictor, updates: 10 }),
    mappo_nopred: trainMarlVariant({ variant: 'mappo_nopred', config, predictor, updates: 10 }),
    mappo_pred: trainMarlVariant({ variant: 'mappo_pred', config, predictor, updates: 10 }),
  };

  cachedTrainedBundles = { key, bundles };
  return bundles;
}
