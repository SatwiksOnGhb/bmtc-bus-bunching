import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import type { ProjectConfig } from '../common/config';
import { CORRIDOR_LIST } from '../data/corridors';
import type { ScenarioName } from '../sim/scenarios';
import {
  BENCHMARK_SCENARIOS,
  runMultiSeedBenchmark,
  runZeroShotTransferStudy,
  serializeEvaluationCsv,
  serializeEvaluationJson,
  type AggregatedPolicyRow,
  type EvalPolicyId,
  type MultiSeedBenchmarkReport,
} from './benchmarkHarness';

interface AblationEvalViewProps {
  config: ProjectConfig;
}

type ScenarioFilter = 'all' | ScenarioName;

const CHART_POLICIES: Array<{ id: EvalPolicyId; label: string; color: string }> = [
  { id: 'schedule', label: 'Schedule (Current)', color: '#94A3B8' },
  { id: 'daganzo', label: 'Daganzo (2009)', color: '#64748B' },
  { id: 'ippo', label: 'IPPO', color: '#D97706' },
  { id: 'mappo_nopred', label: 'MAPPO w/o Pred', color: '#60A5FA' },
  { id: 'mappo_pred', label: 'MAPPO + Pred', color: '#1D4ED8' },
];

function triggerBrowserDownload(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function AblationGroupedChart({ report }: { report: MultiSeedBenchmarkReport }) {
  const width = 760;
  const height = 250;
  const pad = { top: 20, right: 20, bottom: 40, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const scenarios: Array<{ id: ScenarioName; label: string }> = [
    { id: 'normal', label: 'Normal Peak (09:00)' },
    { id: 'rain', label: 'Monsoon Rain' },
    { id: 'breakdown', label: 'Bus Breakdown' },
  ];

  const allVals = BENCHMARK_SCENARIOS.flatMap((sc) =>
    report.byScenario[sc]
      .filter((r) => CHART_POLICIES.some((cp) => cp.id === r.policy_id))
      .map((r) => r.headway_cv.mean + r.headway_cv.std),
  );
  const maxCv = Math.max(0.45, Math.ceil(Math.max(...allVals, 0.4) * 10) / 10 + 0.05);

  const yScale = (v: number) => pad.top + plotH - (Math.min(maxCv, v) / maxCv) * plotH;
  const groupW = plotW / scenarios.length;
  const barW = Math.min(30, (groupW - 44) / CHART_POLICIES.length);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Headline Multi-Seed Ablation: Headway CV (Mean ± 1 SD across Seeds 42, 108, 256)
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Lower is better. Directly isolates the contribution of centralized critics (MAPPO vs IPPO) and calibrated bunching predictions (MAPPO + Pred vs MAPPO w/o Pred).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-600">
          {CHART_POLICIES.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs inline-block" style={{ backgroundColor: p.color }} />
              {p.label}
            </span>
          ))}
        </div>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto block">
        {[0, 0.25, 0.5, 0.75, 1.0].map((frac) => {
          const val = maxCv * frac;
          const y = yScale(val);
          return (
            <g key={frac}>
              <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke="#E2E8F0" strokeWidth="1" />
              <text x={pad.left - 8} y={y + 3} textAnchor="end" className="fill-slate-400 text-[10px] font-mono">
                {val.toFixed(2)}
              </text>
            </g>
          );
        })}

        {scenarios.map((sc, gIdx) => {
          const groupStartX = pad.left + gIdx * groupW + (groupW - CHART_POLICIES.length * (barW + 4)) / 2;
          const rows = report.byScenario[sc.id];

          return (
            <g key={sc.id}>
              {CHART_POLICIES.map((cp, bIdx) => {
                const row = rows.find((r) => r.policy_id === cp.id);
                if (!row) return null;
                const x = groupStartX + bIdx * (barW + 4);
                const y = yScale(row.headway_cv.mean);
                const barH = Math.max(1, pad.top + plotH - y);
                const errTop = yScale(row.headway_cv.mean + row.headway_cv.std);
                const errBot = yScale(Math.max(0, row.headway_cv.mean - row.headway_cv.std));

                return (
                  <g key={cp.id}>
                    <rect
                      x={x}
                      y={y}
                      width={barW}
                      height={barH}
                      rx="2"
                      fill={cp.color}
                    >
                      <title>{`${sc.label} · ${row.policy_name}: CV ${row.headway_cv.mean.toFixed(3)} ± ${row.headway_cv.std.toFixed(3)}`}</title>
                    </rect>
                    {/* ±1 SD Whisker */}
                    <line
                      x1={x + barW / 2}
                      x2={x + barW / 2}
                      y1={errTop}
                      y2={errBot}
                      stroke="#0F172A"
                      strokeWidth="1.2"
                    />
                    <line
                      x1={x + barW / 2 - 3}
                      x2={x + barW / 2 + 3}
                      y1={errTop}
                      y2={errTop}
                      stroke="#0F172A"
                      strokeWidth="1.2"
                    />
                    <line
                      x1={x + barW / 2 - 3}
                      x2={x + barW / 2 + 3}
                      y1={errBot}
                      y2={errBot}
                      stroke="#0F172A"
                      strokeWidth="1.2"
                    />
                  </g>
                );
              })}

              <text
                x={pad.left + gIdx * groupW + groupW / 2}
                y={height - 12}
                textAnchor="middle"
                className="fill-slate-700 text-[11px] font-medium"
              >
                {sc.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function BenchmarkMatrixTable({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle: string;
  rows: AggregatedPolicyRow[];
}) {
  const bestCv = Math.min(...rows.map((r) => r.headway_cv.mean));

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
        </div>
        <span className="text-xs font-mono text-slate-500 tabular-nums">
          Mean ± SD · Lower CV &amp; Wait better
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
              <th className="py-2.5 px-5">Controller</th>
              <th className="py-2.5 px-4 text-right">Headway CV</th>
              <th className="py-2.5 px-4 text-right">Bunched (%)</th>
              <th className="py-2.5 px-4 text-right">Mean Wait (min)</th>
              <th className="py-2.5 px-4 text-right">Avg Hold (s)</th>
              <th className="py-2.5 px-4 text-right">In-Veh Delay (m)</th>
              <th className="py-2.5 px-4 text-right">Trip Time (m)</th>
              <th className="py-2.5 px-5 text-right">Pax-Hrs Saved / Day</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 text-xs tabular-nums">
            {rows.map((r) => {
              const isBest = r.headway_cv.mean === bestCv;
              const isFull = r.policy_id === 'mappo_pred';
              return (
                <tr
                  key={r.policy_id}
                  className={isFull ? 'bg-blue-50/50 font-medium' : 'hover:bg-slate-50/70'}
                >
                  <td className="py-3 px-5">
                    <div className="text-slate-900 font-medium flex items-center gap-2">
                      <span>{r.policy_name}</span>
                      {isBest && (
                        <span className="text-[10px] font-mono text-emerald-700">Best CV</span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500">{r.category}</div>
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-900">
                    {r.headway_cv.mean.toFixed(3)}{' '}
                    <span className="text-slate-400">± {r.headway_cv.std.toFixed(3)}</span>
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-900">
                    {r.bunched_pct.mean.toFixed(1)}%{' '}
                    <span className="text-slate-400">± {r.bunched_pct.std.toFixed(1)}</span>
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-900">
                    {r.mean_wait_min.mean.toFixed(2)}{' '}
                    <span className="text-slate-400">± {r.mean_wait_min.std.toFixed(2)}</span>
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-700">
                    {r.mean_hold_s.mean.toFixed(1)}s
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-700">
                    {r.in_vehicle_hold_min.mean.toFixed(2)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-700">
                    {r.mean_trip_time_min.mean.toFixed(1)}
                  </td>
                  <td
                    className={`py-3 px-5 text-right font-mono font-semibold ${
                      r.daily_pax_hours_saved.mean > 0
                        ? 'text-emerald-700'
                        : r.daily_pax_hours_saved.mean < 0
                        ? 'text-red-700'
                        : 'text-slate-500'
                    }`}
                  >
                    {r.policy_id === 'schedule'
                      ? 'Baseline (0)'
                      : `${r.daily_pax_hours_saved.mean >= 0 ? '+' : ''}${r.daily_pax_hours_saved.mean.toFixed(0)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AblationEvalView({ config }: AblationEvalViewProps) {
  const [routeId, setRouteId] = useState<string>('500D');
  const [scenarioFilter, setScenarioFilter] = useState<ScenarioFilter>('all');

  const benchmark = useMemo(
    () => runMultiSeedBenchmark(routeId, config),
    [routeId, config],
  );
  const transfer = useMemo(
    () => runZeroShotTransferStudy(config),
    [config],
  );

  const activeRows =
    scenarioFilter === 'all' ? benchmark.overallAverage : benchmark.byScenario[scenarioFilter];

  const handleDownloadCsv = () => {
    const csv = serializeEvaluationCsv(benchmark, transfer);
    triggerBrowserDownload(`bmtc_eval_${routeId}_3seed.csv`, csv, 'text/csv;charset=utf-8');
  };

  const handleDownloadJson = () => {
    const json = serializeEvaluationJson(benchmark, transfer);
    triggerBrowserDownload(`bmtc_eval_${routeId}_3seed.json`, json, 'application/json;charset=utf-8');
  };

  const maxFleetCv = Math.max(
    0.45,
    ...transfer.fleetScaling.map((f) => Math.max(f.schedule_cv, f.daganzo_cv, f.mappo_pred_cv) * 1.15),
  );

  return (
    <div className="space-y-6">
      {/* Controls & Export Bar */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Benchmark Corridor</span>
            <select
              value={routeId}
              onChange={(e) => setRouteId(e.target.value)}
              className="mt-1 block rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900"
            >
              {CORRIDOR_LIST.map((c) => (
                <option key={c.route_id} value={c.route_id}>
                  {c.route_id} · {c.corridor_name}
                </option>
              ))}
            </select>
          </label>

          <div>
            <span className="text-xs font-medium text-slate-600 block mb-1">Table Scenario Slice</span>
            <div className="flex items-center border border-slate-200 rounded-md overflow-hidden text-xs">
              {(
                [
                  { id: 'all', label: 'All 3 Scenarios (9 runs)' },
                  { id: 'normal', label: 'Normal' },
                  { id: 'rain', label: 'Monsoon Rain' },
                  { id: 'breakdown', label: 'Breakdown' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setScenarioFilter(tab.id)}
                  className={`px-3 py-1.5 font-medium transition-colors whitespace-nowrap ${
                    scenarioFilter === tab.id
                      ? 'bg-slate-900 text-white'
                      : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleDownloadCsv}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>
          <button
            type="button"
            onClick={handleDownloadJson}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Export JSON Report
          </button>
        </div>
      </div>

      {/* 4-Column Headline Impact KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">MAPPO + Pred vs Schedule (3 Seeds)</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            −{benchmark.headline.cv_reduction_vs_schedule_pct.toFixed(1)}% CV
          </div>
          <div className="text-xs text-emerald-700 mt-1 tabular-nums">
            CV {benchmark.headline.schedule_cv_mean.toFixed(3)} → {benchmark.headline.mappo_pred_cv_mean.toFixed(3)} · −{benchmark.headline.bunched_drop_vs_schedule_pp.toFixed(1)} pp bunched
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Headline Prediction Ablation Lift</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {benchmark.headline.pred_ablation_cv_gain_pct >= 0 ? '−' : '+'}
            {Math.abs(benchmark.headline.pred_ablation_cv_gain_pct).toFixed(1)}% CV
          </div>
          <div className="text-xs text-blue-700 mt-1 tabular-nums">
            MAPPO w/o Pred {benchmark.headline.mappo_nopred_cv_mean.toFixed(3)} → +Pred {benchmark.headline.mappo_pred_cv_mean.toFixed(3)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Zero-Shot Transfer (Held-Out G-4)</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            −{transfer.cv_reduction_vs_schedule_pct.toFixed(1)}% CV
          </div>
          <div className="text-xs text-emerald-700 mt-1 tabular-nums">
            Unseen route · 0 retraining · +{transfer.daily_pax_hours_saved.toFixed(0)} pax-hrs/day
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Simulated Commuter Savings ({routeId})</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {benchmark.headline.daily_pax_hours_saved_vs_schedule >= 0 ? '+' : ''}
            {benchmark.headline.daily_pax_hours_saved_vs_schedule.toFixed(0)} pax-hrs/day
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Avg across Normal, Rain &amp; Breakdown
          </div>
        </div>
      </div>

      {/* Grouped Bar Chart with ±1 SD Error Bars */}
      <AblationGroupedChart report={benchmark} />

      {/* Full 7-Policy Benchmark Matrix */}
      <BenchmarkMatrixTable
        title={`7-Policy × 3-Seed Benchmark Matrix · Route ${benchmark.route_id} (${scenarioFilter === 'all' ? 'All 3 Scenarios Combined' : scenarioFilter})`}
        subtitle={`Evaluated across deterministic seeds [${benchmark.seeds.join(', ')}] with identical traffic & passenger draws per seed.`}
        rows={activeRows}
      />

      {/* Zero-Shot Transfer Study on Held-Out Route G-4 + Fleet-Size Generalization */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-7">
          <BenchmarkMatrixTable
            title="Zero-Shot Transfer: Held-Out BMTC Route G-4 (Brigade Rd → Bannerghatta NP)"
            subtitle="Shared-actor MAPPO trained strictly on 500D & 335E evaluated cold on G-4 across seeds [42, 108, 256]."
            rows={transfer.rows}
          />
        </div>

        <div className="xl:col-span-5 bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Fleet-Size Generalization on Held-Out G-4 (7 to 15 Buses)
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Because every bus shares the same actor π_θ(a_i | o_i), the controller scales seamlessly to any fleet size without retraining.
            </p>
          </div>

          <svg viewBox="0 0 420 190" className="w-full h-auto block">
            {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
              const val = maxFleetCv * frac;
              const y = 16 + (1 - frac) * 134;
              return (
                <g key={frac}>
                  <line x1="38" x2="404" y1={y} y2={y} stroke="#E2E8F0" strokeWidth="1" />
                  <text x="32" y={y + 3} textAnchor="end" className="fill-slate-400 text-[9.5px] font-mono">
                    {val.toFixed(2)}
                  </text>
                </g>
              );
            })}

            {(['schedule_cv', 'daganzo_cv', 'mappo_pred_cv'] as const).map((key) => {
              const color =
                key === 'schedule_cv' ? '#94A3B8' : key === 'daganzo_cv' ? '#64748B' : '#1D4ED8';
              const d = transfer.fleetScaling
                .map((pt, i) => {
                  const x = 66 + (i / Math.max(1, transfer.fleetScaling.length - 1)) * 310;
                  const y = 16 + (1 - Math.min(maxFleetCv, pt[key]) / maxFleetCv) * 134;
                  return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
                })
                .join(' ');
              return <path key={key} d={d} fill="none" stroke={color} strokeWidth={key === 'mappo_pred_cv' ? 2.5 : 1.75} />;
            })}

            {transfer.fleetScaling.map((pt, i) => {
              const x = 66 + (i / Math.max(1, transfer.fleetScaling.length - 1)) * 310;
              const ySched = 16 + (1 - Math.min(maxFleetCv, pt.schedule_cv) / maxFleetCv) * 134;
              const yPred = 16 + (1 - Math.min(maxFleetCv, pt.mappo_pred_cv) / maxFleetCv) * 134;
              return (
                <g key={pt.fleet_size}>
                  <circle cx={x} cy={ySched} r="3" fill="#94A3B8" />
                  <circle cx={x} cy={yPred} r="3.5" fill="#1D4ED8" />
                  <text x={x} y="174" textAnchor="middle" className="fill-slate-600 text-[10px] font-mono">
                    {pt.fleet_size} buses
                  </text>
                </g>
              );
            })}
          </svg>

          <div className="overflow-x-auto border-t border-slate-200 pt-3">
            <table className="w-full text-left border-collapse text-xs tabular-nums">
              <thead>
                <tr className="text-slate-500 border-b border-slate-200">
                  <th className="py-1.5 pr-2">Fleet</th>
                  <th className="py-1.5 px-2 text-right">Schedule CV</th>
                  <th className="py-1.5 px-2 text-right">MAPPO+Pred CV</th>
                  <th className="py-1.5 pl-2 text-right">Pax-Hrs/Day</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {transfer.fleetScaling.map((pt) => (
                  <tr key={pt.fleet_size}>
                    <td className="py-1.5 pr-2 font-mono text-slate-900">{pt.fleet_size} buses</td>
                    <td className="py-1.5 px-2 text-right font-mono text-slate-600">
                      {pt.schedule_cv.toFixed(3)}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono font-semibold text-blue-700">
                      {pt.mappo_pred_cv.toFixed(3)}
                    </td>
                    <td className="py-1.5 pl-2 text-right font-mono text-emerald-700">
                      {pt.daily_pax_hours_saved >= 0 ? '+' : ''}
                      {pt.daily_pax_hours_saved}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Honest Simulation Framing Note (PDF Page 11) */}
      <div className="bg-white border border-slate-200 rounded-lg px-5 py-3.5 text-xs text-slate-600 leading-relaxed">
        <strong className="text-slate-900">Methodological Framing:</strong> All Headway CV, bunching rate, waiting time, and passenger-hour savings figures above are measured{' '}
        <span className="font-medium text-slate-900">in a calibrated digital-twin simulation of BMTC routes</span>{' '}
        (grounded in BMTC GTFS ODbL stop geometry and CNI 2022 GPS hourly speed profiles across seeds 42, 108, and 256). Real-world operational deployment would require field pilot calibration with live bus-mounted AVL feeds and driver HMI compliance checks.
      </div>
    </div>
  );
}
