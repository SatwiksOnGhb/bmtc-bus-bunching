"""Event-driven SUMO simulation of one BMTC route with passengers, dwell, mixed traffic and holding.

The simulator pauses whenever buses arrive at a stop where holding is allowed and asks for
a hold time. Passengers, dwell, road speeds, background traffic, rain and breakdowns run inside.

    from sim.scenarios import make_scenario
    sim = BusSim(make_scenario("375d_base", seed=1))
    obs = sim.reset()                       # {bus_id: BusObservation}
    while not sim.done:
        obs = sim.step(policy.act(obs))     # {bus_id: hold seconds}
    print(sim.kpis())

For per-second control (the live runner), call tick() and apply() instead of step().
bus_id is the GTFS trip_id, so every log row joins back to Varun's schedule tables.
All defaults come from the `sim` section of common/config.yaml.
"""
import itertools
import math
import os
import random
import sys
import tempfile
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path
from statistics import mean

import pandas as pd

if "SUMO_HOME" in os.environ:
    sys.path.append(os.path.join(os.environ["SUMO_HOME"], "tools"))
import sumolib  # noqa: E402
import traci  # noqa: E402

from common.kpis import compute_kpis  # noqa: E402
from common.schemas import BusObservation, BusState, PassengerTrip, StopArrival, VehicleTrip  # noqa: E402
from common.settings import load_settings  # noqa: E402
from sim import scenario as build  # noqa: E402

SETTINGS = load_settings(build.ROOT / "common" / "config.yaml")
_labels = itertools.count()
VTYPES = {
    "bus": '<vType id="bus" vClass="bus" length="12" speedDev="{dev}" sigma="0.5" color="1,0.6,0"/>',
    "car": '<vType id="car" vClass="passenger" length="4.3" speedDev="0.15" color="0.6,0.6,0.6"/>',
    "motorcycle": '<vType id="motorcycle" vClass="motorcycle" length="2.0" speedDev="0.2" color="0.3,0.5,0.9"/>',
    "auto": '<vType id="auto" vClass="passenger" length="2.8" width="1.4" maxSpeed="13.9" speedDev="0.15" '
            'color="0.2,0.7,0.2" guiShape="passenger/hatchback"/>',
}


def _sim_default(name):
    return field(default_factory=lambda: getattr(SETTINGS.sim, name))


@dataclass
class SimConfig:
    route: str = "375d"                          # key in config.yaml sim.routes
    condition: str = "base"                      # base | rain | breakdown
    seed: int = 1
    begin: int = _sim_default("begin_s")
    end: int = _sim_default("end_s")
    demand_per_min: float = _sim_default("demand_per_min")
    peak_factor: float = _sim_default("peak_factor")
    capacity: int = _sim_default("capacity")
    dwell_fixed_s: float = _sim_default("dwell_fixed_s")
    board_s: float = _sim_default("board_s")
    alight_s: float = _sim_default("alight_s")
    min_departure_gap_s: int = _sim_default("min_departure_gap_s")
    speed_dev: float = _sim_default("speed_dev")
    traffic_veh_per_hour: float = _sim_default("traffic_veh_per_hour")
    traffic_mix: dict = _sim_default("traffic_mix")
    rain_speed_factor: float = _sim_default("rain_speed_factor")
    speed_calibration: float = _sim_default("speed_calibration")
    breakdown_window_s: tuple = _sim_default("breakdown_window_s")
    gps_speeds: bool = True
    gui: bool = False
    policy: str = "unknown"
    extra_sumo_args: list = field(default_factory=list)

    @property
    def scenario(self):
        return f"{self.route}_{self.condition}"


@dataclass
class Passenger:
    arrive_t: float
    origin: int
    dest: int
    board_t: float = 0.0


