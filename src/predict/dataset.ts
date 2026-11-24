/**
 * Leak-Free Bunching Dataset & Sequence Feature Builder (predict/dataset.ts).
 * Mirroring predict/labels.py — owned by Prediction (Vikas S Nidagunde).
 *
 * Strictly splits by episode/corridor (never by row) to prevent temporal leakage:
 *  - train:  500D & 335E (seeds 42, 108)
 *  - val:    500D & 335E (seed 256) — used for temperature scaling calibration
 *  - test:   G-4 held-out corridor (seeds 42, 108, 256) — zero-shot transfer test
 */

import { DEFAULT_CONFIG, type ProjectConfig } from '../common/config';
import type { BusState } from '../common/schemas';
import { createBaselinePolicy } from '../control/baselines';
import { getCorridor } from '../data/corridors';
import { BMTCHoldingEnv, type StopArrivalEvent } from '../sim/corridorEnv';

export type DatasetSplit = 'train' | 'val' | 'test_transfer';

export interface SequenceSample {
  sample_id: string;
  episode_id: string;
  split: DatasetSplit;
  route_id: string;
  hour: number;
  bus_id: string;
  stop_idx: number;
  stop_name: string;
  scheduled_headway_s: number;
  history: BusState[];            // last N stop states (oldest -> newest)
  dwell_history_s: number[];      // aligned dwell durations
  // Ground truth lookahead labels: 1 if bus bunches within next k stops
  labels: Record<number, 0 | 1>;  // k in {3, 5, 8}
  lead_time_min: Record<number, number | null>; // exact minutes until first future bunch
}

export interface BunchingDatasetBundle {
  samples: SequenceSample[];
  episodeSplits: Record<DatasetSplit, string[]>;
  stats: {
    totalSamples: number;
    trainSamples: number;
    valSamples: number;
    testTransferSamples: number;
    positiveRateByK: Record<number, number>;
    meanLeadTimeMinByK: Record<number, number>;
  };
}

interface EpisodeSpec {
  episode_id: string;
  split: DatasetSplit;
  route_id: string;
  seed: number;
  hour: number;
  policy_id: 'no_control' | 'schedule';
}

const EPISODE_SPECS: EpisodeSpec[] = [
  // Train episodes (500D & 335E, seeds 42 & 108)
  { episode_id: 'ep-500D-s42-h9-nc', split: 'train', route_id: '500D', seed: 42, hour: 9, policy_id: 'no_control' },
  { episode_id: 'ep-500D-s108-h18-sc', split: 'train', route_id: '500D', seed: 108, hour: 18, policy_id: 'schedule' },
  { episode_id: 'ep-335E-s42-h9-nc', split: 'train', route_id: '335E', seed: 42, hour: 9, policy_id: 'no_control' },
  { episode_id: 'ep-335E-s108-h18-sc', split: 'train', route_id: '335E', seed: 108, hour: 18, policy_id: 'schedule' },
  // Validation / Calibration episodes (500D & 335E, unseen seed 256)
  { episode_id: 'ep-500D-s256-h9-nc', split: 'val', route_id: '500D', seed: 256, hour: 9, policy_id: 'no_control' },
  { episode_id: 'ep-335E-s256-h18-sc', split: 'val', route_id: '335E', seed: 256, hour: 18, policy_id: 'schedule' },
  // Zero-shot transfer test episodes (held-out unseen route G-4)
  { episode_id: 'ep-G4-s42-h9-nc', split: 'test_transfer', route_id: 'G-4', seed: 42, hour: 9, policy_id: 'no_control' },
  { episode_id: 'ep-G4-s256-h18-sc', split: 'test_transfer', route_id: 'G-4', seed: 256, hour: 18, policy_id: 'schedule' },
];

function eventToBusState(ev: StopArrivalEvent, lat: number, lon: number): BusState {
  return {
    bus_id: ev.bus_id,
    route_id: ev.route_id,
    t: ev.arrival_t,
    stop_idx: ev.stop_idx,
    lat,
    lon,
    fwd_headway_s: ev.fwd_headway_s,
    bwd_headway_s: ev.bwd_headway_s,
    sched_dev_s: ev.sched_dev_s,
    load: ev.load_after,
    waiting_at_stop: ev.waiting_before,
  };
}

let cachedBundle: { key: string; bundle: BunchingDatasetBundle } | null = null;

