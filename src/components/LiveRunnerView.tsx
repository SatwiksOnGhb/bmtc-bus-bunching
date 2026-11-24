import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CloudRain,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Wrench,
} from 'lucide-react';
import type { ProjectConfig } from '../common/config';
import type { BusState, Prediction } from '../common/schemas';
import { CORRIDOR_LIST } from '../data/corridors';
import {
  DualSimulationRunner,
  RUNNER_POLICY_OPTIONS,
  type DualSnapshotFrame,
  type RunnerPolicyId,
} from '../sim/runner';
import type { ScenarioName } from '../sim/scenarios';

interface LiveRunnerViewProps {
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

function riskColor(pBunch: number): { fill: string; text: string; label: string } {
  if (pBunch >= 0.65) {
    return { fill: '#DC2626', text: 'text-red-700', label: 'High Risk' };
  }
  if (pBunch >= 0.35) {
    return { fill: '#D97706', text: 'text-amber-700', label: 'Watch' };
  }
  return { fill: '#1D4ED8', text: 'text-blue-700', label: 'Nominal' };
}

function CorridorLaneTrack({
  title,
  subtitle,
  buses,
  predictions,
  holds,
  stopCount,
  stopNames,
  headwayCv,
  bunchedPct,
  meanWaitMin,
  accent,
}: {
  title: string;
  subtitle: string;
  buses: BusState[];
  predictions: Prediction[];
  holds: Record<string, number>;
  stopCount: number;
  stopNames: string[];
  headwayCv: number;
  bunchedPct: number;
  meanWaitMin: number;
  accent: 'baseline' | 'mappo';
}) {
  const predMap = useMemo(() => {
    const m = new Map<string, Prediction>();
    for (const p of predictions) m.set(p.bus_id, p);
    return m;
  }, [predictions]);

  const maxIdx = Math.max(1, stopCount - 1);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
          <span className="text-slate-600">
            CV:{' '}
            <strong className={accent === 'mappo' ? 'text-blue-700' : 'text-slate-900'}>
              {headwayCv.toFixed(3)}
            </strong>
          </span>
          <span className="text-slate-600">
            Bunched: <strong className="text-slate-900">{bunchedPct.toFixed(1)}%</strong>
          </span>
          <span className="text-slate-600">
            Wait: <strong className="text-slate-900">{meanWaitMin.toFixed(2)}m</strong>
          </span>
        </div>
      </div>

      {/* Horizontal Corridor Track */}
      <div className="relative pt-7 pb-6 px-3">
        {/* Main Road Spine */}
        <div className="h-1.5 bg-slate-200 rounded-full relative">
          {/* Stop Ticks */}
          {stopNames.map((name, idx) => {
            const pct = (idx / maxIdx) * 100;
            const isMajor = idx === 0 || idx === maxIdx || idx % 4 === 0;
            return (
              <div
                key={idx}
                style={{ left: `${pct}%` }}
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 flex flex-col items-center"
              >
                <div
                  className={`rounded-full ${
                    isMajor ? 'w-2.5 h-2.5 bg-slate-400' : 'w-1.5 h-1.5 bg-slate-300'
                  }`}
                />
                {isMajor && (
                  <span className="absolute top-3.5 text-[10px] text-slate-500 whitespace-nowrap max-w-[84px] truncate">
                    {name}
                  </span>
                )}
              </div>
            );
          })}

          {/* Live Bus Markers */}
          {buses.map((bus) => {
            const pct = (bus.stop_idx / maxIdx) * 100;
            const pred = predMap.get(bus.bus_id);
            const pBunch = pred?.p_bunch ?? 0;
            const holdS = holds[bus.bus_id] ?? 0;
            const rc = riskColor(pBunch);
            const shortNum = bus.bus_id.split('-').pop() ?? bus.bus_id;

            return (
              <div
                key={bus.bus_id}
                style={{ left: `${pct}%` }}
                title={`${bus.bus_id} · Stop ${bus.stop_idx + 1}/${stopCount} · Fwd HW ${bus.fwd_headway_s}s · Load ${bus.load} · p_bunch ${(pBunch * 100).toFixed(0)}%${holdS > 0 ? ` · Hold ${holdS}s` : ''}`}
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 transition-all duration-200"
              >
                <div className="flex flex-col items-center -mt-4">
                  <span className="text-[10px] font-mono font-semibold text-slate-700 leading-none mb-1 tabular-nums">
                    {shortNum}
                  </span>
                  <div
                    className="w-4 h-4 rounded-sm border border-white flex items-center justify-center text-[9px] font-mono text-white font-semibold shadow-xs"
                    style={{ backgroundColor: rc.fill }}
                  >
                    {holdS > 0 ? 'H' : ''}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 pt-1 border-t border-slate-100">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-xs bg-blue-700 inline-block" />
            Nominal (p &lt; 35%)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-xs bg-amber-600 inline-block" />
            Watch (35–65%)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-xs bg-red-600 inline-block" />
            High Risk (&ge; 65%)
          </span>
        </div>
        <span className="font-mono">H = Active holding action</span>
      </div>
    </div>
  );
}

function TelemetryStreamChart({ frame }: { frame: DualSnapshotFrame }) {
  const series = frame.telemetry_series;
  const width = 680;
  const height = 220;
  const pad = { top: 18, right: 20, bottom: 32, left: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxT = Math.max(20, frame.horizon_s / 60);
  const maxCv = Math.max(
    0.55,
    ...series.map((p) => Math.max(p.left_cv, p.right_cv) * 1.15),
  );

  const xScale = (tMin: number) => pad.left + (Math.min(maxT, tMin) / maxT) * plotW;
  const yScale = (cv: number) => pad.top + plotH - (Math.min(maxCv, cv) / maxCv) * plotH;

  const leftPath = series
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.t_min).toFixed(1)} ${yScale(p.left_cv).toFixed(1)}`)
    .join(' ');
  const rightPath = series
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.t_min).toFixed(1)} ${yScale(p.right_cv).toFixed(1)}`)
    .join(' ');

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Synchronized Telemetry Stream (Headway CV over Sim Time)
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Live paired diff from Runner.stream() — identical seed, traffic shocks &amp; passenger arrivals on both lanes.
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className="inline-flex items-center gap-1.5 text-slate-700">
            <span className="w-3 h-0.5 bg-slate-500 inline-block" />
            Left: {frame.left.policy_name}
          </span>
          <span className="inline-flex items-center gap-1.5 text-blue-700 font-medium">
            <span className="w-3 h-0.5 bg-blue-700 inline-block" />
            Right: {frame.right.policy_name}
          </span>
        </div>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto block">
        {/* Horizontal gridlines */}
        {[0, 0.25, 0.5, 0.75, 1.0].map((frac) => {
          const val = maxCv * frac;
          const y = yScale(val);
          return (
            <g key={frac}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y}
                y2={y}
                stroke="#E2E8F0"
                strokeWidth="1"
              />
              <text
                x={pad.left - 8}
                y={y + 3}
                textAnchor="end"
                className="fill-slate-400 text-[10px] font-mono"
              >
                {val.toFixed(2)}
              </text>
            </g>
          );
        })}

        {/* Vertical time markers */}
        {[0, 20, 40, 60, 80, 100].map((tMin) => {
          if (tMin > maxT) return null;
          const x = xScale(tMin);
          return (
            <text
              key={tMin}
              x={x}
              y={height - 10}
              textAnchor="middle"
              className="fill-slate-400 text-[10px] font-mono"
            >
              {tMin}m
            </text>
          );
        })}

        {/* Live injected disruption markers */}
        {frame.live_disruptions.map((d, i) => {
          const x = xScale(d.t_min);
          const color = d.type === 'rain' ? '#2563EB' : '#D97706';
          return (
            <g key={`${d.type}-${i}`}>
              <line
                x1={x}
                x2={x}
                y1={pad.top}
                y2={pad.top + plotH}
                stroke={color}
                strokeWidth="1.25"
                strokeDasharray="4 3"
              />
              <text
                x={x + 4}
                y={pad.top + 11 + i * 12}
                className="text-[9px] font-medium"
                fill={color}
              >
                {d.label}
              </text>
            </g>
          );
        })}

        {/* Left & Right Curves */}
        {series.length > 1 && (
          <>
            <path d={leftPath} fill="none" stroke="#64748B" strokeWidth="2" />
            <path d={rightPath} fill="none" stroke="#1D4ED8" strokeWidth="2.5" />
          </>
        )}

        {/* Current Tip Dots */}
        {series.length > 0 && (
          <>
            <circle
              cx={xScale(series[series.length - 1].t_min)}
              cy={yScale(series[series.length - 1].left_cv)}
              r="3.5"
              fill="#64748B"
            />
            <circle
              cx={xScale(series[series.length - 1].t_min)}
              cy={yScale(series[series.length - 1].right_cv)}
              r="4"
              fill="#1D4ED8"
            />
          </>
        )}
      </svg>
    </div>
  );
}

