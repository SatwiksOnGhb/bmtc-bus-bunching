/**
 * Seeded What-If Disruption Scenario Generator (mirroring sim/scenarios.py).
 * Owned by Simulation (Satwik Ray — Impact Feature: Rain & Bus Breakdown).
 *
 * Contract: makeScenario(name, seed, overrides?) -> ScenarioSpec
 * Both rain and bus breakdown are reproducibly seeded and also support
 * live mid-run injection from the Dispatcher Dashboard (Steps 8–9).
 */

import { createSeededRng } from '../common/stubs';
import { getCorridor } from '../data/corridors';

export type ScenarioName = 'normal' | 'rain' | 'breakdown';

export interface RainDisruptionParams {
  onset_s: number;
  end_s: number;
  ramp_s: number;
  min_speed_factor: number;   // e.g. 0.68 = 32% slower links in monsoon downpour
  variance_boost: number;     // e.g. 1.45 = 45% wider link travel time jitter
  demand_boost: number;       // e.g. 1.22 = 22% higher stop arrivals (mode shift from 2-wheelers)
}

export interface BreakdownDisruptionParams {
  trigger_t_s: number;
  target_bus_idx: number;     // 1-indexed bus number (e.g., 4 -> B04)
  target_stop_idx: number;    // mid-corridor stop where immobilization occurs
  duration_s: number;         // repair / tow clearance duration (s)
}

export interface DisruptionEventLog {
  t: number;
  type: 'rain_onset' | 'breakdown_start' | 'breakdown_cleared';
  bus_id?: string;
  stop_idx?: number;
  stop_name?: string;
  duration_s?: number;
  stranded_pax?: number;
  summary: string;
}

export interface ScenarioSpec {
  name: ScenarioName;
  seed: number;
  route_id: string;
  label: string;
  description: string;
  rain: RainDisruptionParams | null;
  breakdown: BreakdownDisruptionParams | null;
  getSpeedMultiplier(t: number, stopIdx: number): number;
  getVarianceMultiplier(t: number): number;
  getDemandMultiplier(t: number): number;
}

export interface ScenarioOverrides {
  route_id?: string;
  rain_onset_min?: number;
  rain_speed_drop_pct?: number; // 15..50
  breakdown_trigger_min?: number;
  breakdown_duration_min?: number;
  breakdown_bus_num?: number;
}

/**
 * Seeded factory mirroring make_scenario(name, seed) from the PDF spec.
 */
export function makeScenario(
  name: ScenarioName,
  seed: number,
  overrides?: ScenarioOverrides,
): ScenarioSpec {
  const rng = createSeededRng(seed * 7919 + (name === 'rain' ? 101 : name === 'breakdown' ? 211 : 17));
  const routeId = overrides?.route_id ?? '500D';
  const corridor = getCorridor(routeId);

  if (name === 'normal') {
    return {
      name: 'normal',
      seed,
      route_id: routeId,
      label: 'Normal Operations',
      description: 'Illustrative traffic speeds and peak boarding demand for the browser simulation.',
      rain: null,
      breakdown: null,
      getSpeedMultiplier: () => 1.0,
      getVarianceMultiplier: () => 1.0,
      getDemandMultiplier: () => 1.0,
    };
  }

  if (name === 'rain') {
    const onsetMin = overrides?.rain_onset_min ?? Math.round(18 + rng() * 10);
    const speedDropPct = overrides?.rain_speed_drop_pct ?? Math.round(28 + rng() * 8);
    const minSpeedFactor = Number(Math.max(0.48, Math.min(0.88, 1 - speedDropPct / 100)).toFixed(2));
    const rain: RainDisruptionParams = {
      onset_s: onsetMin * 60,
      end_s: (onsetMin + 70) * 60,
      ramp_s: 300, // 5-minute storm intensification
      min_speed_factor: minSpeedFactor,
      variance_boost: Number((1.25 + (speedDropPct / 100) * 0.7).toFixed(2)),
      demand_boost: Number((1.12 + (speedDropPct / 100) * 0.35).toFixed(2)),
    };

    const intensityAt = (t: number): number => {
      if (t < rain.onset_s || t > rain.end_s) return 0;
      const sinceOnset = t - rain.onset_s;
      if (sinceOnset < rain.ramp_s) return sinceOnset / rain.ramp_s;
      const beforeEnd = rain.end_s - t;
      if (beforeEnd < rain.ramp_s) return beforeEnd / rain.ramp_s;
      return 1.0;
    };

    return {
      name: 'rain',
      seed,
      route_id: routeId,
      label: 'Bengaluru Monsoon Rain',
      description: `Waterlogged arterial slowdown (−${speedDropPct}% link speed from t=${onsetMin}m) with higher travel-time variance and commuter surge.`,
      rain,
      breakdown: null,
      getSpeedMultiplier(t: number, stopIdx: number) {
        const alpha = intensityAt(t);
        if (alpha <= 0) return 1.0;
        // Major junctions & flyovers suffer extra waterlogging friction
        const hubExtra = corridor.stops[stopIdx]?.is_major_hub ? 0.94 : 1.0;
        const factor = 1 - alpha * (1 - rain.min_speed_factor);
        return Math.max(0.45, factor * (1 - alpha * (1 - hubExtra)));
      },
      getVarianceMultiplier(t: number) {
        const alpha = intensityAt(t);
        return 1 + alpha * (rain.variance_boost - 1);
      },
      getDemandMultiplier(t: number) {
        const alpha = intensityAt(t);
        return 1 + alpha * (rain.demand_boost - 1);
      },
    };
  }

  // Breakdown scenario: mid-fleet bus immobilized mid-corridor, offloading riders onto stop queue
  const triggerMin = overrides?.breakdown_trigger_min ?? Math.round(24 + rng() * 10);
  const durationMin = overrides?.breakdown_duration_min ?? Math.round(18 + rng() * 6);
  const targetBusIdx =
    overrides?.breakdown_bus_num ?? Math.min(corridor.fleet_size, Math.max(3, Math.round(3 + rng() * 3)));
  const targetStopIdx = Math.max(
    4,
    Math.min(corridor.stops.length - 5, Math.floor(corridor.stops.length * (0.35 + rng() * 0.2))),
  );
  const stopName = corridor.stops[targetStopIdx]?.name ?? `Stop #${targetStopIdx + 1}`;
  const busLabel = `${routeId}-B${String(targetBusIdx).padStart(2, '0')}`;

  const breakdown: BreakdownDisruptionParams = {
    trigger_t_s: triggerMin * 60,
    target_bus_idx: targetBusIdx,
    target_stop_idx: targetStopIdx,
    duration_s: durationMin * 60,
  };

  return {
    name: 'breakdown',
    seed,
    route_id: routeId,
    label: 'Mid-Corridor Bus Breakdown',
    description: `${busLabel} immobilized for ${durationMin} min near ${stopName} (around t=${triggerMin}m), offloading passengers and creating a downstream double-headway gap.`,
    rain: null,
    breakdown,
    getSpeedMultiplier: () => 1.0,
    getVarianceMultiplier: () => 1.0,
    getDemandMultiplier: () => 1.0,
  };
}
