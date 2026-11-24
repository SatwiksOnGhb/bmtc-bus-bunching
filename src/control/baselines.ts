/**
 * Rule-Based Holding Baselines behind the frozen Policy.act(obs) contract (control/baselines.ts).
 * Owned by Control (Varun D Sawalkar).
 *
 * Implements:
 *  1. No Control (0s always)
 *  2. Schedule-Based Holding (closest to current BMTC practice)
 *  3. Headway-Based Holding — Daganzo (2009) linear forward-headway feedback
 *  4. Two-Headway Holding — balances forward and backward gaps simultaneously
 */

import { DEFAULT_CONFIG, type ProjectConfig } from '../common/config';
import { computeCorridorKpis, type CorridorKpiReport } from '../common/kpis';
import type { BusObservation, HoldingPolicy } from '../common/schemas';
import {
  BMTCHoldingEnv,
  type CorridorEnvOptions,
  type StopArrivalEvent,
} from '../sim/corridorEnv';
import type { ScenarioSpec } from '../sim/scenarios';

export type BaselinePolicyId =
  | 'no_control'
  | 'schedule'
  | 'daganzo'
  | 'two_headway';

/** Quantizes a continuous desired hold duration (s) to the closest discrete action index */
export function quantizeHoldToActionIndex(
  desiredHoldS: number,
  holdActionsS: readonly number[],
): number {
  if (desiredHoldS <= 0) return 0;
  let bestIdx = 0;
  let minDiff = Infinity;
  for (let i = 0; i < holdActionsS.length; i++) {
    const diff = Math.abs(holdActionsS[i] - desiredHoldS);
    if (diff < minDiff) {
      minDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** 1. No Control — departs immediately after boarding dwell (0s hold) */
export class NoControlPolicy implements HoldingPolicy {
  readonly id: BaselinePolicyId = 'no_control';
  readonly name = 'No Control';
  readonly description = 'Buses depart immediately after passenger dwell with 0s holding.';

  act(observations: Record<string, BusObservation>): Record<string, number> {
    const actions: Record<string, number> = {};
    for (const busId of Object.keys(observations)) {
      actions[busId] = 0;
    }
    return actions;
  }
}

/**
 * 2. Schedule-Based Holding (closest to current transit practice):
 * Holds only early buses (sched_dev_s < 0) to prevent running ahead of timetable.
 * Does nothing when buses are late (the common peak-hour case on Bengaluru corridors).
 */
export class ScheduleBasedPolicy implements HoldingPolicy {
  readonly id: BaselinePolicyId = 'schedule';
  readonly name = 'Schedule-Based Holding';
  readonly description =
    'Current practice baseline: holds early buses back toward timetable; late buses depart immediately.';
  private holdActionsS: readonly number[];

  constructor(config: ProjectConfig = DEFAULT_CONFIG) {
    this.holdActionsS = config.hold_actions_s;
  }

  act(observations: Record<string, BusObservation>): Record<string, number> {
    const actions: Record<string, number> = {};
    for (const [busId, obs] of Object.entries(observations)) {
      if (obs.stop_idx === 0) {
        actions[busId] = 0;
        continue;
      }
      // sched_dev_s < 0 means bus is early; hold to absorb earliness
      const desiredHold = obs.sched_dev_s < -10 ? Math.min(90, -obs.sched_dev_s * 0.85) : 0;
      actions[busId] = quantizeHoldToActionIndex(desiredHold, this.holdActionsS);
    }
    return actions;
  }
}

/**
 * 3. Headway-Based Holding — Daganzo (2009):
 * Proportional feedback on forward headway deficit:
 *   hold = max(0, alpha * (H_sched - fwd_headway_s))
 */
export class DaganzoHeadwayPolicy implements HoldingPolicy {
  readonly id: BaselinePolicyId = 'daganzo';
  readonly name = 'Headway-Based (Daganzo 2009)';
  readonly description =
    'Forward-headway linear feedback: holds buses running too close to the leader (α = 0.72).';
  private holdActionsS: readonly number[];
  private scheduledHeadwayS: number;
  private alpha: number;

  constructor(
    scheduledHeadwayS: number,
    config: ProjectConfig = DEFAULT_CONFIG,
    alpha = 0.72,
  ) {
    this.scheduledHeadwayS = scheduledHeadwayS;
    this.holdActionsS = config.hold_actions_s;
    this.alpha = alpha;
  }

  act(observations: Record<string, BusObservation>): Record<string, number> {
    const actions: Record<string, number> = {};
    for (const [busId, obs] of Object.entries(observations)) {
      if (obs.stop_idx === 0) {
        actions[busId] = 0;
        continue;
      }
      const deficit = this.scheduledHeadwayS - obs.fwd_headway_s;
      const desiredHold = deficit > 12 ? this.alpha * deficit : 0;
      actions[busId] = quantizeHoldToActionIndex(desiredHold, this.holdActionsS);
    }
    return actions;
  }
}

/**
 * 4. Two-Headway Holding:
 * Balances both forward and backward gaps simultaneously:
 *   hold = max(0, beta * 0.5 * (bwd_headway_s - fwd_headway_s))
 * Plus mild protection against over-holding heavily loaded buses.
 */
export class TwoHeadwayPolicy implements HoldingPolicy {
  readonly id: BaselinePolicyId = 'two_headway';
  readonly name = 'Two-Headway Holding';
  readonly description =
    'Balances gaps to both leader and follower simultaneously, avoiding backward pile-up.';
  private holdActionsS: readonly number[];
  private scheduledHeadwayS: number;
  private beta: number;

  constructor(
    scheduledHeadwayS: number,
    config: ProjectConfig = DEFAULT_CONFIG,
    beta = 0.68,
  ) {
    this.scheduledHeadwayS = scheduledHeadwayS;
    this.holdActionsS = config.hold_actions_s;
    this.beta = beta;
  }

  act(observations: Record<string, BusObservation>): Record<string, number> {
    const actions: Record<string, number> = {};
    for (const [busId, obs] of Object.entries(observations)) {
      if (obs.stop_idx === 0) {
        actions[busId] = 0;
        continue;
      }
      const gapAsymmetry = 0.5 * (obs.bwd_headway_s - obs.fwd_headway_s);
      const fwdDeficit = Math.max(0, this.scheduledHeadwayS - obs.fwd_headway_s);
      // Blend two-headway centering with gentle forward-headway floor
      const rawHold = this.beta * gapAsymmetry + 0.18 * fwdDeficit;
      const desiredHold = rawHold > 10 ? rawHold : 0;
      actions[busId] = quantizeHoldToActionIndex(desiredHold, this.holdActionsS);
    }
    return actions;
  }
}

export function createBaselinePolicy(
  id: BaselinePolicyId,
  scheduledHeadwayS: number,
  config: ProjectConfig = DEFAULT_CONFIG,
): HoldingPolicy & { id: BaselinePolicyId; description: string } {
  switch (id) {
    case 'no_control':
      return new NoControlPolicy();
    case 'schedule':
      return new ScheduleBasedPolicy(config);
    case 'daganzo':
      return new DaganzoHeadwayPolicy(scheduledHeadwayS, config);
    case 'two_headway':
      return new TwoHeadwayPolicy(scheduledHeadwayS, config);
  }
}

export const ALL_BASELINE_IDS: BaselinePolicyId[] = [
  'no_control',
  'schedule',
  'daganzo',
  'two_headway',
];

export interface PolicyEpisodeEvaluation {
  policy_id: string;
  policy_name: string;
  description: string;
  kpis: CorridorKpiReport;
  events: StopArrivalEvent[];
  scheduledHeadwayS: number;
}

/** Evaluates any HoldingPolicy on BMTCHoldingEnv for a given seed/corridor/hour */
export function evaluatePolicyEpisode(params: {
  policyId: string;
  policyDescription?: string;
  policy: HoldingPolicy;
  config: ProjectConfig;
  seed: number;
  options?: CorridorEnvOptions;
  horizonMinutes?: number;
}): PolicyEpisodeEvaluation {
  const {
    policyId,
    policyDescription = '',
    policy,
    config,
    seed,
    options,
    horizonMinutes = 110,
  } = params;

  const env = new BMTCHoldingEnv(config);
  let { observations } = env.reset(seed, options);
  const horizonSec = horizonMinutes * 60;

  let guard = 0;
  while (guard < 1400) {
    guard += 1;
    const actions = policy.act(observations);
    const res = env.step(actions);
    observations = res.observations;
    if (env.snapshot(policy.name).t >= horizonSec) {
      break;
    }
  }

  const events = env.getArrivalLog();
  const corridor = env.getCorridorDefinition();
  const scheduledHeadwayS = env.getScheduledHeadwayS();
  const kpis = computeCorridorKpis({
    policy_id: policyId,
    policy_name: policy.name,
    corridor,
    scheduledHeadwayS,
    seed,
    events,
    config,
  });

  return {
    policy_id: policyId,
    policy_name: policy.name,
    description: policyDescription,
    kpis,
    events,
    scheduledHeadwayS,
  };
}

/** Evaluates all 4 baseline policies on identical seed, corridor, hour & scenario */
export function runAllBaselinesComparison(params: {
  config: ProjectConfig;
  routeId: string;
  hour: number;
  seed: number;
  scenario?: 'normal' | 'rain' | 'breakdown';
  scenarioSpec?: ScenarioSpec;
  horizonMinutes?: number;
}): PolicyEpisodeEvaluation[] {
  const {
    config,
    routeId,
    hour,
    seed,
    scenario = 'normal',
    scenarioSpec,
    horizonMinutes = 110,
  } = params;
  const probeEnv = new BMTCHoldingEnv(config);
  probeEnv.reset(seed, { route_id: routeId, hour, scenario, scenarioSpec });
  const scheduledHeadwayS = probeEnv.getScheduledHeadwayS();

  return ALL_BASELINE_IDS.map((id) => {
    const policy = createBaselinePolicy(id, scheduledHeadwayS, config);
    return evaluatePolicyEpisode({
      policyId: id,
      policyDescription: policy.description,
      policy,
      config,
      seed,
      options: { route_id: routeId, hour, scenario, scenarioSpec, dwellFeedback: true },
      horizonMinutes,
    });
  });
}
