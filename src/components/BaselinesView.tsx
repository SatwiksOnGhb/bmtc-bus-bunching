import { useMemo, useState } from 'react';
import type { ProjectConfig } from '../common/config';
import { estimateCommuterImpact } from '../common/kpis';
import {
  runAllBaselinesComparison,
  type BaselinePolicyId,
  type PolicyEpisodeEvaluation,
} from '../control/baselines';
import { CORRIDOR_LIST, getCorridor } from '../data/corridors';

interface BaselinesViewProps {
  config: ProjectConfig;
}

const HOUR_OPTIONS = [
  { hour: 9, label: '09:00 AM Peak' },
  { hour: 18, label: '18:00 PM Peak' },
  { hour: 13, label: '13:00 Midday' },
];

const HOLD_COLORS: Record<number, string> = {
  0: 'bg-slate-200',
  15: 'bg-sky-400',
  30: 'bg-blue-500',
  45: 'bg-blue-700',
  60: 'bg-amber-500',
  90: 'bg-red-600',
};

const LINE_PALETTE = [
  '#1d4ed8',
  '#0f766e',
  '#4338ca',
  '#0369a1',
  '#334155',
  '#6d28d9',
  '#047857',
  '#1e40af',
  '#475569',
  '#0284c7',
  '#15803d',
  '#3730a3',
];

