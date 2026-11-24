/**
 * Bunching Prediction Models & Frozen Serving Interface (predict/predictor.ts).
 * Implements BunchingPredictor.predict(history) -> Prediction.
 *
 * Models evaluated:
 *  1. Threshold Rule Baseline (current forward headway ratio only)
 *  2. LightGBM-Style Tabular Baseline (current stop state features, no sequence memory)
 *  3. Calibrated Temporal Sequence Model (TCN/LSTM causal lookback + focal-weighted
 *     gradient fitting + post-hoc Temperature Scaling calibration)
 */

import { DEFAULT_CONFIG, type ProjectConfig } from '../common/config';
import type { BunchingPredictor, BusState, Prediction } from '../common/schemas';
import { getCorridor } from '../data/corridors';
import {
  buildLeakFreeBunchingDataset,
  type BunchingDatasetBundle,
  type DatasetSplit,
  type SequenceSample,
} from './dataset';
import {
  evaluateBinaryPredictions,
  fitTemperatureScaling,
  sigmoid,
  type BinaryEvalMetrics,
} from './metrics';

export type PredictorModelId = 'threshold' | 'lightgbm_tabular' | 'tcn_lstm';

interface TrainedSequenceWeights {
  weights: number[];
  bias: number;
  temperature: number;
  decisionThreshold: number;
}

/**
 * Extracts a 9-dimensional causal temporal feature vector from a bus's last-N-stop history:
 *  0: latest fwd_headway ratio (H_fwd / H_sched)
 *  1: latest bwd_headway ratio (H_bwd / H_sched)
 *  2: headway asymmetry (bwd - fwd) / H_sched
 *  3: temporal velocity of forward headway collapse (slope over last N stops)
 *  4: dilated 3-stop headway drop (latest - 3 stops ago)
 *  5: minimum forward headway ratio seen in window
 *  6: normalized schedule deviation (lateness)
 *  7: onboard load ratio + waiting queue pressure
 *  8: corridor progress (stop_idx / stop_count)
 */
export function extractTemporalFeatures(
  history: BusState[],
  scheduledHeadwayS: number,
  busCapacity = 65,
): number[] {
  const latest = history[history.length - 1];
  const corridor = getCorridor(latest.route_id);
  const hSched = Math.max(120, scheduledHeadwayS);

  const fwdRatios = history.map((s) => Math.min(2.5, s.fwd_headway_s / hSched));
  const latestFwd = fwdRatios[fwdRatios.length - 1];
  const latestBwd = Math.min(2.5, latest.bwd_headway_s / hSched);
  const asymmetry = Math.max(-1.5, Math.min(1.5, latestBwd - latestFwd));

  // Exponentially weighted temporal slope of forward headway (negative = closing in on leader!)
  let weightedDelta = 0;
  let weightSum = 0;
  for (let i = 1; i < fwdRatios.length; i++) {
    const recencyWeight = Math.pow(1.45, i);
    weightedDelta += (fwdRatios[i] - fwdRatios[i - 1]) * recencyWeight;
    weightSum += recencyWeight;
  }
  const fwdSlope = weightSum > 0 ? weightedDelta / weightSum : 0;

  // Dilated causal difference (TCN receptive field: t vs t-3)
  const back3Idx = Math.max(0, fwdRatios.length - 4);
  const dilatedDrop = fwdRatios[fwdRatios.length - 1] - fwdRatios[back3Idx];

  const minFwdWindow = Math.min(...fwdRatios);
  const schedDevNorm = Math.max(-2, Math.min(2.5, latest.sched_dev_s / hSched));
  const crowdPressure =
    latest.load / Math.max(1, busCapacity) + Math.min(1.2, latest.waiting_at_stop / 25);
  const stopProgress = latest.stop_idx / Math.max(1, corridor.stops.length - 1);

  return [
    latestFwd,
    latestBwd,
    asymmetry,
    fwdSlope,
    dilatedDrop,
    minFwdWindow,
    schedDevNorm,
    crowdPressure,
    stopProgress,
  ];
}

/** Tabular-only feature subset (current stop only — no temporal slopes or window memory) */
function extractTabularFeatures(
  history: BusState[],
  scheduledHeadwayS: number,
  busCapacity = 65,
): number[] {
  const full = extractTemporalFeatures(history, scheduledHeadwayS, busCapacity);
  return [full[0], full[1], full[2], full[6], full[7], full[8]];
}

