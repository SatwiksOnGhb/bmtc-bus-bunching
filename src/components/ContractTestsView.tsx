import { CheckCircle2, Play, XCircle } from 'lucide-react';
import type { ContractSuiteReport } from '../common/contractTests';

interface ContractTestsViewProps {
  report: ContractSuiteReport;
  onRunTests: () => void;
}

export function ContractTestsView({ report, onRunTests }: ContractTestsViewProps) {
  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-lg p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Gate 1 Contract Verification Suite
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Executes real runtime assertions against StubHoldingEnv, ConstantPredictor, RandomPolicy, FakeSnapshotFeed, and Config invariants. Last run at{' '}
            <span className="font-mono tabular-nums text-slate-700">{report.ranAt}</span>.
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-sm font-semibold tabular-nums text-slate-900">
              {report.passed} passed · {report.failed} failed
            </div>
            <div
              className={`text-xs ${
                report.failed === 0 ? 'text-emerald-700' : 'text-red-700'
              }`}
            >
              {report.failed === 0 ? 'Merge gate passing' : 'Fix failures before merge'}
            </div>
          </div>
          <button
            type="button"
            onClick={onRunTests}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Play className="w-3.5 h-3.5" />
            Re-run Suite
          </button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                <th className="py-2.5 px-5">Status</th>
                <th className="py-2.5 px-4">Contract</th>
                <th className="py-2.5 px-4">Assertion</th>
                <th className="py-2.5 px-4">Observed Output</th>
                <th className="py-2.5 px-5 text-right">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {report.results.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50/70">
                  <td className="py-3.5 px-5 whitespace-nowrap">
                    <span
                      className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                        r.passed ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {r.passed ? (
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                      ) : (
                        <XCircle className="w-4 h-4 shrink-0" />
                      )}
                      {r.passed ? 'Pass' : 'Fail'}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 font-mono text-xs font-medium text-slate-900 whitespace-nowrap">
                    {r.contract}
                  </td>
                  <td className="py-3.5 px-4 text-slate-800">{r.name}</td>
                  <td className="py-3.5 px-4 font-mono text-xs text-slate-600">
                    {r.details}
                  </td>
                  <td className="py-3.5 px-5 text-right font-mono text-xs tabular-nums text-slate-500 whitespace-nowrap">
                    {r.durationMs.toFixed(2)} ms
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
