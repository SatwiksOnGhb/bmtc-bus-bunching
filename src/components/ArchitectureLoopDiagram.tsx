/**
 * System architecture diagram mirroring Page 2 of BMTC_Bus_Bunching_Stack_and_Work_Split.pdf.
 * Shows how Prediction feeds Control and one Runner streams Snapshots to the Dashboard.
 */
export function ArchitectureLoopDiagram() {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4 mb-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            System Control Loop Architecture
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            Each bus arrival triggers one pass of the loop: the twin reports bus states, the predictor adds p(bunch), and MAPPO returns a hold time.
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs text-slate-600">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-xs bg-blue-100 border border-blue-600" />
            Simulation (Satwik)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-xs bg-amber-100 border border-amber-600" />
            Prediction (Vikas)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-xs bg-emerald-100 border border-emerald-600" />
            Control (Varun)
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <svg
          viewBox="0 0 920 300"
          className="w-full min-w-[720px] h-auto"
          role="img"
          aria-label="BMTC Bus Bunching 7-component architecture diagram"
        >
          <defs>
            <marker
              id="arrow-slate"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#64748b" />
            </marker>
          </defs>

          {/* Control loop dashed boundary */}
          <rect
            x="260"
            y="14"
            width="640"
            height="174"
            rx="10"
            fill="#f8fafc"
            stroke="#cbd5e1"
            strokeDasharray="5 5"
            strokeWidth="1.2"
          />
          <text x="278" y="34" fontSize="11" fill="#475569" fontWeight="500">
            Control loop: one decision per bus arrival at a stop
          </text>

          {/* 1. Open Data (Simulation) */}
          <rect x="20" y="54" width="190" height="72" rx="8" fill="#eff6ff" stroke="#2563eb" strokeWidth="1.3" />
          <text x="34" y="76" fontSize="13" fontWeight="600" fill="#1e3a8a">Open data</text>
          <text x="34" y="95" fontSize="11" fill="#334155">BMTC GTFS, OSM roads</text>
          <text x="34" y="111" fontSize="11" fill="#334155">CNI 2022 GPS traces</text>

          {/* Arrow Open Data -> Twin */}
          <line x1="210" y1="90" x2="286" y2="90" stroke="#64748b" strokeWidth="1.4" markerEnd="url(#arrow-slate)" />
          <text x="232" y="83" fontSize="10.5" fill="#64748b">builds</text>

          {/* 2. SUMO Digital Twin (Simulation) */}
          <rect x="290" y="54" width="230" height="72" rx="8" fill="#eff6ff" stroke="#2563eb" strokeWidth="1.3" />
          <text x="304" y="76" fontSize="13" fontWeight="600" fill="#1e3a8a">SUMO digital twin</text>
          <text x="304" y="95" fontSize="11" fill="#334155">BMTCHoldingEnv (PettingZoo)</text>
          <text x="304" y="111" fontSize="11" fill="#334155">mixed traffic, rain &amp; breakdown</text>

          {/* Arrow Twin -> Predictor */}
          <line x1="520" y1="90" x2="624" y2="90" stroke="#64748b" strokeWidth="1.4" markerEnd="url(#arrow-slate)" />
          <text x="546" y="83" fontSize="10.5" fill="#64748b">bus states</text>

          {/* 3. Bunching Predictor (Prediction) */}
          <rect x="628" y="54" width="252" height="72" rx="8" fill="#fffbeb" stroke="#d97706" strokeWidth="1.3" />
          <text x="642" y="76" fontSize="13" fontWeight="600" fill="#92400e">Bunching predictor</text>
          <text x="642" y="95" fontSize="11" fill="#334155">LSTM / TCN calibrated probability</text>
          <text x="642" y="111" fontSize="11" fill="#334155">p(bunch) k stops ahead (k = 3, 5, 8)</text>

          {/* Arrow Predictor -> MAPPO */}
          <line x1="754" y1="126" x2="754" y2="146" stroke="#64748b" strokeWidth="1.4" markerEnd="url(#arrow-slate)" />
          <text x="764" y="140" fontSize="10.5" fill="#64748b">obs + p_bunch</text>

          {/* 4. MAPPO Controller (Control) */}
          <rect x="628" y="150" width="252" height="28" rx="6" fill="#ecfdf5" stroke="#059669" strokeWidth="1.3" />
          <text x="642" y="168" fontSize="12" fontWeight="600" fill="#065f46">MAPPO controller (shared actor + baselines)</text>

          {/* Arrow MAPPO -> Twin (hold seconds) */}
          <path
            d="M 628 164 L 405 164 L 405 130"
            fill="none"
            stroke="#64748b"
            strokeWidth="1.4"
            markerEnd="url(#arrow-slate)"
          />
          <text x="478" y="158" fontSize="10.5" fill="#64748b">hold seconds [0..90s]</text>

          {/* 5. Live Runner (Simulation) */}
          <rect x="20" y="216" width="230" height="70" rx="8" fill="#eff6ff" stroke="#2563eb" strokeWidth="1.3" />
          <text x="34" y="238" fontSize="13" fontWeight="600" fill="#1e3a8a">Live runner</text>
          <text x="34" y="256" fontSize="11" fill="#334155">drives two seeded sims side by side</text>
          <text x="34" y="272" fontSize="11" fill="#334155">logs KPIs &amp; applies scenario events</text>

          {/* Arrow Runner -> Control loop */}
          <path
            d="M 135 216 L 135 164 L 256 164"
            fill="none"
            stroke="#64748b"
            strokeWidth="1.4"
            markerEnd="url(#arrow-slate)"
          />
          <text x="142" y="158" fontSize="10.5" fill="#64748b">steps the loop</text>

          {/* 6. Snapshot Feed (Simulation) */}
          <rect x="330" y="216" width="230" height="70" rx="8" fill="#eff6ff" stroke="#2563eb" strokeWidth="1.3" />
          <text x="344" y="238" fontSize="13" fontWeight="600" fill="#1e3a8a">Snapshot feed</text>
          <text x="344" y="256" fontSize="11" fill="#334155">Runner.stream() @ 1 Hz</text>
          <text x="344" y="272" fontSize="11" fill="#334155">Frozen Pydantic / TS schemas</text>

          {/* Arrows Runner <-> Snapshot Feed */}
          <line x1="250" y1="242" x2="326" y2="242" stroke="#64748b" strokeWidth="1.4" markerEnd="url(#arrow-slate)" />
          <text x="262" y="236" fontSize="10.5" fill="#64748b">snapshots</text>
          <line x1="330" y1="264" x2="254" y2="264" stroke="#64748b" strokeWidth="1.4" markerEnd="url(#arrow-slate)" />
          <text x="262" y="278" fontSize="10.5" fill="#64748b">commands</text>

          {/* 7. Dispatcher Dashboard (Prediction) */}
          <rect x="640" y="216" width="240" height="70" rx="8" fill="#fffbeb" stroke="#d97706" strokeWidth="1.3" />
          <text x="654" y="238" fontSize="13" fontWeight="600" fill="#92400e">Dispatcher dashboard</text>
          <text x="654" y="256" fontSize="11" fill="#334155">map, time-space diagram, alerts</text>
          <text x="654" y="272" fontSize="11" fill="#334155">KPIs, scenario &amp; override controls</text>

          {/* Arrows Snapshot Feed <-> Dashboard */}
          <line x1="560" y1="242" x2="636" y2="242" stroke="#64748b" strokeWidth="1.4" markerEnd="url(#arrow-slate)" />
          <text x="578" y="236" fontSize="10.5" fill="#64748b">live feed</text>
          <line x1="640" y1="264" x2="564" y2="264" stroke="#64748b" strokeWidth="1.4" markerEnd="url(#arrow-slate)" />
          <text x="582" y="278" fontSize="10.5" fill="#64748b">actions</text>
        </svg>
      </div>
    </div>
  );
}
