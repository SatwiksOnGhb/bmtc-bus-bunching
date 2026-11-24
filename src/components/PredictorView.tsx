import { useMemo, useState } from 'react';
import type { ProjectConfig } from '../common/config';
import {
  buildAndEvaluatePredictorSuite,
  type PredictorModelId,
} from '../predict/predictor';

interface PredictorViewProps {
  config: ProjectConfig;
}

export function PredictorView({ config }: PredictorViewProps) {
  const [horizonK, setHorizonK] = useState<number>(
    config.prediction_horizons_stops[1] ?? 5,
  );
  const [evalSplit, setEvalSplit] = useState<'val' | 'transfer'>('val');
  const [showCalibrated, setShowCalibrated] = useState<boolean>(true);
  const [selectedSampleIdx, setSelectedSampleIdx] = useState<number>(0);

  const suite = useMemo(() => buildAndEvaluatePredictorSuite(config), [config]);
  const horizonData =
    suite.byHorizon[horizonK] ?? Object.values(suite.byHorizon)[0];

  const seqRow =
    horizonData.models.find((m) => m.model_id === 'tcn_lstm') ??
    horizonData.models[2];

  const activeMetrics = (row: (typeof horizonData.models)[number]) => {
    if (evalSplit === 'transfer') return row.transfer_metrics;
    return showCalibrated ? row.val_metrics : row.val_uncalibrated_metrics;
  };

  const seqMetrics = activeMetrics(seqRow);
  const rawSeqMetrics = seqRow.val_uncalibrated_metrics;

  // Pick curated real sequences from the selected split (mix of true positives & negatives)
  const inspectableSamples = useMemo(() => {
    const targetSplit = evalSplit === 'val' ? 'val' : 'test_transfer';
    const pool = suite.dataset.samples.filter((s) => s.split === targetSplit);
    const positives = pool.filter((s) => s.labels[horizonK] === 1).slice(0, 6);
    const negatives = pool.filter((s) => s.labels[horizonK] === 0).slice(0, 4);
    return [...positives, ...negatives];
  }, [suite.dataset.samples, evalSplit, horizonK]);

  const activeSample =
    inspectableSamples[selectedSampleIdx] ?? inspectableSamples[0] ?? null;

  const livePrediction = useMemo(() => {
    if (!activeSample) return null;
    return horizonData.servingPredictor.predict(activeSample.history);
  }, [activeSample, horizonData.servingPredictor]);

  // Horizon sweep data for F1 vs Lead Time chart
  const horizonSweep = useMemo(() => {
    return config.prediction_horizons_stops.map((k) => {
      const hd = suite.byHorizon[k];
      const pick = (id: PredictorModelId) => {
        const row = hd.models.find((m) => m.model_id === id)!;
        return evalSplit === 'transfer' ? row.transfer_metrics : row.val_metrics;
      };
      return {
        k,
        leadMin: hd.mean_lead_time_min,
        posRate: hd.positive_rate_pct,
        threshold: pick('threshold'),
        lightgbm: pick('lightgbm_tabular'),
        sequence: pick('tcn_lstm'),
      };
    });
  }, [config.prediction_horizons_stops, suite.byHorizon, evalSplit]);

  // SVG Reliability Diagram geometry
  const relChart = { w: 440, h: 255, padL: 46, padR: 20, padT: 18, padB: 36 };
  const rx = (p: number) => relChart.padL + p * (relChart.w - relChart.padL - relChart.padR);
  const ry = (p: number) => relChart.h - relChart.padB - p * (relChart.h - relChart.padT - relChart.padB);

  const calBins = seqRow.val_metrics.reliability_bins.filter((b) => b.count > 0);
  const rawBins = seqRow.val_uncalibrated_metrics.reliability_bins.filter((b) => b.count > 0);
  const transferBins = seqRow.transfer_metrics.reliability_bins.filter((b) => b.count > 0);
  const primaryBins = evalSplit === 'transfer' ? transferBins : showCalibrated ? calBins : rawBins;

  return (
    <div className="space-y-8">
      {/* Control Toolbar */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Horizon k selector */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {config.prediction_horizons_stops.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setHorizonK(k);
                  setSelectedSampleIdx(0);
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  horizonK === k
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                k = {k} stops ahead
              </button>
            ))}
          </div>

          {/* Evaluation split selector */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            <button
              type="button"
              onClick={() => {
                setEvalSplit('val');
                setSelectedSampleIdx(0);
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                evalSplit === 'val'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Validation (500D / 335E)
            </button>
            <button
              type="button"
              onClick={() => {
                setEvalSplit('transfer');
                setSelectedSampleIdx(0);
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                evalSplit === 'transfer'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Held-Out Transfer (G-4)
            </button>
          </div>
        </div>

        {/* Temperature Scaling Toggle */}
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md shrink-0">
          <button
            type="button"
            onClick={() => setShowCalibrated(true)}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              showCalibrated
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Temp. Scaled (T*={seqRow.temperature.toFixed(2)})
          </button>
          <button
            type="button"
            onClick={() => setShowCalibrated(false)}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              !showCalibrated
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Raw Uncalibrated
          </button>
        </div>
      </div>

      {/* 4-Column Summary KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">TCN / LSTM PR-AUC (k={horizonK})</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {seqMetrics.pr_auc.toFixed(3)}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            Avg lead time: {horizonData.mean_lead_time_min.toFixed(1)} min ahead
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">TCN / LSTM F1 Score</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {seqMetrics.f1.toFixed(3)}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            Prec {seqMetrics.precision.toFixed(2)} · Rec {seqMetrics.recall.toFixed(2)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Calibration Error (ECE)</div>
          <div
            className={`text-xl font-semibold mt-1 tabular-nums ${
              seqMetrics.ece <= 0.08 ? 'text-emerald-700' : 'text-amber-700'
            }`}
          >
            {seqMetrics.ece.toFixed(3)}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            T* = {seqRow.temperature.toFixed(2)} (raw ECE: {rawSeqMetrics.ece.toFixed(3)})
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Leak-Free Episode Dataset</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {suite.dataset.stats.totalSamples.toLocaleString()} seqs
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            Train {suite.dataset.stats.trainSamples} · Val {suite.dataset.stats.valSamples} · G-4 {suite.dataset.stats.testTransferSamples} ({horizonData.positive_rate_pct}% pos)
          </div>
        </div>
      </div>

      {/* Model Comparison Benchmark Matrix */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Bunching Predictor Benchmark — Horizon k = {horizonK} Stops ({evalSplit === 'val' ? 'Validation Episodes' : 'Unseen Route G-4 Zero-Shot'})
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Strict episode-level split (zero shared episodes between train, validation, and G-4 transfer). Positive label = headway &lt; {Math.round(config.bunching_headway_ratio * 100)}% of scheduled within next {horizonK} stops.
            </p>
          </div>
          <span className="text-xs font-mono text-slate-500 tabular-nums shrink-0">
            n = {seqMetrics.total_count} ({seqMetrics.positive_count} positives)
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                <th className="py-2.5 px-5">Model</th>
                <th className="py-2.5 px-3 text-right">PR-AUC</th>
                <th className="py-2.5 px-3 text-right">F1</th>
                <th className="py-2.5 px-3 text-right">Precision</th>
                <th className="py-2.5 px-3 text-right">Recall</th>
                <th className="py-2.5 px-3 text-right">ECE (Calib.)</th>
                <th className="py-2.5 px-5 text-right">Brier Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {horizonData.models.map((row) => {
                const m = activeMetrics(row);
                const isBest = row.model_id === 'tcn_lstm';
                return (
                  <tr
                    key={row.model_id}
                    className={isBest ? 'bg-blue-50/40' : 'hover:bg-slate-50'}
                  >
                    <td className="py-3.5 px-5">
                      <div className="font-medium text-slate-900">{row.model_name}</div>
                      <div className="text-xs text-slate-500 mt-0.5">{row.architecture}</div>
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                      {m.pr_auc.toFixed(3)}
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums font-medium text-slate-900">
                      {m.f1.toFixed(3)}
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-700">
                      {m.precision.toFixed(3)}
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-700">
                      {m.recall.toFixed(3)}
                    </td>
                    <td
                      className={`py-3.5 px-3 text-right font-mono tabular-nums font-medium ${
                        m.ece <= 0.08 ? 'text-emerald-700' : 'text-amber-700'
                      }`}
                    >
                      {m.ece.toFixed(3)}
                    </td>
                    <td className="py-3.5 px-5 text-right font-mono tabular-nums text-slate-700">
                      {m.brier.toFixed(3)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Reliability Calibration Curve & F1 vs Lead Time */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Calibration Reliability Curve */}
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Probability Calibration (Reliability Diagram)
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                MAPPO consumes p_bunch directly, so probabilities must match empirical bunching rates.
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-600">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-blue-700 inline-block" />
                {evalSplit === 'transfer' ? 'G-4 Transfer' : showCalibrated ? 'Temp. Scaled' : 'Raw'}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 h-0.5 border-t border-dashed border-slate-400 inline-block" />
                Ideal
              </span>
            </div>
          </div>

          <svg
            viewBox={`0 0 ${relChart.w} ${relChart.h}`}
            className="w-full h-auto"
            role="img"
            aria-label="Probability calibration reliability diagram"
          >
            {[0, 0.25, 0.5, 0.75, 1].map((v) => (
              <g key={v}>
                <line
                  x1={relChart.padL}
                  x2={relChart.w - relChart.padR}
                  y1={ry(v)}
                  y2={ry(v)}
                  stroke="#f1f5f9"
                  strokeWidth="1"
                />
                <text
                  x={relChart.padL - 8}
                  y={ry(v) + 3.5}
                  textAnchor="end"
                  fontSize="9.5"
                  fill="#64748b"
                  className="font-mono"
                >
                  {v.toFixed(2)}
                </text>
                <text
                  x={rx(v)}
                  y={relChart.h - 14}
                  textAnchor="middle"
                  fontSize="9.5"
                  fill="#64748b"
                  className="font-mono"
                >
                  {v.toFixed(2)}
                </text>
              </g>
            ))}

            {/* Axes */}
            <line
              x1={relChart.padL}
              x2={relChart.padL}
              y1={relChart.padT}
              y2={relChart.h - relChart.padB}
              stroke="#cbd5e1"
              strokeWidth="1.2"
            />
            <line
              x1={relChart.padL}
              x2={relChart.w - relChart.padR}
              y1={relChart.h - relChart.padB}
              y2={relChart.h - relChart.padB}
              stroke="#cbd5e1"
              strokeWidth="1.2"
            />

            {/* Perfect calibration diagonal */}
            <line
              x1={rx(0)}
              y1={ry(0)}
              x2={rx(1)}
              y2={ry(1)}
              stroke="#94a3b8"
              strokeWidth="1.3"
              strokeDasharray="4 4"
            />

            {/* Raw uncalibrated overlay when viewing calibrated val */}
            {evalSplit === 'val' && showCalibrated && rawBins.length >= 2 && (
              <path
                d={rawBins
                  .map(
                    (b, i) =>
                      `${i === 0 ? 'M' : 'L'} ${rx(b.mean_pred).toFixed(1)} ${ry(b.empirical_rate).toFixed(1)}`,
                  )
                  .join(' ')}
                fill="none"
                stroke="#f59e0b"
                strokeWidth="1.5"
                strokeDasharray="3 3"
                strokeOpacity="0.8"
              />
            )}

            {/* Primary reliability curve */}
            {primaryBins.length >= 2 && (
              <path
                d={primaryBins
                  .map(
                    (b, i) =>
                      `${i === 0 ? 'M' : 'L'} ${rx(b.mean_pred).toFixed(1)} ${ry(b.empirical_rate).toFixed(1)}`,
                  )
                  .join(' ')}
                fill="none"
                stroke="#1d4ed8"
                strokeWidth="2.2"
              />
            )}

            {primaryBins.map((b) => (
              <circle
                key={b.bin_idx}
                cx={rx(b.mean_pred)}
                cy={ry(b.empirical_rate)}
                r={Math.min(6.5, 3 + Math.sqrt(b.count) * 0.35)}
                fill="#1d4ed8"
                stroke="#ffffff"
                strokeWidth="1.5"
              >
                <title>
                  Bin [{b.low.toFixed(2)}, {b.high.toFixed(2)}]: pred {b.mean_pred.toFixed(2)} vs empirical {b.empirical_rate.toFixed(2)} (n={b.count})
                </title>
              </circle>
            ))}

            <text
              x={(relChart.padL + relChart.w - relChart.padR) / 2}
              y={relChart.h - 2}
              textAnchor="middle"
              fontSize="10"
              fill="#475569"
            >
              Predicted p(bunch)
            </text>
          </svg>
        </div>

        {/* F1 & PR-AUC vs Early-Warning Lead Time */}
        <div className="bg-white border border-slate-200 rounded-lg p-5 flex flex-col justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Early-Warning Accuracy vs. Lead Time (k = 3, 5, 8 Stops)
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Compares PR-AUC and F1 as the prediction horizon lengthens from ~4 min to ~14 min lead time.
            </p>
          </div>

          <div className="mt-4 space-y-4">
            {horizonSweep.map((row) => (
              <div
                key={row.k}
                className={`p-3.5 rounded-md border transition-colors ${
                  row.k === horizonK
                    ? 'border-blue-300 bg-blue-50/40'
                    : 'border-slate-200 bg-slate-50/50'
                }`}
              >
                <div className="flex items-center justify-between text-xs mb-2.5">
                  <span className="font-semibold text-slate-900">
                    k = {row.k} stops ahead · ~{row.leadMin.toFixed(1)} min mean lead time
                  </span>
                  <span className="font-mono text-slate-500 tabular-nums">
                    {row.posRate}% positive rate
                  </span>
                </div>

                <div className="space-y-1.5 text-xs">
                  {[
                    { label: 'TCN / LSTM', m: row.sequence, bar: 'bg-blue-700' },
                    { label: 'LightGBM', m: row.lightgbm, bar: 'bg-slate-600' },
                    { label: 'Threshold', m: row.threshold, bar: 'bg-slate-300' },
                  ].map((item) => (
                    <div key={item.label} className="grid grid-cols-12 items-center gap-2">
                      <span className="col-span-3 text-slate-700">{item.label}</span>
                      <div className="col-span-6 h-2 bg-slate-200 rounded-xs overflow-hidden">
                        <div
                          style={{ width: `${Math.round(item.m.pr_auc * 100)}%` }}
                          className={`h-full ${item.bar}`}
                        />
                      </div>
                      <span className="col-span-3 text-right font-mono tabular-nums text-slate-700">
                        AUC {item.m.pr_auc.toFixed(2)} · F1 {item.m.f1.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Live Predictor.predict(history) Serving Inspector */}
      {activeSample && livePrediction && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Live Predictor.predict(history) Sequence Inspector
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Inspect exact last-{config.history_window_stops}-stop BusState sequences fed into the serving predictor and compare p_bunch against ground-truth future bunching.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-md">
              {inspectableSamples.slice(0, 6).map((s, idx) => (
                <button
                  key={s.sample_id}
                  type="button"
                  onClick={() => setSelectedSampleIdx(idx)}
                  className={`px-2.5 py-1 text-xs font-mono rounded transition-colors whitespace-nowrap shrink-0 ${
                    idx === selectedSampleIdx
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {s.bus_id} @{s.stop_idx + 1}
                </button>
              ))}
            </div>
          </div>

          <div className="p-5 grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
            {/* Rolling Sequence Table */}
            <div className="xl:col-span-8 overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                    <th className="py-2 px-3">Step</th>
                    <th className="py-2 px-3">Stop #</th>
                    <th className="py-2 px-3 text-right">Fwd Gap</th>
                    <th className="py-2 px-3 text-right">Bwd Gap</th>
                    <th className="py-2 px-3 text-right">Sched Dev</th>
                    <th className="py-2 px-3 text-right">Dwell</th>
                    <th className="py-2 px-3 text-right">Load / Wait</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs font-mono tabular-nums">
                  {activeSample.history.map((st, idx) => {
                    const isLatest = idx === activeSample.history.length - 1;
                    return (
                      <tr key={idx} className={isLatest ? 'bg-blue-50/50 font-semibold' : ''}>
                        <td className="py-2 px-3 text-slate-500">
                          {isLatest ? 't (now)' : `t−${activeSample.history.length - 1 - idx}`}
                        </td>
                        <td className="py-2 px-3 text-slate-900">#{st.stop_idx + 1}</td>
                        <td className="py-2 px-3 text-right text-slate-800">
                          {st.fwd_headway_s.toFixed(0)}s
                        </td>
                        <td className="py-2 px-3 text-right text-slate-700">
                          {st.bwd_headway_s.toFixed(0)}s
                        </td>
                        <td className="py-2 px-3 text-right text-slate-700">
                          {st.sched_dev_s >= 0 ? '+' : ''}
                          {st.sched_dev_s.toFixed(0)}s
                        </td>
                        <td className="py-2 px-3 text-right text-slate-700">
                          {(activeSample.dwell_history_s[idx] ?? 0).toFixed(0)}s
                        </td>
                        <td className="py-2 px-3 text-right text-slate-700">
                          {st.load} / {st.waiting_at_stop}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Serving Prediction Output */}
            <div className="xl:col-span-4 border border-slate-200 rounded-md p-4 bg-slate-50/60 space-y-3">
              <div className="text-xs text-slate-500">
                Serving Output · {activeSample.route_id} · {activeSample.stop_name}
              </div>

              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium text-slate-700">
                  Calibrated p(bunch)
                </span>
                <span
                  className={`text-2xl font-bold font-mono tabular-nums ${
                    livePrediction.p_bunch >= config.alert_probability_threshold
                      ? 'text-red-700'
                      : livePrediction.p_bunch >= 0.4
                      ? 'text-amber-700'
                      : 'text-emerald-700'
                  }`}
                >
                  {(livePrediction.p_bunch * 100).toFixed(1)}%
                </span>
              </div>

              <div className="h-2.5 w-full bg-slate-200 rounded-xs overflow-hidden">
                <div
                  style={{ width: `${Math.round(livePrediction.p_bunch * 100)}%` }}
                  className={`h-full ${
                    livePrediction.p_bunch >= config.alert_probability_threshold
                      ? 'bg-red-600'
                      : livePrediction.p_bunch >= 0.4
                      ? 'bg-amber-500'
                      : 'bg-emerald-600'
                  }`}
                />
              </div>

              <div className="pt-3 border-t border-slate-200 text-xs space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-500">Horizon</span>
                  <span className="font-mono text-slate-900">
                    next {livePrediction.horizon_stops} stops
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Dispatcher Alert (&ge; {Math.round(config.alert_probability_threshold * 100)}%)</span>
                  <span
                    className={
                      livePrediction.p_bunch >= config.alert_probability_threshold
                        ? 'font-semibold text-red-700'
                        : 'text-slate-600'
                    }
                  >
                    {livePrediction.p_bunch >= config.alert_probability_threshold
                      ? 'Triggered'
                      : 'Monitoring'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Ground Truth</span>
                  <span
                    className={
                      activeSample.labels[horizonK] === 1
                        ? 'font-semibold text-red-700'
                        : 'font-semibold text-emerald-700'
                    }
                  >
                    {activeSample.labels[horizonK] === 1
                      ? `Bunches in ${(activeSample.lead_time_min[horizonK] ?? 0).toFixed(1)} min`
                      : 'No bunching'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
