"""BMTC bus bunching dashboard (Part 2, runs on Part 1's rule-based policies; Part 3 adds MAPPO).

From the bmtc folder:
    streamlit run dashboard/app.py
"""
import os
import sys
from pathlib import Path

import pandas as pd
import plotly.graph_objects as go
import pydeck as pdk
import streamlit as st

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
if "SUMO_HOME" in os.environ:
    sys.path.append(os.path.join(os.environ["SUMO_HOME"], "tools"))

from sim.bus_sim import SETTINGS  # noqa: E402
from sim.runner import Runner  # noqa: E402
from sim.scenario import load_route, route_dir  # noqa: E402
from sim.scenarios import CONDITIONS, ROUTES, route_label  # noqa: E402

POLICIES = ["no_control", "schedule", "daganzo", "two_headway"]
POLICY_LABELS = {"no_control": "No control", "schedule": "Schedule holding",
                 "daganzo": "Headway holding (Daganzo)", "two_headway": "Two-headway holding"}
CONDITION_LABELS = {"base": "Normal day", "rain": "Rain", "breakdown": "Bus breakdown"}
RATIO = SETTINGS.bunching.ratio
COLORS = {"ok": [46, 160, 67], "close": [245, 166, 35], "bunched": [220, 50, 47], "holding": [51, 102, 204]}
DATASET = ROOT / "runs" / "dataset" / "baseline_summary.csv"

st.set_page_config(page_title="BMTC bus bunching", layout="wide")


@st.cache_data
def route_paths(route):
    """Road geometry of each direction as lon/lat paths, for the map."""
    import sumolib
    net = sumolib.net.readNet(str(route_dir(route) / "net.xml"))
    paths = []
    for name, d in load_route(route)["directions"].items():
        coords = []
        for e in d["edges"]:
            for x, y in net.getEdge(e).getShape():
                lon, lat = net.convertXY2LonLat(x, y)
                coords.append([lon, lat])
        paths.append({"direction": name, "path": coords})
    return paths


def clock(t):
    t = int(t)
    return f"{t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}"


def bus_status(runner, bus):
    if bus.bus_id in runner.sim.release and runner.sim.hold_log.get(bus.bus_id, 0) > 0:
        return "holding"
    obs = runner.sim.last_obs.get(bus.bus_id)
    if obs is None or obs.fwd_headway_s is None or not obs.scheduled_headway_s:
        return "ok"
    ratio = obs.fwd_headway_s / obs.scheduled_headway_s
    return "bunched" if ratio < RATIO else "close" if ratio < 0.5 else "ok"


def new_runner(scenario, seed, policy):
    return Runner(scenario, seed=seed, policy=policy)


# ---------------------------------------------------------------- sidebar
st.sidebar.title("BMTC bus bunching")
route = st.sidebar.selectbox("Route", ROUTES, format_func=lambda r: f"{route_label(r)} ({r})")
condition = st.sidebar.selectbox("Scenario", CONDITIONS, format_func=CONDITION_LABELS.get)
policy = st.sidebar.selectbox("Policy", POLICIES, index=3, format_func=POLICY_LABELS.get)
compare = st.sidebar.checkbox("Side-by-side with a second policy")
policy_b = st.sidebar.selectbox("Second policy", POLICIES, index=0, format_func=POLICY_LABELS.get,
                                disabled=not compare)
seed = st.sidebar.number_input("Seed", min_value=1, max_value=999, value=1)
speed = st.sidebar.select_slider("Simulated seconds per refresh", [5, 15, 30, 60, 120], value=30)
scenario = f"{route}_{condition}"

state = st.session_state
state.setdefault("runners", {})
state.setdefault("playing", False)

c1, c2, c3 = st.sidebar.columns(3)
start = c1.button("Start", type="primary", help="Restart with the settings above")
if start or not state.runners:
    for r in state.runners.values():
        r.close()
    state.runners = {"A": new_runner(scenario, seed, policy)}
    if compare:
        state.runners["B"] = new_runner(scenario, seed, policy_b)
    state.playing = start
if c2.button("Pause" if state.playing else "Play"):
    state.playing = not state.playing
step_once = c3.button("Step")

st.sidebar.markdown("**What-if events**")
e1, e2, e3 = st.sidebar.columns(3)
for label, event, col in (("Rain", "rain", e1), ("Clear", "clear", e2), ("Breakdown", "breakdown", e3)):
    if col.button(label):
        for r in state.runners.values():
            r.trigger(event)
for name, r in state.runners.items():
    if name == "A" and r.policy_name != policy:
        r.set_policy(policy)

st.sidebar.caption("Results are from a calibrated simulation of BMTC routes: 2019 GPS road speeds, "
                   "the Nov 2026 GTFS timetable and assumed passenger demand.")