export function buildLeakFreeBunchingDataset(
  config: ProjectConfig = DEFAULT_CONFIG,
): BunchingDatasetBundle {
  const cacheKey = `${config.bunching_headway_ratio}-${config.history_window_stops}-${config.prediction_horizons_stops.join(',')}`;
  if (cachedBundle && cachedBundle.key === cacheKey) {
    return cachedBundle.bundle;
  }

  const horizons = config.prediction_horizons_stops;
  const windowN = config.history_window_stops;
  const samples: SequenceSample[] = [];
  const episodeSplits: Record<DatasetSplit, string[]> = {
    train: [],
    val: [],
    test_transfer: [],
  };

  for (const spec of EPISODE_SPECS) {
    episodeSplits[spec.split].push(spec.episode_id);
    const env = new BMTCHoldingEnv(config);
    let { observations } = env.reset(spec.seed, {
      route_id: spec.route_id,
      hour: spec.hour,
      scenario: 'normal',
      dwellFeedback: true,
    });
    const schedHw = env.getScheduledHeadwayS();
    const policy = createBaselinePolicy(spec.policy_id, schedHw, config);

    let guard = 0;
    while (guard < 1100) {
      guard += 1;
      const actions = policy.act(observations);
      const res = env.step(actions);
      observations = res.observations;
      if (env.snapshot(policy.name).t >= 100 * 60) {
        break;
      }
    }

    const events = env.getArrivalLog();
    const corridor = getCorridor(spec.route_id);
    const bunchThresholdS = config.bunching_headway_ratio * schedHw;

    // Group events chronologically per (bus_id, trip_num)
    const byTrip = new Map<string, StopArrivalEvent[]>();
    for (const ev of events) {
      const key = `${ev.bus_id}#${ev.trip_num}`;
      const arr = byTrip.get(key) ?? [];
      arr.push(ev);
      byTrip.set(key, arr);
    }

    for (const tripEvents of byTrip.values()) {
      tripEvents.sort((a, b) => a.arrival_t - b.arrival_t);
      if (tripEvents.length < 4) continue;

      const states = tripEvents.map((ev) => {
        const stop = corridor.stops[ev.stop_idx] ?? corridor.stops[0];
        return eventToBusState(ev, stop.lat, stop.lon);
      });

      // Build samples for every arrival with at least 2 future stops remaining
      for (let i = 1; i < tripEvents.length - 2; i++) {
        const ev = tripEvents[i];
        const startIdx = Math.max(0, i - windowN + 1);
        const history = states.slice(startIdx, i + 1);
        const dwellHistory = tripEvents.slice(startIdx, i + 1).map((e) => e.dwell_s);

        const labels: Record<number, 0 | 1> = {};
        const leadTimeMin: Record<number, number | null> = {};

        for (const k of horizons) {
          let bunched = false;
          let firstLeadMin: number | null = null;
          const endLook = Math.min(tripEvents.length - 1, i + k);
          for (let j = i + 1; j <= endLook; j++) {
            const fut = tripEvents[j];
            if (fut.stop_idx > 0 && fut.fwd_headway_s < bunchThresholdS) {
              bunched = true;
              firstLeadMin = Number(((fut.arrival_t - ev.arrival_t) / 60).toFixed(2));
              break;
            }
          }
          labels[k] = bunched ? 1 : 0;
          leadTimeMin[k] = firstLeadMin;
        }

        samples.push({
          sample_id: `${spec.episode_id}-${ev.event_idx}`,
          episode_id: spec.episode_id,
          split: spec.split,
          route_id: spec.route_id,
          hour: spec.hour,
          bus_id: ev.bus_id,
          stop_idx: ev.stop_idx,
          stop_name: ev.stop_name,
          scheduled_headway_s: schedHw,
          history,
          dwell_history_s: dwellHistory,
          labels,
          lead_time_min: leadTimeMin,
        });
      }
    }
  }

  const positiveRateByK: Record<number, number> = {};
  const meanLeadTimeMinByK: Record<number, number> = {};
  for (const k of horizons) {
    const positives = samples.filter((s) => s.labels[k] === 1);
    positiveRateByK[k] =
      samples.length > 0 ? Number(((positives.length / samples.length) * 100).toFixed(1)) : 0;
    const leads = positives
      .map((s) => s.lead_time_min[k])
      .filter((v): v is number => v !== null);
    meanLeadTimeMinByK[k] =
      leads.length > 0
        ? Number((leads.reduce((a, b) => a + b, 0) / leads.length).toFixed(1))
        : 0;
  }

  const bundle: BunchingDatasetBundle = {
    samples,
    episodeSplits,
    stats: {
      totalSamples: samples.length,
      trainSamples: samples.filter((s) => s.split === 'train').length,
      valSamples: samples.filter((s) => s.split === 'val').length,
      testTransferSamples: samples.filter((s) => s.split === 'test_transfer').length,
      positiveRateByK,
      meanLeadTimeMinByK,
    },
  };

  cachedBundle = { key: cacheKey, bundle };
  return bundle;
}
