/**
 * Illustrative speed and demand profiles for the browser demo.
 * Use data/gps_clean.py for source-trace processing and the SUMO handoff.
 */

export interface HourlyTrafficProfile {
  hour: number;               // 7 .. 19 (7 AM to 7 PM)
  label: string;              // "07:00" .. "19:00"
  gps_mean_kmh: number;       // illustrative bus speed for this browser fixture
  gps_p25_kmh: number;        // 25th percentile congested speed
  gps_p75_kmh: number;        // 75th percentile free-ish speed
  gtfs_scheduled_kmh: number; // implied GTFS timetable speed
  pax_arrival_mult: number;   // relative passenger demand multiplier by time of day
  scheduled_headway_s: number;
  mixed_traffic_share: {
    two_wheelers_pct: number;
    cars_pct: number;
    autos_pct: number;
    buses_pct: number;
  };
}

export interface GpsCleaningSummary {
  raw_gps_pings: number;
  unique_buses_observed: number;
  window: string;
  dropped_speed_outliers_pct: number;
  dropped_depot_stationary_pct: number;
  retained_corridor_pings: number;
  mean_speed_gap_vs_gtfs_kmh: number;
}

export const CNI_GPS_SUMMARY: GpsCleaningSummary = {
  raw_gps_pings: 1_842_600,
  unique_buses_observed: 1_984,
  window: '07:00 – 19:00 IST (browser simulation fixture)',
  dropped_speed_outliers_pct: 2.8,
  dropped_depot_stationary_pct: 11.4,
  retained_corridor_pings: 1_580_950,
  mean_speed_gap_vs_gtfs_kmh: -4.1,
};

interface HourSeed {
  hour: number;
  speed500D: number;
  speed335E: number;
  speedG4: number;
  paxMult: number;
  twoWheelers: number;
  cars: number;
  autos: number;
}

const HOURLY_SEEDS: HourSeed[] = [
  { hour: 7,  speed500D: 25.4, speed335E: 23.1, speedG4: 24.6, paxMult: 0.72, twoWheelers: 44, cars: 32, autos: 16 },
  { hour: 8,  speed500D: 18.2, speed335E: 16.4, speedG4: 18.8, paxMult: 1.38, twoWheelers: 47, cars: 33, autos: 13 },
  { hour: 9,  speed500D: 13.6, speed335E: 12.8, speedG4: 15.2, paxMult: 1.85, twoWheelers: 49, cars: 34, autos: 11 },
  { hour: 10, speed500D: 14.8, speed335E: 14.1, speedG4: 16.5, paxMult: 1.56, twoWheelers: 46, cars: 34, autos: 13 },
  { hour: 11, speed500D: 19.5, speed335E: 17.9, speedG4: 19.4, paxMult: 0.96, twoWheelers: 42, cars: 33, autos: 17 },
  { hour: 12, speed500D: 21.8, speed335E: 19.8, speedG4: 20.9, paxMult: 0.84, twoWheelers: 41, cars: 33, autos: 18 },
  { hour: 13, speed500D: 22.1, speed335E: 20.4, speedG4: 21.4, paxMult: 0.82, twoWheelers: 41, cars: 32, autos: 19 },
  { hour: 14, speed500D: 20.9, speed335E: 19.2, speedG4: 20.2, paxMult: 0.88, twoWheelers: 42, cars: 33, autos: 17 },
  { hour: 15, speed500D: 19.2, speed335E: 17.6, speedG4: 18.9, paxMult: 0.98, twoWheelers: 43, cars: 33, autos: 16 },
  { hour: 16, speed500D: 16.5, speed335E: 15.1, speedG4: 16.7, paxMult: 1.24, twoWheelers: 46, cars: 33, autos: 14 },
  { hour: 17, speed500D: 13.1, speed335E: 12.3, speedG4: 14.4, paxMult: 1.78, twoWheelers: 49, cars: 34, autos: 11 },
  { hour: 18, speed500D: 11.8, speed335E: 11.4, speedG4: 13.5, paxMult: 1.94, twoWheelers: 50, cars: 34, autos: 10 },
  { hour: 19, speed500D: 14.4, speed335E: 13.8, speedG4: 15.8, paxMult: 1.46, twoWheelers: 47, cars: 33, autos: 13 },
];

export function getHourlyTrafficProfile(routeId: string): HourlyTrafficProfile[] {
  const baseScheduledKmh = routeId === '500D' ? 21.7 : routeId === '335E' ? 18.5 : 18.8;
  const baseHeadwayS = routeId === '500D' ? 360 : routeId === '335E' ? 420 : 480;

  return HOURLY_SEEDS.map((h) => {
    const mean =
      routeId === '500D' ? h.speed500D : routeId === '335E' ? h.speed335E : h.speedG4;
    const spread = mean < 15 ? 3.2 : 2.6;
    const peakHeadwayAdjust = h.paxMult >= 1.5 ? 0.85 : h.paxMult <= 0.9 ? 1.15 : 1.0;
    const busesPct = Math.max(4, 100 - h.twoWheelers - h.cars - h.autos);

    return {
      hour: h.hour,
      label: `${String(h.hour).padStart(2, '0')}:00`,
      gps_mean_kmh: mean,
      gps_p25_kmh: Number(Math.max(6.5, mean - spread).toFixed(1)),
      gps_p75_kmh: Number((mean + spread * 1.15).toFixed(1)),
      gtfs_scheduled_kmh: baseScheduledKmh,
      pax_arrival_mult: h.paxMult,
      scheduled_headway_s: Math.round((baseHeadwayS * peakHeadwayAdjust) / 15) * 15,
      mixed_traffic_share: {
        two_wheelers_pct: h.twoWheelers,
        cars_pct: h.cars,
        autos_pct: h.autos,
        buses_pct: busesPct,
      },
    };
  });
}

export function getCalibratedSpeedKmh(routeId: string, hour: number): number {
  const profile = getHourlyTrafficProfile(routeId);
  const clamped = Math.max(7, Math.min(19, Math.floor(hour)));
  return profile.find((p) => p.hour === clamped)?.gps_mean_kmh ?? 16.0;
}

export function exportGpsCalibrationJson(routeId: string): string {
  return JSON.stringify(
    {
      route_id: routeId,
      data_source: 'synthetic_demo_fixture',
      source: CNI_GPS_SUMMARY.window,
      cleaning_summary: CNI_GPS_SUMMARY,
      hourly_profile: getHourlyTrafficProfile(routeId),
    },
    null,
    2,
  );
}
