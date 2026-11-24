import { useState } from 'react';
import { AlertTriangle, Check, SlidersHorizontal } from 'lucide-react';
import type { DualSnapshotFrame } from '../sim/runner';

interface AlertOverridePanelProps {
  frame: DualSnapshotFrame;
  holdActionsS: readonly number[];
  onAcceptAlert: (alertId: string) => void;
  onOverrideAlert: (alertId: string, holdSec: number) => void;
  onSelectBus: (busId: string) => void;
}

function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function AlertOverridePanel({
  frame,
  holdActionsS,
  onAcceptAlert,
  onOverrideAlert,
  onSelectBus,
}: AlertOverridePanelProps) {
  const [overridePickerId, setOverridePickerId] = useState<string | null>(null);
  const [selectedHoldByAlert, setSelectedHoldByAlert] = useState<Record<string, number>>({});

  const pendingOverridesList = Object.entries(frame.pending_overrides);
  const acceptedCount = frame.override_history.filter((h) => h.action === 'accepted').length;
  const overriddenCount = frame.override_history.filter((h) => h.action === 'overridden').length;

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col">
      <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Early-Warning Alerts &amp; Dispatcher Override
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Accept MAPPO&apos;s recommended hold or override with a custom duration for the bus&apos;s next stop.
          </p>
        </div>
        <div className="text-xs font-mono text-slate-500 tabular-nums shrink-0">
          {frame.alerts.length} alerts
        </div>
      </div>

      {/* Pending Human Overrides Banner */}
      {pendingOverridesList.length > 0 && (
        <div className="px-5 py-2.5 bg-purple-50 border-b border-purple-200 text-xs text-purple-900 flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">
            Queued for next arrival:
          </span>
          <span className="font-mono tabular-nums">
            {pendingOverridesList.map(([busId, holdS]) => `${busId} → ${holdS}s`).join(' · ')}
          </span>
        </div>
      )}

      {/* Alerts List */}
      <div className="divide-y divide-slate-200 max-h-[340px] overflow-y-auto">
        {frame.right.disruption_events.map((ev, i) => (
          <div key={`dis-${i}`} className="px-5 py-3 bg-amber-50/60 text-xs">
            <div className="flex items-center justify-between text-amber-900 font-medium">
              <span className="inline-flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" />
                Active Disruption · {ev.type.replace('_', ' ')}
              </span>
              <span className="font-mono tabular-nums">{formatClock(ev.t)}</span>
            </div>
            <p className="text-slate-700 mt-1">{ev.summary}</p>
          </div>
        ))}

        {frame.alerts.length === 0 ? (
          <div className="px-5 py-10 text-center text-xs text-slate-500">
            No high-risk bunching alerts at t = {formatClock(frame.clock_t)}. Press Play or Step Tick to monitor incoming stop arrivals.
          </div>
        ) : (
          frame.alerts.map((alert) => {
            const isPickerOpen = overridePickerId === alert.id;
            const defaultAlt = alert.recommended_hold_s === 0 ? 30 : 0;
            const chosenHold = selectedHoldByAlert[alert.id] ?? defaultAlt;

            return (
              <div key={alert.id} className="px-5 py-3.5 text-xs space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectBus(alert.bus_id)}
                    className="text-left group"
                  >
                    <span className="font-mono font-semibold text-slate-900 group-hover:text-blue-700">
                      {alert.bus_id}
                    </span>
                    <span className="text-slate-400 mx-1.5">·</span>
                    <span className="text-slate-600">{alert.stop_name}</span>
                  </button>
                  <span className="font-mono text-red-700 font-medium tabular-nums shrink-0">
                    p={(alert.p_bunch * 100).toFixed(0)}% · {formatClock(alert.t)}
                  </span>
                </div>

                <p className="text-slate-700 leading-relaxed">{alert.message}</p>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                  <div className="text-[11px] font-mono text-slate-500 tabular-nums">
                    Rec: <strong className="text-slate-900">{alert.recommended_hold_s}s</strong>
                    <span className="mx-1.5">·</span>
                    Status:{' '}
                    <span
                      className={
                        alert.status === 'accepted'
                          ? 'text-emerald-700 font-semibold'
                          : alert.status === 'overridden'
                          ? 'text-purple-700 font-semibold'
                          : 'text-amber-700 font-medium'
                      }
                    >
                      {alert.status === 'accepted'
                        ? `Accepted (${alert.applied_hold_s}s)`
                        : alert.status === 'overridden'
                        ? `Overridden (${alert.applied_hold_s}s)`
                        : 'Pending review'}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        onAcceptAlert(alert.id);
                        setOverridePickerId(null);
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-sm transition-colors"
                    >
                      <Check className="w-3 h-3" />
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setOverridePickerId((curr) => (curr === alert.id ? null : alert.id))
                      }
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-sm transition-colors"
                    >
                      <SlidersHorizontal className="w-3 h-3" />
                      Override
                    </button>
                  </div>
                </div>

                {isPickerOpen && (
                  <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1">
                      {holdActionsS.map((h) => (
                        <button
                          key={h}
                          type="button"
                          onClick={() =>
                            setSelectedHoldByAlert((prev) => ({ ...prev, [alert.id]: h }))
                          }
                          className={`px-2 py-0.5 text-[11px] font-mono rounded-xs border ${
                            chosenHold === h
                              ? 'bg-slate-900 text-white border-slate-900'
                              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                          }`}
                        >
                          {h}s
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        onOverrideAlert(alert.id, chosenHold);
                        setOverridePickerId(null);
                      }}
                      className="px-2.5 py-1 text-[11px] font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-sm transition-colors"
                    >
                      Apply {chosenHold}s Override
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Executed Human-in-the-Loop Audit Trail */}
      <div className="px-5 py-3.5 border-t border-slate-200 bg-slate-50/70 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-slate-700">Executed Dispatcher Interventions</span>
          <span className="font-mono text-slate-500 tabular-nums">
            {acceptedCount} accepted · {overriddenCount} overridden
          </span>
        </div>

        {frame.override_history.length === 0 ? (
          <p className="text-[11px] text-slate-500">
            Click Accept or Override on any warning (or select a bus on the map) and advance the simulation to verify the executed hold override.
          </p>
        ) : (
          <div className="space-y-1 max-h-[110px] overflow-y-auto">
            {frame.override_history.slice(0, 6).map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between text-[11px] text-slate-700 tabular-nums"
              >
                <span className="truncate">
                  <strong className="font-mono text-slate-900">{item.bus_id}</strong> at {item.stop_name}
                </span>
                <span className="font-mono shrink-0 ml-2">
                  Policy {item.policy_hold_s}s →{' '}
                  <strong className={item.action === 'overridden' ? 'text-purple-700' : 'text-emerald-700'}>
                    {item.executed_hold_s}s
                  </strong>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
