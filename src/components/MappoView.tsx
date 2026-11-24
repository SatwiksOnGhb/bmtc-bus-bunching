import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ProjectConfig } from '../common/config';
import { estimateCommuterImpact } from '../common/kpis';
import { runAllBaselinesComparison } from '../control/baselines';
import {
  getTrainedMarlSuite,
  MappoHoldingPolicy,
  runIntegratedMarlEpisode,
  type MarlVariantId,
} from '../control/mappo';
import { CORRIDOR_LIST, getCorridor } from '../data/corridors';
import { getProductionPredictor } from '../predict/predictor';

interface MappoViewProps {
  config: ProjectConfig;
}

const HOUR_OPTIONS = [
  { hour: 9, label: '09:00 AM Peak' },
  { hour: 18, label: '18:00 PM Peak' },
  { hour: 13, label: '13:00 Midday' },
];

export function MappoView({ config }: MappoViewProps) {
  const [routeId, setRouteId] = useState<string>('500D');
  const [hour, setHour] = useState<number>(9);
  const [seed, setSeed] = useState<number>(config.default_seed);
  const [retrainNonce, setRetrainNonce] = useState<number>(0);

  // Interactive Shared-Actor Policy Inspector state
  const [probeFwdRatio, setProbeFwdRatio] = useState<number>(0.55);
  const [probeBwdRatio, setProbeBwdRatio] = useState<number>(1.25);
  const [probeLoad, setProbeLoad] = useState<number>(28);
  const [probePBunch, setProbePBunch] = useState<number>(0.78);

  const corridor = useMemo(() => getCorridor(routeId), [routeId]);
  const predictor = useMemo(() => getProductionPredictor(config, 5), [config]);
  const trainedSuite = useMemo(
    () => getTrainedMarlSuite(config, retrainNonce),
    [config, retrainNonce],
  );

  const baselines = useMemo(
    () =>
      runAllBaselinesComparison({
        config,
        routeId,
        hour,
        seed,
        scenario: 'normal',
        horizonMinutes: 110,
      }),
    [config, routeId, hour, seed],
  );

  const marlResults = useMemo(() => {
    const variants: MarlVariantId[] = ['ippo', 'mappo_nopred', 'mappo_pred'];
    return variants.map((v) =>
      runIntegratedMarlEpisode({
        variant: v,
        weights: trainedSuite[v].weights,
        predictor,
        config,
        seed,
        options: { route_id: routeId, hour, scenario: 'normal', dwellFeedback: true },
        horizonMinutes: 110,
      }),
    );
  }, [trainedSuite, predictor, config, seed, routeId, hour]);

  const scheduleEval = baselines.find((b) => b.policy_id === 'schedule') ?? baselines[1];
  const daganzoEval = baselines.find((b) => b.policy_id === 'daganzo') ?? baselines[2];
  const mappoPredEval =
    marlResults.find((m) => m.policy_id === 'mappo_pred') ?? marlResults[2];
  const mappoNoPredEval =
    marlResults.find((m) => m.policy_id === 'mappo_nopred') ?? marlResults[1];

  const impactVsSchedule = useMemo(
    () => estimateCommuterImpact(mappoPredEval.kpis, scheduleEval.kpis, corridor),
    [mappoPredEval.kpis, scheduleEval.kpis, corridor],
  );
  const impactVsDaganzo = useMemo(
    () => estimateCommuterImpact(mappoPredEval.kpis, daganzoEval.kpis, corridor),
    [mappoPredEval.kpis, daganzoEval.kpis, corridor],
  );
  const predAblationDeltaCv = Number(
    (mappoNoPredEval.kpis.headway_cv - mappoPredEval.kpis.headway_cv).toFixed(3),
  );

  const allPoliciesTable = useMemo(
    () => [...baselines, ...marlResults],
    [baselines, marlResults],
  );

  // Interactive shared-actor softmax probe (MAPPO + Predictions vs MAPPO w/o Predictions)
  const actorProbe = useMemo(() => {
    const schedHw = mappoPredEval.scheduledHeadwayS;
    const obs = {
      bus_id: `${routeId}-B04`,
      route_id: routeId,
      stop_idx: 7,
      fwd_headway_s: Math.round(probeFwdRatio * schedHw),
      bwd_headway_s: Math.round(probeBwdRatio * schedHw),
      sched_dev_s: 25,
      load: probeLoad,
      waiting_at_stop: 12,
      p_bunch: probePBunch,
    };
    const withPredPolicy = new MappoHoldingPolicy({
      variant: 'mappo_pred',
      weights: trainedSuite.mappo_pred.weights,
      scheduledHeadwayS: schedHw,
      config,
    });
    const noPredPolicy = new MappoHoldingPolicy({
      variant: 'mappo_nopred',
      weights: trainedSuite.mappo_nopred.weights,
      scheduledHeadwayS: schedHw,
      config,
    });
    return {
      withPredProbs: withPredPolicy.getActionProbabilities(obs),
      noPredProbs: noPredPolicy.getActionProbabilities(obs),
      withPredAction: config.hold_actions_s[withPredPolicy.act({ [obs.bus_id]: obs })[obs.bus_id]],
      noPredAction: config.hold_actions_s[noPredPolicy.act({ [obs.bus_id]: obs })[obs.bus_id]],
    };
  }, [
    mappoPredEval.scheduledHeadwayS,
    routeId,
    probeFwdRatio,
    probeBwdRatio,
    probeLoad,
    probePBunch,
    trainedSuite,
    config,
  ]);

  // SVG Training Curve Geometry (Headway CV over 10 PPO updates)
  const curveChart = useMemo(() => {
    const w = 540;
    const h = 235;
    const padL = 46;
    const padR = 18;
    const padT = 18;
    const padB = 34;

    const histories = [
      trainedSuite.mappo_pred.training_history,
      trainedSuite.mappo_nopred.training_history,
      trainedSuite.ippo.training_history,
    ];
    const allCvs = histories.flat().map((e) => e.headway_cv);
    const minY = Math.max(0.05, Math.floor((Math.min(...allCvs) - 0.04) * 20) / 20);
    const maxY = Math.ceil((Math.max(...allCvs) + 0.04) * 20) / 20;
    const nPts = Math.max(2, histories[0].length);

    const xAt = (idx: number) => padL + (idx / (nPts - 1)) * (w - padL - padR);
    const yAt = (cv: number) =>
      padT + ((maxY - cv) / Math.max(0.05, maxY - minY)) * (h - padT - padB);

    const makePath = (hist: typeof histories[0]) =>
      hist
        .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yAt(pt.headway_cv).toFixed(1)}`)
        .join(' ');

    return {
      w,
      h,
      padL,
      padR,
      padT,
      padB,
      minY,
      maxY,
      xAt,
      yAt,
      pathMappoPred: makePath(histories[0]),
      pathMappoNoPred: makePath(histories[1]),
      pathIppo: makePath(histories[2]),
      ticksY: [minY, (minY + maxY) / 2, maxY],
    };
  }, [trainedSuite]);

  return (
    <div className="space-y-8">
      {/* Control Toolbar */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {CORRIDOR_LIST.map((c) => (
              <button
                key={c.route_id}
                type="button"
                onClick={() => setRouteId(c.route_id)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  routeId === c.route_id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {c.route_id}
                {c.split === 'held_out_transfer' ? ' (Zero-Shot)' : ''}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {HOUR_OPTIONS.map((opt) => (
              <button
                key={opt.hour}
                type="button"
                onClick={() => setHour(opt.hour)}
                className={`px-2.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  hour === opt.hour
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {config.evaluation_seeds.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSeed(s)}
                className={`px-2.5 py-1.5 text-xs font-mono font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  seed === s
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Seed {s}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setRetrainNonce((n) => n + 1)}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Re-run Event-Driven PPO
        </button>
      </div>

      {/* 4-Column Headline Gate 3 Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">MAPPO + Predictions CV</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {mappoPredEval.kpis.headway_cv.toFixed(3)}
          </div>
          <div className="text-xs text-emerald-700 mt-1 tabular-nums">
            {impactVsSchedule.cv_reduction_pct >= 0 ? '−' : '+'}
            {Math.abs(impactVsSchedule.cv_reduction_pct).toFixed(1)}% vs Schedule ·{' '}
            {impactVsDaganzo.cv_reduction_pct >= 0 ? '−' : '+'}
            {Math.abs(impactVsDaganzo.cv_reduction_pct).toFixed(1)}% vs Daganzo
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Headline Prediction Ablation</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {mappoPredEval.kpis.bunched_pct.toFixed(1)}% bunched
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            vs {mappoNoPredEval.kpis.bunched_pct.toFixed(1)}% w/o pred (ΔCV{' '}
            {predAblationDeltaCv >= 0 ? '−' : '+'}
            {Math.abs(predAblationDeltaCv).toFixed(3)})
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Mean Wait / In-Veh Hold</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {mappoPredEval.kpis.mean_wait_min.toFixed(2)} min
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            In-vehicle hold: +{mappoPredEval.kpis.in_vehicle_hold_s_per_pax.toFixed(1)}s / pax (λ={config.mappo_hold_penalty_lambda})
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Daily Commuter Savings</div>
          <div
            className={`text-xl font-semibold mt-1 tabular-nums ${
              impactVsSchedule.daily_pax_hours_saved >= 0
                ? 'text-emerald-700'
                : 'text-amber-700'
            }`}
          >
            {impactVsSchedule.daily_pax_hours_saved >= 0 ? '+' : ''}
            {impactVsSchedule.daily_pax_hours_saved.toFixed(0)} pax-hrs/day
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            vs Schedule-Based on {routeId} ({corridor.fleet_size} buses)
          </div>
        </div>
      </div>

      {/* Full 7-Policy Benchmark & Headline Ablation Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Gate 3 Full-Loop Benchmark: MAPPO + Predictions vs. Ablations &amp; Rule Baselines
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Route {routeId} ({corridor.split === 'held_out_transfer' ? 'unseen held-out zero-shot transfer corridor' : 'training corridor'}) · Seed {seed} · {String(hour).padStart(2, '0')}:00 IST. Same traffic &amp; passenger seed across all 7 rows.
            </p>
          </div>
          <span className="text-xs font-mono text-slate-500 shrink-0">
            Discount γ = {config.mappo_discount_per_min}/min
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                <th className="py-2.5 px-5">Controller</th>
                <th className="py-2.5 px-3 text-right">Headway CV</th>
                <th className="py-2.5 px-3 text-right">% Bunched</th>
                <th className="py-2.5 px-3 text-right">Mean Wait</th>
                <th className="py-2.5 px-3 text-right">In-Veh Delay</th>
                <th className="py-2.5 px-3 text-right">Avg Hold</th>
                <th className="py-2.5 px-5 text-right">Pax-Hrs Saved / Day</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {allPoliciesTable.map((ev) => {
                const rowImpact = estimateCommuterImpact(ev.kpis, scheduleEval.kpis, corridor);
                const isHeadline = ev.policy_id === 'mappo_pred';
                return (
                  <tr
                    key={ev.policy_id}
                    className={isHeadline ? 'bg-blue-50/50' : 'hover:bg-slate-50'}
                  >
                    <td className="py-3.5 px-5">
                      <div className="font-medium text-slate-900">{ev.policy_name}</div>
                      <div className="text-xs text-slate-500 mt-0.5">{ev.description}</div>
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                      {ev.kpis.headway_cv.toFixed(3)}
                    </td>
                    <td
                      className={`py-3.5 px-3 text-right font-mono tabular-nums font-medium ${
                        ev.kpis.bunched_pct >= 10
                          ? 'text-red-700'
                          : ev.kpis.bunched_pct <= 3
                          ? 'text-emerald-700'
                          : 'text-amber-700'
                      }`}
                    >
                      {ev.kpis.bunched_pct.toFixed(1)}%
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-800">
                      {ev.kpis.mean_wait_min.toFixed(2)} min
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-700">
                      +{ev.kpis.in_vehicle_hold_s_per_pax.toFixed(1)}s
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-700">
                      {ev.kpis.mean_hold_s.toFixed(1)}s
                    </td>
                    <td
                      className={`py-3.5 px-5 text-right font-mono tabular-nums font-medium ${
                        ev.policy_id === 'schedule'
                          ? 'text-slate-500'
                          : rowImpact.daily_pax_hours_saved > 0
                          ? 'text-emerald-700'
                          : 'text-red-700'
                      }`}
                    >
                      {ev.policy_id === 'schedule'
                        ? 'Baseline (0)'
                        : `${rowImpact.daily_pax_hours_saved >= 0 ? '+' : ''}${rowImpact.daily_pax_hours_saved.toFixed(0)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Learning Curves & Interactive Shared Actor Inspector */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
        {/* PPO Event-Driven Training Learning Curves */}
        <div className="xl:col-span-6 bg-white border border-slate-200 rounded-lg p-5 flex flex-col justify-between">
          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Event-Driven PPO Convergence (Headway CV over Updates)
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Trained asynchronously on 500D &amp; 335E with elapsed-time discounting γ^(Δt/60).
                </p>
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-600">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-0.5 bg-blue-700 inline-block" />
                  MAPPO+Pred
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-0.5 border-t border-dashed border-slate-600 inline-block" />
                  MAPPO w/o Pred
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-0.5 border-t border-dashed border-amber-600 inline-block" />
                  IPPO
                </span>
              </div>
            </div>

            <svg
              viewBox={`0 0 ${curveChart.w} ${curveChart.h}`}
              className="w-full h-auto"
              role="img"
              aria-label="PPO training headway CV convergence curves"
            >
              {curveChart.ticksY.map((val, idx) => {
                const y = curveChart.yAt(val);
                return (
                  <g key={idx}>
                    <line
                      x1={curveChart.padL}
                      x2={curveChart.w - curveChart.padR}
                      y1={y}
                      y2={y}
                      stroke="#f1f5f9"
                      strokeWidth="1"
                    />
                    <text
                      x={curveChart.padL - 8}
                      y={y + 3.5}
                      textAnchor="end"
                      fontSize="9.5"
                      fill="#64748b"
                      className="font-mono"
                    >
                      {val.toFixed(2)}
                    </text>
                  </g>
                );
              })}

              {trainedSuite.mappo_pred.training_history.map((pt, i) => (
                <text
                  key={pt.update}
                  x={curveChart.xAt(i)}
                  y={curveChart.h - 12}
                  textAnchor="middle"
                  fontSize="9.5"
                  fill="#64748b"
                  className="font-mono"
                >
                  U{pt.update}
                </text>
              ))}

              <line
                x1={curveChart.padL}
                x2={curveChart.padL}
                y1={curveChart.padT}
                y2={curveChart.h - curveChart.padB}
                stroke="#cbd5e1"
                strokeWidth="1.2"
              />
              <line
                x1={curveChart.padL}
                x2={curveChart.w - curveChart.padR}
                y1={curveChart.h - curveChart.padB}
                y2={curveChart.h - curveChart.padB}
                stroke="#cbd5e1"
                strokeWidth="1.2"
              />

              <path
                d={curveChart.pathIppo}
                fill="none"
                stroke="#d97706"
                strokeWidth="1.6"
                strokeDasharray="4 3"
              />
              <path
                d={curveChart.pathMappoNoPred}
                fill="none"
                stroke="#475569"
                strokeWidth="1.8"
                strokeDasharray="5 3"
              />
              <path
                d={curveChart.pathMappoPred}
                fill="none"
                stroke="#1d4ed8"
                strokeWidth="2.3"
              />

              {trainedSuite.mappo_pred.training_history.map((pt, i) => (
                <circle
                  key={pt.update}
                  cx={curveChart.xAt(i)}
                  cy={curveChart.yAt(pt.headway_cv)}
                  r="3.2"
                  fill="#1d4ed8"
                  stroke="#ffffff"
                  strokeWidth="1.2"
                />
              ))}
            </svg>
          </div>

          <div className="pt-3 border-t border-slate-200 flex flex-wrap justify-between gap-2 text-xs text-slate-600 font-mono tabular-nums">
            <span>
              Final entropy:{' '}
              {trainedSuite.mappo_pred.training_history.at(-1)?.policy_entropy.toFixed(2)}
            </span>
            <span>
              Critic MSE:{' '}
              {trainedSuite.mappo_pred.training_history.at(-1)?.critic_loss.toFixed(3)}
            </span>
            <span>Lower CV = steadier headways</span>
          </div>
        </div>

        {/* Interactive Shared-Actor Policy Decision Probe */}
        <div className="xl:col-span-6 bg-white border border-slate-200 rounded-lg p-5 space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Interactive Shared-Actor Policy Inspector
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Adjust live bus state features to see how calibrated p(bunch) shifts MAPPO&apos;s discrete hold probabilities compared to the no-prediction ablation.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <label className="block">
              <div className="flex justify-between text-slate-700 mb-1">
                <span>Forward Gap / Sched.</span>
                <span className="font-mono tabular-nums">{probeFwdRatio.toFixed(2)}×</span>
              </div>
              <input
                type="range"
                min="0.2"
                max="1.4"
                step="0.05"
                value={probeFwdRatio}
                onChange={(e) => setProbeFwdRatio(Number(e.target.value))}
                className="w-full accent-blue-700"
              />
            </label>

            <label className="block">
              <div className="flex justify-between text-slate-700 mb-1">
                <span>Backward Gap / Sched.</span>
                <span className="font-mono tabular-nums">{probeBwdRatio.toFixed(2)}×</span>
              </div>
              <input
                type="range"
                min="0.3"
                max="1.8"
                step="0.05"
                value={probeBwdRatio}
                onChange={(e) => setProbeBwdRatio(Number(e.target.value))}
                className="w-full accent-blue-700"
              />
            </label>

            <label className="block">
              <div className="flex justify-between text-slate-700 mb-1">
                <span>Onboard Passengers</span>
                <span className="font-mono tabular-nums">
                  {probeLoad} / {config.bus_capacity}
                </span>
              </div>
              <input
                type="range"
                min="0"
                max={config.bus_capacity}
                step="1"
                value={probeLoad}
                onChange={(e) => setProbeLoad(Number(e.target.value))}
                className="w-full accent-blue-700"
              />
            </label>

            <label className="block">
              <div className="flex justify-between text-slate-700 mb-1">
                <span>Predictor p(bunch)</span>
                <span className="font-mono tabular-nums font-semibold text-blue-700">
                  {(probePBunch * 100).toFixed(0)}%
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.02"
                value={probePBunch}
                onChange={(e) => setProbePBunch(Number(e.target.value))}
                className="w-full accent-blue-700"
              />
            </label>
          </div>

          <div className="pt-3 border-t border-slate-200 space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-700">
                Action Distribution π(hold | obs)
              </span>
              <span className="font-mono text-slate-600 tabular-nums">
                MAPPO+Pred: <strong className="text-blue-700">{actorProbe.withPredAction}s</strong> · w/o Pred:{' '}
                <strong className="text-slate-900">{actorProbe.noPredAction}s</strong>
              </span>
            </div>

            {config.hold_actions_s.map((holdSec, idx) => {
              const pWith = actorProbe.withPredProbs[idx] ?? 0;
              const pWithout = actorProbe.noPredProbs[idx] ?? 0;
              return (
                <div key={holdSec} className="grid grid-cols-12 items-center gap-2 text-xs">
                  <span className="col-span-2 font-mono text-slate-700 tabular-nums">
                    {holdSec}s
                  </span>
                  <div className="col-span-7 space-y-1">
                    <div className="h-2 bg-slate-100 rounded-xs overflow-hidden">
                      <div
                        style={{ width: `${Math.round(pWith * 100)}%` }}
                        className="h-full bg-blue-700 transition-all duration-150"
                      />
                    </div>
                    <div className="h-1.5 bg-slate-100 rounded-xs overflow-hidden">
                      <div
                        style={{ width: `${Math.round(pWithout * 100)}%` }}
                        className="h-full bg-slate-400 transition-all duration-150"
                      />
                    </div>
                  </div>
                  <span className="col-span-3 text-right font-mono tabular-nums text-slate-600">
                    {(pWith * 100).toFixed(0)}% / {(pWithout * 100).toFixed(0)}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