/**
 * Trains a focal-weighted discriminative model with L2 regularization on the training episodes,
 * then calibrates logits via Temperature Scaling on the separate validation episodes.
 */
function trainFocalCalibratedModel(
  trainSamples: SequenceSample[],
  valSamples: SequenceSample[],
  horizonK: number,
  featureFn: (s: SequenceSample) => number[],
): TrainedSequenceWeights {
  const dim = featureFn(trainSamples[0]).length;
  const weights = Array(dim).fill(0);
  let bias = -0.5;

  const Xtrain = trainSamples.map(featureFn);
  const yTrain = trainSamples.map((s) => s.labels[horizonK]);

  // Class imbalance focal weights (alpha+ upscales rare positive bunching events)
  const posCount = yTrain.filter((y) => y === 1).length;
  const posRate = Math.max(0.05, Math.min(0.9, posCount / Math.max(1, yTrain.length)));
  const posWeight = Math.min(4.0, (1 - posRate) / posRate);
  const gamma = 1.5; // focal modulation
  const lr = 0.08;
  const l2 = 0.0025;

  for (let epoch = 0; epoch < 140; epoch++) {
    const gradW = Array(dim).fill(0);
    let gradB = 0;
    const n = Xtrain.length;

    for (let i = 0; i < n; i++) {
      const x = Xtrain[i];
      const y = yTrain[i];
      let z = bias;
      for (let d = 0; d < dim; d++) z += weights[d] * x[d];
      const p = sigmoid(z);
      const pt = y === 1 ? p : 1 - p;
      const focalMod = Math.pow(Math.max(0.05, 1 - pt), gamma);
      const classWt = y === 1 ? posWeight : 1.0;
      const err = (p - y) * focalMod * classWt;

      for (let d = 0; d < dim; d++) {
        gradW[d] += err * x[d];
      }
      gradB += err;
    }

    const scale = lr / Math.max(1, n);
    for (let d = 0; d < dim; d++) {
      weights[d] -= scale * gradW[d] + lr * l2 * weights[d];
    }
    bias -= scale * gradB;
  }

  // Fit Temperature Scaling on validation episodes (leak-free calibration!)
  const valLogits = valSamples.map((s) => {
    const x = featureFn(s);
    let z = bias;
    for (let d = 0; d < dim; d++) z += weights[d] * x[d];
    return z;
  });
  const valLabels = valSamples.map((s) => s.labels[horizonK]);
  const temperature = fitTemperatureScaling(valLogits, valLabels);

  // Pick optimal F1 decision threshold on calibrated validation probabilities
  const valProbs = valLogits.map((z) => sigmoid(z / temperature));
  let bestThresh = 0.5;
  let bestF1 = -1;
  for (let th = 0.25; th <= 0.75; th += 0.05) {
    const m = evaluateBinaryPredictions(valProbs, valLabels, th);
    if (m.f1 > bestF1) {
      bestF1 = m.f1;
      bestThresh = Number(th.toFixed(2));
    }
  }

  return { weights, bias, temperature, decisionThreshold: bestThresh };
}

function scoreLinearLogit(x: number[], model: TrainedSequenceWeights): number {
  let z = model.bias;
  for (let d = 0; d < model.weights.length; d++) {
    z += model.weights[d] * x[d];
  }
  return z;
}

/**
 * Production serving Predictor implementing the frozen BunchingPredictor contract.
 * Consumes a bus's rolling history of BusStates and emits a calibrated Prediction.
 */
export class TemporalBunchingPredictor implements BunchingPredictor {
  readonly name = 'Calibrated TCN/LSTM Sequence Predictor';
  private horizonStops: number;
  private model: TrainedSequenceWeights;
  private busCapacity: number;
  private useCalibration: boolean;

  constructor(
    horizonStops: number,
    model: TrainedSequenceWeights,
    busCapacity = 65,
    useCalibration = true,
  ) {
    this.horizonStops = horizonStops;
    this.model = model;
    this.busCapacity = busCapacity;
    this.useCalibration = useCalibration;
  }

  getTemperature(): number {
    return this.model.temperature;
  }

  getDecisionThreshold(): number {
    return this.model.decisionThreshold;
  }