class Demand:
    """Poisson arrivals per stop with a morning peak; destinations uniform downstream."""

    def __init__(self, n_stops, cfg: SimConfig, rng):
        self.n, self.cfg, self.rng = n_stops, cfg, rng
        self.queue = [deque() for _ in range(n_stops)]
        self.next_t = [None] * n_stops

    def rate(self, t):
        per_min = self.cfg.demand_per_min * (1 + self.cfg.peak_factor * math.exp(-((t - 30600) / 3600) ** 2))
        return per_min / 60.0

    def update(self, k, t):
        if k >= self.n - 1 or self.cfg.demand_per_min <= 0:
            return
        if self.next_t[k] is None:
            self.next_t[k] = self.cfg.begin + self.rng.expovariate(self.rate(self.cfg.begin))
        while self.next_t[k] <= t:
            self.queue[k].append(Passenger(self.next_t[k], k, self.rng.randint(k + 1, self.n - 1)))
            self.next_t[k] += self.rng.expovariate(self.rate(self.next_t[k]))


class Direction:
    """Schedule and live state for one direction of the route."""

    def __init__(self, name, spec, cfg, schedule, rng):
        self.name = name
        self.pattern_id = spec["pattern_id"]
        self.edges, self.stops = spec["edges"], spec["stops"]
        self.label = f"to {spec['last_stop']}"
        self.n = len(self.stops)
        rows = schedule[schedule.pattern_id == self.pattern_id]
        first = rows[rows.stop_idx == 0].set_index("trip_id").departure_s
        trips = first[(first >= cfg.begin) & (first < cfg.end)].sort_values()
        # The feed has trips 0-60 s apart (likely duplicates). Keep one per min_departure_gap_s.
        kept, last = [], None
        for trip, dep in trips.items():
            if last is None or dep - last >= cfg.min_departure_gap_s:
                kept.append(trip)
                last = dep
        self.dropped_trips = len(trips) - len(kept)
        trips = trips[kept]
        self.trips = list(trips.index)
        rows = rows[rows.trip_id.isin(self.trips)]
        if (rows.groupby("trip_id").size() != self.n).any():
            raise ValueError(f"{name}: GTFS stop count differs from the SUMO route ({self.n} stops)")
        self.sched = {t: g.sort_values("stop_idx").arrival_s.tolist() for t, g in rows.groupby("trip_id")}
        self.sched_hw = {}
        for i, t in enumerate(self.trips):
            other = self.trips[i - 1] if i > 0 else (self.trips[1] if len(self.trips) > 1 else None)
            self.sched_hw[t] = [abs(self.sched[t][k] - self.sched[other][k]) or None if other else None
                                for k in range(self.n)]
        self.depart = trips.to_dict()
        self.position = {t: i for i, t in enumerate(self.trips)}
        self.demand = Demand(self.n, cfg, rng)
        self.last_arrival = [None] * self.n
        self.stop_index = {s: k for k, s in enumerate(self.stops)}