function MiniTimeSpacePlot({
  evaluation,
  maxKm,
  title,
  subtitle,
}: {
  evaluation: PolicyEpisodeEvaluation;
  maxKm: number;
  title: string;
  subtitle: string;
}) {
  const w = 440;
  const h = 250;
  const padL = 44;
  const padR = 14;
  const padT = 14;
  const padB = 30;
  const maxMin = 110;

  const xAtSec = (sec: number) =>
    padL + (Math.min(maxMin * 60, sec) / (maxMin * 60)) * (w - padL - padR);
  const yAtKm = (km: number) =>
    h - padB - (km / Math.max(1, maxKm)) * (h - padT - padB);

  const trajectories = useMemo(() => {
    const map = new Map<string, { busNum: number; pts: Array<{ t: number; km: number }> }>();
    for (const ev of evaluation.events) {
      const key = `${ev.bus_id}#${ev.trip_num}`;
      const entry = map.get(key) ?? { busNum: ev.bus_num, pts: [] };
      entry.pts.push({ t: ev.arrival_t, km: ev.cum_dist_km });
      map.set(key, entry);
    }
    return Array.from(map.entries());
  }, [evaluation.events]);

  const bunched = useMemo(
    () => evaluation.events.filter((e) => e.is_bunched),
    [evaluation.events],
  );

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
        </div>
        <div className="text-right font-mono text-xs tabular-nums shrink-0">
          <span className="text-slate-900 font-semibold">
            CV {evaluation.kpis.headway_cv.toFixed(3)}
          </span>
          <span className="text-slate-400 mx-1.5">·</span>
          <span
            className={
              evaluation.kpis.bunched_pct >= 10
                ? 'text-red-700 font-semibold'
                : 'text-emerald-700 font-semibold'
            }
          >
            {evaluation.kpis.bunched_pct.toFixed(1)}% bunched
          </span>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-auto"
        role="img"
        aria-label={`Time-space diagram for ${title}`}
      >
        {[0, 30, 60, 90].map((min) => {
          const x = xAtSec(min * 60);
          return (
            <g key={min}>
              <line
                x1={x}
                x2={x}
                y1={padT}
                y2={h - padB}
                stroke="#e2e8f0"
                strokeWidth="1"
              />
              <text
                x={x}
                y={h - 10}
                textAnchor="middle"
                fontSize="10"
                fill="#64748b"
                className="font-mono"
              >
                {min}m
              </text>
            </g>
          );
        })}

        {[0, 0.5, 1].map((frac) => {
          const km = maxKm * frac;
          const y = yAtKm(km);
          return (
            <g key={frac}>
              <line
                x1={padL}
                x2={w - padR}
                y1={y}
                y2={y}
                stroke="#f1f5f9"
                strokeWidth="1"
              />
              <text
                x={padL - 8}
                y={y + 3}
                textAnchor="end"
                fontSize="9.5"
                fill="#64748b"
                className="font-mono"
              >
                {km.toFixed(0)} km
              </text>
            </g>
          );
        })}

        <line x1={padL} x2={padL} y1={padT} y2={h - padB} stroke="#cbd5e1" strokeWidth="1" />
        <line x1={padL} x2={w - padR} y1={h - padB} y2={h - padB} stroke="#cbd5e1" strokeWidth="1" />

        {trajectories.map(([key, traj]) => {
          if (traj.pts.length < 2) return null;
          const sorted = [...traj.pts].sort((a, b) => a.t - b.t);
          const d = sorted
            .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${xAtSec(p.t).toFixed(1)} ${yAtKm(p.km).toFixed(1)}`)
            .join(' ');
          return (
            <path
              key={key}
              d={d}
              fill="none"
              stroke={LINE_PALETTE[(traj.busNum - 1) % LINE_PALETTE.length]}
              strokeWidth="1.5"
              strokeOpacity="0.82"
            />
          );
        })}

        {bunched.map((ev) => (
          <circle
            key={ev.event_idx}
            cx={xAtSec(ev.arrival_t)}
            cy={yAtKm(ev.cum_dist_km)}
            r="3"
            fill="#dc2626"
            stroke="#ffffff"
            strokeWidth="0.9"
          />
        ))}
      </svg>
    </div>
  );
}

export function BaselinesView({ config }: BaselinesViewProps) {
  const [routeId, setRouteId] = useState<string>('500D');
  const [hour, setHour] = useState<number>(9);
  const [seed, setSeed] = useState<number>(config.default_seed);
  const [selectedPolicyId, setSelectedPolicyId] =
    useState<BaselinePolicyId>('two_headway');

  const corridor = useMemo(() => getCorridor(routeId), [routeId]);
  const maxKm = corridor.stops[corridor.stops.length - 1].cum_dist_km;

  const evaluations = useMemo(
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

  const noControlEval =
    evaluations.find((e) => e.policy_id === 'no_control') ?? evaluations[0];
  const scheduleEval =
    evaluations.find((e) => e.policy_id === 'schedule') ?? evaluations[1];
  const selectedEval =
    evaluations.find((e) => e.policy_id === selectedPolicyId) ?? evaluations[3];

  // Reference is Schedule-Based Holding (Current Practice), or No Control when inspecting Schedule
  const referenceEval =
    selectedPolicyId === 'schedule' || selectedPolicyId === 'no_control'
      ? noControlEval
      : scheduleEval;

  const impact = useMemo(
    () => estimateCommuterImpact(selectedEval.kpis, referenceEval.kpis, corridor),
    [selectedEval.kpis, referenceEval.kpis, corridor],
  );

  return (
    <div className="space-y-8">
      {/* Control Bar */}
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

        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md shrink-0">
          {(['schedule', 'daganzo', 'two_headway'] as BaselinePolicyId[]).map((pid) => {
            const label =
              pid === 'schedule'
                ? 'Schedule'
                : pid === 'daganzo'
                ? 'Daganzo (2009)'
                : 'Two-Headway';
            return (
              <button
                key={pid}
                type="button"
                onClick={() => setSelectedPolicyId(pid)}
                className={`px-2.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  selectedPolicyId === pid
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 4-Column Commuter Impact KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Headway CV ({selectedEval.policy_name})</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {selectedEval.kpis.headway_cv.toFixed(3)}
          </div>
          <div
            className={`text-xs mt-1 tabular-nums ${
              impact.cv_reduction_pct >= 0 ? 'text-emerald-700' : 'text-red-700'
            }`}
          >
            {impact.cv_reduction_pct >= 0 ? '−' : '+'}
            {Math.abs(impact.cv_reduction_pct).toFixed(1)}% vs {referenceEval.policy_name}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Bunched Arrivals</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {selectedEval.kpis.bunched_pct.toFixed(1)}%
          </div>
          <div
            className={`text-xs mt-1 tabular-nums ${
              impact.bunching_reduction_pct_pts >= 0 ? 'text-emerald-700' : 'text-red-700'
            }`}
          >
            {impact.bunching_reduction_pct_pts >= 0 ? '−' : '+'}
            {Math.abs(impact.bunching_reduction_pct_pts).toFixed(1)} pp vs {referenceEval.policy_name}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Mean Passenger Wait</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {selectedEval.kpis.mean_wait_min.toFixed(2)} min
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            In-vehicle hold: +{selectedEval.kpis.in_vehicle_hold_s_per_pax.toFixed(1)}s / pax
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Est. Daily Commuter Impact</div>
          <div
            className={`text-xl font-semibold mt-1 tabular-nums ${
              impact.daily_pax_hours_saved >= 0 ? 'text-emerald-700' : 'text-amber-700'
            }`}
          >
            {impact.daily_pax_hours_saved >= 0 ? '+' : ''}
            {impact.daily_pax_hours_saved.toFixed(0)} pax-hrs/day
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {impact.estimated_daily_riders.toLocaleString()} daily riders on {routeId}
          </div>
        </div>
      </div>

      {/* Head-to-Head Baseline Comparison Matrix Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Baseline Policy Benchmark — Route {routeId} (Seed {seed}, {String(hour).padStart(2, '0')}:00 IST)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              All 4 policies evaluated behind the identical frozen Policy.act(obs) interface on the exact same seeded passenger &amp; traffic trajectory. Click any row to compare side by side.
            </p>
          </div>
          <span className="text-xs text-slate-500 whitespace-nowrap shrink-0">
            Reference: Schedule-Based (Current Practice)
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                <th className="py-2.5 px-5">Policy</th>
                <th className="py-2.5 px-3 text-right">Headway CV</th>
                <th className="py-2.5 px-3 text-right">% Bunched</th>
                <th className="py-2.5 px-3 text-right">Mean Wait</th>
                <th className="py-2.5 px-3 text-right">In-Veh Delay</th>
                <th className="py-2.5 px-3 text-right">Mean Trip</th>
                <th className="py-2.5 px-3 text-right">Avg Hold</th>
                <th className="py-2.5 px-5 text-right">Pax-Hrs Saved / Day</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {evaluations.map((ev) => {
                const rowImpact = estimateCommuterImpact(ev.kpis, scheduleEval.kpis, corridor);
                const isSelected = ev.policy_id === selectedPolicyId;
                return (
                  <tr
                    key={ev.policy_id}
                    onClick={() => setSelectedPolicyId(ev.policy_id as BaselinePolicyId)}
                    className={`cursor-pointer transition-colors ${
                      isSelected ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                    }`}
                  >
                    <td className="py-3.5 px-5">
                      <div className="font-medium text-slate-900">{ev.policy_name}</div>
                      <div className="text-xs text-slate-500 mt-0.5">{ev.description}</div>
                    </td>
                    <td className="py-3.5 px-3 text-right font-mono tabular-nums font-medium text-slate-900">
                      {ev.kpis.headway_cv.toFixed(3)}
                    </td>
                    <td
                      className={`py-3.5 px-3 text-right font-mono tabular-nums font-medium ${
                        ev.kpis.bunched_pct >= 10
                          ? 'text-red-700'
                          : ev.kpis.bunched_pct <= 4
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
                      {ev.kpis.mean_trip_time_min.toFixed(1)} min
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

      {/* Synchronized Side-by-Side Time-Space Diagrams */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <MiniTimeSpacePlot
          evaluation={noControlEval}
          maxKm={maxKm}
          title="No Control (Uncontrolled Corridor)"
          subtitle={`Seed ${seed} · natural dwell-feedback bunching`}
        />
        <MiniTimeSpacePlot
          evaluation={selectedEval}
          maxKm={maxKm}
          title={selectedEval.policy_name}
          subtitle={`Seed ${seed} · mean hold ${selectedEval.kpis.mean_hold_s.toFixed(1)}s · wait ${selectedEval.kpis.mean_wait_min.toFixed(2)} min`}
        />
      </div>

      {/* Discrete Hold Action Distribution */}
      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-4 mb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Discrete Hold Action Distribution across Stop Arrivals
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Share of stop decisions selecting each discrete hold in [{config.hold_actions_s.join(', ')}]s — verifies policies regulate gaps without over-holding.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
            {config.hold_actions_s.map((h) => (
              <span key={h} className="inline-flex items-center gap-1.5 font-mono">
                <span className={`w-2.5 h-2.5 rounded-xs ${HOLD_COLORS[h] ?? 'bg-slate-400'}`} />
                {h}s
              </span>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          {evaluations.map((ev) => {
            const totalDecisions = Math.max(
              1,
              Object.values(ev.kpis.hold_distribution).reduce((a, b) => a + b, 0),
            );
            return (
              <div key={ev.policy_id} className="grid grid-cols-12 items-center gap-3 text-xs">
                <div className="col-span-12 sm:col-span-3 font-medium text-slate-800 truncate">
                  {ev.policy_name}
                </div>
                <div className="col-span-9 sm:col-span-7 h-5 bg-slate-100 rounded-sm overflow-hidden flex">
                  {config.hold_actions_s.map((h) => {
                    const count = ev.kpis.hold_distribution[h] ?? 0;
                    const pct = (count / totalDecisions) * 100;
                    if (pct <= 0) return null;
                    return (
                      <div
                        key={h}
                        style={{ width: `${pct}%` }}
                        className={`${HOLD_COLORS[h] ?? 'bg-slate-400'} h-full`}
                        title={`${h}s hold: ${pct.toFixed(1)}% (${count} stops)`}
                      />
                    );
                  })}
                </div>
                <div className="col-span-3 sm:col-span-2 text-right font-mono tabular-nums text-slate-600">
                  {ev.kpis.hold_rate_pct.toFixed(0)}% held
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