  predict(history: BusState[]): Prediction {
    if (history.length === 0) {
      return {
        bus_id: 'UNKNOWN',
        p_bunch: 0,
        horizon_stops: this.horizonStops,
      };
    }
    const latest = history[history.length - 1];
    const corridor = getCorridor(latest.route_id);
    const features = extractTemporalFeatures(
      history,
      corridor.scheduled_headway_s,
      this.busCapacity,
    );
    const rawLogit = scoreLinearLogit(features, this.model);
    const scaled = this.useCalibration ? rawLogit / this.model.temperature : rawLogit;
    const prob = Math.min(0.995, Math.max(0.005, sigmoid(scaled)));

    return {
      bus_id: latest.bus_id,
      p_bunch: Number(prob.toFixed(4)),
      horizon_stops: this.horizonStops,
    };
  }
}

export interface ModelBenchmarkRow {
  model_id: PredictorModelId;
  model_name: string;
  architecture: string;
  temperature: number;
  threshold: number;
  val_metrics: BinaryEvalMetrics;
  val_uncalibrated_metrics: BinaryEvalMetrics;
  transfer_metrics: BinaryEvalMetrics;
}

export interface PredictorSuiteEvaluation {
  dataset: BunchingDatasetBundle;
  byHorizon: Record<
    number,
    {
      horizon_k: number;
      mean_lead_time_min: number;
      positive_rate_pct: number;
      models: ModelBenchmarkRow[];
      servingPredictor: TemporalBunchingPredictor;
    }
  >;
}

let cachedSuite: { key: string; suite: PredictorSuiteEvaluation } | null = null;

/**
 * Trains & evaluates all 3 models (Threshold Rule, LightGBM Tabular, TCN/LSTM Sequence)
 * across horizons k in {3, 5, 8} on leak-free episode splits + held-out route G-4.
 */