# ---------------------------------------------------------------- views
def render(runner, snap, key):
    k = snap.kpis
    st.subheader(POLICY_LABELS.get(runner.policy_name, runner.policy_name))
    m = st.columns(5)
    m[0].metric("Clock (IST)", clock(snap.t))
    m[1].metric("Headway CV", "–" if k.get("headway_cv") is None else f"{k['headway_cv']:.2f}")
    m[2].metric("Bunched arrivals", "–" if k.get("bunched_arrivals_pct") is None
                else f"{k['bunched_arrivals_pct']:.1f}%")
    m[3].metric("Mean wait", "–" if k.get("mean_passenger_wait_s") is None
                else f"{k['mean_passenger_wait_s'] / 60:.1f} min")
    m[4].metric("Buses on road", len(snap.buses))

    buses = pd.DataFrame([{"bus": b.bus_id, "lon": b.lon, "lat": b.lat, "stop": b.stop_idx,
                           "load": b.load, "status": bus_status(runner, b)} for b in snap.buses])
    layers = [pdk.Layer("PathLayer", route_paths(route), get_path="path", get_color=[120, 120, 120],
                        width_min_pixels=2)]
    if not buses.empty:
        buses["color"] = buses.status.map(COLORS)
        layers.append(pdk.Layer("ScatterplotLayer", buses, get_position=["lon", "lat"], get_fill_color="color",
                                get_radius=90, radius_min_pixels=5, pickable=True))
    paths = route_paths(route)
    lons = [p[0] for d in paths for p in d["path"]]
    lats = [p[1] for d in paths for p in d["path"]]
    view = pdk.ViewState(longitude=sum(lons) / len(lons), latitude=sum(lats) / len(lats), zoom=12)
    st.pydeck_chart(pdk.Deck(layers=layers, initial_view_state=view, map_style=pdk.map_styles.CARTO_LIGHT,
                             tooltip={"text": "{bus}\nstop {stop} · {load} on board · {status}"}),
                    key=f"map_{key}")
    st.caption("🟢 normal gap · 🟠 gap under half the schedule · 🔴 bunched · 🔵 holding at stop")

    arrivals = runner.sim.arrivals
    if arrivals:
        df = pd.DataFrame([{"bus": a.bus_id, "t": a.t, "stop": a.stop_idx, "pattern": a.pattern_id}
                           for a in arrivals if a.t >= snap.t - 5400])
        fig = go.Figure()
        for d_i, (name, d) in enumerate(runner.sim.dirs.items()):
            sub = df[df.pattern == d.pattern_id]
            for bus, g in sub.groupby("bus"):
                fig.add_trace(go.Scatter(x=pd.to_datetime(g.t, unit="s"), y=g.stop if d_i == 0 else -g.stop,
                                         mode="lines", line=dict(width=1.5), name=bus, showlegend=False,
                                         hovertemplate=f"{bus}<br>stop %{{text}}<extra></extra>",
                                         text=g.stop))
        dirs = list(runner.sim.dirs.values())
        fig.update_layout(height=330, margin=dict(l=10, r=10, t=30, b=10),
                          title=f"Time-space (last 90 min) · up: {dirs[0].label} · down: {dirs[-1].label}",
                          xaxis_title=None, yaxis_title="stop index", xaxis_tickformat="%H:%M")
        st.plotly_chart(fig, width="stretch", key=f"ts_{key}")

    alerts = buses[buses.status == "bunched"] if not buses.empty else buses
    for _, a in alerts.head(5).iterrows():
        st.warning(f"Bus {a.bus} bunched with the bus ahead near stop {a.stop}")
    events = runner.sim.events[-3:]
    for t, e in events:
        st.info(f"{clock(t)} · {e}")


live_tab, results_tab = st.tabs(["Live simulation", "Baseline results"])

with live_tab:
    @st.fragment(run_every=1.0)
    def live():
        runners = st.session_state.runners
        advance = st.session_state.playing or step_once
        cols = st.columns(len(runners))
        for col, (key, runner) in zip(cols, runners.items()):
            snap = runner.advance(speed if advance else 0)
            with col:
                render(runner, snap, key)
            if runner.done:
                st.session_state.playing = False
        if all(r.done for r in runners.values()):
            st.success("Episode finished.")

    live()

with results_tab:
    if DATASET.exists():
        summary = pd.read_csv(DATASET)
        sub = summary[(summary.route == route) & (summary.condition == condition)]
        st.write(f"Mean over seeds · route {route_label(route)} · {CONDITION_LABELS[condition]}")
        st.dataframe(sub.set_index("policy").drop(columns=["route", "condition"]), width="stretch")
        metrics = {"headway_cv": "Headway CV", "bunched_arrivals_pct": "Bunched arrivals (%)",
                   "mean_passenger_wait_s": "Mean wait (s)", "mean_trip_time_s": "Trip time (s)"}
        cols = st.columns(len(metrics))
        for col, (m, label) in zip(cols, metrics.items()):
            fig = go.Figure(go.Bar(x=[POLICY_LABELS[p] for p in sub.policy], y=sub[m]))
            fig.update_layout(title=label, height=300, margin=dict(l=10, r=10, t=40, b=10))
            col.plotly_chart(fig, width="stretch", key=f"res_{m}")
    else:
        st.info("Run `python -m sim.dataset` to generate baseline results.")
