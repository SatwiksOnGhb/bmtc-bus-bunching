import { RotateCcw } from 'lucide-react';
import {
  DEFAULT_CONFIG,
  serializeConfigYaml,
  validateConfig,
  type ProjectConfig,
} from '../common/config';

interface ConfigViewProps {
  config: ProjectConfig;
  onChangeConfig: (next: ProjectConfig) => void;
}

export function ConfigView({ config, onChangeConfig }: ConfigViewProps) {
  const errors = validateConfig(config);
  const yamlPreview = serializeConfigYaml(config);

  const updateNumericField = (
    key:
      | 'default_seed'
      | 'bunching_headway_ratio'
      | 'dwell_fixed_s'
      | 'dwell_per_boarding_s'
      | 'mappo_hold_penalty_lambda'
      | 'alert_probability_threshold',
    rawValue: string,
  ) => {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return;
    onChangeConfig({ ...config, [key]: parsed });
  };

  return (
    <div className="space-y-8">
      {/* Route Registry Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Configured BMTC High-Frequency Corridors
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              2 corridors reserved for training and 1 unseen corridor held out for zero-shot transfer testing (Rule #3: no magic numbers in code).
            </p>
          </div>
          <span className="text-xs text-slate-500 whitespace-nowrap shrink-0">
            {config.data_licence}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                <th className="py-2.5 px-5">Route</th>
                <th className="py-2.5 px-4">Corridor</th>
                <th className="py-2.5 px-4">Split</th>
                <th className="py-2.5 px-4 text-right">Daily Trips</th>
                <th className="py-2.5 px-4 text-right">Stops</th>
                <th className="py-2.5 px-4 text-right">Length (km)</th>
                <th className="py-2.5 px-4 text-right">Sched. Headway</th>
                <th className="py-2.5 px-5 text-right">Fleet Size</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {config.routes.map((route) => (
                <tr key={route.route_id} className="hover:bg-slate-50/70">
                  <td className="py-3.5 px-5 font-mono font-semibold text-slate-900">
                    {route.route_id}
                  </td>
                  <td className="py-3.5 px-4">
                    <div className="font-medium text-slate-900">{route.corridor_name}</div>
                    <div className="text-xs text-slate-500">
                      {route.origin} to {route.destination}
                    </div>
                  </td>
                  <td className="py-3.5 px-4 text-xs font-medium">
                    <span
                      className={
                        route.split === 'train' ? 'text-blue-700' : 'text-amber-700'
                      }
                    >
                      {route.split === 'train' ? 'Training' : 'Held-out Transfer'}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-700">
                    {route.daily_trips}
                  </td>
                  <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-700">
                    {route.stop_count}
                  </td>
                  <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-700">
                    {route.corridor_length_km.toFixed(1)}
                  </td>
                  <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-700">
                    {route.scheduled_headway_s}s
                  </td>
                  <td className="py-3.5 px-5 text-right font-mono tabular-nums text-slate-700">
                    {route.fleet_size} buses
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Parameter Editor + Live YAML Source */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-6 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Shared Simulation, Prediction &amp; Control Parameters
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Adjusting values immediately re-validates invariants and updates the YAML spec.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onChangeConfig(DEFAULT_CONFIG)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Defaults
            </button>
          </div>

          {errors.length > 0 ? (
            <div className="p-3.5 rounded-md bg-red-50 border border-red-200 text-xs text-red-800 space-y-1">
              <div className="font-semibold">Configuration invariant failure</div>
              {errors.map((err, i) => (
                <div key={i}>{err}</div>
              ))}
            </div>
          ) : (
            <div className="p-3 rounded-md bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
              All configuration invariants valid — ready for contract tests and downstream modules.
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="text-xs font-medium text-slate-700">Default Seed</span>
              <input
                type="number"
                value={config.default_seed}
                onChange={(e) => updateNumericField('default_seed', e.target.value)}
                className="mt-1 w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-700">
                Bunching Headway Ratio
              </span>
              <input
                type="number"
                step="0.05"
                min="0.1"
                max="0.7"
                value={config.bunching_headway_ratio}
                onChange={(e) => updateNumericField('bunching_headway_ratio', e.target.value)}
                className="mt-1 w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-700">
                Fixed Dwell Time (s)
              </span>
              <input
                type="number"
                step="0.5"
                min="0"
                value={config.dwell_fixed_s}
                onChange={(e) => updateNumericField('dwell_fixed_s', e.target.value)}
                className="mt-1 w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-700">
                Dwell per Boarding (s/pax)
              </span>
              <input
                type="number"
                step="0.2"
                min="0.2"
                value={config.dwell_per_boarding_s}
                onChange={(e) => updateNumericField('dwell_per_boarding_s', e.target.value)}
                className="mt-1 w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-700">
                MAPPO Hold Penalty (λ)
              </span>
              <input
                type="number"
                step="0.005"
                min="0"
                max="1"
                value={config.mappo_hold_penalty_lambda}
                onChange={(e) => updateNumericField('mappo_hold_penalty_lambda', e.target.value)}
                className="mt-1 w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-700">
                Dispatcher Alert Threshold
              </span>
              <input
                type="number"
                step="0.05"
                min="0.1"
                max="0.95"
                value={config.alert_probability_threshold}
                onChange={(e) => updateNumericField('alert_probability_threshold', e.target.value)}
                className="mt-1 w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </label>
          </div>

          <div className="pt-3 border-t border-slate-200 text-xs text-slate-600 flex flex-wrap gap-x-4 gap-y-1">
            <span>
              Discrete holds:{' '}
              <span className="font-mono text-slate-900">
                [{config.hold_actions_s.join(', ')}]s
              </span>
            </span>
            <span>
              Horizons:{' '}
              <span className="font-mono text-slate-900">
                k ∈ &#123;{config.prediction_horizons_stops.join(', ')}&#125; stops
              </span>
            </span>
            <span>
              Eval seeds:{' '}
              <span className="font-mono text-slate-900">
                [{config.evaluation_seeds.join(', ')}]
              </span>
            </span>
          </div>
        </div>

        <div className="xl:col-span-6 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">common/config.yaml</h3>
            <span className="text-xs text-slate-500">Generated live</span>
          </div>
          <pre className="p-5 text-xs font-mono text-slate-800 bg-slate-50/70 overflow-x-auto leading-relaxed">
            {yamlPreview}
          </pre>
        </div>
      </div>
    </div>
  );
}
