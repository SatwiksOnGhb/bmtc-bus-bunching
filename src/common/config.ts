/**
 * Single configuration source of truth (mirroring common/config.yaml).
 * Holds route IDs, stop counts, hold action space, thresholds, and scenario defaults.
 * Rule #3: No magic numbers in code.
 */

export interface RouteSpec {
  route_id: string;
  corridor_name: string;
  origin: string;
  destination: string;
  split: 'train' | 'held_out_transfer';
  daily_trips: number;
  stop_count: number;
  corridor_length_km: number;
  scheduled_headway_s: number;
  fleet_size: number;
  anchor_lat: number;
  anchor_lon: number;
}

export interface ProjectConfig {
  project_name: string;
  city: string;
  data_licence: string;
  default_seed: number;
  evaluation_seeds: number[];
  hold_actions_s: number[];
  bunching_headway_ratio: number;
  prediction_horizons_stops: number[];
  history_window_stops: number;
  dwell_fixed_s: number;
  dwell_per_boarding_s: number;
  bus_capacity: number;
  mappo_hold_penalty_lambda: number;
  mappo_discount_per_min: number;
  alert_probability_threshold: number;
  scenarios: Array<'normal' | 'rain' | 'breakdown'>;
  routes: RouteSpec[];
}

export const DEFAULT_CONFIG: ProjectConfig = {
  project_name: 'bmtc-bunching',
  city: 'Bengaluru',
  data_licence: 'ODbL (Vonter/bmtc-gtfs) + CNI 2022 GPS',
  default_seed: 42,
  evaluation_seeds: [42, 108, 256],
  hold_actions_s: [0, 15, 30, 45, 60, 90],
  bunching_headway_ratio: 0.25,
  prediction_horizons_stops: [3, 5, 8],
  history_window_stops: 6,
  dwell_fixed_s: 8.0,
  dwell_per_boarding_s: 2.4,
  bus_capacity: 65,
  mappo_hold_penalty_lambda: 0.015,
  mappo_discount_per_min: 0.96,
  alert_probability_threshold: 0.65,
  scenarios: ['normal', 'rain', 'breakdown'],
  routes: [
    {
      route_id: '500D',
      corridor_name: 'Outer Ring Road Express',
      origin: 'Hebbal',
      destination: 'Central Silk Board',
      split: 'train',
      daily_trips: 312,
      stop_count: 18,
      corridor_length_km: 24.6,
      scheduled_headway_s: 360,
      fleet_size: 12,
      anchor_lat: 12.9716,
      anchor_lon: 77.6946,
    },
    {
      route_id: '335E',
      corridor_name: 'Old Airport Road — ITPL',
      origin: 'Kempegowda Bus Station (Majestic)',
      destination: 'Kadugodi Bus Stand',
      split: 'train',
      daily_trips: 284,
      stop_count: 20,
      corridor_length_km: 22.8,
      scheduled_headway_s: 420,
      fleet_size: 11,
      anchor_lat: 12.9698,
      anchor_lon: 77.6499,
    },
    {
      route_id: 'G-4',
      corridor_name: 'Bannerghatta Main Road',
      origin: 'Brigade Road',
      destination: 'Bannerghatta National Park',
      split: 'held_out_transfer',
      daily_trips: 218,
      stop_count: 16,
      corridor_length_km: 19.4,
      scheduled_headway_s: 480,
      fleet_size: 9,
      anchor_lat: 12.8996,
      anchor_lon: 77.6006,
    },
  ],
};

export interface TeamOwner {
  role: 'Control' | 'Simulation' | 'Prediction';
  owner: string;
  objective: string;
  core_piece: string;
  engineering_piece: string;
  impact_feature: string;
  directories: string[];
  handoffs: string[];
}

