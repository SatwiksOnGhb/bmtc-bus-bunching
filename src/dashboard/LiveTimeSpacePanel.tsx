import { useMemo } from 'react';
import type { StopArrivalEvent } from '../sim/corridorEnv';
import type { DualSnapshotFrame } from '../sim/runner';

interface LiveTimeSpacePanelProps {
  frame: DualSnapshotFrame;
}

const BUS_COLORS = [
  '#1D4ED8',
  '#0F766E',
  '#4338CA',
  '#B45309',
  '#0369A1',
  '#7C3AED',
  '#047857',
  '#BE185D',
  '#475569',
  '#2563EB',
  '#0D9488',
  '#6D28D9',
];

function SingleTimeSpaceChart({
  title,
  subtitle,
  events,
  maxDistKm,
  horizonMin,
  clockMin,
  headwayCv,
  bunchedPct,
  liveDisruptions,
  accent,
}: {
  title: string;
  subtitle: string;
  events: StopArrivalEvent[];
  maxDistKm: number;
  horizonMin: number;
  clockMin: number;
  headwayCv: number;
  bunchedPct: number;
  liveDisruptions: Array<{ t_min: number; type: 'rain' | 'breakdown'; label: string }>;
  accent: 'baseline' | 'mappo';
}) {
  const width = 560;
  const height = 250;
  const pad = { top: 18, right: 16, bottom: 32, left: 42 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const xScale = (tMin: number) => pad.left + (Math.min(horizonMin, tMin) / Math.max(1, horizonMin)) * plotW;
  const yScale = (km: number) => pad.top + plotH - (Math.min(maxDistKm, km) / Math.max(0.5, maxDistKm)) * plotH;

  // Group events into continuous per-(bus, trip) trajectory polylines
  const trajectories = useMemo(() => {
    const map = new Map<string, { busNum: number; points: StopArrivalEvent[] }>();
    for (const ev of events) {
      const key = `${ev.bus_id}-T${ev.trip_num}`;
      const entry = map.get(key) ?? { busNum: ev.bus_num, points: [] };
      entry.points.push(ev);
      map.set(key, entry);
    }
    return Array.from(map.entries()).map(([key, val]) => ({
      key,
      busNum: val.busNum,
      d: val.points
        .map(
          (p, i) =>
            `${i === 0 ? 'M' : 'L'} ${xScale(p.arrival_t / 60).toFixed(1)} ${yScale(p.cum_dist_km).toFixed(1)}`,
        )
        .join(' '),
    }));
  }, [events, horizonMin, maxDistKm]);

  const bunchedPoints = useMemo(() => events.filter((e) => e.is_bunched), [events]);
  const heldPoints = useMemo(() => events.filter((e) => e.hold_s > 0), [events]);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-900">{title}</h4>
          <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
        </div>
        <div className="flex items-center gap-3 text-xs tabular-nums">
          <span className="text-slate-600">
            CV:{' '}
            <strong className={accent === 'mappo' ? 'text-blue-700' : 'text-slate-900'}>
              {headwayCv.toFixed(3)}
            </strong>
          </span>
          <span className="text-slate-600">
            Bunched:{' '}
            <strong className={bunchedPct > 12 ? 'text-red-700' : 'text-emerald-700'}>
              {bunchedPct.toFixed(1)}%
            </strong>
          </span>
        </div>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto block">
        {/* Distance Horizontal Gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const km = maxDistKm * frac;
          const y = yScale(km);
          return (
            <g key={frac}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y}
                y2={y}
                stroke="#E2E8F0"
                strokeWidth="1"
              />
              <text
                x={pad.left - 6}
                y={y + 3}
                textAnchor="end"
                className="fill-slate-400 text-[9.5px] font-mono"
              >
                {km.toFixed(0)}km
              </text>
            </g>
          );
        })}

        {/* Time Axis Labels */}
        {[0, 20, 40, 60, 80, 100].map((tMin) => {
          if (tMin > horizonMin) return null;
          const x = xScale(tMin);
          return (
            <g key={tMin}>
              <line
                x1={x}
                x2={x}
                y1={pad.top}
                y2={pad.top + plotH}
                stroke="#F1F5F9"
                strokeWidth="1"
              />
              <text
                x={x}
                y={height - 10}
                textAnchor="middle"
                className="fill-slate-400 text-[9.5px] font-mono"
              >
                {tMin}m
              </text>
            </g>
          );
        })}

        {/* Current Live Clock Sweep Line */}
        <line
          x1={xScale(clockMin)}
          x2={xScale(clockMin)}
          y1={pad.top}
          y2={pad.top + plotH}
          stroke="#0F172A"
          strokeWidth="1"
          strokeOpacity="0.35"
          strokeDasharray="2 2"
        />

        {/* Live Disruption Markers */}
        {liveDisruptions.map((d, idx) => {
          const x = xScale(d.t_min);
          const color = d.type === 'rain' ? '#2563EB' : '#D97706';
          return (
            <line
              key={`${d.type}-${idx}`}
              x1={x}
              x2={x}
              y1={pad.top}
              y2={pad.top + plotH}
              stroke={color}
              strokeWidth="1.25"
              strokeDasharray="4 3"
            />
          );
        })}

        {/* Bus Trajectories */}
        {trajectories.map((tr) => (
          <path
            key={tr.key}
            d={tr.d}
            fill="none"
            stroke={BUS_COLORS[(tr.busNum - 1) % BUS_COLORS.length]}
            strokeWidth="1.5"
            strokeOpacity="0.82"
          />
        ))}

        {/* Holding Decision Markers */}
        {heldPoints.map((ev) => (
          <circle
            key={`hold-${ev.event_idx}`}
            cx={xScale(ev.arrival_t / 60)}
            cy={yScale(ev.cum_dist_km)}
            r="2.2"
            fill="#1D4ED8"
            fillOpacity="0.7"
          />
        ))}

        {/* Bunched Arrival Markers */}
        {bunchedPoints.map((ev) => (
          <circle
            key={`bunch-${ev.event_idx}`}
            cx={xScale(ev.arrival_t / 60)}
            cy={yScale(ev.cum_dist_km)}
            r="3"
            fill="#DC2626"
            stroke="#FFFFFF"
            strokeWidth="0.8"
          />
        ))}
      </svg>

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
        <div className="flex items-center gap-3.5">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-red-600 inline-block" />
            Bunched arrival ({bunchedPoints.length})
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-blue-700 inline-block" />
            Hold action ({heldPoints.length})
          </span>
        </div>
        <span className="font-mono">x: sim min · y: distance (km)</span>
      </div>
    </div>
  );
}

