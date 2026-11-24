/**
 * Frozen Week-1 contracts (mirroring common/schemas.py).
 * Shared across Simulation (Satwik), Prediction (Vikas), and Control (Varun).
 * Changed only by a PR all three owners approve.
 */

export interface BusState {
  bus_id: string;
  route_id: string;
  t: number;              // sim time, seconds
  stop_idx: number;       // last stop reached
  lat: number;
  lon: number;
  fwd_headway_s: number;  // gap to the bus ahead (s)
  bwd_headway_s: number;  // gap to the bus behind (s)
  sched_dev_s: number;    // positive = late (s)
  load: number;           // passengers currently onboard
  waiting_at_stop: number;
}

export interface Prediction {
  bus_id: string;
  p_bunch: number;        // calibrated probability in [0, 1]
  horizon_stops: number;  // k in {3, 5, 8}
}

export interface Snapshot {
  t: number;
  policy: string;
  scenario: string;
  buses: BusState[];
  predictions: Prediction[];
  holds: Record<string, number>; // bus_id -> hold seconds
  kpis: Record<string, number>;
}

/**
 * Per-bus observation vector passed to Policy.act(obs).
 * Includes predictor's bunching probability p_bunch so MAPPO + Prediction
 * forms one integrated control loop.
 */
export interface BusObservation {
  bus_id: string;
  route_id: string;
  stop_idx: number;
  fwd_headway_s: number;
  bwd_headway_s: number;
  sched_dev_s: number;
  load: number;
  waiting_at_stop: number;
  p_bunch: number;
}

export interface EnvResetOptions {
  scenario?: 'normal' | 'rain' | 'breakdown';
  route_id?: string;
}

export interface EnvStepResult {
  observations: Record<string, BusObservation>;
  rewards: Record<string, number>;
  terminations: Record<string, boolean>;
  truncations: Record<string, boolean>;
  infos: Record<string, BusState>;
}

/** Contract 2: Environment (PettingZoo Parallel API shape) */
export interface HoldingEnv {
  readonly name: string;
  reset(seed: number, options?: EnvResetOptions): {
    observations: Record<string, BusObservation>;
    infos: Record<string, BusState>;
  };
  step(actions: Record<string, number>): EnvStepResult;
  snapshot(policyName?: string): Snapshot;
}

/** Contract 3: Predictor */
export interface BunchingPredictor {
  readonly name: string;
  predict(history: BusState[]): Prediction;
}

/** Contract 4: Policy */
export interface HoldingPolicy {
  readonly name: string;
  act(observations: Record<string, BusObservation>): Record<string, number>;
}

/** Contract 5: Snapshot feed */
export interface SnapshotFeed {
  readonly name: string;
  stream(steps: number): Generator<Snapshot, void, unknown>;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export function validateBusState(state: BusState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!state.bus_id || typeof state.bus_id !== 'string') {
    issues.push({ field: 'bus_id', message: 'must be a non-empty string' });
  }
  if (!state.route_id || typeof state.route_id !== 'string') {
    issues.push({ field: 'route_id', message: 'must be a non-empty string' });
  }
  if (!Number.isFinite(state.t) || state.t < 0) {
    issues.push({ field: 't', message: 'must be a non-negative finite number' });
  }
  if (!Number.isInteger(state.stop_idx) || state.stop_idx < 0) {
    issues.push({ field: 'stop_idx', message: 'must be an integer >= 0' });
  }
  if (state.lat < 12.7 || state.lat > 13.3) {
    issues.push({ field: 'lat', message: 'outside Bengaluru latitude bounds [12.7, 13.3]' });
  }
  if (state.lon < 77.3 || state.lon > 77.9) {
    issues.push({ field: 'lon', message: 'outside Bengaluru longitude bounds [77.3, 77.9]' });
  }
  if (!Number.isFinite(state.fwd_headway_s) || state.fwd_headway_s < 0) {
    issues.push({ field: 'fwd_headway_s', message: 'must be >= 0 seconds' });
  }
  if (!Number.isFinite(state.bwd_headway_s) || state.bwd_headway_s < 0) {
    issues.push({ field: 'bwd_headway_s', message: 'must be >= 0 seconds' });
  }
  if (!Number.isFinite(state.sched_dev_s)) {
    issues.push({ field: 'sched_dev_s', message: 'must be finite' });
  }
  if (!Number.isInteger(state.load) || state.load < 0) {
    issues.push({ field: 'load', message: 'must be an integer >= 0' });
  }
  if (!Number.isInteger(state.waiting_at_stop) || state.waiting_at_stop < 0) {
    issues.push({ field: 'waiting_at_stop', message: 'must be an integer >= 0' });
  }
  return issues;
}