export function LiveRunnerView({ config }: LiveRunnerViewProps) {
  const [routeId, setRouteId] = useState<string>('500D');
  const [seed, setSeed] = useState<number>(config.default_seed);
  const [scenario, setScenario] = useState<ScenarioName>('normal');
  const [leftPolicyId, setLeftPolicyId] = useState<RunnerPolicyId>('schedule');
  const [rightPolicyId, setRightPolicyId] = useState<RunnerPolicyId>('mappo_pred');
  const [speedIdx, setSpeedIdx] = useState<number>(1);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  const runnerRef = useRef<DualSimulationRunner | null>(null);

  const [frame, setFrame] = useState<DualSnapshotFrame>(() => {
    const r = new DualSimulationRunner({
      config,
      routeId: '500D',
      hour: 9,
      seed: config.default_seed,
      scenario: 'normal',
      leftPolicyId: 'schedule',
      rightPolicyId: 'mappo_pred',
      horizonMinutes: 110,
      tickSeconds: 60,
    });
    runnerRef.current = r;
    return r.getFrame();
  });

  // Rebuild synchronized dual twins when core configuration inputs change
  useEffect(() => {
    setIsPlaying(false);
    const r = new DualSimulationRunner({
      config,
      routeId,
      hour: 9,
      seed,
      scenario,
      leftPolicyId,
      rightPolicyId,
      horizonMinutes: 110,
      tickSeconds: 60,
    });
    runnerRef.current = r;
    setFrame(r.getFrame());
  }, [config, routeId, seed, scenario, leftPolicyId, rightPolicyId]);

  // Playback timer driving Runner.stepClock()
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

  const handleStepOnce = () => {
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

  const stopNames = useMemo(
    () => frame.corridor.stops.map((s) => s.name),
    [frame.corridor.stops],
  );

  const progressPct = Math.min(100, (frame.clock_t / Math.max(1, frame.horizon_s)) * 100);

  return (
    <div className="space-y-6">
      {/* Control Deck */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Playback Controls */}
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
              {isPlaying ? 'Pause Stream' : frame.done ? 'Replay Run' : 'Play Dual Stream'}
            </button>
            <button
              type="button"
              onClick={handleStepOnce}
              disabled={frame.done}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <SkipForward className="w-3.5 h-3.5" />
              Step Tick
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset
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

          {/* Live Mid-Run Disruption Injection Buttons */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleInjectRain}
              disabled={frame.done}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-blue-800 bg-blue-50 hover:bg-blue-100 border border-blue-200 disabled:opacity-40 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <CloudRain className="w-3.5 h-3.5" />
              Inject Live Rain
            </button>
            <button
              type="button"
              onClick={handleInjectBreakdown}
              disabled={frame.done}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-amber-900 bg-amber-50 hover:bg-amber-100 border border-amber-200 disabled:opacity-40 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Wrench className="w-3.5 h-3.5" />
              Inject Bus Breakdown
            </button>
          </div>
        </div>

        {/* Corridor, Seed, Initial Scenario & Policy Selectors */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 pt-4 border-t border-slate-200">
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Corridor</span>
            <select
              value={routeId}
              onChange={(e) => setRouteId(e.target.value)}
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
            >
              {CORRIDOR_LIST.map((c) => (
                <option key={c.route_id} value={c.route_id}>
                  {c.route_id} · {c.split === 'held_out_transfer' ? 'Held-Out' : 'Train'}
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
            <span className="text-xs font-medium text-slate-600">Start Scenario</span>
            <select
              value={scenario}
              onChange={(e) => setScenario(e.target.value as ScenarioName)}
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
            >
              <option value="normal">Normal Peak (09:00)</option>
              <option value="rain">Seeded Monsoon Rain</option>
              <option value="breakdown">Seeded Bus Breakdown</option>
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-slate-600">Left Lane (Baseline)</span>
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
            <span className="text-xs font-medium text-slate-600">Right Lane (Active AI)</span>
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

        {/* Synchronized Clock Progress Bar */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-600 tabular-nums">
            <span>
              Synchronized Clock:{' '}
              <strong className="font-mono text-slate-900">{formatClock(frame.clock_t)}</strong> /{' '}
              <span className="font-mono">{formatClock(frame.horizon_s)}</span>
              <span className="mx-2 text-slate-300">·</span>
              Tick #{frame.tick}
              <span className="mx-2 text-slate-300">·</span>
              Active Scenario: <strong className="text-slate-900 capitalize">{frame.scenario}</strong>
            </span>
            <span className="font-mono">{progressPct.toFixed(0)}% complete</span>
          </div>
          <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-700 transition-all duration-200"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* 4-Column Synchronized Diff KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Headway CV (Right vs Left)</div>
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
            {Math.abs(frame.diff.headway_cv_reduction_pct).toFixed(1)}% vs left lane
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
            {frame.diff.bunched_pct_delta.toFixed(1)} pp diff
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Mean Passenger Wait</div>
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
            {frame.diff.mean_wait_delta_min.toFixed(2)} min per rider
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Projected Commuter Impact</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {frame.diff.daily_pax_hours_saved >= 0 ? '+' : ''}
            {frame.diff.daily_pax_hours_saved.toFixed(0)} pax-hrs/day
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Calibrated {frame.route_id} simulation · Hold Δ {frame.diff.mean_hold_delta_s >= 0 ? '+' : ''}
            {frame.diff.mean_hold_delta_s.toFixed(1)}s
          </div>
        </div>
      </div>

      {/* Synchronized Dual Corridor Tracks */}
      <div className="space-y-4">
        <CorridorLaneTrack
          title={`Left Lane · ${frame.left.policy_name}`}
          subtitle={`Seed ${frame.seed} · ${frame.left.arrival_count} stop arrivals processed · ${frame.corridor.origin} → ${frame.corridor.destination}`}
          buses={frame.left.snapshot.buses}
          predictions={frame.left.snapshot.predictions}
          holds={frame.left.snapshot.holds}
          stopCount={frame.corridor.stops.length}
          stopNames={stopNames}
          headwayCv={frame.left.kpis.headway_cv}
          bunchedPct={frame.left.kpis.bunched_pct}
          meanWaitMin={frame.left.kpis.mean_wait_min}
          accent="baseline"
        />

        <CorridorLaneTrack
          title={`Right Lane · ${frame.right.policy_name}`}
          subtitle={`Identical Seed ${frame.seed} · ${frame.right.arrival_count} stop arrivals processed · Predictor p_bunch active`}
          buses={frame.right.snapshot.buses}
          predictions={frame.right.snapshot.predictions}
          holds={frame.right.snapshot.holds}
          stopCount={frame.corridor.stops.length}
          stopNames={stopNames}
          headwayCv={frame.right.kpis.headway_cv}
          bunchedPct={frame.right.kpis.bunched_pct}
          meanWaitMin={frame.right.kpis.mean_wait_min}
          accent="mappo"
        />
      </div>

      {/* Streaming Telemetry Chart + Live Alert/Event Stream */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-7">
          <TelemetryStreamChart frame={frame} />
        </div>

        <div className="xl:col-span-5 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Early-Warning &amp; Disruption Feed
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Live predictions (p_bunch &ge; 55%) emitted by Runner.stream()
              </p>
            </div>
            <span className="text-xs font-mono text-slate-500 tabular-nums">
              {frame.alerts.length} alerts
            </span>
          </div>

          <div className="divide-y divide-slate-200 max-h-[260px] overflow-y-auto">
            {frame.right.disruption_events.map((ev, i) => (
              <div key={`dis-${i}`} className="px-5 py-3 bg-amber-50/50 text-xs">
                <div className="flex items-center justify-between text-amber-900 font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Disruption · {ev.type.replace('_', ' ')}
                  </span>
                  <span className="font-mono tabular-nums">{formatClock(ev.t)}</span>
                </div>
                <p className="text-slate-700 mt-1">{ev.summary}</p>
              </div>
            ))}

            {frame.alerts.length === 0 ? (
              <div className="px-5 py-8 text-center text-xs text-slate-500">
                No high-risk bunching warnings yet — press Play or Step Tick to stream arrivals.
              </div>
            ) : (
              frame.alerts.slice(0, 8).map((alert) => (
                <div key={alert.id} className="px-5 py-3 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-semibold text-slate-900">
                      {alert.bus_id} · Stop #{alert.stop_idx + 1}
                    </span>
                    <span className="font-mono text-red-700 font-medium tabular-nums">
                      p={(alert.p_bunch * 100).toFixed(0)}% · {formatClock(alert.t)}
                    </span>
                  </div>
                  <p className="text-slate-600 mt-1">{alert.message}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Synchronized Per-Bus Snapshot Diff Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Synchronized Fleet Snapshot Comparison (t = {formatClock(frame.clock_t)})
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Direct bus-by-bus state comparison from paired Snapshot objects validating identical fleet identity across both lanes.
            </p>
          </div>
          <span className="text-xs font-mono text-slate-500 tabular-nums">
            {frame.right.snapshot.buses.length} buses · Sched HW {Math.round(frame.scheduled_headway_s / 60)}m
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                <th className="py-2.5 px-5">Bus ID</th>
                <th className="py-2.5 px-4">Left Stop</th>
                <th className="py-2.5 px-4 text-right">Left Fwd HW</th>
                <th className="py-2.5 px-4 text-right">Left Load</th>
                <th className="py-2.5 px-4">Right Stop</th>
                <th className="py-2.5 px-4 text-right">Right Fwd HW</th>
                <th className="py-2.5 px-4 text-right">Right Load</th>
                <th className="py-2.5 px-4 text-right">p_bunch (k=5)</th>
                <th className="py-2.5 px-5 text-right">Active Hold</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs tabular-nums">
              {frame.right.snapshot.buses.map((rBus, idx) => {
                const lBus = frame.left.snapshot.buses[idx];
                const pred = frame.right.snapshot.predictions.find((p) => p.bus_id === rBus.bus_id);
                const pBunch = pred?.p_bunch ?? 0;
                const holdS = frame.right.snapshot.holds[rBus.bus_id] ?? 0;
                const rc = riskColor(pBunch);

                return (
                  <tr key={rBus.bus_id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-5 font-mono font-medium text-slate-900">
                      {rBus.bus_id}
                    </td>
                    <td className="py-2.5 px-4 text-slate-600">
                      #{lBus ? lBus.stop_idx + 1 : '-'} · {lBus ? stopNames[lBus.stop_idx] : '-'}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-slate-700">
                      {lBus ? `${lBus.fwd_headway_s.toFixed(0)}s` : '-'}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-slate-700">
                      {lBus ? lBus.load : '-'}
                    </td>
                    <td className="py-2.5 px-4 text-slate-900 font-medium">
                      #{rBus.stop_idx + 1} · {stopNames[rBus.stop_idx]}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-slate-900">
                      {rBus.fwd_headway_s.toFixed(0)}s
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-slate-900">
                      {rBus.load}
                    </td>
                    <td className={`py-2.5 px-4 text-right font-mono font-medium ${rc.text}`}>
                      {(pBunch * 100).toFixed(0)}%
                    </td>
                    <td className="py-2.5 px-5 text-right font-mono text-slate-900">
                      {holdS > 0 ? `${holdS}s` : '0s'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
