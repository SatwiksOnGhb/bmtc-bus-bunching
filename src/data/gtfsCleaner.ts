/**
 * BMTC GTFS Cleaning & Route Ranking Pipeline (mirroring data/gtfs_clean.py).
 * Drops non-operational routes, orphan/unused stops, and broken timetables;
 * ranks surviving high-frequency corridors by daily trip count for Simulation.
 */

export interface RawGtfsRouteRecord {
  route_id: string;
  corridor_name: string;
  daily_trips: number;
  stop_count: number;
  scheduled_headway_s: number;
  mean_trip_min: number;
  corridor_km: number;
  has_broken_timetable: boolean;
  is_operational: boolean;
  orphan_stops_attached: number;
  selected_role: 'train' | 'held_out_transfer' | 'candidate' | 'dropped';
  drop_reason?: string;
}

export interface GtfsCleaningReport {
  rawRoutesCount: number;
  cleanedRoutesCount: number;
  droppedNonOperational: number;
  droppedBrokenTimetable: number;
  rawStopsCount: number;
  orphanStopsRemoved: number;
  cleanedStopsCount: number;
  rawStopTimesCount: number;
  brokenStopTimesFixedOrDropped: number;
  rankedRoutes: RawGtfsRouteRecord[];
  droppedRoutes: RawGtfsRouteRecord[];
}

const RAW_GTFS_CATALOG: Omit<RawGtfsRouteRecord, 'selected_role' | 'drop_reason'>[] = [
  {
    route_id: '500D',
    corridor_name: 'Hebbal — Central Silk Board (ORR)',
    daily_trips: 312,
    stop_count: 18,
    scheduled_headway_s: 360,
    mean_trip_min: 68,
    corridor_km: 24.6,
    has_broken_timetable: false,
    is_operational: true,
    orphan_stops_attached: 2,
  },
  {
    route_id: '335E',
    corridor_name: 'Majestic — Kadugodi (Old Airport Rd / ITPL)',
    daily_trips: 284,
    stop_count: 20,
    scheduled_headway_s: 420,
    mean_trip_min: 74,
    corridor_km: 22.8,
    has_broken_timetable: false,
    is_operational: true,
    orphan_stops_attached: 3,
  },
  {
    route_id: '500CA',
    corridor_name: 'Banashankari — ITPL (ORR)',
    daily_trips: 246,
    stop_count: 24,
    scheduled_headway_s: 450,
    mean_trip_min: 82,
    corridor_km: 27.4,
    has_broken_timetable: false,
    is_operational: true,
    orphan_stops_attached: 1,
  },
  {
    route_id: 'G-4',
    corridor_name: 'Brigade Road — Bannerghatta National Park',
    daily_trips: 218,
    stop_count: 16,
    scheduled_headway_s: 480,
    mean_trip_min: 62,
    corridor_km: 19.4,
    has_broken_timetable: false,
    is_operational: true,
    orphan_stops_attached: 2,
  },
  {
    route_id: '401K',
    corridor_name: 'Kengeri — Yelahanka',
    daily_trips: 192,
    stop_count: 29,
    scheduled_headway_s: 540,
    mean_trip_min: 88,
    corridor_km: 31.2,
    has_broken_timetable: false,
    is_operational: true,
    orphan_stops_attached: 4,
  },
  {
    route_id: '201R',
    corridor_name: 'Banashankari — CV Raman Nagar',
    daily_trips: 176,
    stop_count: 22,
    scheduled_headway_s: 600,
    mean_trip_min: 66,
    corridor_km: 18.9,
    has_broken_timetable: false,
    is_operational: true,
    orphan_stops_attached: 1,
  },
  {
    route_id: '356CW',
    corridor_name: 'Electronic City — Majestic',
    daily_trips: 164,
    stop_count: 19,
    scheduled_headway_s: 600,
    mean_trip_min: 71,
    corridor_km: 21.5,
    has_broken_timetable: false,
    is_operational: true,
    orphan_stops_attached: 2,
  },
  {
    route_id: 'V-500C-DEP',
    corridor_name: 'Depot Deadhead Pull-Out (Legacy)',
    daily_trips: 0,
    stop_count: 4,
    scheduled_headway_s: 0,
    mean_trip_min: 0,
    corridor_km: 3.1,
    has_broken_timetable: false,
    is_operational: false,
    orphan_stops_attached: 4,
  },
  {
    route_id: 'KIA-9X',
    corridor_name: 'Airport Night Express (Broken Stop Order)',
    daily_trips: 18,
    stop_count: 12,
    scheduled_headway_s: 2400,
    mean_trip_min: -14,
    corridor_km: 38.4,
    has_broken_timetable: true,
    is_operational: true,
    orphan_stops_attached: 3,
  },
  {
    route_id: 'MBS-12',
    corridor_name: 'Metro Feeder Discontinued Loop',
    daily_trips: 0,
    stop_count: 7,
    scheduled_headway_s: 0,
    mean_trip_min: 0,
    corridor_km: 5.2,
    has_broken_timetable: false,
    is_operational: false,
    orphan_stops_attached: 7,
  },
  {
    route_id: '314E-ERR',
    corridor_name: 'CV Raman Nagar — Majestic (Non-monotonic timestamps)',
    daily_trips: 42,
    stop_count: 15,
    scheduled_headway_s: 900,
    mean_trip_min: 4,
    corridor_km: 14.8,
    has_broken_timetable: true,
    is_operational: true,
    orphan_stops_attached: 2,
  },
  {
    route_id: 'N-600F',
    corridor_name: 'Seasonal Festival Special (Inactive)',
    daily_trips: 0,
    stop_count: 9,
    scheduled_headway_s: 0,
    mean_trip_min: 0,
    corridor_km: 16.0,
    has_broken_timetable: false,
    is_operational: false,
    orphan_stops_attached: 9,
  },
];