export const TEAM_WORK_SPLIT: TeamOwner[] = [
  {
    role: 'Control',
    owner: 'Varun D Sawalkar',
    objective: 'Objective 3',
    core_piece: 'Event-driven MAPPO holding controller',
    engineering_piece: 'Fast stub env, training & evaluation harness',
    impact_feature: 'AI vs current practice: passenger-hours saved per day',
    directories: ['control/', 'common/kpis.py'],
    handoffs: ['Policy.act(obs)', 'Trained shared actor', 'KPI module'],
  },
  {
    role: 'Simulation',
    owner: 'Satwik Ray',
    objective: 'Objective 1',
    core_piece: 'SUMO digital twin from GTFS + OSM',
    engineering_piece: 'Live dual-sim runner & snapshot stream',
    impact_feature: 'What-if disruptions: rain and bus breakdown',
    directories: ['sim/', 'common/schemas.py'],
    handoffs: ['BMTCHoldingEnv', 'make_scenario(name, seed)', 'Runner.stream()'],
  },
  {
    role: 'Prediction',
    owner: 'Vikas S Nidagunde',
    objective: 'Objectives 2 & 4',
    core_piece: 'GTFS/GPS EDA & calibrated LSTM/TCN predictor',
    engineering_piece: 'Real-time dispatcher dashboard',
    impact_feature: 'Early-warning alerts with Accept / Override',
    directories: ['data/', 'predict/', 'dashboard/'],
    handoffs: ['Predictor.predict(history)', 'Cleaned GTFS + GPS speeds', 'Live dashboard'],
  },
];

export function validateConfig(cfg: ProjectConfig): string[] {
  const errors: string[] = [];
  if (cfg.hold_actions_s.length < 2 || cfg.hold_actions_s[0] !== 0) {
    errors.push('hold_actions_s must start with 0s (no-hold option) and have at least 2 actions.');
  }
  for (let i = 1; i < cfg.hold_actions_s.length; i++) {
    if (cfg.hold_actions_s[i] <= cfg.hold_actions_s[i - 1]) {
      errors.push('hold_actions_s must be strictly increasing.');
      break;
    }
  }
  if (cfg.bunching_headway_ratio <= 0.05 || cfg.bunching_headway_ratio >= 0.75) {
    errors.push('bunching_headway_ratio must be in (0.05, 0.75).');
  }
  if (cfg.prediction_horizons_stops.some((k) => !Number.isInteger(k) || k <= 0)) {
    errors.push('prediction_horizons_stops must contain positive integers.');
  }
  if (cfg.mappo_hold_penalty_lambda < 0 || cfg.mappo_hold_penalty_lambda > 1) {
    errors.push('mappo_hold_penalty_lambda must lie in [0, 1].');
  }
  const trainCount = cfg.routes.filter((r) => r.split === 'train').length;
  const transferCount = cfg.routes.filter((r) => r.split === 'held_out_transfer').length;
  if (trainCount < 2 || transferCount < 1) {
    errors.push('Must specify at least 2 training routes and 1 held-out transfer route.');
  }
  return errors;
}

export function serializeConfigYaml(cfg: ProjectConfig): string {
  const routesYaml = cfg.routes
    .map(
      (r) => `  - route_id: "${r.route_id}"
    corridor: "${r.corridor_name}"
    split: "${r.split}"
    daily_trips: ${r.daily_trips}
    stop_count: ${r.stop_count}
    scheduled_headway_s: ${r.scheduled_headway_s}
    fleet_size: ${r.fleet_size}`,
    )
    .join('\n');

  return `# common/config.yaml — single source of truth (no magic numbers in code)
project: ${cfg.project_name}
city: ${cfg.city}
seeds:
  default: ${cfg.default_seed}
  evaluation: [${cfg.evaluation_seeds.join(', ')}]

control:
  hold_actions_s: [${cfg.hold_actions_s.join(', ')}]
  mappo_hold_penalty_lambda: ${cfg.mappo_hold_penalty_lambda}
  mappo_discount_per_min: ${cfg.mappo_discount_per_min}

prediction:
  bunching_headway_ratio: ${cfg.bunching_headway_ratio}
  horizons_stops: [${cfg.prediction_horizons_stops.join(', ')}]
  history_window_stops: ${cfg.history_window_stops}
  alert_probability_threshold: ${cfg.alert_probability_threshold}

simulation:
  dwell_fixed_s: ${cfg.dwell_fixed_s}
  dwell_per_boarding_s: ${cfg.dwell_per_boarding_s}
  bus_capacity: ${cfg.bus_capacity}
  scenarios: [${cfg.scenarios.join(', ')}]

routes:
${routesYaml}`;
}
