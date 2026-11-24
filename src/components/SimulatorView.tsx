import { useMemo, useState } from 'react';
import type { ProjectConfig } from '../common/config';
import { CORRIDOR_LIST } from '../data/corridors';
import {
  runCorridorEpisode,
  type StopArrivalEvent,
} from '../sim/corridorEnv';

interface SimulatorViewProps {
  config: ProjectConfig;
}

const HOUR_PRESETS = [
  { hour: 7, label: '07:00 Early' },
  { hour: 9, label: '09:00 AM Peak' },
  { hour: 13, label: '13:00 Midday' },
  { hour: 18, label: '18:00 PM Peak' },
];

const BUS_LINE_COLORS = [
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

function formatSimTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function SimulatorView({ config }: SimulatorViewProps) {
  const [routeId, setRouteId] = useState<string>('500D');
  const [hour, setHour] = useState<number>(9);
  const [seed, setSeed] = useState<number>(config.default_seed);
  const [dwellFeedback, setDwellFeedback] = useState<boolean>(true);
  const [selectedEvent, setSelectedEvent] = useState<StopArrivalEvent | null>(null);
  const [logFilter, setLogFilter] = useState<'all' | 'bunched'>('bunched');

  const episode = useMemo(() => {
    return runCorridorEpisode(config, {
      route_id: routeId,
      hour,
      seed,
      dwellFeedback,
      horizonMinutes: 110,
      scenario: 'normal',
    });
  }, [config, routeId, hour, seed, dwellFeedback]);

  // Group events into per-(bus_id, trip_num) trajectories for the Time-Space Diagram
  const trajectories = useMemo(() => {
    const groups = new Map<string, StopArrivalEvent[]>();
    for (const ev of episode.events) {
      const key = `${ev.bus_id}#${ev.trip_num}`;
      const list = groups.get(key) ?? [];
      list.push(ev);
      groups.set(key, list);
    }
    return Array.from(groups.entries()).map(([key, evs]) => ({
      key,
      bus_id: evs[0].bus_id,
      bus_num: evs[0].bus_num,
      events: evs.sort((a, b) => a.arrival_t - b.arrival_t),
    }));
  }, [episode.events]);

  const bunchedEvents = useMemo(
    () => episode.events.filter((e) => e.is_bunched),
    [episode.events],
  );

  const bunchThresholdS = Math.round(
    config.bunching_headway_ratio * episode.scheduledHeadwayS,
  );

  const originCv = episode.cvByStop[1]?.headway_cv ?? 0;
  const terminalCv =
    episode.cvByStop[episode.cvByStop.length - 1]?.headway_cv ?? 0;
  const peakDwellS = useMemo(
    () => Math.max(0, ...episode.events.map((e) => e.dwell_s)),
    [episode.events],
  );

  // SVG Time-Space Diagram geometry
  const tsDiagram = useMemo(() => {
    const w = 920;
    const h = 380;
    const padL = 152;
    const padR = 24;
    const padT = 20;
    const padB = 38;
    const maxMin = 110;
    const maxKm = Math.max(
      1,
      episode.corridor.stops[episode.corridor.stops.length - 1].cum_dist_km,
    );

    const xAtSec = (sec: number) =>
      padL + (Math.min(maxMin * 60, sec) / (maxMin * 60)) * (w - padL - padR);
    const yAtKm = (km: number) =>
      h - padB - (km / maxKm) * (h - padT - padB);

    return { w, h, padL, padR, padT, padB, maxMin, maxKm, xAtSec, yAtKm };
  }, [episode.corridor.stops]);

  // Select evenly spaced stop labels for Y-axis readability
  const yAxisStops = useMemo(() => {
    const stops = episode.corridor.stops;
    const step = Math.max(1, Math.floor(stops.length / 6));
    return stops.filter(
      (_, idx) => idx === 0 || idx === stops.length - 1 || idx % step === 0,
    );
  }, [episode.corridor.stops]);

  const displayedLog = useMemo(() => {
    const base = logFilter === 'bunched' ? bunchedEvents : episode.events;
    return base.slice(0, 60);
  }, [logFilter, bunchedEvents, episode.events]);

  const maxCvInChart = useMemo(
    () => Math.max(0.6, ...episode.cvByStop.map((s) => s.headway_cv)),
    [episode.cvByStop],
  );

  return (
    <div className="space-y-8">
      {/* Simulation Parameters Control Bar */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
          {/* Corridor */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {CORRIDOR_LIST.map((c) => (
              <button
                key={c.route_id}
                type="button"
                onClick={() => {
                  setRouteId(c.route_id);
                  setSelectedEvent(null);
                }}
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

          {/* Hour Preset */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {HOUR_PRESETS.map((p) => (
              <button
                key={p.hour}
                type="button"
                onClick={() => {
                  setHour(p.hour);
                  setSelectedEvent(null);
                }}
                className={`px-2.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  hour === p.hour
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Seed */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {config.evaluation_seeds.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setSeed(s);
                  setSelectedEvent(null);
                }}
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

        {/* Dwell Feedback Toggle (Gate 2 Proof Switch) */}
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md shrink-0">
          <button
            type="button"
            onClick={() => setDwellFeedback(true)}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              dwellFeedback
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Dwell Feedback ON
          </button>
          <button
            type="button"
            onClick={() => setDwellFeedback(false)}
            className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              !dwellFeedback
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Fixed Dwell OFF
          </button>
        </div>
      </div>

      {/* 4-Column Gate 2 Bunching KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Bunched Stop Arrivals</div>
          <div
            className={`text-xl font-semibold mt-1 tabular-nums ${
              episode.finalSnapshot.kpis.bunched_pct >= 8
                ? 'text-red-700'
                : 'text-emerald-700'
            }`}
          >
            {episode.finalSnapshot.kpis.bunched_pct.toFixed(1)}%
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            {bunchedEvents.length} events &lt; {bunchThresholdS}s gap (25% sched.)
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Corridor Headway CV</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {episode.finalSnapshot.kpis.headway_cv.toFixed(3)}
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            Stop 2: {originCv.toFixed(2)} → Terminal: {terminalCv.toFixed(2)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Mean Passenger Wait</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {episode.finalSnapshot.kpis.mean_wait_min.toFixed(2)} min
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            vs {(episode.scheduledHeadwayS / 120).toFixed(2)} min ideal half-headway
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Passengers Boarded / Peak Dwell</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {episode.finalSnapshot.kpis.total_boarded.toLocaleString()} pax
          </div>
          <div className="text-xs text-slate-500 mt-1 tabular-nums">
            Peak stop dwell: {peakDwellS.toFixed(0)}s · Policy: No Control
          </div>
        </div>
      </div>

      {/* Time-Space Diagram (Gate 2 Primary Visual Proof) */}
      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-4 mb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Time-Space Diagram — Route {episode.corridor.route_id} ({String(hour).padStart(2, '0')}:00 IST, No Holding Control)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Each diagonal trace is a BMTC bus moving from {episode.corridor.origin} to {episode.corridor.destination}. Converging lines and crimson dots confirm natural bus bunching emerging from boarding dwell feedback.
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs text-slate-600 shrink-0">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-0.5 bg-blue-700 inline-block" />
              Bus trajectory
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-red-600 inline-block" />
              Bunched arrival (&lt;{bunchThresholdS}s)
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 ${tsDiagram.w} ${tsDiagram.h}`}
            className="w-full min-w-[740px] h-auto"
            role="img"
            aria-label={`Time-space diagram of BMTC route ${episode.corridor.route_id}`}
          >
            {/* Vertical time gridlines every 15 minutes */}
            {[0, 15, 30, 45, 60, 75, 90, 105].map((min) => {
              const x = tsDiagram.xAtSec(min * 60);
              return (
                <g key={min}>
                  <line
                    x1={x}
                    x2={x}
                    y1={tsDiagram.padT}
                    y2={tsDiagram.h - tsDiagram.padB}
                    stroke="#e2e8f0"
                    strokeWidth="1"
                  />
                  <text
                    x={x}
                    y={tsDiagram.h - 14}
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

            {/* Horizontal stop gridlines */}
            {yAxisStops.map((stop) => {
              const y = tsDiagram.yAtKm(stop.cum_dist_km);
              return (
                <g key={stop.stop_id}>
                  <line
                    x1={tsDiagram.padL}
                    x2={tsDiagram.w - tsDiagram.padR}
                    y1={y}
                    y2={y}
                    stroke="#f1f5f9"
                    strokeWidth="1"
                  />
                  <text
                    x={tsDiagram.padL - 10}
                    y={y + 3.5}
                    textAnchor="end"
                    fontSize="10"
                    fill="#475569"
                  >
                    {stop.name.length > 22 ? `${stop.name.slice(0, 21)}…` : stop.name}
                  </text>
                </g>
              );
            })}

            {/* Axis border */}
            <line
              x1={tsDiagram.padL}
              x2={tsDiagram.padL}
              y1={tsDiagram.padT}
              y2={tsDiagram.h - tsDiagram.padB}
              stroke="#cbd5e1"
              strokeWidth="1.2"
            />
            <line
              x1={tsDiagram.padL}
              x2={tsDiagram.w - tsDiagram.padR}
              y1={tsDiagram.h - tsDiagram.padB}
              y2={tsDiagram.h - tsDiagram.padB}
              stroke="#cbd5e1"
              strokeWidth="1.2"
            />

            {/* Bus trajectory paths */}
            {trajectories.map((traj) => {
              if (traj.events.length < 2) return null;
              const stroke =
                BUS_LINE_COLORS[(traj.bus_num - 1) % BUS_LINE_COLORS.length];
              const d = traj.events
                .map((ev, idx) => {
                  const x = tsDiagram.xAtSec(ev.arrival_t);
                  const y = tsDiagram.yAtKm(ev.cum_dist_km);
                  return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
                })
                .join(' ');
              return (
                <path
                  key={traj.key}
                  d={d}
                  fill="none"
                  stroke={stroke}
                  strokeWidth="1.75"
                  strokeOpacity="0.82"
                  strokeLinejoin="round"
                />
              );
            })}

            {/* Interactive markers for bunched arrival events */}
            {bunchedEvents.map((ev) => {
              const cx = tsDiagram.xAtSec(ev.arrival_t);
              const cy = tsDiagram.yAtKm(ev.cum_dist_km);
              const isSelected = selectedEvent?.event_idx === ev.event_idx;
              return (
                <circle
                  key={ev.event_idx}
                  cx={cx}
                  cy={cy}
                  r={isSelected ? 6 : 3.8}
                  fill="#dc2626"
                  stroke="#ffffff"
                  strokeWidth={isSelected ? 2 : 1.2}
                  className="cursor-pointer"
                  onClick={() => setSelectedEvent(ev)}
                  onMouseEnter={() => setSelectedEvent(ev)}
                />
              );
            })}
          </svg>
        </div>

        {/* Selected Arrival Inspector Footer */}
        <div className="mt-4 pt-3.5 border-t border-slate-200 flex flex-wrap items-center justify-between gap-4 text-xs">
          {selectedEvent ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-700">
              <span className="font-mono font-semibold text-slate-900">
                {selectedEvent.bus_id}
              </span>
              <span>
                Stop #{selectedEvent.stop_idx + 1}: {selectedEvent.stop_name}
              </span>
              <span className="font-mono tabular-nums">
                t = {formatSimTime(selectedEvent.arrival_t)}
              </span>
              <span className="font-mono tabular-nums text-red-700 font-medium">
                Fwd headway: {selectedEvent.fwd_headway_s.toFixed(0)}s
              </span>
              <span className="font-mono tabular-nums">
                Dwell: {selectedEvent.dwell_s.toFixed(1)}s
              </span>
              <span className="font-mono tabular-nums">
                Boarded: {selectedEvent.boarded} · Onboard: {selectedEvent.load_after}
              </span>
            </div>
          ) : (
            <span className="text-slate-500">
              Hover or click any crimson bunching marker on the Time-Space Diagram to inspect bus headway, dwell, and load.
            </span>
          )}
          <span className="font-mono text-slate-500 tabular-nums">
            {episode.events.length} total stop arrivals logged
          </span>
        </div>
      </div>

      {/* Headway CV Amplification Along Corridor + Event Log */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Stop-by-Stop Headway CV Growth */}
        <div className="xl:col-span-5 bg-white border border-slate-200 rounded-lg p-5">
          <h2 className="text-base font-semibold text-slate-900">
            Headway Instability Growth Along Corridor
          </h2>
          <p className="text-xs text-slate-500 mt-0.5 mb-4">
            Headway Coefficient of Variation (CV) rises from origin to terminal as boarding dwell amplifies upstream delays.
          </p>

          <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
            {episode.cvByStop.slice(1).map((st) => {
              const barPct = Math.min(100, Math.round((st.headway_cv / maxCvInChart) * 100));
              const isSevere = st.headway_cv >= 0.45;
              return (
                <div key={st.stop_idx} className="grid grid-cols-12 items-center gap-2 text-xs">
                  <div className="col-span-5 truncate text-slate-700" title={st.stop_name}>
                    <span className="font-mono text-slate-400 mr-1.5 tabular-nums">
                      {String(st.stop_idx + 1).padStart(2, '0')}
                    </span>
                    {st.stop_name}
                  </div>
                  <div className="col-span-5 h-2.5 bg-slate-100 rounded-xs overflow-hidden">
                    <div
                      style={{ width: `${barPct}%` }}
                      className={`h-full rounded-xs ${
                        isSevere ? 'bg-red-600' : st.headway_cv >= 0.25 ? 'bg-amber-500' : 'bg-blue-700'
                      }`}
                    />
                  </div>
                  <div className="col-span-2 text-right font-mono tabular-nums text-slate-700">
                    {st.headway_cv.toFixed(2)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Arrival Event Telemetry Table */}
        <div className="xl:col-span-7 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Asynchronous Stop-Arrival Event Stream
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Events emitted by BMTCHoldingEnv — ready for Step 4 Baselines and Step 5 Predictor dataset generation.
              </p>
            </div>
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md shrink-0">
              <button
                type="button"
                onClick={() => setLogFilter('bunched')}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  logFilter === 'bunched'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Bunched Only ({bunchedEvents.length})
              </button>
              <button
                type="button"
                onClick={() => setLogFilter('all')}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  logFilter === 'all'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                All Events ({episode.events.length})
              </button>
            </div>
          </div>

          <div className="overflow-x-auto max-h-[370px] overflow-y-auto">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                <tr>
                  <th className="py-2 px-4">Time</th>
                  <th className="py-2 px-3">Bus</th>
                  <th className="py-2 px-3">Stop</th>
                  <th className="py-2 px-3 text-right">Fwd Gap</th>
                  <th className="py-2 px-3 text-right">Dwell</th>
                  <th className="py-2 px-3 text-right">Board / Load</th>
                  <th className="py-2 px-4">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs">
                {displayedLog.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-500">
                      No bunched arrivals detected in this run (try enabling Dwell Feedback or selecting Peak hours).
                    </td>
                  </tr>
                ) : (
                  displayedLog.map((ev) => (
                    <tr
                      key={ev.event_idx}
                      onClick={() => setSelectedEvent(ev)}
                      className={`cursor-pointer transition-colors ${
                        selectedEvent?.event_idx === ev.event_idx
                          ? 'bg-blue-50/70'
                          : 'hover:bg-slate-50'
                      }`}
                    >
                      <td className="py-2.5 px-4 font-mono tabular-nums text-slate-600">
                        {formatSimTime(ev.arrival_t)}
                      </td>
                      <td className="py-2.5 px-3 font-mono font-medium text-slate-900">
                        {ev.bus_id}
                      </td>
                      <td className="py-2.5 px-3 text-slate-700 truncate max-w-[160px]">
                        #{ev.stop_idx + 1} {ev.stop_name}
                      </td>
                      <td
                        className={`py-2.5 px-3 text-right font-mono tabular-nums ${
                          ev.is_bunched ? 'text-red-700 font-semibold' : 'text-slate-700'
                        }`}
                      >
                        {ev.fwd_headway_s.toFixed(0)}s
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                        {ev.dwell_s.toFixed(0)}s
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                        +{ev.boarded} / {ev.load_after}
                      </td>
                      <td className="py-2.5 px-4">
                        <span
                          className={
                            ev.is_bunched
                              ? 'text-red-700 font-medium'
                              : 'text-emerald-700'
                          }
                        >
                          {ev.is_bunched ? 'Bunched' : 'Nominal'}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