export function validatePrediction(pred: Prediction, allowedHorizons: readonly number[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!pred.bus_id) {
    issues.push({ field: 'bus_id', message: 'must be a non-empty string' });
  }
  if (!Number.isFinite(pred.p_bunch) || pred.p_bunch < 0 || pred.p_bunch > 1) {
    issues.push({ field: 'p_bunch', message: 'calibrated probability must lie in [0, 1]' });
  }
  if (!allowedHorizons.includes(pred.horizon_stops)) {
    issues.push({
      field: 'horizon_stops',
      message: `must be one of [${allowedHorizons.join(', ')}]`,
    });
  }
  return issues;
}

export function validateSnapshot(
  snap: Snapshot,
  allowedHolds: readonly number[],
  allowedHorizons: readonly number[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Number.isFinite(snap.t) || snap.t < 0) {
    issues.push({ field: 't', message: 'must be a non-negative finite number' });
  }
  if (!snap.policy) {
    issues.push({ field: 'policy', message: 'must specify active policy' });
  }
  if (!snap.scenario) {
    issues.push({ field: 'scenario', message: 'must specify active scenario' });
  }
  snap.buses.forEach((bus, idx) => {
    for (const issue of validateBusState(bus)) {
      issues.push({ field: `buses[${idx}].${issue.field}`, message: issue.message });
    }
  });
  snap.predictions.forEach((pred, idx) => {
    for (const issue of validatePrediction(pred, allowedHorizons)) {
      issues.push({ field: `predictions[${idx}].${issue.field}`, message: issue.message });
    }
  });
  for (const [busId, holdSec] of Object.entries(snap.holds)) {
    if (!allowedHolds.includes(holdSec)) {
      issues.push({
        field: `holds.${busId}`,
        message: `hold ${holdSec}s not in discrete set [${allowedHolds.join(', ')}]`,
      });
    }
  }
  for (const [kpiName, val] of Object.entries(snap.kpis)) {
    if (!Number.isFinite(val)) {
      issues.push({ field: `kpis.${kpiName}`, message: 'must be a finite number' });
    }
  }
  return issues;
}

export const PYTHON_SCHEMAS_REFERENCE = `# common/schemas.py: frozen in week 1, changed only by a PR all three approve
from pydantic import BaseModel

class BusState(BaseModel):
    bus_id: str
    route_id: str
    t: float                # sim time, s
    stop_idx: int           # last stop reached
    lat: float
    lon: float
    fwd_headway_s: float    # gap to the bus ahead
    bwd_headway_s: float    # gap to the bus behind
    sched_dev_s: float      # positive = late
    load: int
    waiting_at_stop: int

class Prediction(BaseModel):
    bus_id: str
    p_bunch: float          # calibrated probability
    horizon_stops: int

class Snapshot(BaseModel):
    t: float
    policy: str
    scenario: str
    buses: list[BusState]
    predictions: list[Prediction]
    holds: dict[str, float] # bus_id -> hold seconds
    kpis: dict[str, float]`;

export const TYPESCRIPT_SCHEMAS_REFERENCE = `// src/common/schemas.ts: TypeScript mirror of common/schemas.py
export interface BusState {
  bus_id: string;
  route_id: string;
  t: number;              // sim time, s
  stop_idx: number;       // last stop reached
  lat: number;
  lon: number;
  fwd_headway_s: number;  // gap to the bus ahead
  bwd_headway_s: number;  // gap to the bus behind
  sched_dev_s: number;    // positive = late
  load: number;
  waiting_at_stop: number;
}

export interface Prediction {
  bus_id: string;
  p_bunch: number;        // calibrated probability [0, 1]
  horizon_stops: number;  // k in {3, 5, 8}
}

export interface Snapshot {
  t: number;
  policy: string;
  scenario: string;
  buses: BusState[];
  predictions: Prediction[];
  holds: Record<string, number>;
  kpis: Record<string, number>;
}`;
