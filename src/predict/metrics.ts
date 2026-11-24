/**
 * Classification & Probability Calibration Metrics (predict/metrics.ts).
 * Computes Precision, Recall, F1, PR-AUC, Expected Calibration Error (ECE),
 * Reliability Diagram bins, and Temperature Scaling NLL optimization.
 */

export interface CalibrationBin {
  bin_idx: number;
  low: number;
  high: number;
  count: number;
  mean_pred: number;
  empirical_rate: number;
}

export interface BinaryEvalMetrics {
  precision: number;
  recall: number;
  f1: number;
  pr_auc: number;
  ece: number;
  brier: number;
  positive_count: number;
  total_count: number;
  reliability_bins: CalibrationBin[];
}

export function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Fits scalar Temperature T > 0 on validation logits & labels by minimizing
 * Negative Log-Likelihood (Guo et al. 2017 temperature scaling).
 */
export function fitTemperatureScaling(logits: number[], labels: Array<0 | 1>): number {
  if (logits.length === 0) return 1.0;
  let bestT = 1.0;
  let bestNll = Infinity;

  // Coarse + fine grid search over T in [0.45 .. 2.8]
  for (let t = 0.45; t <= 2.8; t += 0.05) {
    let nll = 0;
    for (let i = 0; i < logits.length; i++) {
      const p = Math.min(1 - 1e-6, Math.max(1e-6, sigmoid(logits[i] / t)));
      nll += labels[i] === 1 ? -Math.log(p) : -Math.log(1 - p);
    }
    if (nll < bestNll) {
      bestNll = nll;
      bestT = t;
    }
  }
  return Number(bestT.toFixed(2));
}

export function evaluateBinaryPredictions(
  probs: number[],
  labels: Array<0 | 1>,
  decisionThreshold = 0.5,
): BinaryEvalMetrics {
  const n = probs.length;
  if (n === 0) {
    return {
      precision: 0,
      recall: 0,
      f1: 0,
      pr_auc: 0,
      ece: 0,
      brier: 0,
      positive_count: 0,
      total_count: 0,
      reliability_bins: [],
    };
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let brierSum = 0;
  let positiveCount = 0;

  for (let i = 0; i < n; i++) {
    const y = labels[i];
    const p = probs[i];
    if (y === 1) positiveCount += 1;
    const pred = p >= decisionThreshold ? 1 : 0;
    if (pred === 1 && y === 1) tp += 1;
    else if (pred === 1 && y === 0) fp += 1;
    else if (pred === 0 && y === 1) fn += 1;
    brierSum += (p - y) ** 2;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  // Exact Average Precision (PR-AUC) via descending probability sort
  const pairs = probs.map((p, idx) => ({ p, y: labels[idx] }));
  pairs.sort((a, b) => b.p - a.p);

  let cumTp = 0;
  let prAuc = 0;
  let prevRecall = 0;
  if (positiveCount > 0) {
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i].y === 1) {
        cumTp += 1;
        const currRecall = cumTp / positiveCount;
        const currPrec = cumTp / (i + 1);
        prAuc += (currRecall - prevRecall) * currPrec;
        prevRecall = currRecall;
      }
    }
  }

  // 8-bin reliability diagram & Expected Calibration Error (ECE)
  const numBins = 8;
  const bins: CalibrationBin[] = [];
  let ece = 0;

  for (let b = 0; b < numBins; b++) {
    const low = b / numBins;
    const high = (b + 1) / numBins;
    let count = 0;
    let predSum = 0;
    let posSum = 0;
    for (let i = 0; i < n; i++) {
      const p = probs[i];
      const inBin = b === numBins - 1 ? p >= low && p <= high : p >= low && p < high;
      if (inBin) {
        count += 1;
        predSum += p;
        posSum += labels[i];
      }
    }
    const meanPred = count > 0 ? predSum / count : (low + high) / 2;
    const empRate = count > 0 ? posSum / count : 0;
    if (count > 0) {
      ece += (count / n) * Math.abs(empRate - meanPred);
    }
    bins.push({
      bin_idx: b,
      low: Number(low.toFixed(2)),
      high: Number(high.toFixed(2)),
      count,
      mean_pred: Number(meanPred.toFixed(3)),
      empirical_rate: Number(empRate.toFixed(3)),
    });
  }

  return {
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    f1: Number(f1.toFixed(3)),
    pr_auc: Number(prAuc.toFixed(3)),
    ece: Number(ece.toFixed(3)),
    brier: Number((brierSum / n).toFixed(3)),
    positive_count: positiveCount,
    total_count: n,
    reliability_bins: bins,
  };
}