class BusSim:
    def __init__(self, cfg: SimConfig = None, predictor=None):
        self.cfg = cfg or SimConfig()
        self.predictor = predictor
        self.settings = SETTINGS
        self.actions_s = self.settings.holding.actions_s
        self.route_id = self.settings.sim.routes[self.cfg.route]
        self.route_dir = build.route_dir(self.cfg.route)
        self._spec = build.load_route(self.cfg.route)["directions"]
        self._schedule = pd.read_csv(build.SCHEDULE)
        self._schedule = self._schedule[self._schedule.route_id == self.route_id]
        self._speeds = self._load_speeds() if self.cfg.gps_speeds else None
        self.conn = None
        self.done = False
        self.t = float(self.cfg.begin)
        self.label = f"bmtc{os.getpid()}_{next(_labels)}"

    # ----------------------------------------------------------------- setup
    def _load_speeds(self):
        edges = pd.read_csv(build.EDGE_SPEEDS)
        route_edges = {e for d in self._spec.values() for e in d["edges"]}
        edges = edges[edges.edge_id.isin(route_edges)]
        edge_speed = {(r.edge_id, int(r.hour_ist)): r.median_speed_mps for r in edges.itertuples()}
        corr = pd.read_csv(build.CORRIDOR_SPEEDS)
        corr = corr[corr.route_id == self.route_id]
        corridor = {int(r.hour_ist): r.median_speed_kmh / 3.6 for r in corr.itertuples()}
        return edge_speed, corridor

    def _traffic_lines(self):
        """Background flows that follow sections of the bus route (cars, two-wheelers, autos)."""
        if self.cfg.traffic_veh_per_hour <= 0:
            return []
        lines, rng = [], random.Random(self.cfg.seed + 7919)
        total = sum(self.cfg.traffic_mix.values()) or 1.0
        for d in self.dirs.values():
            # Stretches of the route without loops (buses circle some blocks near terminals;
            # traffic sent round those loops queues into itself).
            stretches, current = [], []
            for e in d.edges:
                if e in current or d.edges.count(e) > 1:
                    if len(current) > 20:
                        stretches.append(current)
                    current = [] if d.edges.count(e) > 1 else [e]
                else:
                    current.append(e)
            if len(current) > 20:
                stretches.append(current)
            if not stretches:
                continue
            n_sections = 6
            for s in range(n_sections):
                stretch = max(stretches, key=len) if s == 0 else rng.choice(stretches)
                i = rng.randrange(0, max(1, len(stretch) // 2))
                j = rng.randrange(min(len(stretch) - 1, i + 15), len(stretch))
                rid = f"bg_{d.name}_{s}"
                lines.append(f'    <route id="{rid}" edges="{" ".join(stretch[i:j + 1])}"/>')
                for vtype, share in self.cfg.traffic_mix.items():
                    rate = self.cfg.traffic_veh_per_hour * share / total / n_sections
                    if rate > 0:
                        lines.append(f'    <flow id="{rid}_{vtype}" type="{vtype}" route="{rid}" '
                                     f'begin="{self.cfg.begin}" end="{self.cfg.end + 3600}" '
                                     f'vehsPerHour="{rate:.2f}" departLane="best" departSpeed="max"/>')
        return lines

    def _write_routes(self):
        lines = ["<routes>", "    " + VTYPES["bus"].format(dev=self.cfg.speed_dev)]
        lines += ["    " + VTYPES[v] for v in self.cfg.traffic_mix] if self.cfg.traffic_veh_per_hour > 0 else []
        vehicles = []
        for d in self.dirs.values():
            lines.append(f'    <route id="{d.name}" edges="{" ".join(d.edges)}">')
            lines += [f'        <stop busStop="{s}" duration="100000" parking="true"/>' for s in d.stops]
            lines.append("    </route>")
            vehicles += [(d.depart[t], t, d.name) for t in d.trips]
        flows = self._traffic_lines()
        lines += [x for x in flows if x.lstrip().startswith("<route")]
        body = [(dep, f'    <vehicle id="{trip}" type="bus" route="{route}" depart="{dep:.0f}" '
                      f'line="{self.cfg.route}"/>') for dep, trip, route in vehicles]
        body += [(self.cfg.begin, x) for x in flows if x.lstrip().startswith("<flow")]
        lines += [x for _, x in sorted(body, key=lambda b: b[0])]
        lines.append("</routes>")
        path = Path(tempfile.gettempdir()) / f"{self.label}.rou.xml"
        path.write_text("\n".join(lines), encoding="utf-8")
        return path

    def reset(self, seed=None):
        """Start a new episode. Returns the first holding decisions {bus_id: BusObservation}."""
        if seed is not None:
            self.cfg.seed = seed
        self.close()
        self.rng = random.Random(self.cfg.seed)
        self.dirs = {name: Direction(name, spec, self.cfg, self._schedule, self.rng)
                     for name, spec in self._spec.items()}
        self.dir_of = {t: d for d in self.dirs.values() for t in d.trips}
        self.all_trips = [t for d in self.dirs.values() for t in d.trips]
        routes = self._write_routes()
        binary = sumolib.checkBinary("sumo-gui" if self.cfg.gui else "sumo")
        traci.start([binary, "-n", str(self.route_dir / "net.xml"), "-a", str(self.route_dir / "stops.add.xml"),
                     "-r", str(routes), "--begin", str(self.cfg.begin), "--seed", str(self.cfg.seed),
                     "--time-to-teleport", "300", "--ignore-junction-blocker", "30",
                     "--no-step-log", "true", "--no-warnings", "true",
                     *self.cfg.extra_sumo_args], label=self.label)
        self.conn = traci.getConnection(self.label)

        self.t = float(self.cfg.begin)
        self.onboard = defaultdict(list)
        self.last_stop = {}
        self.last_obs = {}
        self.at_stop = set()
        self.release = {}
        self.pending = {}          # bus -> (obs, dwell)
        self.depart_t = {}
        self.history = defaultdict(list)
        self.arrivals, self.trips_done, self.passengers, self.holds = [], [], [], []
        self.hold_log = {}         # bus -> last hold seconds
        self.predictions = {}      # bus -> Prediction
        self.events = []
        self.bus_teleports = 0
        self.traffic_removed = 0
        self.finished = set()
        self.rain = self.cfg.condition == "rain"
        self.broken_bus, self.breakdown_at = None, None
        if self.cfg.condition == "breakdown":
            lo, hi = self.cfg.breakdown_window_s
            self.breakdown_at = self.cfg.begin + self.rng.uniform(lo, hi)
        self._speed_key = None
        self._limits = None
        self.episode_id = f"{self.cfg.scenario}-{self.cfg.policy}-s{self.cfg.seed}"
        self.done = False
        return self._advance()

    def close(self):
        if self.conn is not None:
            try:
                self.conn.close()
            except Exception:
                pass
            self.conn = None

    # ------------------------------------------------------- live triggers
    def trigger(self, event):
        """What-if events during a run: 'rain', 'clear' or 'breakdown'."""
        if event == "rain":
            self.rain = True
        elif event == "clear":
            self.rain = False
        elif event == "breakdown" and self.broken_bus is None:
            self.breakdown_at = self.t
        else:
            return
        self.events.append((self.t, event))

    # ------------------------------------------------------------- dynamics
    def _apply_speeds(self):
        hour = int(self.t // 3600)
        key = (hour, self.rain)
        if self._speeds is None or key == self._speed_key:
            return
        self._speed_key = key
        edge_speed, corridor = self._speeds
        hours = sorted(corridor)
        h = min(max(hour, hours[0]), hours[-1])
        factor = self.cfg.rain_speed_factor if self.rain else 1.0
        if self._limits is None:     # OSM speed limits, read once before any change
            self._limits = {e: self.conn.lane.getMaxSpeed(f"{e}_0") for d in self.dirs.values() for e in d.edges}
        for e, limit in self._limits.items():
            speed = edge_speed.get((e, h), corridor[h])
            self.conn.edge.setMaxSpeed(e, min(limit, speed * self.cfg.speed_calibration) * factor)

    def _follower(self, d, bus):
        for t in d.trips[d.position[bus] + 1:]:
            if t not in self.finished:
                return t
        return None

    def _observe(self, bus, d, k):
        t = self.t
        fwd = t - d.last_arrival[k] if d.last_arrival[k] is not None else None
        bwd = None
        f = self._follower(d, bus)
        if f is not None:
            if f in self.last_stop:
                kf, tf = self.last_stop[f]
                expected = tf + d.sched[f][k] - d.sched[f][kf] if kf < k else t
            else:
                expected = max(d.depart[f], t) + d.sched[f][k] - d.sched[f][0]
            bwd = max(0.0, expected - t)
        x, y = self.conn.vehicle.getPosition(bus)
        lon, lat = self.conn.simulation.convertGeo(x, y)
        return BusObservation(
            bus_id=bus, route_id=self.route_id, t=t, stop_idx=k, lat=lat, lon=lon,
            fwd_headway_s=fwd, bwd_headway_s=bwd, sched_dev_s=t - d.sched[bus][k],
            load=len(self.onboard[bus]), waiting_at_stop=len(d.demand.queue[k]),
            scheduled_headway_s=d.sched_hw[bus][k], can_hold=0 < k < d.n - 1)

    def _break_down(self, bus, d, k):
        """The bus leaves service at stop k; its passengers wait there for the next bus."""
        riders = self.onboard.pop(bus, [])
        for p in riders:
            p.board_t = 0.0
        d.demand.queue[k].extendleft(reversed(riders))
        self.conn.vehicle.remove(bus)
        self.finished.add(bus)
        self.at_stop.discard(bus)
        self.events.append((self.t, f"breakdown {bus} at stop {k}"))

    def _arrive(self, bus, d, k):
        t = self.t
        d.demand.update(k, t)
        if bus == self.broken_bus:
            self._break_down(bus, d, k)
            return
        obs = self._observe(bus, d, k)
        staying, alight = [], 0
        for p in self.onboard[bus]:
            if p.dest == k:
                alight += 1
                self.passengers.append(PassengerTrip(
                    wait_s=p.board_t - p.arrive_t, in_vehicle_s=t - p.board_t,
                    reference_in_vehicle_s=d.sched[bus][k] - d.sched[bus][p.origin]))
            else:
                staying.append(p)
        self.onboard[bus] = staying
        board = 0
        while d.demand.queue[k] and len(staying) < self.cfg.capacity:
            p = d.demand.queue[k].popleft()
            p.board_t = t
            staying.append(p)
            board += 1
        dwell = self.cfg.dwell_fixed_s + self.cfg.board_s * board + self.cfg.alight_s * alight
        row = StopArrival(
            **obs.model_dump(), episode_id=self.episode_id, trip_id=bus, pattern_id=d.pattern_id,
            stop_id=d.stops[k], scenario=self.cfg.scenario, policy=self.cfg.policy, seed=self.cfg.seed,
            dwell_s=dwell, hour_ist=int(t // 3600) % 24, data_source="simulation")
        self.history[bus].append(row)
        if self.predictor is not None:
            pred = self.predictor.predict(self.history[bus])
            self.predictions[bus] = pred
            obs = obs.model_copy(update={"p_bunch": pred.p_bunch})
            row = row.model_copy(update={"p_bunch": pred.p_bunch})
            self.history[bus][-1] = row
        self.arrivals.append(row)
        self.last_obs[bus] = obs
        d.last_arrival[k] = t
        self.last_stop[bus] = (k, t)
        if obs.can_hold:
            self.pending[bus] = (obs, dwell)
        else:
            self.release[bus] = t + math.ceil(dwell)

    def tick(self):
        """Advance SUMO by one second. Returns buses that now need a hold decision."""
        conn = self.conn
        conn.simulationStep()
        self.t = conn.simulation.getTime()
        self._apply_speeds()
        self.bus_teleports += sum(v in self.dir_of for v in conn.simulation.getStartingTeleportIDList())
        for v in conn.simulation.getDepartedIDList():
            if v in self.dir_of:
                self.depart_t[v] = self.t
        for v in conn.simulation.getArrivedIDList():
            if v in self.dir_of:
                self.finished.add(v)
                if v in self.depart_t:
                    self.trips_done.append(VehicleTrip(departure_s=self.depart_t[v], arrival_s=self.t))
                self.at_stop.discard(v)
                self.release.pop(v, None)
        if int(self.t) % 30 == 0:
            self._clear_stuck_traffic()
        for v, t_rel in list(self.release.items()):
            if self.t >= t_rel:
                conn.vehicle.resume(v)
                del self.release[v]
                self.at_stop.discard(v)
        if self.breakdown_at is not None and self.broken_bus is None and self.t >= self.breakdown_at:
            running = [b for b in self.depart_t if b not in self.finished
                       and self.last_stop.get(b, (0, 0))[0] < self.dir_of[b].n - 3]
            if running:
                self.broken_bus = self.rng.choice(sorted(running))
        for v in [b for b in self.depart_t if b not in self.finished and b not in self.at_stop]:
            if not conn.vehicle.isAtBusStop(v):
                continue
            d = self.dir_of[v]
            nxt = conn.vehicle.getStops(v, 1)
            if not nxt or nxt[0].stoppingPlaceID not in d.stop_index:
                continue
            self.at_stop.add(v)
            self._arrive(v, d, d.stop_index[nxt[0].stoppingPlaceID])
        if len(self.finished) >= len(self.all_trips):
            self.done = True
        return {bus: obs for bus, (obs, _) in self.pending.items()}

    def _clear_stuck_traffic(self, max_wait_s=120.0):
        """Background vehicles stuck for over max_wait_s leave the corridor (as if turning off into a
        side street). This stops one-off map artefacts, such as zero-length links or double
        signals, from gridlocking the whole corridor. Buses are never removed."""
        for v in self.conn.vehicle.getIDList():
            if v not in self.dir_of and self.conn.vehicle.getWaitingTime(v) > max_wait_s:
                self.conn.vehicle.remove(v)
                self.traffic_removed += 1

    def apply(self, holds_s):
        """Apply hold seconds to the buses waiting for a decision. Missing buses hold 0."""
        for bus, (obs, dwell) in self.pending.items():
            hold = int(holds_s.get(bus, 0))
            if hold not in self.actions_s:
                raise ValueError(f"Hold {hold}s for {bus} is not one of {self.actions_s}")
            self.release[bus] = self.t + math.ceil(dwell) + hold
            self.holds.append(hold)
            self.hold_log[bus] = hold
        self.pending = {}

    def _advance(self):
        while not self.done:
            pending = self.tick()
            if pending:
                return pending
        self.close()
        return {}

    def step(self, holds_s):
        """holds_s: {bus_id: hold seconds}. Runs until the next decision; returns its observations."""
        self.apply(holds_s)
        return self._advance()

    # ------------------------------------------------------------- results
    def bus_states(self):
        """Current BusState of every bus on the road (for the live runner and dashboard)."""
        states = []
        for bus in self.depart_t:
            if bus in self.finished:
                continue
            d = self.dir_of[bus]
            try:
                x, y = self.conn.vehicle.getPosition(bus)
            except traci.TraCIException:
                continue
            if not (math.isfinite(x) and abs(x) < 1e8):   # teleporting or not yet inserted
                continue
            lon, lat = self.conn.simulation.convertGeo(x, y)
            if not (math.isfinite(lon) and math.isfinite(lat)):
                continue
            last = self.last_obs.get(bus)
            k = self.last_stop.get(bus, (0, self.t))[0]
            states.append(BusState(
                bus_id=bus, route_id=self.route_id, t=self.t, stop_idx=k, lat=lat, lon=lon,
                fwd_headway_s=last.fwd_headway_s if last else None,
                bwd_headway_s=last.bwd_headway_s if last else None,
                sched_dev_s=last.sched_dev_s if last else 0.0,
                load=len(self.onboard[bus]), waiting_at_stop=len(d.demand.queue[k])))
        return states

    def kpis(self):
        k = compute_kpis(self.arrivals, self.passengers, self.trips_done,
                         bunching_ratio=self.settings.bunching.ratio)
        k["mean_hold_s"] = mean(self.holds) if self.holds else 0.0
        k["bus_teleports"] = self.bus_teleports
        k["traffic_removed"] = self.traffic_removed
        k["max_load"] = max((a.load for a in self.arrivals), default=0)
        k["passenger_hours_waiting"] = sum(p.wait_s for p in self.passengers) / 3600
        flags = [a.fwd_headway_s < 0.5 * a.scheduled_headway_s for a in self.arrivals
                 if a.fwd_headway_s is not None and a.scheduled_headway_s is not None]
        k["bunched_pct_r50"] = 100 * mean(flags) if flags else None
        return k
