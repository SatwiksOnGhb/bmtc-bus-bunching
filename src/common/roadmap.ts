/**
 * 10-Step Engineering Roadmap for the BMTC Bus Bunching Project.
 * Derived directly from BMTC_Bus_Bunching_Stack_and_Work_Split.pdf.
 */

export type StepStatus = 'completed' | 'next' | 'planned';

export interface BuildStep {
  step: number;
  title: string;
  shortTitle: string;
  modulePath: string;
  owner: 'All three' | 'Vikas S Nidagunde (Prediction)' | 'Satwik Ray (Simulation)' | 'Varun D Sawalkar (Data and Baselines)' | 'Varun D Sawalkar (Control)';
  gate: 'Gate 1: Stubs' | 'Gate 2: Bunching' | 'Gate 3: Full Loop' | 'Gate 4: Demo & Proof';
  status: StepStatus;
  summary: string;
  deliverables: string[];
}

export const TEN_STEP_ROADMAP: BuildStep[] = [
  {
    step: 1,
    title: 'Frozen Contracts, Single Config & Gate 1 Stub Harness',
    shortTitle: 'Contracts & Config',
    modulePath: 'common/ + tests/',
    owner: 'All three',
    gate: 'Gate 1: Stubs',
    status: 'completed',
    summary:
      'Freeze BusState, Prediction, Snapshot, Env, Predictor, Policy, and SnapshotFeed contracts; define single corridor config; verify end-to-end Gate 1 stubs with executable contract tests.',
    deliverables: [
      'Frozen TypeScript & Pydantic schema contracts (BusState, Prediction, Snapshot)',
      'Python handoff config and route manifest for the selected GTFS schedules',
      'Working Gate 1 stubs (StubEnv, ConstantPredictor, RandomPolicy, FakeSnapshotFeed)',
      'Executable contract test runner verifying all 5 interfaces',
    ],
  },
  {
    step: 2,
    title: 'BMTC GTFS Cleaning, CNI GPS Speed Calibration & Corridor EDA',
    shortTitle: 'GTFS & GPS EDA',
    modulePath: 'data/',
    owner: 'Varun D Sawalkar (Data and Baselines)',
    gate: 'Gate 1: Stubs',
    status: 'next',
    summary:
      'Use the Python handoff for cleaned community GTFS and schedule analysis. CNI GPS traces are still needed for measured speed calibration.',
    deliverables: [
      'Selected GTFS corridors: 375-D and 378 for training, 401-M for transfer',
      'GTFS cleaning pipeline dropping non-operational routes and broken timetables',
      'OSM way-hour speed pipeline, tested with example traces',
      'Schedule EDA notebook: headways, trip times, and stop patterns',
    ],
  },
  {
    step: 3,
    title: 'Stochastic Digital Twin Corridor with Dwell Feedback',
    shortTitle: 'Corridor Simulator',
    modulePath: 'sim/env + control/stub_env',
    owner: 'Satwik Ray (Simulation)',
    gate: 'Gate 2: Bunching',
    status: 'completed',
    summary:
      'Replace StubEnv with a physics-driven corridor simulator featuring Bengaluru mixed traffic (cars, two-wheelers, autos), Poisson stop arrivals, and dwell = fixed + s/boarding so natural bunching emerges.',
    deliverables: [
      'Seeded PettingZoo Parallel environment with asynchronous stop-arrival events',
      'Mixed-traffic link speed stochasticity calibrated to time of day',
      'Boarding dwell feedback loop demonstrating natural bus bunching on time-space plots',
      'Bus capacity enforcement and per-stop passenger queue tracking',
    ],
  },
  {
    step: 4,
    title: 'Commuter KPI Module & Rule-Based Baseline Controllers',
    shortTitle: 'KPIs & Baselines',
    modulePath: 'common/kpis + control/baselines',
    owner: 'Varun D Sawalkar (Control)',
    gate: 'Gate 2: Bunching',
    status: 'completed',
    summary:
      'Build the shared KPI engine (headway CV, % bunched arrivals, passenger wait, in-vehicle delay, trip time) and implement all 4 baseline policies behind Policy.act(obs).',
    deliverables: [
      'Shared KPI calculator including daily passenger-hours saved',
      'No Control baseline & Schedule-Based Holding (current practice)',
      'Headway-Based Holding (Daganzo 2009) & Two-Headway Holding',
      'Head-to-head baseline comparison table on seeded corridor runs',
    ],
  },
  {
    step: 5,
    title: 'Leak-Free Bunching Dataset & Calibrated Sequence Predictor',
    shortTitle: 'Bunching Predictor',
    modulePath: 'predict/',
    owner: 'Vikas S Nidagunde (Prediction)',
    gate: 'Gate 3: Full Loop',
    status: 'completed',
    summary:
      'Collect episode-split arrival logs, label bunching k stops ahead (k = 3, 5, 8; gap < 25% scheduled headway), and run Threshold, LightGBM-style, and calibrated temporal sequence predictors.',
    deliverables: [
      'Episode-level train/val/test split preventing temporal leakage',
      'Rolling N-stop sequence feature builder & focal-loss / temperature calibration',
      'Precision, Recall, F1, PR-AUC, calibration curve & F1-vs-lead-time charts',
      'Drop-in Predictor.predict(history) serving calibrated p_bunch to MARL',
    ],
  },
  {
    step: 6,
    title: 'Event-Driven MAPPO Controller & IPPO Ablation',
    shortTitle: 'MAPPO Controller',
    modulePath: 'control/mappo',
    owner: 'Varun D Sawalkar (Control)',
    gate: 'Gate 3: Full Loop',
    status: 'completed',
    summary:
      'Implement shared-actor MAPPO with centralized route-wide critic, elapsed-time discounting between stop arrivals, discrete holds {0..90}s, and IPPO / no-prediction ablations.',
    deliverables: [
      'Shared actor network generalizing to arbitrary fleet sizes',
      'Centralized critic observing corridor-wide headway distribution',
      'Event-driven reward: -(headway imbalance) - lambda * hold * onboard load',
      'Interactive training curve & policy action distribution inspector',
    ],
  },
  {
    step: 7,
    title: 'Seeded What-If Disruption Generator (Rain & Breakdown)',
    shortTitle: 'Disruption Scenarios',
    modulePath: 'sim/scenarios',
    owner: 'Satwik Ray (Simulation)',
    gate: 'Gate 3: Full Loop',
    status: 'completed',
    summary:
      'Build reproducible Bengaluru disruption scenarios — heavy monsoon rain slowing links and mid-corridor bus breakdown — both pre-seeded and triggerable live.',
    deliverables: [
      'make_scenario(name, seed) generator for normal, rain, and breakdown',
      'Monsoon rain link speed degradation and demand surge dynamics',
      'Bus breakdown immobilization with downstream gap recovery',
      'Live mid-run disruption triggers inside the simulator',
    ],
  },
  {
    step: 8,
    title: 'Dual-Seeded Live Runner & Synchronized Snapshot Stream',
    shortTitle: 'Dual Live Runner',
    modulePath: 'sim/runner',
    owner: 'Satwik Ray (Simulation)',
    gate: 'Gate 4: Demo & Proof',
    status: 'completed',
    summary:
      'Run two identical seeded simulations side by side (same seed, same traffic, same passengers): Current Practice on the left, MAPPO + Predictor on the right.',
    deliverables: [
      'Dual synchronized Runner.stream() emitting paired Snapshots every tick',
      'Live policy switcher and playback controls (Play, Pause, 1x–8x, Reset)',
      'Guaranteed identical passenger arrival & link-time seeds across both lanes',
      'Real-time telemetry diff stream (baseline vs MAPPO)',
    ],
  },
  {
    step: 9,
    title: 'Dispatcher Dashboard: Map, Time-Space Diagram & Alert Override',
    shortTitle: 'Dispatcher Dashboard',
    modulePath: 'dashboard/',
    owner: 'Vikas S Nidagunde (Prediction)',
    gate: 'Gate 4: Demo & Proof',
    status: 'completed',
    summary:
      'Build the operational BMTC control room UI with a live corridor map colored by p_bunch risk, side-by-side time-space diagrams, commuter KPI cards, and Accept / Override alerts.',
    deliverables: [
      'Interactive Bengaluru corridor bus map colored by real-time bunching risk',
      'Synchronized side-by-side Time-Space Diagrams (Baseline vs MAPPO)',
      'Early-warning alerts ("Bus X likely to bunch within k stops; hold s at stop")',
      'Human-in-the-loop Accept & Override buttons altering live bus holds',
    ],
  },
  {
    step: 10,
    title: 'Multi-Seed Ablation Harness, Zero-Shot Transfer & Impact Report',
    shortTitle: 'Ablations & Transfer',
    modulePath: 'eval/',
    owner: 'Varun D Sawalkar (Control)',
    gate: 'Gate 4: Demo & Proof',
    status: 'completed',
    summary:
      'Run the headline 3-seed experiment (MAPPO + Predictions vs MAPPO without Predictions vs all baselines), test zero-shot transfer on held-out route G-4, and export commuter impact.',
    deliverables: [
      '3-seed benchmark matrix across all policies and disruption scenarios',
      'Headline ablation: MAPPO with predictions vs MAPPO without predictions',
      'Zero-shot transfer test on unseen route G-4 and varied fleet sizes',
      'Commuter impact summary (passenger-hours saved/day) + CSV/JSON export',
    ],
  },
];
