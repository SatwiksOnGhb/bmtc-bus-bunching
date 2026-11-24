/**
 * Cleaned Bengaluru BMTC corridor stop sequences and geometry (data/corridors.ts).
 * Grounded in real Bengaluru landmarks & coordinates along:
 *  - 500D: Hebbal -> Central Silk Board (Outer Ring Road, train)
 *  - 335E: Kempegowda Bus Station (Majestic) -> Kadugodi (Old Airport Rd / ITPL, train)
 *  - G-4:  Brigade Road -> Bannerghatta National Park (Bannerghatta Rd, held-out transfer)
 */

export interface CorridorStop {
  stop_idx: number;
  stop_id: string;
  name: string;
  lat: number;
  lon: number;
  cum_dist_km: number;
  link_dist_m: number;     // distance from previous stop (0 for origin)
  demand_weight: number;   // relative passenger arrival intensity [0.4 .. 2.2]
  is_major_hub: boolean;
}

export interface CorridorDefinition {
  route_id: string;
  corridor_name: string;
  origin: string;
  destination: string;
  split: 'train' | 'held_out_transfer';
  scheduled_headway_s: number;
  fleet_size: number;
  daily_trips: number;
  stops: CorridorStop[];
}

interface RawStopSeed {
  id: string;
  name: string;
  lat: number;
  lon: number;
  demand_weight: number;
  is_major_hub?: boolean;
}

/** Haversine road-adjusted distance (×1.18 urban Bengaluru winding factor) in meters */
export function haversineRoadMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const straight = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(straight * 1.18);
}

function buildStops(seeds: RawStopSeed[]): CorridorStop[] {
  let cumMeters = 0;
  return seeds.map((s, idx) => {
    const linkMeters =
      idx === 0
        ? 0
        : haversineRoadMeters(seeds[idx - 1].lat, seeds[idx - 1].lon, s.lat, s.lon);
    cumMeters += linkMeters;
    return {
      stop_idx: idx,
      stop_id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      cum_dist_km: Number((cumMeters / 1000).toFixed(2)),
      link_dist_m: linkMeters,
      demand_weight: s.demand_weight,
      is_major_hub: Boolean(s.is_major_hub),
    };
  });
}

const STOPS_500D: RawStopSeed[] = [
  { id: 'BMTC-500D-01', name: 'Hebbal Flyover', lat: 13.0358, lon: 77.5970, demand_weight: 1.8, is_major_hub: true },
  { id: 'BMTC-500D-02', name: 'Veerannapalya', lat: 13.0402, lon: 77.6135, demand_weight: 1.0 },
  { id: 'BMTC-500D-03', name: 'Nagawara Junction', lat: 13.0445, lon: 77.6208, demand_weight: 1.7, is_major_hub: true },
  { id: 'BMTC-500D-04', name: 'Hennur Cross', lat: 13.0342, lon: 77.6382, demand_weight: 1.2 },
  { id: 'BMTC-500D-05', name: 'Kalyan Nagar ORR', lat: 13.0252, lon: 77.6485, demand_weight: 1.3 },
  { id: 'BMTC-500D-06', name: 'Banaswadi Ring Rd', lat: 13.0145, lon: 77.6580, demand_weight: 1.1 },
  { id: 'BMTC-500D-07', name: 'Ramamurthy Nagar', lat: 13.0102, lon: 77.6742, demand_weight: 1.3 },
  { id: 'BMTC-500D-08', name: 'KR Puram Railway Stn', lat: 13.0012, lon: 77.6852, demand_weight: 2.0, is_major_hub: true },
  { id: 'BMTC-500D-09', name: 'Mahadevapura ORR', lat: 12.9905, lon: 77.6948, demand_weight: 1.5 },
  { id: 'BMTC-500D-10', name: 'Doddanekundi', lat: 12.9788, lon: 77.6986, demand_weight: 1.4 },
  { id: 'BMTC-500D-11', name: 'Karthik Nagar', lat: 12.9675, lon: 77.6995, demand_weight: 1.2 },
  { id: 'BMTC-500D-12', name: 'Marathahalli Bridge', lat: 12.9569, lon: 77.7011, demand_weight: 2.2, is_major_hub: true },
  { id: 'BMTC-500D-13', name: 'Kadubeesanahalli', lat: 12.9368, lon: 77.6974, demand_weight: 1.7 },
  { id: 'BMTC-500D-14', name: 'Ecospace / Bellandur', lat: 12.9279, lon: 77.6812, demand_weight: 2.1, is_major_hub: true },
  { id: 'BMTC-500D-15', name: 'Iblur Junction', lat: 12.9212, lon: 77.6650, demand_weight: 1.4 },
  { id: 'BMTC-500D-16', name: 'Agara Flyover', lat: 12.9225, lon: 77.6480, demand_weight: 1.3 },
  { id: 'BMTC-500D-17', name: 'HSR Layout 14th Main', lat: 12.9178, lon: 77.6340, demand_weight: 1.5 },
  { id: 'BMTC-500D-18', name: 'Central Silk Board', lat: 12.9172, lon: 77.6228, demand_weight: 2.0, is_major_hub: true },
];

