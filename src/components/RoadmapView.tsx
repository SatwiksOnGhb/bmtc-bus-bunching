import { Check, ChevronRight } from 'lucide-react';
import { TEAM_WORK_SPLIT } from '../common/config';
import { TEN_STEP_ROADMAP, type BuildStep } from '../common/roadmap';
import { ArchitectureLoopDiagram } from './ArchitectureLoopDiagram';

interface RoadmapViewProps {
  selectedStep: number;
  onSelectStep: (step: number) => void;
  onJumpToTab: (
    tab:
      | 'data'
      | 'sim'
      | 'baselines'
      | 'predict'
      | 'mappo'
      | 'scenarios'
      | 'runner'
      | 'dashboard'
      | 'eval'
      | 'contracts'
      | 'config'
      | 'tests',
  ) => void;
  testsPassed: number;
  testsTotal: number;
}

export function RoadmapView({
  selectedStep,
  onSelectStep,
  onJumpToTab,
  testsPassed,
  testsTotal,
}: RoadmapViewProps) {
  const activeStep: BuildStep =
    TEN_STEP_ROADMAP.find((s) => s.step === selectedStep) ?? TEN_STEP_ROADMAP[0];
  const completedCount = TEN_STEP_ROADMAP.filter((s) => s.status === 'completed').length;
  const nextStep = TEN_STEP_ROADMAP.find((s) => s.status === 'next');

  return (
    <div className="space-y-8">
      {/* Top Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Current Build Stage</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            Step {completedCount} of 10
          </div>
          <div className="text-xs text-emerald-700 mt-1">
            Steps 1–{completedCount} complete{nextStep ? ` · Step ${nextStep.step} queued` : ''}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Frozen Contracts</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            5 / 5
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Schemas · Env · Predictor · Policy · Feed
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Contract Tests</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            {testsPassed} / {testsTotal}
          </div>
          <div className="text-xs text-emerald-700 mt-1">
            {testsPassed === testsTotal ? 'All Gates 1–4 verified' : `${testsTotal - testsPassed} check(s) failing`}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Configured Corridors</div>
          <div className="text-xl font-semibold text-slate-900 mt-1 tabular-nums">
            3 Routes
          </div>
          <div className="text-xs text-slate-500 mt-1">
            500D · 335E (train) · G-4 (transfer)
          </div>
        </div>
      </div>

      {/* 10-Step Interactive Build Plan */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-7 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                10-Step Incremental Execution Plan
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Each step replaces stubs one module at a time while preserving the frozen Week-1 contracts.
              </p>
            </div>
            <span className="text-xs font-mono text-slate-500 tabular-nums shrink-0">
              {completedCount} / 10 done
            </span>
          </div>

          <div className="divide-y divide-slate-200">
            {TEN_STEP_ROADMAP.map((item) => {
              const isSelected = item.step === activeStep.step;
              return (
                <button
                  key={item.step}
                  type="button"
                  onClick={() => onSelectStep(item.step)}
                  className={`w-full text-left px-5 py-3.5 flex items-center gap-4 transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 ${
                    isSelected ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                  }`}
                >
                  <div
                    className={`w-7 h-7 rounded-md flex items-center justify-center text-xs font-mono font-semibold shrink-0 tabular-nums ${
                      item.status === 'completed'
                        ? 'bg-emerald-600 text-white'
                        : item.status === 'next'
                        ? 'bg-blue-700 text-white'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {item.status === 'completed' ? <Check className="w-3.5 h-3.5" /> : item.step}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-900 truncate">
                        {String(item.step).padStart(2, '0')}. {item.title}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-mono">{item.modulePath}</span>
                      <span aria-hidden="true">·</span>
                      <span>{item.owner}</span>
                      <span aria-hidden="true">·</span>
                      <span
                        className={
                          item.status === 'completed'
                            ? 'text-emerald-700 font-medium'
                            : item.status === 'next'
                            ? 'text-blue-700 font-medium'
                            : 'text-slate-500'
                        }
                      >
                        {item.status === 'completed'
                          ? 'Completed'
                          : item.status === 'next'
                          ? 'Up Next'
                          : 'Planned'}
                      </span>
                    </div>
                  </div>

                  <ChevronRight
                    className={`w-4 h-4 shrink-0 ${
                      isSelected ? 'text-blue-700' : 'text-slate-400'
                    }`}
                  />
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected Step Detail Inspector */}
        <div className="xl:col-span-5 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
          <div>
            <div className="text-xs text-slate-500 flex items-center gap-2">
              <span>Step {activeStep.step} of 10</span>
              <span aria-hidden="true">·</span>
              <span>{activeStep.gate}</span>
              <span aria-hidden="true">·</span>
              <span
                className={
                  activeStep.status === 'completed'
                    ? 'text-emerald-700 font-medium'
                    : activeStep.status === 'next'
                    ? 'text-blue-700 font-medium'
                    : 'text-slate-600'
                }
              >
                {activeStep.status === 'completed'
                  ? 'Completed'
                  : activeStep.status === 'next'
                  ? 'Ready to build next'
                  : 'Scheduled'}
              </span>
            </div>
            <h3 className="text-lg font-semibold text-slate-900 mt-1.5">
              {activeStep.title}
            </h3>
            <p className="text-sm text-slate-600 mt-2 leading-relaxed">
              {activeStep.summary}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-200 text-xs">
            <div>
              <div className="text-slate-500">Module Path</div>
              <div className="font-mono font-medium text-slate-900 mt-1">
                {activeStep.modulePath}
              </div>
            </div>
            <div>
              <div className="text-slate-500">Lead Owner</div>
              <div className="font-medium text-slate-900 mt-1">{activeStep.owner}</div>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200">
            <div className="text-xs font-medium text-slate-700 mb-2.5">
              Concrete Deliverables
            </div>
            <ul className="space-y-2">
              {activeStep.deliverables.map((deliv, i) => (
                <li key={i} className="text-sm text-slate-700 flex items-start gap-2.5">
                  <span className="font-mono text-xs text-slate-400 mt-0.5 tabular-nums">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span>{deliv}</span>
                </li>
              ))}
            </ul>
          </div>

          {activeStep.step === 1 ? (
            <div className="pt-4 border-t border-slate-200 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onJumpToTab('contracts')}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Inspect Schemas
              </button>
              <button
                type="button"
                onClick={() => onJumpToTab('config')}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Edit Corridor Config
              </button>
              <button
                type="button"
                onClick={() => onJumpToTab('tests')}
                className="px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                View Test Results
              </button>
            </div>
          ) : activeStep.step === 2 ? (
            <div className="pt-4 border-t border-slate-200 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onJumpToTab('data')}
                className="px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Open GTFS &amp; GPS EDA
              </button>
              <button
                type="button"
                onClick={() => onJumpToTab('tests')}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Verify Data Tests
              </button>
            </div>
          ) : activeStep.step === 3 ? (
            <div className="pt-4 border-t border-slate-200 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onJumpToTab('sim')}
                className="px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Open Corridor Simulator
              </button>
              <button
                type="button"
                onClick={() => onJumpToTab('tests')}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Verify Gate 2 Tests
              </button>
            </div>
          ) : activeStep.step === 4 ? (
            <div className="pt-4 border-t border-slate-200 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onJumpToTab('baselines')}
                className="px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Open Baselines &amp; KPIs
              </button>
              <button
                type="button"
                onClick={() => onJumpToTab('tests')}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Verify Policy Tests
              </button>
            </div>
          ) : activeStep.step === 5 ? (
            <div className="pt-4 border-t border-slate-200 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onJumpToTab('predict')}
                className="px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Open Bunching Predictor
              </button>
              <button
                type="button"
                onClick={() => onJumpToTab('tests')}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Verify Predictor Tests
              </button>
            </div>
          ) : activeStep.step === 6 ? (
            <div className="pt-4 border-t border-slate-200 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onJumpToTab('mappo')}
                className="px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Open MAPPO Controller
              </button>
              <button
                type="button"
                onClick={() => onJumpToTab('tests')}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Verify Gate 3 Tests
              </button>
            </div>
          ) : activeStep.step === 7 ? (
            <div className="pt-4 border-t border-slate-200 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onJumpToTab('scenarios')}
                className="px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Open Disruption Scenarios
              </button>
              <button
                type="button"
                onClick={() => onJumpToTab('tests')}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Verify Scenario Tests
              </button>
            </div>
          ) : activeStep.step === 8 ? (
            <div className="pt-4 border-t border-slate-200 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onJumpToTab('runner')}
                className="px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Open Dual Live Runner
              </button>
              <button
                type="button"
                onClick={() => onJumpToTab('tests')}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Verify Stream Tests
              </button>
            </div>
          ) : activeStep.step === 9 ? (
            <div className="pt-4 border-t border-slate-200 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onJumpToTab('dashboard')}
                className="px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Open Dispatcher Dashboard
              </button>
              <button
                type="button"
                onClick={() => onJumpToTab('tests')}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Verify Dashboard Tests
              </button>
            </div>
          ) : activeStep.step === 10 ? (
            <div className="pt-4 border-t border-slate-200 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onJumpToTab('eval')}
                className="px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Open Ablations &amp; Impact Report
              </button>
              <button
                type="button"
                onClick={() => onJumpToTab('tests')}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Verify All 25 Tests
              </button>
            </div>
          ) : (
            <div className="pt-4 border-t border-slate-200 text-xs text-slate-600 leading-relaxed">
              Ask to proceed with <span className="font-semibold text-slate-900">Step {activeStep.step}</span> in chat when ready to implement this module on top of the frozen contracts.
            </div>
          )}
        </div>
      </div>

      {/* System Architecture Diagram */}
      <ArchitectureLoopDiagram />

      {/* Team Ownership & Work Split Table (Page 1 of PDF) */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-base font-semibold text-slate-900">
            Team Work Split & Interface Handoffs
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Each team member owns one synopsis objective, one engineering piece, and one operational impact feature (~7 person-weeks each).
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                <th className="py-2.5 px-5">Role & Owner</th>
                <th className="py-2.5 px-4">Core Piece</th>
                <th className="py-2.5 px-4">Engineering Piece</th>
                <th className="py-2.5 px-4">Impact Feature</th>
                <th className="py-2.5 px-5">Handoff Contracts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {TEAM_WORK_SPLIT.map((member) => (
                <tr key={member.role} className="hover:bg-slate-50/70">
                  <td className="py-3.5 px-5 align-top">
                    <div className="font-medium text-slate-900">{member.owner}</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {member.role} · {member.objective}
                    </div>
                  </td>
                  <td className="py-3.5 px-4 align-top text-slate-700">{member.core_piece}</td>
                  <td className="py-3.5 px-4 align-top text-slate-700">
                    {member.engineering_piece}
                  </td>
                  <td className="py-3.5 px-4 align-top text-slate-700">
                    {member.impact_feature}
                  </td>
                  <td className="py-3.5 px-5 align-top font-mono text-xs text-slate-700">
                    {member.handoffs.join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
