import { useEffect, useRef, useState } from 'react';
import {
  CloudRain,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Wrench,
} from 'lucide-react';
import type { ProjectConfig } from '../common/config';
import { CORRIDOR_LIST } from '../data/corridors';
import {
  DualSimulationRunner,
  RUNNER_POLICY_OPTIONS,
  type DualSnapshotFrame,
  type RunnerPolicyId,
} from '../sim/runner';
import type { ScenarioName } from '../sim/scenarios';
import { AlertOverridePanel } from './AlertOverridePanel';
import { CorridorGeoMap } from './CorridorGeoMap';
import { LiveTimeSpacePanel } from './LiveTimeSpacePanel';

interface DispatcherDashboardViewProps {
  config: ProjectConfig;
}

const SEEDS = [42, 108, 256];
const SPEEDS: Array<{ label: string; ms: number; stepSec: number }> = [
  { label: '1x', ms: 650, stepSec: 60 },
  { label: '2x', ms: 340, stepSec: 60 },
  { label: '4x', ms: 180, stepSec: 90 },
  { label: '8x', ms: 95, stepSec: 120 },
];

function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function createWarmedRunner(params: {
  config: ProjectConfig;
  routeId: string;
  seed: number;
  scenario: ScenarioName;
  leftPolicyId: RunnerPolicyId;
  rightPolicyId: RunnerPolicyId;
}): { runner: DualSimulationRunner; frame: DualSnapshotFrame } {
  const runner = new DualSimulationRunner({
    config: params.config,
    routeId: params.routeId,
    hour: 9,
    seed: params.seed,
    scenario: params.scenario,
    leftPolicyId: params.leftPolicyId,
    rightPolicyId: params.rightPolicyId,
    horizonMinutes: 110,
    tickSeconds: 60,
    alertThreshold: 0.45,
  });
  // Pre-advance 18 minutes in 2-minute chunks so map, time-space diagram & early warnings are immediately populated
  let frame = runner.getFrame();
  for (let i = 0; i < 9; i++) {
    frame = runner.stepClock(120);
  }
  return { runner, frame };
}

