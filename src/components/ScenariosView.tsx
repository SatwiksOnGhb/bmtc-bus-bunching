import { useMemo, useState } from 'react';
import { CloudRain, RotateCcw, Wrench } from 'lucide-react';
import type { ProjectConfig } from '../common/config';
import { estimateCommuterImpact } from '../common/kpis';
import { runAllBaselinesComparison } from '../control/baselines';
import {
  getTrainedMarlSuite,
  runIntegratedMarlEpisode,
  type MarlVariantId,
} from '../control/mappo';
import { CORRIDOR_LIST, getCorridor } from '../data/corridors';
import { getProductionPredictor } from '../predict/predictor';
import type { StopArrivalEvent } from '../sim/corridorEnv';
import {
  makeScenario,
  type DisruptionEventLog,
  type ScenarioName,
  type ScenarioSpec,
} from '../sim/scenarios';

interface ScenariosViewProps {
  config: ProjectConfig;
}

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

function DisruptionTimeSpacePlot({
  events,
  scenarioSpec,
  disruptionEvents,
  maxKm,
  title,
  headwayCv,
  bunchedPct,
}: {
  events: StopArrivalEvent[];
  scenarioSpec: ScenarioSpec;
  disruptionEvents: DisruptionEventLog[];
  maxKm: number;
  title: string;
  headwayCv: number;
  bunchedPct: number;
}) {
  const w = 440;
  const h = 255;
  const padL = 44;
  const padR = 14;
  const padT = 16;
  const padB = 30;
  const maxMin = 110;

  const xAtSec = (sec: number) =>
    padL + (Math.min(maxMin * 60, sec) / (maxMin * 60)) * (w - padL - padR);
  const yAtKm = (km: number) =>
    h - padB - (km / Math.max(1, maxKm)) * (h - padT - padB);

  const trajectories = useMemo(() => {
    const map = new Map<string, { busNum: number; pts: Array<{ t: number; km: number }> }>();
    for (const ev of events) {
      const key = `${ev.bus_id}#${ev.trip_num}`;
      const entry = map.get(key) ?? { busNum: ev.bus_num, pts: [] };
      entry.pts.push({ t: ev.arrival_t, km: ev.cum_dist_km });
      map.set(key, entry);
    }
    return Array.from(map.entries());
  }, [events]);

  const bunched = useMemo(() => events.filter((e) => e.is_bunched), [events]);

  const breakdownStart = disruptionEvents.find((d) => d.type === 'breakdown_start');
  const breakdownClear = disruptionEvents.find((d) => d.type === 'breakdown_cleared');
  const breakdownKm = useMemo(() => {
    if (!breakdownStart) return null;
    const match = events.find(
      (e) =>
        e.bus_id === breakdownStart.bus_id &&
        e.stop_idx === breakdownStart.stop_idx &&
        Math.abs(e.arrival_t - breakdownStart.t) < 5,
    );
    return match?.cum_dist_km ?? null;
  }, [breakdownStart, events]);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <p className="text-xs text-slate-500 mt-0.5">{scenarioSpec.label}</p>
        </div>
        <div className="font-mono text-xs tabular-nums shrink-0">
          <span className="font-semibold text-slate-900">CV {headwayCv.toFixed(3)}</span>
          <span className="text-slate-400 mx-1.5">·</span>
          <span
            className={
              bunchedPct >= 10
                ? 'text-red-700 font-semibold'
                : 'text-emerald-700 font-semibold'
            }
          >
            {bunchedPct.toFixed(1)}% bunched
          </span>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-auto"
        role="img"
        aria-label={`Disruption time-space plot for ${title}`}
      >
        {/* Monsoon Rain shaded storm window */}
        {scenarioSpec.rain && (
          <g>
            <rect
              x={xAtSec(scenarioSpec.rain.onset_s)}
              y={padT}
              width={Math.max(
                8,
                xAtSec(scenarioSpec.rain.end_s) - xAtSec(scenarioSpec.rain.onset_s),
              )}
              height={h - padT - padB}
              fill="#dbeafe"
              fillOpacity="0.45"
            />
            <text
              x={xAtSec(scenarioSpec.rain.onset_s) + 6}
              y={padT + 12}
              fontSize="9.5"
              fill="#1e40af"
              fontWeight="600"
            >
              Rain storm window
            </text>
          </g>
        )}

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

        {/* Bus breakdown immobilization horizontal bar */}
        {breakdownStart && breakdownKm !== null && (
          <g>
            <line
              x1={xAtSec(breakdownStart.t)}
              x2={xAtSec(breakdownClear?.t ?? breakdownStart.t + (breakdownStart.duration_s ?? 1200))}
              y1={yAtKm(breakdownKm)}
              y2={yAtKm(breakdownKm)}
              stroke="#d97706"
              strokeWidth="4"
              strokeDasharray="5 3"
            />
            <circle
              cx={xAtSec(breakdownStart.t)}
              cy={yAtKm(breakdownKm)}
              r="5"
              fill="#d97706"
              stroke="#ffffff"
              strokeWidth="1.5"
            />
          </g>
        )}

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

export function ScenariosView({ config }: ScenariosViewProps) {
  const [routeId, setRouteId] = useState<string>('500D');
  const [scenarioName, setScenarioName] = useState<ScenarioName>('rain');
  const [seed, setSeed] = useState<number>(config.default_seed);
  const [rainDropPct, setRainDropPct] = useState<number>(34);
  const [rainOnsetMin, setRainOnsetMin] = useState<number>(20);
  const [breakdownDurMin, setBreakdownDurMin] = useState<number>(20);
  const [breakdownBusNum, setBreakdownBusNum] = useState<number>(4);

  const corridor = useMemo(() => getCorridor(routeId), [routeId]);
  const maxKm = corridor.stops[corridor.stops.length - 1].cum_dist_km;
  const predictor = useMemo(() => getProductionPredictor(config, 5), [config]);
  const trainedSuite = useMemo(() => getTrainedMarlSuite(config), [config]);

  const scenarioSpec = useMemo(
    () =>
      makeScenario(scenarioName, seed, {
        route_id: routeId,
        rain_speed_drop_pct: rainDropPct,
        rain_onset_min: rainOnsetMin,
        breakdown_duration_min: breakdownDurMin,
        breakdown_bus_num: Math.min(corridor.fleet_size, breakdownBusNum),
      }),
    [
      scenarioName,
      seed,
      routeId,
      rainDropPct,
      rainOnsetMin,
      breakdownDurMin,
      breakdownBusNum,
      corridor.fleet_size,
    ],
  );

  const baselines = useMemo(
    () =>
      runAllBaselinesComparison({
        config,
        routeId,
        hour: 9,
        seed,
        scenario: scenarioName,
        scenarioSpec,
        horizonMinutes: 110,
      }),
    [config, routeId, seed, scenarioName, scenarioSpec],
  );

  const marlResults = useMemo(() => {
    const variants: MarlVariantId[] = ['mappo_nopred', 'mappo_pred'];
    return variants.map((v) =>
      runIntegratedMarlEpisode({
        variant: v,
        weights: trainedSuite[v].weights,
        predictor,
        config,
        seed,
        options: {
          route_id: routeId,
          hour: 9,
          scenario: scenarioName,
          scenarioSpec,
          dwellFeedback: true,
        },
        horizonMinutes: 110,
      }),
    );
  }, [trainedSuite, predictor, config, seed, routeId, scenarioName, scenarioSpec]);

  const scheduleEval = baselines.find((b) => b.policy_id === 'schedule') ?? baselines[1];
  const mappoPredEval =
    marlResults.find((m) => m.policy_id === 'mappo_pred') ?? marlResults[1];
  const impactVsSchedule = useMemo(
    () => estimateCommuterImpact(mappoPredEval.kpis, scheduleEval.kpis, corridor),
    [mappoPredEval.kpis, scheduleEval.kpis, corridor],
  );

  const combinedTable = useMemo(() => [...baselines, ...marlResults], [baselines, marlResults]);

  const resetOverrides = () => {
    setRainDropPct(34);
    setRainOnsetMin(20);
    setBreakdownDurMin(20);
    setBreakdownBusNum(4);
  };

  return (
    <div className="space-y-8">
      {/* Scenario Controls Toolbar */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Scenario selector */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {(
              [
                { id: 'normal', label: 'Normal Day' },
                { id: 'rain', label: 'Monsoon Rain' },
                { id: 'breakdown', label: 'Bus Breakdown' },
              ] as const
            ).map((sc) => (
              <button
                key={sc.id}
                type="button"
                onClick={() => setScenarioName(sc.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  scenarioName === sc.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {sc.label}
              </button>
            ))}
          </div>

          {/* Corridor */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {CORRIDOR_LIST.map((c) => (
              <button
                key={c.route_id}
                type="button"
                onClick={() => setRouteId(c.route_id)}
                className={`px-2.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  routeId === c.route_id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {c.route_id}
              </button>
            ))}
          </div>

          {/* Seed */}
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
          onClick={resetOverrides}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset Disruption Params
        </button>
      </div>

      {/* Custom What-If Severity Sliders (contextual to Rain or Breakdown) */}
      {scenarioName !== 'normal' && (
        <div className="bg-white border border-slate-200 rounded-lg p-5 grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
          <div className="md:col-span-5">
            <div className="inline-flex items-center gap-2 text-sm font-semibold text-slate-900">
              {scenarioName === 'rain' ? (
                <CloudRain className="w-4 h-4 text-blue-700 shrink-0" />
              ) : (
                <Wrench className="w-4 h-4 text-amber-700 shrink-0" />
              )}
              <span>{scenarioSpec.label}</span>
            </div>
            <p className="text-xs text-slate-600 mt-1 leading-relaxed">
              {scenarioSpec.description}
            </p>
          </div>

          {scenarioName === 'rain' ? (
            <div className="md:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <label className="block">
                <div className="flex justify-between text-slate-700 mb-1">
                  <span>Monsoon Speed Drop</span>
                  <span className="font-mono tabular-nums font-semibold text-blue-700">
                    −{rainDropPct}%
                  </span>
                </div>
                <input
                  type="range"
                  min="15"
                  max="50"
                  step="1"
                  value={rainDropPct}
                  onChange={(e) => setRainDropPct(Number(e.target.value))}
                  className="w-full accent-blue-700"
                />
              </label>

              <label className="block">
                <div className="flex justify-between text-slate-700 mb-1">
                  <span>Storm Onset Minute</span>
                  <span className="font-mono tabular-nums font-semibold">
                    t = {rainOnsetMin} min
                  </span>
                </div>
                <input
                  type="range"
                  min="8"
                  max="45"
                  step="2"
                  value={rainOnsetMin}
                  onChange={(e) => setRainOnsetMin(Number(e.target.value))}
                  className="w-full accent-blue-700"
                />
              </label>
            </div>
          ) : (
            <div className="md:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <label className="block">
                <div className="flex justify-between text-slate-700 mb-1">
                  <span>Immobilization Duration</span>
                  <span className="font-mono tabular-nums font-semibold text-amber-700">
                    {breakdownDurMin} min
                  </span>
                </div>
                <input
                  type="range"
                  min="10"
                  max="35"
                  step="2"
                  value={breakdownDurMin}
                  onChange={(e) => setBreakdownDurMin(Number(e.target.value))}
                  className="w-full accent-blue-700"
                />
              </label>

              <label className="block">
                <div className="flex justify-between text-slate-700 mb-1">
                  <span>Affected Bus Index</span>
                  <span className="font-mono tabular-nums font-semibold">
                    {routeId}-B{String(Math.min(corridor.fleet_size, breakdownBusNum)).padStart(2, '0')}
                  </span>
                </div>
                <input
                  type="range"
                  min="2"
                  max={Math.min(8, corridor.fleet_size)}
                  step="1"
                  value={Math.min(corridor.fleet_size, breakdownBusNum)}
                  onChange={(e) => setBreakdownBusNum(Number(e.target.value))}
                  className="w-full accent-blue-700"
                />
              </label>
            </div>
          )}
        </div>
      )}

      {/* 4-Column Resilience KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">MAPPO Disruption Headway CV</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {mappoPredEval.kpis.headway_cv.toFixed(3)}
          </div>
          <div className="text-xs text-emerald-700 mt-1 tabular-nums">
            vs {scheduleEval.kpis.headway_cv.toFixed(3)} Schedule ({impactVsSchedule.cv_reduction_pct >= 0 ? '−' : '+'}
            {Math.abs(impactVsSchedule.cv_reduction_pct).toFixed(1)}%)
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Bunched Arrivals Under Stress</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {mappoPredEval.kpis.bunched_pct.toFixed(1)}%
          </div>
          <div className="text-xs text-emerald-700 mt-1 tabular-nums">
            vs {scheduleEval.kpis.bunched_pct.toFixed(1)}% Current Practice
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Mean Commuter Wait</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {mappoPredEval.kpis.mean_wait_min.toFixed(2)} min
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            vs {scheduleEval.kpis.mean_wait_min.toFixed(2)} min Schedule
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Disruption Commuter Savings</div>
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
          <div className="text-xs text-slate-500 mt-1">
            Scenario: {scenarioSpec.label}
          </div>
        </div>
      </div>

      {/* Side-by-Side Disruption Time-Space Diagrams */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <DisruptionTimeSpacePlot
          events={scheduleEval.events}
          scenarioSpec={scenarioSpec}
          disruptionEvents={mappoPredEval.disruptionEvents}
          maxKm={maxKm}
          title="Schedule-Based Holding (Current Practice)"
          headwayCv={scheduleEval.kpis.headway_cv}
          bunchedPct={scheduleEval.kpis.bunched_pct}
        />
        <DisruptionTimeSpacePlot
          events={mappoPredEval.events}
          scenarioSpec={scenarioSpec}
          disruptionEvents={mappoPredEval.disruptionEvents}
          maxKm={maxKm}
          title="MAPPO + Calibrated Predictor"
          headwayCv={mappoPredEval.kpis.headway_cv}
          bunchedPct={mappoPredEval.kpis.bunched_pct}
        />
      </div>

      {/* Stress-Test Benchmark Matrix & Seeded Event Timeline */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-8 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200">
            <h2 className="text-base font-semibold text-slate-900">
              Controller Resilience Under {scenarioSpec.label} ({routeId}, Seed {seed})
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Identical disruption timing, link-speed shocks, and passenger surges applied across all controllers.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                  <th className="py-2.5 px-5">Controller</th>
                  <th className="py-2.5 px-3 text-right">Headway CV</th>
                  <th className="py-2.5 px-3 text-right">% Bunched</th>
                  <th className="py-2.5 px-3 text-right">Mean Wait</th>
                  <th className="py-2.5 px-3 text-right">Avg Hold</th>
                  <th className="py-2.5 px-5 text-right">Pax-Hrs Saved</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {combinedTable.map((ev) => {
                  const imp = estimateCommuterImpact(ev.kpis, scheduleEval.kpis, corridor);
                  const isMappo = ev.policy_id === 'mappo_pred';
                  return (
                    <tr key={ev.policy_id} className={isMappo ? 'bg-blue-50/50' : 'hover:bg-slate-50'}>
                      <td className="py-3 px-5 font-medium text-slate-900">{ev.policy_name}</td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                        {ev.kpis.headway_cv.toFixed(3)}
                      </td>
                      <td
                        className={`py-3 px-3 text-right font-mono tabular-nums ${
                          ev.kpis.bunched_pct >= 12
                            ? 'text-red-700 font-semibold'
                            : 'text-slate-800'
                        }`}
                      >
                        {ev.kpis.bunched_pct.toFixed(1)}%
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-800">
                        {ev.kpis.mean_wait_min.toFixed(2)} min
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700">
                        {ev.kpis.mean_hold_s.toFixed(1)}s
                      </td>
                      <td
                        className={`py-3 px-5 text-right font-mono tabular-nums font-medium ${
                          ev.policy_id === 'schedule'
                            ? 'text-slate-500'
                            : imp.daily_pax_hours_saved > 0
                            ? 'text-emerald-700'
                            : 'text-red-700'
                        }`}
                      >
                        {ev.policy_id === 'schedule'
                          ? 'Baseline'
                          : `${imp.daily_pax_hours_saved >= 0 ? '+' : ''}${imp.daily_pax_hours_saved.toFixed(0)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Seeded Disruption Event Timeline */}
        <div className="xl:col-span-4 bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Seeded Disruption Event Log
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Generated reproducibly by make_scenario(&ldquo;{scenarioName}&rdquo;, {seed})
            </p>
          </div>

          {mappoPredEval.disruptionEvents.length === 0 ? (
            <div className="p-4 rounded-md bg-slate-50 border border-slate-200 text-xs text-slate-600">
              Nominal Bengaluru peak run — no weather or mechanical disruption events triggered. Select Monsoon Rain or Bus Breakdown above to inject seeded shocks.
            </div>
          ) : (
            <div className="space-y-3">
              {mappoPredEval.disruptionEvents.map((ev, idx) => (
                <div
                  key={idx}
                  className="p-3 rounded-md bg-slate-50 border border-slate-200 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between font-mono">
                    <span
                      className={
                        ev.type === 'breakdown_start'
                          ? 'text-amber-700 font-semibold'
                          : ev.type === 'rain_onset'
                          ? 'text-blue-700 font-semibold'
                          : 'text-emerald-700 font-semibold'
                      }
                    >
                      {ev.type === 'rain_onset'
                        ? 'Monsoon Onset'
                        : ev.type === 'breakdown_start'
                        ? 'Breakdown Start'
                        : 'Service Cleared'}
                    </span>
                    <span className="text-slate-500 tabular-nums">
                      t = {(ev.t / 60).toFixed(1)} min
                    </span>
                  </div>
                  <p className="text-slate-700 leading-relaxed">{ev.summary}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