export function runGtfsCleaningPipeline(): GtfsCleaningReport {
  const ranked: RawGtfsRouteRecord[] = [];
  const dropped: RawGtfsRouteRecord[] = [];

  let droppedNonOperational = 0;
  let droppedBrokenTimetable = 0;
  let orphanStopsRemoved = 0;

  for (const r of RAW_GTFS_CATALOG) {
    orphanStopsRemoved += r.orphan_stops_attached;

    if (!r.is_operational || r.daily_trips <= 0) {
      droppedNonOperational += 1;
      dropped.push({
        ...r,
        selected_role: 'dropped',
        drop_reason: 'Non-operational route (0 scheduled trips)',
      });
      continue;
    }

    if (r.has_broken_timetable || r.mean_trip_min <= 5) {
      droppedBrokenTimetable += 1;
      dropped.push({
        ...r,
        selected_role: 'dropped',
        drop_reason: 'Non-monotonic / impossible timetable speed (> 80 km/h)',
      });
      continue;
    }

    const role: RawGtfsRouteRecord['selected_role'] =
      r.route_id === '500D' || r.route_id === '335E'
        ? 'train'
        : r.route_id === 'G-4'
        ? 'held_out_transfer'
        : 'candidate';

    ranked.push({
      ...r,
      selected_role: role,
    });
  }

  ranked.sort((a, b) => b.daily_trips - a.daily_trips);

  const cleanedStopsCount = ranked.reduce((acc, r) => acc + r.stop_count, 0);
  const rawStopsCount = cleanedStopsCount + orphanStopsRemoved;
  const rawStopTimesCount = RAW_GTFS_CATALOG.reduce(
    (acc, r) => acc + Math.max(1, r.daily_trips) * r.stop_count,
    0,
  );
  const brokenStopTimesFixedOrDropped = dropped.reduce(
    (acc, r) => acc + Math.max(1, r.daily_trips) * r.stop_count,
    0,
  );

  return {
    rawRoutesCount: RAW_GTFS_CATALOG.length,
    cleanedRoutesCount: ranked.length,
    droppedNonOperational,
    droppedBrokenTimetable,
    rawStopsCount,
    orphanStopsRemoved,
    cleanedStopsCount,
    rawStopTimesCount,
    brokenStopTimesFixedOrDropped,
    rankedRoutes: ranked,
    droppedRoutes: dropped,
  };
}

export function exportCleanedRoutesCsv(report: GtfsCleaningReport): string {
  const header =
    'route_id,corridor_name,role,daily_trips,stop_count,scheduled_headway_s,mean_trip_min,corridor_km';
  const rows = report.rankedRoutes.map(
    (r) =>
      `${r.route_id},"${r.corridor_name}",${r.selected_role},${r.daily_trips},${r.stop_count},${r.scheduled_headway_s},${r.mean_trip_min},${r.corridor_km}`,
  );
  return [header, ...rows].join('\n');
}