export function DispatcherDashboardView({ config }: DispatcherDashboardViewProps) {
  const [routeId, setRouteId] = useState<string>('500D');
  const [seed, setSeed] = useState<number>(config.default_seed);
  const [scenario, setScenario] = useState<ScenarioName>('normal');
  const [leftPolicyId, setLeftPolicyId] = useState<RunnerPolicyId>('schedule');
  const [rightPolicyId, setRightPolicyId] = useState<RunnerPolicyId>('mappo_pred');
  const [speedIdx, setSpeedIdx] = useState<number>(1);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [selectedBusId, setSelectedBusId] = useState<string | null>(null);

  const runnerRef = useRef<DualSimulationRunner | null>(null);

  const [frame, setFrame] = useState<DualSnapshotFrame>(() => {
    const { runner, frame: initFrame } = createWarmedRunner({
      config,
      routeId: '500D',
      seed: config.default_seed,
      scenario: 'normal',
      leftPolicyId: 'schedule',
      rightPolicyId: 'mappo_pred',
    });
    runnerRef.current = runner;
    return initFrame;
  });

  useEffect(() => {
    setIsPlaying(false);
    const { runner, frame: initFrame } = createWarmedRunner({
      config,
      routeId,
      seed,
      scenario,
      leftPolicyId,
      rightPolicyId,
    });
    runnerRef.current = runner;
    setFrame(initFrame);
    setSelectedBusId(initFrame.right.snapshot.buses[0]?.bus_id ?? null);
  }, [config, routeId, seed, scenario, leftPolicyId, rightPolicyId]);

  useEffect(() => {
    if (!isPlaying || frame.done) return;
    const speed = SPEEDS[speedIdx] ?? SPEEDS[1];
    const timer = window.setInterval(() => {
      if (!runnerRef.current) return;
      const next = runnerRef.current.stepClock(speed.stepSec);
      setFrame(next);
      if (next.done) {
        setIsPlaying(false);
      }
    }, speed.ms);
    return () => window.clearInterval(timer);
  }, [isPlaying, speedIdx, frame.done]);

  const handleStep = () => {
    if (!runnerRef.current) return;
    const speed = SPEEDS[speedIdx] ?? SPEEDS[0];
    setFrame(runnerRef.current.stepClock(speed.stepSec));
  };

  const handleReset = () => {
    setIsPlaying(false);
    if (!runnerRef.current) return;
    setFrame(runnerRef.current.reset());
  };

  const handleInjectRain = () => {
    if (!runnerRef.current) return;
    setFrame(runnerRef.current.injectLiveRain(34));
  };

  const handleInjectBreakdown = () => {
    if (!runnerRef.current) return;
    setFrame(runnerRef.current.injectLiveBreakdown(18, 4));
  };

  const handleAcceptAlert = (alertId: string) => {
    if (!runnerRef.current) return;
    setFrame(runnerRef.current.applyAlertAction(alertId, 'accept'));
  };

  const handleOverrideAlert = (alertId: string, holdSec: number) => {
    if (!runnerRef.current) return;
    setFrame(runnerRef.current.applyAlertAction(alertId, 'override', holdSec));
  };

  const handleQueueManualHold = (busId: string, holdSec: number) => {
    if (!runnerRef.current) return;
    setFrame(runnerRef.current.queueBusHoldOverride(busId, holdSec));
  };

  const progressPct = Math.min(100, (frame.clock_t / Math.max(1, frame.horizon_s)) * 100);

  return (
    <div className="space-y-6">
      {/* Operational Control Bar */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (frame.done) {
                  handleReset();
                  setIsPlaying(true);
                } else {
                  setIsPlaying((p) => !p);
                }
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {isPlaying ? 'Pause Live Feed' : frame.done ? 'Restart Shift' : 'Resume Live Feed'}
            </button>
            <button
              type="button"
              onClick={handleStep}
              disabled={frame.done}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <SkipForward className="w-3.5 h-3.5" />
              Step +1m
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset to 06m
            </button>

            <div className="flex items-center border border-slate-200 rounded-md overflow-hidden ml-1">
              {SPEEDS.map((sp, idx) => (
                <button
                  key={sp.label}
                  type="button"
                  onClick={() => setSpeedIdx(idx)}
                  className={`px-2.5 py-1.5 text-xs font-mono transition-colors ${
                    speedIdx === idx
                      ? 'bg-slate-900 text-white font-medium'
                      : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {sp.label}
                </button>
              ))}
            </div>
          </div>

          {/* Live Disruption Triggers */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleInjectRain}
              disabled={frame.done}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-blue-800 bg-blue-50 hover:bg-blue-100 border border-blue-200 disabled:opacity-40 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <CloudRain className="w-3.5 h-3.5" />
              Trigger Monsoon Rain
            </button>
            <button
              type="button"
              onClick={handleInjectBreakdown}
              disabled={frame.done}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-amber-900 bg-amber-50 hover:bg-amber-100 border border-amber-200 disabled:opacity-40 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Wrench className="w-3.5 h-3.5" />
              Trigger Bus Breakdown
            </button>
          </div>
        </div>

        {/* Route, Seed, Scenario & Policy Selectors */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 pt-4 border-t border-slate-200">
          <label className="block">
            <span className="text-xs font-medium text-slate-600">BMTC Corridor</span>
            <select
              value={routeId}
              onChange={(e) => setRouteId(e.target.value)}
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
            >
              {CORRIDOR_LIST.map((c) => (
                <option key={c.route_id} value={c.route_id}>
                  {c.route_id} · {c.split === 'held_out_transfer' ? 'Held-Out G-4' : c.origin}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-slate-600">Shared Seed</span>
            <select
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value))}
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono text-slate-900"
            >
              {SEEDS.map((s) => (
                <option key={s} value={s}>
                  seed = {s}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-slate-600">Operating Scenario</span>
            <select
              value={scenario}
              onChange={(e) => setScenario(e.target.value as ScenarioName)}
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
            >
              <option value="normal">Normal Morning Peak (09:00)</option>
              <option value="rain">Seeded Monsoon Rain</option>
              <option value="breakdown">Seeded Bus Breakdown</option>
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-slate-600">Baseline Policy (Left)</span>
            <select
              value={leftPolicyId}
              onChange={(e) => setLeftPolicyId(e.target.value as RunnerPolicyId)}
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
            >
              {RUNNER_POLICY_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-slate-600">Active AI Policy (Right)</span>
            <select
              value={rightPolicyId}
              onChange={(e) => setRightPolicyId(e.target.value as RunnerPolicyId)}
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
            >
              {RUNNER_POLICY_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Synchronized Progress Bar */}
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 tabular-nums">
            <span>
              Control Room Clock:{' '}
              <strong className="font-mono text-slate-900">{formatClock(frame.clock_t)}</strong> /{' '}
              <span className="font-mono">{formatClock(frame.horizon_s)}</span>
              <span className="mx-2 text-slate-300">·</span>
              Scenario: <strong className="text-slate-900 capitalize">{frame.scenario}</strong>
              <span className="mx-2 text-slate-300">·</span>
              Scheduled Headway:{' '}
              <strong className="font-mono text-slate-900">
                {Math.round(frame.scheduled_headway_s / 60)} min
              </strong>
            </span>
            <span className="font-mono text-slate-500">
              {frame.right.arrival_count} arrivals logged · {progressPct.toFixed(0)}%
            </span>
          </div>
          <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-700 transition-all duration-200"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* 4-Column Commuter KPI Comparison Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Headway CV (Regularity)</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {frame.right.kpis.headway_cv.toFixed(3)}{' '}
            <span className="text-xs font-normal text-slate-500">
              vs {frame.left.kpis.headway_cv.toFixed(3)}
            </span>
          </div>
          <div
            className={`text-xs mt-1 tabular-nums font-medium ${
              frame.diff.headway_cv_delta <= 0 ? 'text-emerald-700' : 'text-amber-700'
            }`}
          >
            {frame.diff.headway_cv_delta <= 0 ? '−' : '+'}
            {Math.abs(frame.diff.headway_cv_reduction_pct).toFixed(1)}% vs {frame.left.policy_name.split(' ')[0]}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Bunched Arrivals (&lt; 25% HW)</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {frame.right.kpis.bunched_pct.toFixed(1)}%{' '}
            <span className="text-xs font-normal text-slate-500">
              vs {frame.left.kpis.bunched_pct.toFixed(1)}%
            </span>
          </div>
          <div
            className={`text-xs mt-1 tabular-nums font-medium ${
              frame.diff.bunched_pct_delta <= 0 ? 'text-emerald-700' : 'text-amber-700'
            }`}
          >
            {frame.diff.bunched_pct_delta > 0 ? '+' : ''}
            {frame.diff.bunched_pct_delta.toFixed(1)} pp reduction
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Mean Commuter Wait</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {frame.right.kpis.mean_wait_min.toFixed(2)} min{' '}
            <span className="text-xs font-normal text-slate-500">
              vs {frame.left.kpis.mean_wait_min.toFixed(2)} min
            </span>
          </div>
          <div
            className={`text-xs mt-1 tabular-nums font-medium ${
              frame.diff.mean_wait_delta_min <= 0 ? 'text-emerald-700' : 'text-amber-700'
            }`}
          >
            {frame.diff.mean_wait_delta_min > 0 ? '+' : ''}
            {frame.diff.mean_wait_delta_min.toFixed(2)} min · Avg hold {frame.right.kpis.mean_hold_s.toFixed(1)}s
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Commuter Time Saved</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {frame.diff.daily_pax_hours_saved >= 0 ? '+' : ''}
            {frame.diff.daily_pax_hours_saved.toFixed(0)} pax-hrs/day
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Calibrated simulation of BMTC {frame.route_id}
          </div>
        </div>
      </div>

      {/* Primary Control Room Grid: Bengaluru Corridor Map (Left) + Early-Warning & Override Panel (Right) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-7">
          <CorridorGeoMap
            frame={frame}
            selectedBusId={selectedBusId}
            onSelectBus={setSelectedBusId}
            onQueueManualHold={handleQueueManualHold}
            holdActionsS={config.hold_actions_s}
          />
        </div>
        <div className="xl:col-span-5">
          <AlertOverridePanel
            frame={frame}
            holdActionsS={config.hold_actions_s}
            onAcceptAlert={handleAcceptAlert}
            onOverrideAlert={handleOverrideAlert}
            onSelectBus={setSelectedBusId}
          />
        </div>
      </div>

      {/* Synchronized Side-by-Side Live Time-Space Diagrams */}
      <LiveTimeSpacePanel frame={frame} />
    </div>
  );
}
