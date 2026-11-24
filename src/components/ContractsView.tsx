import { useState } from 'react';
import {
  PYTHON_SCHEMAS_REFERENCE,
  TYPESCRIPT_SCHEMAS_REFERENCE,
  type Snapshot,
} from '../common/schemas';

interface ContractsViewProps {
  sampleSnapshot: Snapshot;
  onRefreshStubSnapshot: () => void;
}

const FIVE_CONTRACTS = [
  {
    name: 'Schemas',
    builtBy: 'All three (Simulation drafts)',
    usedBy: 'Everyone',
    shape: 'BusState, Prediction, Snapshot in common/schemas.py & src/common/schemas.ts',
    gate1Stub: 'Frozen runtime validators',
  },
  {
    name: 'Environment',
    builtBy: 'Simulation (SUMO), Control (stub)',
    usedBy: 'Control, Prediction',
    shape: 'PettingZoo Parallel: reset(seed, options={"scenario": ...}), step({bus_id: hold_idx}). Only buses at a stop appear in obs; info[bus_id] carries BusState.',
    gate1Stub: 'StubHoldingEnv',
  },
  {
    name: 'Predictor',
    builtBy: 'Prediction',
    usedBy: 'Control, Runner',
    shape: 'predict(history: BusState[]) -> Prediction (calibrated p_bunch in [0, 1])',
    gate1Stub: 'ConstantPredictor (p=0.18)',
  },
  {
    name: 'Policy',
    builtBy: 'Control',
    usedBy: 'Runner',
    shape: 'act(obs) -> {bus_id: hold_idx}; baselines and MAPPO share one interface for live switching',
    gate1Stub: 'RandomPolicy',
  },
  {
    name: 'Snapshot feed',
    builtBy: 'Simulation',
    usedBy: 'Dashboard',
    shape: 'Runner.stream() yields one Snapshot per second; dashboard controls scenario & policy',
    gate1Stub: 'FakeSnapshotFeed',
  },
];

export function ContractsView({
  sampleSnapshot,
  onRefreshStubSnapshot,
}: ContractsViewProps) {
  const [lang, setLang] = useState<'typescript' | 'python'>('python');

  return (
    <div className="space-y-8">
      {/* Five Contracts Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-base font-semibold text-slate-900">
            Five Frozen Week-1 Interface Contracts
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Every contract ships a Gate 1 stub today. Swapping any stub for the real implementation in Steps 2–10 is a one-line change.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                <th className="py-2.5 px-5">Contract</th>
                <th className="py-2.5 px-4">Built By</th>
                <th className="py-2.5 px-4">Used By</th>
                <th className="py-2.5 px-4">Interface Shape</th>
                <th className="py-2.5 px-5">Step 1 Active Stub</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {FIVE_CONTRACTS.map((c) => (
                <tr key={c.name} className="hover:bg-slate-50/70">
                  <td className="py-3.5 px-5 align-top font-medium text-slate-900 whitespace-nowrap">
                    {c.name}
                  </td>
                  <td className="py-3.5 px-4 align-top text-slate-600">{c.builtBy}</td>
                  <td className="py-3.5 px-4 align-top text-slate-600">{c.usedBy}</td>
                  <td className="py-3.5 px-4 align-top text-slate-700 font-mono text-xs leading-relaxed">
                    {c.shape}
                  </td>
                  <td className="py-3.5 px-5 align-top font-mono text-xs text-emerald-700 whitespace-nowrap">
                    {c.gate1Stub}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Schema Code + Live Stub Snapshot Output */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Frozen Schema Definition
              </h3>
              <p className="text-xs text-slate-500">
                Exact 1:1 mirror between Python Pydantic and TypeScript runtime contracts
              </p>
            </div>
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md shrink-0">
              <button
                type="button"
                onClick={() => setLang('python')}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  lang === 'python'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Python (Pydantic)
              </button>
              <button
                type="button"
                onClick={() => setLang('typescript')}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  lang === 'typescript'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                TypeScript
              </button>
            </div>
          </div>

          <pre className="p-5 text-xs font-mono text-slate-800 bg-slate-50/70 overflow-x-auto leading-relaxed flex-1">
            {lang === 'python' ? PYTHON_SCHEMAS_REFERENCE : TYPESCRIPT_SCHEMAS_REFERENCE}
          </pre>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Live Gate 1 Stub Snapshot Payload
              </h3>
              <p className="text-xs text-slate-500">
                Emitted by FakeSnapshotFeed (t = {sampleSnapshot.t}s · {sampleSnapshot.buses.length} buses)
              </p>
            </div>
            <button
              type="button"
              onClick={onRefreshStubSnapshot}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              Step Stub Feed
            </button>
          </div>

          <pre className="p-5 text-xs font-mono text-slate-800 bg-slate-50/70 overflow-x-auto max-h-[440px] leading-relaxed flex-1">
            {JSON.stringify(
              {
                t: sampleSnapshot.t,
                policy: sampleSnapshot.policy,
                scenario: sampleSnapshot.scenario,
                kpis: sampleSnapshot.kpis,
                holds: sampleSnapshot.holds,
                predictions: sampleSnapshot.predictions,
                buses_sample_first_3: sampleSnapshot.buses.slice(0, 3),
              },
              null,
              2,
            )}
          </pre>
        </div>
      </div>
    </div>
  );
}