const STOPS_335E: RawStopSeed[] = [
  { id: 'BMTC-335E-01', name: 'Kempegowda Bus Stn (Majestic)', lat: 12.9776, lon: 77.5713, demand_weight: 2.2, is_major_hub: true },
  { id: 'BMTC-335E-02', name: 'KR Circle', lat: 12.9754, lon: 77.5862, demand_weight: 1.1 },
  { id: 'BMTC-335E-03', name: 'Corporation Circle', lat: 12.9682, lon: 77.5876, demand_weight: 1.4 },
  { id: 'BMTC-335E-04', name: 'Richmond Circle', lat: 12.9660, lon: 77.5992, demand_weight: 1.2 },
  { id: 'BMTC-335E-05', name: 'Mayo Hall / MG Rd', lat: 12.9730, lon: 77.6118, demand_weight: 1.7, is_major_hub: true },
  { id: 'BMTC-335E-06', name: 'Trinity Circle', lat: 12.9728, lon: 77.6202, demand_weight: 1.3 },
  { id: 'BMTC-335E-07', name: 'Command Hospital', lat: 12.9662, lon: 77.6318, demand_weight: 1.1 },
  { id: 'BMTC-335E-08', name: 'Domlur Flyover', lat: 12.9609, lon: 77.6387, demand_weight: 1.8, is_major_hub: true },
  { id: 'BMTC-335E-09', name: 'Kodihalli', lat: 12.9598, lon: 77.6485, demand_weight: 1.2 },
  { id: 'BMTC-335E-10', name: 'HAL Main Gate', lat: 12.9585, lon: 77.6650, demand_weight: 1.6, is_major_hub: true },
  { id: 'BMTC-335E-11', name: 'Murugeshpalya', lat: 12.9570, lon: 77.6565, demand_weight: 1.3 },
  { id: 'BMTC-335E-12', name: 'Konena Agrahara', lat: 12.9554, lon: 77.6752, demand_weight: 1.0 },
  { id: 'BMTC-335E-13', name: 'HAL Heritage Centre', lat: 12.9548, lon: 77.6855, demand_weight: 1.1 },
  { id: 'BMTC-335E-14', name: 'Marathahalli Market', lat: 12.9562, lon: 77.6995, demand_weight: 2.0, is_major_hub: true },
  { id: 'BMTC-335E-15', name: 'Kundalahalli Gate', lat: 12.9572, lon: 77.7152, demand_weight: 1.7 },
  { id: 'BMTC-335E-16', name: 'Brookefield', lat: 12.9648, lon: 77.7178, demand_weight: 1.5 },
  { id: 'BMTC-335E-17', name: 'Kundalahalli Colony', lat: 12.9718, lon: 77.7192, demand_weight: 1.3 },
  { id: 'BMTC-335E-18', name: 'Graphite India', lat: 12.9775, lon: 77.7265, demand_weight: 1.6 },
  { id: 'BMTC-335E-19', name: 'ITPL Main Gate', lat: 12.9854, lon: 77.7364, demand_weight: 2.1, is_major_hub: true },
  { id: 'BMTC-335E-20', name: 'Kadugodi Bus Stand', lat: 12.9968, lon: 77.7592, demand_weight: 1.5, is_major_hub: true },
];