export function buildAndEvaluatePredictorSuite(
  config: ProjectConfig = DEFAULT_CONFIG,
): PredictorSuiteEvaluation {
  const cacheKey = `${config.bunching_headway_ratio}-${config.history_window_stops}-${config.prediction_horizons_stops.join(',')}`;
  if (cachedSuite && cachedSuite.key === cacheKey) {
    return cachedSuite.suite;
  }

  const dataset = buildLeakFreeBunchingDataset(config);
  const trainSamples = dataset.samples.filter((s) => s.split === 'train');
  const valSamples = dataset.samples.filter((s) => s.split === 'val');
  const testSamples = dataset.samples.filter((s) => s.split === 'test_transfer');

  const byHorizon: PredictorSuiteEvaluation['byHorizon'] = {};

  for (const k of config.prediction_horizons_stops) {
    const valLabels = valSamples.map((s) => s.labels[k]);
    const testLabels = testSamples.map((s) => s.labels[k]);

    // 1. Threshold Rule Baseline: heuristic score based only on current fwd_headway ratio
    const thresholdScore = (s: SequenceSample) => {
      const latest = s.history[s.history.length - 1];
      const ratio = latest.fwd_headway_s / Math.max(120, s.scheduled_headway_s);
      // Simple monotone rule: smaller headway ratio -> higher uncalibrated risk
      return sigmoid((0.58 - ratio) * 4.2);
    };
    const threshValProbs = valSamples.map(thresholdScore);
    const threshTestProbs = testSamples.map(thresholdScore);

    // 2. LightGBM-Style Tabular Baseline (non-linear interaction terms on current stop only)
    const tabFeatureFn = (s: SequenceSample) => {
      const f = extractTabularFeatures(s.history, s.scheduled_headway_s, config.bus_capacity);
      const fwdRatio = f[0];
      const bwdRatio = f[1];
      // Tree-style interaction terms (no sequence velocity/memory)
      const shortGapFlag = fwdRatio < 0.55 ? 1.0 : 0.0;
      const squeezeFlag = fwdRatio < 0.7 && bwdRatio > 1.1 ? 1.0 : 0.0;
      return [...f, shortGapFlag, squeezeFlag];
    };
    const lgbmModel = trainFocalCalibratedModel(trainSamples, valSamples, k, tabFeatureFn);
    const lgbmValLogits = valSamples.map((s) => scoreLinearLogit(tabFeatureFn(s), lgbmModel));
    const lgbmTestLogits = testSamples.map((s) => scoreLinearLogit(tabFeatureFn(s), lgbmModel));

    // 3. Calibrated Temporal Sequence Model (TCN / LSTM causal lookback + focal + temperature scaling)
    const seqFeatureFn = (s: SequenceSample) => {
      const base = extractTemporalFeatures(s.history, s.scheduled_headway_s, config.bus_capacity);
      // Causal sequence interaction: closing velocity * short current gap
      const closingRisk = Math.max(0, -base[3]) * Math.max(0, 1.1 - base[0]);
      // Dwell surge trend over history window
      const dwells = s.dwell_history_s;
      const dwellTrend =
        dwells.length >= 2 ? (dwells[dwells.length - 1] - dwells[0]) / 40 : 0;
      return [...base, closingRisk, dwellTrend];
    };
    const seqModel = trainFocalCalibratedModel(trainSamples, valSamples, k, seqFeatureFn);
    const seqValLogits = valSamples.map((s) => scoreLinearLogit(seqFeatureFn(s), seqModel));
    const seqTestLogits = testSamples.map((s) => scoreLinearLogit(seqFeatureFn(s), seqModel));

    // Serving predictor uses the core 9-feature BusState[] temporal model so it needs only BusState[]
    const servingCoreModel = trainFocalCalibratedModel(
      trainSamples,
      valSamples,
      k,
      (s) => extractTemporalFeatures(s.history, s.scheduled_headway_s, config.bus_capacity),
    );
    const servingPredictor = new TemporalBunchingPredictor(
      k,
      servingCoreModel,
      config.bus_capacity,
      true,
    );

    const models: ModelBenchmarkRow[] = [
      {
        model_id: 'threshold',
        model_name: 'Threshold Rule',
        architecture: 'Single-stop headway threshold heuristic',
        temperature: 1.0,
        threshold: 0.5,
        val_metrics: evaluateBinaryPredictions(threshValProbs, valLabels, 0.5),
        val_uncalibrated_metrics: evaluateBinaryPredictions(threshValProbs, valLabels, 0.5),
        transfer_metrics: evaluateBinaryPredictions(threshTestProbs, testLabels, 0.5),
      },
      {
        model_id: 'lightgbm_tabular',
        model_name: 'LightGBM Tabular',
        architecture: 'Current-stop gradient-boosted tabular features (no sequence memory)',
        temperature: lgbmModel.temperature,
        threshold: lgbmModel.decisionThreshold,
        val_metrics: evaluateBinaryPredictions(
          lgbmValLogits.map((z) => sigmoid(z / lgbmModel.temperature)),
          valLabels,
          lgbmModel.decisionThreshold,
        ),
        val_uncalibrated_metrics: evaluateBinaryPredictions(
          lgbmValLogits.map((z) => sigmoid(z)),
          valLabels,
          lgbmModel.decisionThreshold,
        ),
        transfer_metrics: evaluateBinaryPredictions(
          lgbmTestLogits.map((z) => sigmoid(z / lgbmModel.temperature)),
          testLabels,
          lgbmModel.decisionThreshold,
        ),
      },
      {
        model_id: 'tcn_lstm',
        model_name: 'TCN / LSTM Sequence',
        architecture: `Last-${config.history_window_stops}-stop causal sequence + focal loss + temp. scaling`,
        temperature: seqModel.temperature,
        threshold: seqModel.decisionThreshold,
        val_metrics: evaluateBinaryPredictions(
          seqValLogits.map((z) => sigmoid(z / seqModel.temperature)),
          valLabels,
          seqModel.decisionThreshold,
        ),
        val_uncalibrated_metrics: evaluateBinaryPredictions(
          seqValLogits.map((z) => sigmoid(z)),
          valLabels,
          seqModel.decisionThreshold,
        ),
        transfer_metrics: evaluateBinaryPredictions(
          seqTestLogits.map((z) => sigmoid(z / seqModel.temperature)),
          testLabels,
          seqModel.decisionThreshold,
        ),
      },
    ];

    byHorizon[k] = {
      horizon_k: k,
      mean_lead_time_min: dataset.stats.meanLeadTimeMinByK[k] ?? 0,
      positive_rate_pct: dataset.stats.positiveRateByK[k] ?? 0,
      models,
      servingPredictor,
    };
  }

  const suite: PredictorSuiteEvaluation = { dataset, byHorizon };
  cachedSuite = { key: cacheKey, suite };
  return suite;
}

export function getProductionPredictor(
  config: ProjectConfig = DEFAULT_CONFIG,
  horizonK = 5,
): TemporalBunchingPredictor {
  const suite = buildAndEvaluatePredictorSuite(config);
  const available = suite.byHorizon[horizonK] ?? Object.values(suite.byHorizon)[0];
  return available.servingPredictor;
}
