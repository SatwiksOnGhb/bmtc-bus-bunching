import { useMemo, useState } from 'react';
import type { BusState, Prediction } from '../common/schemas';
import type { DualSnapshotFrame } from '../sim/runner';

interface CorridorGeoMapProps {
  frame: DualSnapshotFrame;
  selectedBusId: string | null;
  onSelectBus: (busId: string) => void;
  onQueueManualHold: (busId: string, holdSec: number) => void;
  holdActionsS: readonly number[];
}

type MapLaneMode = 'right' | 'left' | 'both';

function riskStyle(pBunch: number): { fill: string; ring: string; label: string; textCls: string } {
  if (pBunch >= 0.65) {
    return { fill: '#DC2626', ring: '#FCA5A5', label: 'High Risk', textCls: 'text-red-700' };
  }
  if (pBunch >= 0.35) {
    return { fill: '#D97706', ring: '#FCD34D', label: 'Watch', textCls: 'text-amber-700' };
  }
  return { fill: '#1D4ED8', ring: '#93C5FD', label: 'Nominal', textCls: 'text-blue-700' };
}

export function CorridorGeoMap({
  frame,
  selectedBusId,
  onSelectBus,
  onQueueManualHold,
  holdActionsS,
}: CorridorGeoMapProps) {
  const [laneMode, setLaneMode] = useState<MapLaneMode>('right');

  const stops = frame.corridor.stops;
  const width = 680;
  const height = 400;
  const pad = { top: 36, right: 120, bottom: 42, left: 68 };

  const bounds = useMemo(() => {
    const lats = stops.map((s) => s.lat);
    const lons = stops.map((s) => s.lon);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const latMargin = Math.max(0.012, (maxLat - minLat) * 0.12);
    const lonMargin = Math.max(0.014, (maxLon - minLon) * 0.14);
    return {
      minLat: minLat - latMargin,
      maxLat: maxLat + latMargin,
      minLon: minLon - lonMargin,
      maxLon: maxLon + lonMargin,
    };
  }, [stops]);

  const project = (lat: number, lon: number) => {
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const x = pad.left + ((lon - bounds.minLon) / Math.max(1e-6, bounds.maxLon - bounds.minLon)) * plotW;
    const y = pad.top + ((bounds.maxLat - lat) / Math.max(1e-6, bounds.maxLat - bounds.minLat)) * plotH;
    return { x, y };
  };

  const stopPoints = useMemo(
    () =>
      stops.map((s) => {
        const pt = project(s.lat, s.lon);
        return { ...s, x: pt.x, y: pt.y };
      }),
    [stops, bounds],
  );

  const routePathD = useMemo(
    () =>
      stopPoints
        .map((s, idx) => `${idx === 0 ? 'M' : 'L'} ${s.x.toFixed(1)} ${s.y.toFixed(1)}`)
        .join(' '),
    [stopPoints],
  );

  const rightPredMap = useMemo(() => {
    const m = new Map<string, Prediction>();
    for (const p of frame.right.snapshot.predictions) m.set(p.bus_id, p);
    return m;
  }, [frame.right.snapshot.predictions]);

  const leftPredMap = useMemo(() => {
    const m = new Map<string, Prediction>();
    for (const p of frame.left.snapshot.predictions) m.set(p.bus_id, p);
    return m;
  }, [frame.left.snapshot.predictions]);

  // Estimate live stop waiting queues from latest bus state at each stop
  const stopQueueByIdx = useMemo(() => {
    const q = new Map<number, number>();
    const activeBuses = laneMode === 'left' ? frame.left.snapshot.buses : frame.right.snapshot.buses;
    for (const b of activeBuses) {
      q.set(b.stop_idx, Math.max(q.get(b.stop_idx) ?? 0, b.waiting_at_stop));
    }
    return q;
  }, [frame.left.snapshot.buses, frame.right.snapshot.buses, laneMode]);

  // Group overlapping buses at the same stop so every bus marker remains clickable & legible
  const layoutBuses = (buses: BusState[], xBias: number, yBias: number) => {
    const seenPerStop = new Map<number, number>();
    return buses.map((b) => {
      const count = seenPerStop.get(b.stop_idx) ?? 0;
      seenPerStop.set(b.stop_idx, count + 1);
      const base = project(b.lat, b.lon);
      const angle = count * 1.45;
      const spread = count === 0 ? 0 : 12 + Math.floor(count / 3) * 6;
      return {
        bus: b,
        x: base.x + xBias + Math.cos(angle) * spread,
        y: base.y + yBias + Math.sin(angle) * spread,
      };
    });
  };

  const rightMarkers = layoutBuses(frame.right.snapshot.buses, 0, 0);
  const leftMarkers = layoutBuses(frame.left.snapshot.buses, laneMode === 'both' ? -14 : 0, laneMode === 'both' ? 10 : 0);

  const inspectedBus =
    frame.right.snapshot.buses.find((b) => b.bus_id === selectedBusId) ??
    frame.right.snapshot.buses[0];
  const inspectedLeft = inspectedBus
    ? frame.left.snapshot.buses.find((b) => b.bus_id === inspectedBus.bus_id)
    : undefined;
  const inspectedPred = inspectedBus ? rightPredMap.get(inspectedBus.bus_id) : undefined;
  const inspectedRisk = riskStyle(inspectedPred?.p_bunch ?? 0);
  const inspectedHold = inspectedBus ? frame.right.snapshot.holds[inspectedBus.bus_id] ?? 0 : 0;
  const pendingOverride = inspectedBus ? frame.pending_overrides[inspectedBus.bus_id] : undefined;

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Bengaluru Corridor Map · Route {frame.route_id} ({frame.corridor.origin} → {frame.corridor.destination})
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Real WGS84 BMTC stop coordinates colored by live calibrated bunching probability (p_bunch, k=5 stops). Click any bus to inspect or override.
          </p>
        </div>

        <div className="flex items-center border border-slate-200 rounded-md overflow-hidden text-xs">
          {(
            [
              { id: 'right', label: 'MAPPO Layer' },
              { id: 'left', label: 'Baseline Layer' },
              { id: 'both', label: 'Dual Overlay' },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setLaneMode(m.id)}
              className={`px-2.5 py-1.5 font-medium transition-colors whitespace-nowrap ${
                laneMode === m.id
                  ? 'bg-slate-900 text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Geospatial SVG Canvas */}
      <div className="p-4 bg-slate-50/70">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto block bg-white border border-slate-200 rounded-md">
          {/* Lat/Lon Graticule Grid */}
          {[0.2, 0.4, 0.6, 0.8].map((frac) => {
            const lat = bounds.minLat + frac * (bounds.maxLat - bounds.minLat);
            const lon = bounds.minLon + frac * (bounds.maxLon - bounds.minLon);
            const py = project(lat, bounds.minLon).y;
            const px = project(bounds.minLat, lon).x;
            return (
              <g key={frac}>
                <line
                  x1={pad.left}
                  x2={width - pad.right}
                  y1={py}
                  y2={py}
                  stroke="#F1F5F9"
                  strokeWidth="1"
                />
                <text
                  x={pad.left - 8}
                  y={py + 3}
                  textAnchor="end"
                  className="fill-slate-400 text-[9px] font-mono"
                >
                  {lat.toFixed(3)}°N
                </text>
                <line
                  x1={px}
                  x2={px}
                  y1={pad.top}
                  y2={height - pad.bottom}
                  stroke="#F1F5F9"
                  strokeWidth="1"
                />
                <text
                  x={px}
                  y={height - pad.bottom + 15}
                  textAnchor="middle"
                  className="fill-slate-400 text-[9px] font-mono"
                >
                  {lon.toFixed(3)}°E
                </text>
              </g>
            );
          })}

          {/* Monsoon Rain Tint Overlay when active */}
          {frame.scenario === 'rain' && (
            <rect
              x={pad.left}
              y={pad.top}
              width={width - pad.left - pad.right}
              height={height - pad.top - pad.bottom}
              fill="#DBEAFE"
              fillOpacity="0.22"
            />
          )}

          {/* Corridor Arterial Polyline */}
          <path
            d={routePathD}
            fill="none"
            stroke="#CBD5E1"
            strokeWidth="7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={routePathD}
            fill="none"
            stroke="#64748B"
            strokeWidth="2"
            strokeDasharray="6 4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* BMTC Stops + Passenger Queue Halos */}
          {stopPoints.map((s) => {
            const queue = stopQueueByIdx.get(s.stop_idx) ?? 0;
            const showLabel =
              s.stop_idx === 0 ||
              s.stop_idx === stopPoints.length - 1 ||
              s.is_major_hub ||
              s.stop_idx % 4 === 0;
            return (
              <g key={s.stop_id}>
                {queue >= 8 && (
                  <circle
                    cx={s.x}
                    cy={s.y}
                    r={Math.min(18, 6 + queue * 0.25)}
                    fill="#F59E0B"
                    fillOpacity="0.16"
                    stroke="#D97706"
                    strokeOpacity="0.45"
                    strokeWidth="1"
                  />
                )}
                <circle
                  cx={s.x}
                  cy={s.y}
                  r={s.is_major_hub ? 4.2 : 2.8}
                  fill="#FFFFFF"
                  stroke={s.is_major_hub ? '#334155' : '#94A3B8'}
                  strokeWidth={s.is_major_hub ? 1.8 : 1.2}
                />
                {showLabel && (
                  <text
                    x={s.x + 8}
                    y={s.y + 3}
                    className={`text-[9.5px] ${
                      s.is_major_hub ? 'fill-slate-800 font-semibold' : 'fill-slate-500'
                    }`}
                  >
                    {s.name}
                  </text>
                )}
              </g>
            );
          })}

          {/* Baseline Ghost/Layer Markers */}
          {(laneMode === 'left' || laneMode === 'both') &&
            leftMarkers.map(({ bus, x, y }) => {
              const pred = leftPredMap.get(bus.bus_id);
              const rs = riskStyle(pred?.p_bunch ?? 0);
              const shortNum = bus.bus_id.split('-').pop() ?? bus.bus_id;
              const isGhost = laneMode === 'both';
              return (
                <g
                  key={`left-${bus.bus_id}`}
                  onClick={() => onSelectBus(bus.bus_id)}
                  className="cursor-pointer"
                >
                  <circle
                    cx={x}
                    cy={y}
                    r={isGhost ? 6.5 : 8.5}
                    fill={isGhost ? '#94A3B8' : rs.fill}
                    fillOpacity={isGhost ? 0.65 : 0.95}
                    stroke="#FFFFFF"
                    strokeWidth="1.5"
                  />
                  <text
                    x={x}
                    y={y + 2.8}
                    textAnchor="middle"
                    className="fill-white text-[7.5px] font-mono font-bold pointer-events-none"
                  >
                    {shortNum.replace('B', '')}
                  </text>
                </g>
              );
            })}

          {/* Active MAPPO / Right Layer Markers */}
          {(laneMode === 'right' || laneMode === 'both') &&
            rightMarkers.map(({ bus, x, y }) => {
              const pred = rightPredMap.get(bus.bus_id);
              const rs = riskStyle(pred?.p_bunch ?? 0);
              const isSelected = inspectedBus?.bus_id === bus.bus_id;
              const holdS = frame.right.snapshot.holds[bus.bus_id] ?? 0;
              const hasOverride = frame.pending_overrides[bus.bus_id] !== undefined;
              const shortNum = bus.bus_id.split('-').pop() ?? bus.bus_id;

              return (
                <g
                  key={`right-${bus.bus_id}`}
                  onClick={() => onSelectBus(bus.bus_id)}
                  className="cursor-pointer"
                >
                  {isSelected && (
                    <circle
                      cx={x}
                      cy={y}
                      r={14}
                      fill="none"
                      stroke="#0F172A"
                      strokeWidth="1.75"
                      strokeDasharray="3 2"
                    />
                  )}
                  {(holdS > 0 || hasOverride) && (
                    <circle
                      cx={x}
                      cy={y}
                      r={11.5}
                      fill="none"
                      stroke={hasOverride ? '#7C3AED' : rs.ring}
                      strokeWidth="2.2"
                    />
                  )}
                  <circle
                    cx={x}
                    cy={y}
                    r={9}
                    fill={rs.fill}
                    stroke="#FFFFFF"
                    strokeWidth="1.8"
                  />
                  <text
                    x={x}
                    y={y + 3}
                    textAnchor="middle"
                    className="fill-white text-[8px] font-mono font-bold pointer-events-none"
                  >
                    {shortNum.replace('B', '')}
                  </text>
                </g>
              );
            })}

          {/* Compass & Corridor Scale Legend */}
          <g transform={`translate(${width - 38}, 28)`}>
            <circle cx="0" cy="0" r="13" fill="#F8FAFC" stroke="#CBD5E1" strokeWidth="1" />
            <text x="0" y="3.5" textAnchor="middle" className="fill-slate-700 text-[9px] font-mono font-semibold">
              N
            </text>
          </g>
        </svg>

        {/* Map Legend Row */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
          <div className="flex flex-wrap items-center gap-4">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-700 inline-block" />
              Nominal (p &lt; 35%)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-600 inline-block" />
              Watch (35–65%)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-red-600 inline-block" />
              High Risk (&ge; 65%)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full border-2 border-purple-600 inline-block" />
              Pending Manual Override
            </span>
          </div>
          <span className="font-mono text-slate-500">
            {(stops[stops.length - 1]?.cum_dist_km ?? 0).toFixed(1)} km · {stops.length} stops · {frame.right.snapshot.buses.length} buses
          </span>
        </div>
      </div>

      {/* Selected Bus Telemetry & Quick Override Strip */}
      {inspectedBus && (
        <div className="px-5 py-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-4 bg-white">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono font-semibold text-slate-900">{inspectedBus.bus_id}</span>
              <span className="text-slate-300">·</span>
              <span className="text-slate-700">
                Stop #{inspectedBus.stop_idx + 1}: {stops[inspectedBus.stop_idx]?.name}
              </span>
              <span className="text-slate-300">·</span>
              <span className={`font-medium ${inspectedRisk.textCls}`}>
                p_bunch = {((inspectedPred?.p_bunch ?? 0) * 100).toFixed(0)}% ({inspectedRisk.label})
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 tabular-nums">
              <span>
                Fwd HW: <strong className="text-slate-900">{inspectedBus.fwd_headway_s.toFixed(0)}s</strong>
                {inspectedLeft && (
                  <span className="text-slate-400"> (Base {inspectedLeft.fwd_headway_s.toFixed(0)}s)</span>
                )}
              </span>
              <span>
                Bwd HW: <strong className="text-slate-900">{inspectedBus.bwd_headway_s.toFixed(0)}s</strong>
              </span>
              <span>
                Load: <strong className="text-slate-900">{inspectedBus.load}</strong> pax
              </span>
              <span>
                Last Hold: <strong className="text-slate-900">{inspectedHold}s</strong>
              </span>
              {pendingOverride !== undefined && (
                <span className="text-purple-700 font-medium">
                  Queued Override: {pendingOverride}s next stop
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-slate-500 mr-1">Manual Hold Override:</span>
            {holdActionsS.map((h) => {
              const active = pendingOverride === h;
              return (
                <button
                  key={h}
                  type="button"
                  onClick={() => onQueueManualHold(inspectedBus.bus_id, h)}
                  className={`px-2 py-1 text-[11px] font-mono rounded-sm border transition-colors ${
                    active
                      ? 'bg-purple-700 text-white border-purple-700 font-semibold'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {h}s
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