export function LiveTimeSpacePanel({ frame }: LiveTimeSpacePanelProps) {
  const maxDistKm = frame.corridor.stops[frame.corridor.stops.length - 1]?.cum_dist_km ?? 20;
  const horizonMin = frame.horizon_s / 60;
  const clockMin = frame.clock_t / 60;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      <SingleTimeSpaceChart
        title={`Left · ${frame.left.policy_name}`}
        subtitle="Watch trajectory lines pinch and merge as natural dwell-feedback bunching grows."
        events={frame.left.events}
        maxDistKm={maxDistKm}
        horizonMin={horizonMin}
        clockMin={clockMin}
        headwayCv={frame.left.kpis.headway_cv}
        bunchedPct={frame.left.kpis.bunched_pct}
        liveDisruptions={frame.live_disruptions}
        accent="baseline"
      />
      <SingleTimeSpaceChart
        title={`Right · ${frame.right.policy_name}`}
        subtitle="Proactive discrete holds keep trajectories parallel under identical traffic & demand."
        events={frame.right.events}
        maxDistKm={maxDistKm}
        horizonMin={horizonMin}
        clockMin={clockMin}
        headwayCv={frame.right.kpis.headway_cv}
        bunchedPct={frame.right.kpis.bunched_pct}
        liveDisruptions={frame.live_disruptions}
        accent="mappo"
      />
    </div>
  );
}
