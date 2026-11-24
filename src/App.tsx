/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo, useState } from 'react';
import {
  Activity,
  Award,
  BarChart3,
  Check,
  CloudRain,
  Cpu,
  Database,
  FileCode2,
  FlaskConical,
  ListChecks,
  Map as MapIcon,
  Menu,
  Radar,
  Radio,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { DEFAULT_CONFIG, type ProjectConfig } from './common/config';
import { runContractTestSuite } from './common/contractTests';
import { TEN_STEP_ROADMAP } from './common/roadmap';
import { FakeSnapshotFeed } from './common/stubs';
import { BaselinesView } from './components/BaselinesView';
import { ConfigView } from './components/ConfigView';
import { ContractsView } from './components/ContractsView';
import { ContractTestsView } from './components/ContractTestsView';
import { DataEdaView } from './components/DataEdaView';
import { LiveRunnerView } from './components/LiveRunnerView';
import { MappoView } from './components/MappoView';
import { PredictorView } from './components/PredictorView';
import { RoadmapView } from './components/RoadmapView';
import { ScenariosView } from './components/ScenariosView';
import { SimulatorView } from './components/SimulatorView';
import { DispatcherDashboardView } from './dashboard/DispatcherDashboardView';
import { AblationEvalView } from './eval/AblationEvalView';

type ActiveTab =
  | 'roadmap'
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
  | 'tests';

const NAV_ITEMS: Array<{
  id: ActiveTab;
  label: string;
  breadcrumb: string;
  section: string;
  icon: typeof ListChecks;
}> = [
  { id: 'dashboard', label: 'Dispatcher Dashboard', breadcrumb: 'Dispatcher Dashboard', section: 'Step 9: Control Room', icon: MapIcon },
  { id: 'eval', label: 'Ablations & Impact', breadcrumb: 'Ablations & Impact', section: 'Step 10: Multi-Seed Proof', icon: Award },
  { id: 'roadmap', label: '10-Step Plan', breadcrumb: '10-Step Plan', section: 'Project Overview', icon: ListChecks },
  { id: 'data', label: 'GTFS & GPS EDA', breadcrumb: 'GTFS & GPS EDA', section: 'Step 2: Data & Calibration', icon: Database },
  { id: 'sim', label: 'Corridor Simulator', breadcrumb: 'Corridor Simulator', section: 'Step 3: Digital Twin', icon: Activity },
  { id: 'baselines', label: 'Baselines & KPIs', breadcrumb: 'Baselines & KPIs', section: 'Step 4: Control Baselines', icon: BarChart3 },
  { id: 'predict', label: 'Bunching Predictor', breadcrumb: 'Bunching Predictor', section: 'Step 5: Early Warning ML', icon: Radar },
  { id: 'mappo', label: 'MAPPO Controller', breadcrumb: 'MAPPO Controller', section: 'Step 6: Event-Driven MARL', icon: Cpu },
  { id: 'scenarios', label: 'Disruption Scenarios', breadcrumb: 'Disruption Scenarios', section: 'Step 7: What-If Disruptions', icon: CloudRain },
  { id: 'runner', label: 'Dual Live Runner', breadcrumb: 'Dual Live Runner', section: 'Step 8: Synchronized Stream', icon: Radio },
  { id: 'contracts', label: 'Frozen Contracts', breadcrumb: 'Frozen Contracts', section: 'Step 1: Contracts & Config', icon: FileCode2 },
  { id: 'config', label: 'Corridor Config', breadcrumb: 'Corridor Config', section: 'Step 1: Contracts & Config', icon: SlidersHorizontal },
  { id: 'tests', label: 'Contract Tests', breadcrumb: 'Contract Tests', section: 'Verification', icon: FlaskConical },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('eval');
  const [selectedStep, setSelectedStep] = useState<number>(10);
  const [config, setConfig] = useState<ProjectConfig>(DEFAULT_CONFIG);
  const [testRunNonce, setTestRunNonce] = useState<number>(0);
  const [stubStepCount, setStubStepCount] = useState<number>(5);
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);

  const report = useMemo(() => {
    void testRunNonce;
    return runContractTestSuite(config);
  }, [config, testRunNonce]);

  const liveStubSnapshot = useMemo(() => {
    const feed = new FakeSnapshotFeed(config, config.default_seed, 'normal');
    const snaps = Array.from(feed.stream(stubStepCount));
    return snaps[snaps.length - 1] ?? report.sampleSnapshot;
  }, [config, stubStepCount, report.sampleSnapshot]);

  const currentNav = NAV_ITEMS.find((item) => item.id === activeTab) ?? NAV_ITEMS[0];

  const handleRunContractTests = () => {
    setTestRunNonce((n) => n + 1);
    setActiveTab('tests');
  };

  const handleSelectSidebarStep = (stepNumber: number) => {
    setSelectedStep(stepNumber);
    setActiveTab('roadmap');
    setMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Mobile Sidebar Backdrop */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-slate-900/30 z-30 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Workspace Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-40 w-64 bg-white border-r border-slate-200 flex flex-col transition-transform duration-150 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="h-14 px-5 border-b border-slate-200 flex items-center justify-between shrink-0">
          <span className="font-display text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            BMTC Control Room
          </span>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            className="lg:hidden p-1.5 text-slate-500 hover:text-slate-900 rounded-md"
            aria-label="Close navigation"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
          {/* Primary Workbench Navigation */}
          <div>
            <div className="px-2.5 text-xs font-medium text-slate-500 mb-2">
              Control Room Modules
            </div>
            <nav className="space-y-0.5" aria-label="Primary navigation">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center justify-between gap-2.5 px-2.5 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      active
                        ? 'bg-blue-50 text-blue-800'
                        : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    <span className="inline-flex items-center gap-2.5 min-w-0">
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </span>
                    {item.id === 'tests' && (
                      <span className="text-xs font-mono tabular-nums text-emerald-700">
                        {report.passed}/{report.total}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* 10-Step Progress Rail */}
          <div className="pt-4 border-t border-slate-200">
            <div className="px-2.5 flex items-center justify-between text-xs font-medium text-slate-500 mb-2">
              <span>10-Step Build Rail</span>
              <span className="font-mono tabular-nums">
                {TEN_STEP_ROADMAP.filter((s) => s.status === 'completed').length}/10
              </span>
            </div>
            <div className="space-y-0.5">
              {TEN_STEP_ROADMAP.map((s) => {
                const isSelected = activeTab === 'roadmap' && selectedStep === s.step;
                return (
                  <button
                    key={s.step}
                    type="button"
                    onClick={() => handleSelectSidebarStep(s.step)}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 text-xs rounded-md transition-colors text-left ${
                      isSelected
                        ? 'bg-slate-100 text-slate-900 font-medium'
                        : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                    }`}
                  >
                    <span
                      className={`w-4 h-4 rounded-xs flex items-center justify-center text-[10px] font-mono tabular-nums shrink-0 ${
                        s.status === 'completed'
                          ? 'bg-emerald-600 text-white'
                          : s.status === 'next'
                          ? 'bg-blue-700 text-white'
                          : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      {s.status === 'completed' ? <Check className="w-3 h-3" /> : s.step}
                    </span>
                    <span className="truncate">{s.shortTitle}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="px-5 py-3.5 border-t border-slate-200 text-xs text-slate-500">
          Bengaluru BMTC · All 10 Steps Complete
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract: Breadcrumb Left, Primary Action Right */}
        <header className="h-14 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-8 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 -ml-1.5 text-slate-600 hover:text-slate-900 rounded-md"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm text-slate-500 truncate">
              <span className="whitespace-nowrap">{currentNav.section}</span>
              <span aria-hidden="true">/</span>
              <span className="font-medium text-slate-900 truncate">
                {currentNav.breadcrumb}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={handleRunContractTests}
              className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              Run Contract Tests
            </button>
          </div>
        </header>

        {/* Viewport Container */}
        <main className="flex-1 p-6 lg:p-8 max-w-[1360px] w-full mx-auto">
          <div className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              {activeTab === 'roadmap' && 'BMTC Bus Bunching — 10-Step Engineering Roadmap'}
              {activeTab === 'data' && 'Corridor Data Demo'}
              {activeTab === 'sim' && 'Stochastic Digital Twin Corridor & Dwell-Feedback Bunching'}
              {activeTab === 'baselines' && 'Commuter KPI Engine & Rule-Based Holding Baselines'}
              {activeTab === 'predict' && 'Leak-Free Bunching Dataset & Calibrated Sequence Predictor'}
              {activeTab === 'mappo' && 'Event-Driven MAPPO Holding Controller & Headline Ablation'}
              {activeTab === 'scenarios' && 'Seeded What-If Disruption Generator: Monsoon Rain & Bus Breakdown'}
              {activeTab === 'runner' && 'Dual-Seeded Live Runner & Synchronized Snapshot Stream'}
              {activeTab === 'dashboard' && 'BMTC Dispatcher Control Room: Live Map, Time-Space & Alert Override'}
              {activeTab === 'eval' && 'Multi-Seed Ablation Harness, Zero-Shot Transfer & Impact Report'}
              {activeTab === 'contracts' && 'Frozen Week-1 Contracts & Gate 1 Stubs'}
              {activeTab === 'config' && 'Corridor Registry & Single Config Source'}
              {activeTab === 'tests' && 'Contract Verification Test Suite'}
            </h1>
            <p className="text-sm text-slate-600 mt-1 max-w-3xl">
              {activeTab === 'roadmap' &&
                'Incremental delivery plan uniting the SUMO digital twin, calibrated bunching predictor, and event-driven MAPPO holding controller into one shared control loop.'}
              {activeTab === 'data' &&
                'This browser demo uses illustrative route, timetable, and speed data. Open the project README for the community GTFS analysis and SUMO handoff.'}
              {activeTab === 'sim' &&
                'Browser corridor simulation with illustrative traffic speeds, Poisson passenger arrivals, and boarding dwell feedback.'}
              {activeTab === 'baselines' &&
                'Shared commuter KPI calculator and 4 rule-based holding policies (No Control, Schedule-Based, Daganzo 2009, Two-Headway) setting the exact benchmark for MAPPO to beat.'}
              {activeTab === 'predict' &&
                'Episode-split sequence dataset and calibrated TCN/LSTM bunching predictor (k = 3, 5, 8 stops ahead) feeding calibrated p_bunch directly into the MARL control loop.'}
              {activeTab === 'mappo' &&
                'Shared-actor MAPPO with centralized route-wide critic and elapsed-time discounting trained inside the Gate 3 full loop, compared against MAPPO w/o Predictions, IPPO, and all baselines.'}
              {activeTab === 'scenarios' &&
                'Reproducible seeded Bengaluru disruptions (heavy monsoon waterlogging slowdown and mid-corridor bus immobilization) comparing Schedule-Based Holding vs MAPPO + Calibrated Predictor recovery.'}
              {activeTab === 'runner' &&
                'Synchronized dual-twin runner executing identical corridor seeds, traffic shocks, passenger arrivals, and live disruption injections side by side across Current Practice vs MAPPO + Predictor.'}
              {activeTab === 'dashboard' &&
                'Live Bengaluru corridor map colored by calibrated bunching risk (p_bunch), human-in-the-loop Accept / Override early-warning alerts, commuter KPI comparison, and synchronized side-by-side Time-Space Diagrams.'}
              {activeTab === 'eval' &&
                '3-seed [42, 108, 256] benchmark matrix across all 7 policies and 3 disruption scenarios, headline prediction ablation, zero-shot transfer on unseen route G-4 (7–15 buses), and downloadable CSV/JSON reports.'}
              {activeTab === 'contracts' &&
                'Shared interfaces frozen in Step 1 across Simulation, Prediction, and Control so real modules drop in one step at a time.'}
              {activeTab === 'config' &&
                'Centralized route IDs, discrete hold actions, bunching thresholds, and MARL hyperparameters shared by every module.'}
              {activeTab === 'tests' &&
                'Automated runtime checks across all 10 build steps: frozen schemas, GTFS/GPS calibration, Gate 2 bunching, baselines, leak-free predictor, MAPPO, disruptions, dual runner, live overrides, and 3-seed zero-shot transfer.'}
            </p>
          </div>

          {activeTab === 'dashboard' && <DispatcherDashboardView config={config} />}

          {activeTab === 'eval' && <AblationEvalView config={config} />}

          {activeTab === 'roadmap' && (
            <RoadmapView
              selectedStep={selectedStep}
              onSelectStep={setSelectedStep}
              onJumpToTab={(tab) => setActiveTab(tab)}
              testsPassed={report.passed}
              testsTotal={report.total}
            />
          )}

          {activeTab === 'data' && <DataEdaView />}

          {activeTab === 'sim' && <SimulatorView config={config} />}

          {activeTab === 'baselines' && <BaselinesView config={config} />}

          {activeTab === 'predict' && <PredictorView config={config} />}

          {activeTab === 'mappo' && <MappoView config={config} />}

          {activeTab === 'scenarios' && <ScenariosView config={config} />}

          {activeTab === 'runner' && <LiveRunnerView config={config} />}

          {activeTab === 'contracts' && (
            <ContractsView
              sampleSnapshot={liveStubSnapshot}
              onRefreshStubSnapshot={() => setStubStepCount((c) => (c >= 15 ? 5 : c + 1))}
            />
          )}

          {activeTab === 'config' && (
            <ConfigView config={config} onChangeConfig={setConfig} />
          )}

          {activeTab === 'tests' && (
            <ContractTestsView
              report={report}
              onRunTests={() => setTestRunNonce((n) => n + 1)}
            />
          )}
        </main>
      </div>
    </div>
  );
}
