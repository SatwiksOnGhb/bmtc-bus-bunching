import { useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { CORRIDOR_LIST, getCorridor } from '../data/corridors';
import {
  CNI_GPS_SUMMARY,
  exportGpsCalibrationJson,
  getHourlyTrafficProfile,
} from '../data/gpsCalibration';
import {
  exportCleanedRoutesCsv,
  runGtfsCleaningPipeline,
} from '../data/gtfsCleaner';

function triggerDownload(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function DataEdaView() {
  const [selectedRouteId, setSelectedRouteId] = useState<string>('500D');
  const [selectedHour, setSelectedHour] = useState<number>(9);
  const [hoveredStopIdx, setHoveredStopIdx] = useState<number | null>(null);
  const [stopQuery, setStopQuery] = useState<string>('');
  const [gtfsFilter, setGtfsFilter] = useState<'clean' | 'dropped'>('clean');

  const cleaningReport = useMemo(() => runGtfsCleaningPipeline(), []);
  const corridor = useMemo(() => getCorridor(selectedRouteId), [selectedRouteId]);
  const hourlyProfile = useMemo(
    () => getHourlyTrafficProfile(selectedRouteId),
    [selectedRouteId],
  );

  const activeHourProfile =
    hourlyProfile.find((h) => h.hour === selectedHour) ?? hourlyProfile[2];

  const avgLinkMeters = useMemo(() => {
    const links = corridor.stops.slice(1).map((s) => s.link_dist_m);
    return Math.round(links.reduce((a, b) => a + b, 0) / Math.max(1, links.length));
  }, [corridor]);

  const peakSpeed = useMemo(
    () => Math.min(...hourlyProfile.map((h) => h.gps_mean_kmh)),
    [hourlyProfile],
  );

  const filteredStops = useMemo(() => {
    const q = stopQuery.trim().toLowerCase();
    if (!q) return corridor.stops;
    return corridor.stops.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.stop_id.toLowerCase().includes(q) ||
        String(s.stop_idx + 1) === q,
    );
  }, [corridor.stops, stopQuery]);

  // SVG chart geometry for Hourly Speed Profile
  const speedChart = useMemo(() => {
    const w = 640;
    const h = 230;
    const padL = 44;
    const padR = 20;
    const padT = 18;
    const padB = 34;
    const maxY = 30;
    const minY = 5;
    const xAt = (idx: number) =>
      padL + (idx / (hourlyProfile.length - 1)) * (w - padL - padR);
    const yAt = (val: number) =>
      padT + ((maxY - val) / (maxY - minY)) * (h - padT - padB);

    const meanLine = hourlyProfile
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yAt(pt.gps_mean_kmh).toFixed(1)}`)
      .join(' ');

    const schedY = yAt(hourlyProfile[0].gtfs_scheduled_kmh);

    const upperPts = hourlyProfile
      .map((pt, i) => `${xAt(i).toFixed(1)},${yAt(pt.gps_p75_kmh).toFixed(1)}`)
      .join(' ');
    const lowerPts = [...hourlyProfile]
      .reverse()
      .map((pt, revI) => {
        const origI = hourlyProfile.length - 1 - revI;
        return `${xAt(origI).toFixed(1)},${yAt(pt.gps_p25_kmh).toFixed(1)}`;
      })
      .join(' ');

    return { w, h, padL, padR, padT, padB, xAt, yAt, meanLine, schedY, bandPoly: `${upperPts} ${lowerPts}` };
  }, [hourlyProfile]);

  // SVG geographic trace projection for the selected corridor
  const corridorTrace = useMemo(() => {
    const w = 360;
    const h = 320;
    const pad = 34;
    const lats = corridor.stops.map((s) => s.lat);
    const lons = corridor.stops.map((s) => s.lon);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const latSpan = Math.max(0.02, maxLat - minLat);
    const lonSpan = Math.max(0.02, maxLon - minLon);

    // Preserve geographic aspect ratio around 13 deg N
    const cosLat = Math.cos((13 * Math.PI) / 180);
    const spanX = lonSpan * cosLat;
    const spanY = latSpan;
    const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
    const offsetX = (w - spanX * scale) / 2;
    const offsetY = (h - spanY * scale) / 2;

    const points = corridor.stops.map((s) => ({
      stop: s,
      x: offsetX + (s.lon - minLon) * cosLat * scale,
      y: h - offsetY - (s.lat - minLat) * scale,
    }));

    const pathD = points
      .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' ');

    return { w, h, points, pathD };
  }, [corridor.stops]);

  return (
    <div className="space-y-8">
      {/* Corridor Selector & Data Export Toolbar */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-500 mr-1">Active Corridor</span>
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {CORRIDOR_LIST.map((c) => (
              <button
                key={c.route_id}
                type="button"
                onClick={() => {
                  setSelectedRouteId(c.route_id);
                  setHoveredStopIdx(null);
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  selectedRouteId === c.route_id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {c.route_id} · {c.split === 'train' ? 'Train' : 'Held-out'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() =>
              triggerDownload(
                'demo_bmtc_routes.csv',
                exportCleanedRoutesCsv(cleaningReport),
                'text/csv;charset=utf-8',
              )
            }
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Export demo routes
          </button>
          <button
            type="button"
            onClick={() =>
              triggerDownload(
                `demo_speeds_${selectedRouteId}.json`,
                exportGpsCalibrationJson(selectedRouteId),
                'application/json',
              )
            }
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Export demo speeds
          </button>
        </div>
      </div>

      {/* 4-Column Quantitative EDA Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">GTFS Routes Cleaned</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {cleaningReport.cleanedRoutesCount} / {cleaningReport.rawRoutesCount}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {cleaningReport.droppedNonOperational} inactive · {cleaningReport.droppedBrokenTimetable} broken dropped
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Example GPS ping count</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {(CNI_GPS_SUMMARY.retained_corridor_pings / 1_000_000).toFixed(2)}M pings
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {CNI_GPS_SUMMARY.unique_buses_observed.toLocaleString()} buses · 07:00–19:00 IST
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">{corridor.route_id} Peak Min Speed</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {peakSpeed.toFixed(1)} km/h
          </div>
          <div className="text-xs text-amber-700 mt-1">
            vs {hourlyProfile[0].gtfs_scheduled_kmh.toFixed(1)} km/h GTFS schedule
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">{corridor.route_id} Corridor Geometry</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {corridor.stops[corridor.stops.length - 1].cum_dist_km.toFixed(1)} km
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {corridor.stops.length} stops · avg {avgLinkMeters}m spacing
          </div>
        </div>
      </div>

      {/* Hourly GPS Speed Calibration & Demand Profile */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
        {/* Speed Profile Chart */}
        <div className="xl:col-span-7 bg-white border border-slate-200 rounded-lg p-5 flex flex-col">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Example Corridor Speeds by Time of Day ({corridor.route_id})
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Illustrative speeds and a sample timetable. Click an hour to inspect the values.
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs text-slate-600">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-blue-700 inline-block" />
                GPS Mean
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 h-0.5 border-t border-dashed border-amber-600 inline-block" />
                GTFS Schedule
              </span>
            </div>
          </div>

          <div className="overflow-x-auto flex-1">
            <svg
              viewBox={`0 0 ${speedChart.w} ${speedChart.h}`}
              className="w-full min-w-[520px] h-auto"
              role="img"
              aria-label={`Hourly GPS speed chart for BMTC route ${corridor.route_id}`}
            >
              {/* Horizontal gridlines */}
              {[10, 15, 20, 25, 30].map((v) => {
                const y = speedChart.yAt(v);
                return (
                  <g key={v}>
                    <line
                      x1={speedChart.padL}
                      x2={speedChart.w - speedChart.padR}
                      y1={y}
                      y2={y}
                      stroke="#e2e8f0"
                      strokeWidth="1"
                    />
                    <text
                      x={speedChart.padL - 8}
                      y={y + 4}
                      textAnchor="end"
                      fontSize="10"
                      fill="#64748b"
                      className="font-mono"
                    >
                      {v}
                    </text>
                  </g>
                );
              })}

              {/* Y-axis unit label */}
              <text x="10" y="14" fontSize="10" fill="#64748b">
                km/h
              </text>

              {/* P25 - P75 shaded band */}
              <polygon points={speedChart.bandPoly} fill="#dbeafe" fillOpacity="0.65" />

              {/* GTFS scheduled speed dashed line */}
              <line
                x1={speedChart.padL}
                x2={speedChart.w - speedChart.padR}
                y1={speedChart.schedY}
                y2={speedChart.schedY}
                stroke="#d97706"
                strokeWidth="1.5"
                strokeDasharray="5 4"
              />

              {/* GPS mean line */}
              <path
                d={speedChart.meanLine}
                fill="none"
                stroke="#1d4ed8"
                strokeWidth="2.2"
                strokeLinejoin="round"
              />

              {/* Interactive hour nodes */}
              {hourlyProfile.map((pt, i) => {
                const cx = speedChart.xAt(i);
                const cy = speedChart.yAt(pt.gps_mean_kmh);
                const isSelected = pt.hour === selectedHour;
                return (
                  <g
                    key={pt.hour}
                    className="cursor-pointer"
                    onClick={() => setSelectedHour(pt.hour)}
                    onMouseEnter={() => setSelectedHour(pt.hour)}
                  >
                    <rect
                      x={cx - 18}
                      y={speedChart.padT}
                      width="36"
                      height={speedChart.h - speedChart.padT - speedChart.padB}
                      fill="transparent"
                    />
                    {isSelected && (
                      <line
                        x1={cx}
                        x2={cx}
                        y1={speedChart.padT}
                        y2={speedChart.h - speedChart.padB}
                        stroke="#94a3b8"
                        strokeDasharray="3 3"
                        strokeWidth="1"
                      />
                    )}
                    <circle
                      cx={cx}
                      cy={cy}
                      r={isSelected ? 5 : 3.2}
                      fill={isSelected ? '#1d4ed8' : '#ffffff'}
                      stroke="#1d4ed8"
                      strokeWidth="2"
                    />
                    <text
                      x={cx}
                      y={speedChart.h - 10}
                      textAnchor="middle"
                      fontSize="10"
                      fill={isSelected ? '#0f172a' : '#64748b'}
                      fontWeight={isSelected ? '600' : '400'}
                      className="font-mono"
                    >
                      {String(pt.hour).padStart(2, '0')}h
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

        {/* Selected Hour Telemetry & Boarding Demand Breakdown */}
        <div className="xl:col-span-5 bg-white border border-slate-200 rounded-lg p-5 flex flex-col justify-between space-y-5">
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-base font-semibold text-slate-900">
                Hour Snapshot: {activeHourProfile.label} IST
              </h3>
              <span className="text-xs font-mono text-slate-500">
                {activeHourProfile.pax_arrival_mult >= 1.5
                  ? 'Peak congestion'
                  : activeHourProfile.pax_arrival_mult <= 0.9
                  ? 'Midday off-peak'
                  : 'Shoulder period'}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Demo parameters used by the browser corridor simulation for {corridor.route_id}.
            </p>

            <div className="grid grid-cols-2 gap-4 mt-4 pt-4 border-t border-slate-200">
              <div>
                <div className="text-xs text-slate-500">GPS Mean Speed</div>
                <div className="text-lg font-semibold font-mono tabular-nums text-slate-900 mt-0.5">
                  {activeHourProfile.gps_mean_kmh.toFixed(1)} km/h
                </div>
                <div className="text-xs text-slate-500 font-mono tabular-nums">
                  IQR {activeHourProfile.gps_p25_kmh}–{activeHourProfile.gps_p75_kmh} km/h
                </div>
              </div>

              <div>
                <div className="text-xs text-slate-500">Passenger Arrival Load</div>
                <div className="text-lg font-semibold font-mono tabular-nums text-slate-900 mt-0.5">
                  {activeHourProfile.pax_arrival_mult.toFixed(2)}× base
                </div>
                <div className="text-xs text-slate-500 font-mono tabular-nums">
                  Sched. headway {activeHourProfile.scheduled_headway_s}s
                </div>
              </div>
            </div>
          </div>

          {/* Bengaluru Mixed Traffic Class Split */}
          <div className="pt-4 border-t border-slate-200">
            <div className="flex items-center justify-between text-xs mb-2">
              <span className="font-medium text-slate-700">
                Bengaluru Mixed Traffic Vehicle Share
              </span>
              <span className="text-slate-500 font-mono">SUMO vClass mix</span>
            </div>

            <div className="h-2.5 w-full rounded-sm overflow-hidden flex bg-slate-100">
              <div
                style={{ width: `${activeHourProfile.mixed_traffic_share.two_wheelers_pct}%` }}
                className="bg-blue-700"
                title="Two-wheelers"
              />
              <div
                style={{ width: `${activeHourProfile.mixed_traffic_share.cars_pct}%` }}
                className="bg-slate-600"
                title="Cars"
              />
              <div
                style={{ width: `${activeHourProfile.mixed_traffic_share.autos_pct}%` }}
                className="bg-amber-500"
                title="Autos"
              />
              <div
                style={{ width: `${activeHourProfile.mixed_traffic_share.buses_pct}%` }}
                className="bg-emerald-600"
                title="BMTC Buses"
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 text-xs">
              <div>
                <div className="text-slate-500">2-Wheelers</div>
                <div className="font-mono font-medium tabular-nums text-slate-900">
                  {activeHourProfile.mixed_traffic_share.two_wheelers_pct}%
                </div>
              </div>
              <div>
                <div className="text-slate-500">Cars</div>
                <div className="font-mono font-medium tabular-nums text-slate-900">
                  {activeHourProfile.mixed_traffic_share.cars_pct}%
                </div>
              </div>
              <div>
                <div className="text-slate-500">Autos</div>
                <div className="font-mono font-medium tabular-nums text-slate-900">
                  {activeHourProfile.mixed_traffic_share.autos_pct}%
                </div>
              </div>
              <div>
                <div className="text-slate-500">BMTC Buses</div>
                <div className="font-mono font-medium tabular-nums text-slate-900">
                  {activeHourProfile.mixed_traffic_share.buses_pct}%
                </div>
              </div>
            </div>
          </div>

          {/* Hourly Demand Mini Bars */}
          <div className="pt-4 border-t border-slate-200">
            <div className="text-xs font-medium text-slate-700 mb-2">
              Hourly Boarding Demand Intensity (07:00 – 19:00)
            </div>
            <div className="flex items-end gap-1 h-14">
              {hourlyProfile.map((h) => {
                const heightPct = Math.round((h.pax_arrival_mult / 2.0) * 100);
                const isSelected = h.hour === selectedHour;
                return (
                  <button
                    key={h.hour}
                    type="button"
                    onClick={() => setSelectedHour(h.hour)}
                    className="flex-1 h-full flex flex-col justify-end group focus-visible:outline-2 focus-visible:outline-blue-600"
                    title={`${h.label}: ${h.pax_arrival_mult.toFixed(2)}x demand`}
                  >
                    <span
                      style={{ height: `${heightPct}%` }}
                      className={`w-full rounded-t-xs transition-colors ${
                        isSelected
                          ? 'bg-blue-700'
                          : h.pax_arrival_mult >= 1.5
                          ? 'bg-amber-400 group-hover:bg-amber-500'
                          : 'bg-slate-300 group-hover:bg-slate-400'
                      }`}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Spatial Corridor Geometry & Stop Sequence Table */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Corridor Spatial Trace */}
        <div className="xl:col-span-5 bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-baseline justify-between gap-2 mb-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                {corridor.route_id} Spatial Stop Geometry
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {corridor.origin} to {corridor.destination} · real Bengaluru lat/lon trace
              </p>
            </div>
            <span className="text-xs font-mono text-slate-500">WGS84</span>
          </div>

          <svg
            viewBox={`0 0 ${corridorTrace.w} ${corridorTrace.h}`}
            className="w-full h-auto bg-slate-50/70 rounded-md border border-slate-200"
            role="img"
            aria-label={`Geographic stop trace of BMTC route ${corridor.route_id}`}
          >
            <path
              d={corridorTrace.pathD}
              fill="none"
              stroke="#94a3b8"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
            {corridorTrace.points.map(({ stop, x, y }) => {
              const isHovered = hoveredStopIdx === stop.stop_idx;
              const isEndpoint =
                stop.stop_idx === 0 || stop.stop_idx === corridor.stops.length - 1;
              return (
                <g
                  key={stop.stop_id}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoveredStopIdx(stop.stop_idx)}
                  onMouseLeave={() => setHoveredStopIdx(null)}
                >
                  <circle
                    cx={x}
                    cy={y}
                    r={isHovered ? 7 : stop.is_major_hub ? 5 : 3.5}
                    fill={
                      isHovered
                        ? '#1d4ed8'
                        : isEndpoint
                        ? '#0f172a'
                        : stop.is_major_hub
                        ? '#2563eb'
                        : '#ffffff'
                    }
                    stroke={isHovered || stop.is_major_hub ? '#1d4ed8' : '#475569'}
                    strokeWidth="1.8"
                  />
                  {(isHovered || isEndpoint || stop.stop_idx === Math.floor(corridor.stops.length / 2)) && (
                    <text
                      x={x + 9}
                      y={y + 3}
                      fontSize="10"
                      fontWeight={isHovered ? '600' : '500'}
                      fill="#0f172a"
                    >
                      {stop.stop_idx + 1}. {stop.name}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
            <span>
              {hoveredStopIdx !== null
                ? `Selected: #${hoveredStopIdx + 1} ${corridor.stops[hoveredStopIdx].name}`
                : 'Hover any stop node or table row to cross-highlight'}
            </span>
            <span className="font-mono tabular-nums">
              {corridor.stops.filter((s) => s.is_major_hub).length} major hubs
            </span>
          </div>
        </div>

        {/* Stop Sequence Table */}
        <div className="xl:col-span-7 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Cleaned Stop Sequence ({corridor.stops.length} Stops)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Monotonic cumulative distances and stop-level passenger arrival weights
              </p>
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={stopQuery}
                onChange={(e) => setStopQuery(e.target.value)}
                placeholder="Filter stops..."
                aria-label="Filter corridor stops"
                className="pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md w-48 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
          </div>

          <div className="overflow-x-auto max-h-[370px] overflow-y-auto">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                <tr>
                  <th className="py-2 px-4">#</th>
                  <th className="py-2 px-3">Stop Name</th>
                  <th className="py-2 px-3">Lat, Lon</th>
                  <th className="py-2 px-3 text-right">Link (m)</th>
                  <th className="py-2 px-3 text-right">Cum (km)</th>
                  <th className="py-2 px-4 text-right">Demand Wt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs">
                {filteredStops.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-500">
                      No stops match &ldquo;{stopQuery}&rdquo;.
                    </td>
                  </tr>
                ) : (
                  filteredStops.map((s) => {
                    const isHighlighted = hoveredStopIdx === s.stop_idx;
                    return (
                      <tr
                        key={s.stop_id}
                        onMouseEnter={() => setHoveredStopIdx(s.stop_idx)}
                        onMouseLeave={() => setHoveredStopIdx(null)}
                        className={`transition-colors ${
                          isHighlighted ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                        }`}
                      >
                        <td className="py-2.5 px-4 font-mono tabular-nums text-slate-500">
                          {String(s.stop_idx + 1).padStart(2, '0')}
                        </td>
                        <td className="py-2.5 px-3 font-medium text-slate-900">
                          {s.name}
                          {s.is_major_hub && (
                            <span className="ml-2 font-normal text-blue-700">· Hub</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-slate-500">
                          {s.lat.toFixed(4)}, {s.lon.toFixed(4)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                          {s.link_dist_m}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                          {s.cum_dist_km.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-900">
                          {s.demand_weight.toFixed(1)}×
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* GTFS Cleaning Audit Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              GTFS Cleaning &amp; Trip-Count Ranking Audit (routes.csv)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Removed {cleaningReport.orphanStopsRemoved} orphan stops and{' '}
              {cleaningReport.brokenStopTimesFixedOrDropped.toLocaleString()} invalid stop-time entries before handing off to Simulation.
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md shrink-0">
            <button
              type="button"
              onClick={() => setGtfsFilter('clean')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                gtfsFilter === 'clean'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Cleaned Ranked ({cleaningReport.rankedRoutes.length})
            </button>
            <button
              type="button"
              onClick={() => setGtfsFilter('dropped')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                gtfsFilter === 'dropped'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Dropped Anomalies ({cleaningReport.droppedRoutes.length})
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                <th className="py-2.5 px-5">Route ID</th>
                <th className="py-2.5 px-4">Corridor</th>
                <th className="py-2.5 px-4 text-right">Daily Trips</th>
                <th className="py-2.5 px-4 text-right">Stops</th>
                <th className="py-2.5 px-4 text-right">Sched. Headway</th>
                <th className="py-2.5 px-5">
                  {gtfsFilter === 'clean' ? 'Project Role' : 'Drop Reason'}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {(gtfsFilter === 'clean'
                ? cleaningReport.rankedRoutes
                : cleaningReport.droppedRoutes
              ).map((r) => (
                <tr key={r.route_id} className="hover:bg-slate-50/70">
                  <td className="py-3 px-5 font-mono font-semibold text-slate-900">
                    {r.route_id}
                  </td>
                  <td className="py-3 px-4 text-slate-700">{r.corridor_name}</td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                    {r.daily_trips}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                    {r.stop_count}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                    {r.scheduled_headway_s > 0 ? `${r.scheduled_headway_s}s` : '—'}
                  </td>
                  <td className="py-3 px-5 text-xs">
                    {gtfsFilter === 'clean' ? (
                      <span
                        className={
                          r.selected_role === 'train'
                            ? 'text-blue-700 font-medium'
                            : r.selected_role === 'held_out_transfer'
                            ? 'text-amber-700 font-medium'
                            : 'text-slate-500'
                        }
                      >
                        {r.selected_role === 'train'
                          ? 'Selected · Training'
                          : r.selected_role === 'held_out_transfer'
                          ? 'Selected · Held-out Transfer'
                          : 'Ranked Candidate'}
                      </span>
                    ) : (
                      <span className="text-red-700">{r.drop_reason}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