const STOPS_G4: RawStopSeed[] = [
  { id: 'BMTC-G4-01', name: 'Brigade Road / Mayo Hall', lat: 12.9718, lon: 77.6075, demand_weight: 1.9, is_major_hub: true },
  { id: 'BMTC-G4-02', name: 'Richmond Town', lat: 12.9642, lon: 77.6040, demand_weight: 1.2 },
  { id: 'BMTC-G4-03', name: 'Adugodi Police Qtrs', lat: 12.9465, lon: 77.6088, demand_weight: 1.3 },
  { id: 'BMTC-G4-04', name: 'Dairy Circle', lat: 12.9398, lon: 77.6012, demand_weight: 1.7, is_major_hub: true },
  { id: 'BMTC-G4-05', name: 'Sagar Apollo Hospital', lat: 12.9295, lon: 77.6004, demand_weight: 1.4 },
  { id: 'BMTC-G4-06', name: 'Jayadeva Hospital', lat: 12.9170, lon: 77.5998, demand_weight: 2.1, is_major_hub: true },
  { id: 'BMTC-G4-07', name: 'BTM Layout Water Tank', lat: 12.9102, lon: 77.6010, demand_weight: 1.6 },
  { id: 'BMTC-G4-08', name: 'Vega City Mall / Bilekahalli', lat: 12.9052, lon: 77.6014, demand_weight: 1.5 },
  { id: 'BMTC-G4-09', name: 'IIM Bangalore', lat: 12.8955, lon: 77.6018, demand_weight: 1.6, is_major_hub: true },
  { id: 'BMTC-G4-10', name: 'Arekere Gate', lat: 12.8858, lon: 77.6002, demand_weight: 1.4 },
  { id: 'BMTC-G4-11', name: 'Hulimavu Gate', lat: 12.8768, lon: 77.5988, demand_weight: 1.5 },
  { id: 'BMTC-G4-12', name: 'Meenakshi Temple', lat: 12.8702, lon: 77.5956, demand_weight: 1.4 },
  { id: 'BMTC-G4-13', name: 'Gottigere', lat: 12.8576, lon: 77.5892, demand_weight: 1.3 },
  { id: 'BMTC-G4-14', name: 'Basavanapura Gate', lat: 12.8452, lon: 77.5855, demand_weight: 1.0 },
  { id: 'BMTC-G4-15', name: 'Koli Farm Gate', lat: 12.8280, lon: 77.5812, demand_weight: 0.9 },
  { id: 'BMTC-G4-16', name: 'Bannerghatta National Park', lat: 12.8007, lon: 77.5774, demand_weight: 1.4, is_major_hub: true },
];

export const CORRIDORS: Record<string, CorridorDefinition> = {
  '500D': {
    route_id: '500D',
    corridor_name: 'Outer Ring Road Express',
    origin: 'Hebbal',
    destination: 'Central Silk Board',
    split: 'train',
    scheduled_headway_s: 360,
    fleet_size: 12,
    daily_trips: 312,
    stops: buildStops(STOPS_500D),
  },
  '335E': {
    route_id: '335E',
    corridor_name: 'Old Airport Road — ITPL',
    origin: 'Kempegowda Bus Station (Majestic)',
    destination: 'Kadugodi Bus Stand',
    split: 'train',
    scheduled_headway_s: 420,
    fleet_size: 11,
    daily_trips: 284,
    stops: buildStops(STOPS_335E),
  },
  'G-4': {
    route_id: 'G-4',
    corridor_name: 'Bannerghatta Main Road',
    origin: 'Brigade Road',
    destination: 'Bannerghatta National Park',
    split: 'held_out_transfer',
    scheduled_headway_s: 480,
    fleet_size: 9,
    daily_trips: 218,
    stops: buildStops(STOPS_G4),
  },
};

export const CORRIDOR_LIST: CorridorDefinition[] = Object.values(CORRIDORS);

export function getCorridor(routeId: string): CorridorDefinition {
  return CORRIDORS[routeId] ?? CORRIDORS['500D'];
}
