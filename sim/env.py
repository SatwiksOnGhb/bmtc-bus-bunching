"""BMTCHoldingEnv: PettingZoo Parallel environment for multi-agent bus holding.

Each bus (one GTFS trip) is an agent. The environment is event-driven: a bus appears in
`env.agents` only when it has just reached a stop where holding is allowed, and then picks
a hold from config.yaml holding.actions_s (0, 15, 30, 45, 60, 90 s) by index.

    from sim.env import BMTCHoldingEnv
    env = BMTCHoldingEnv()                                    # or BMTCHoldingEnv(predictor=...)
    obs, infos = env.reset(seed=1, options={"scenario": "378_rain"})
    while env.agents:
        actions = {a: actor(obs[a]) for a in env.agents}
        obs, rewards, terminations, truncations, infos = env.step(actions)
    env.kpis()

infos[bus]["bus_state"] is the Part 1 BusObservation (a BusState plus scheduled headway,
p_bunch and can_hold). Rewards are semi-Markov: the reward for a hold arrives with that
bus's NEXT observation, with infos[bus]["elapsed_s"] for discounting by elapsed time:

    r = -|fwd - bwd| / H  -  hold_penalty * hold_s * onboard / (H * capacity)

where H is the scheduled headway. Buses whose trip has ended get reward 0 and
terminations[bus] = True when the episode finishes.

Observation (float32, OBS_DIM values):
    0 forward headway / H        1 forward headway known (0/1)
    2 backward headway / H       3 backward headway known (0/1)
    4 schedule deviation / H (positive = late, clipped to ±5)
    5 load / capacity            6 waiting passengers / capacity
    7 stop index / last stop     8 direction (0 or 1)
    9 fraction of the episode elapsed
    10 p_bunch from the predictor (0 if none)   11 prediction available (0/1)
env.state() is a fixed-size global vector for MAPPO's centralised critic.
"""
import numpy as np
from gymnasium import spaces
from pettingzoo import ParallelEnv

from sim.bus_sim import BusSim
from sim.scenarios import make_scenario

OBS_DIM = 12
MAX_BUSES_PER_DIRECTION = 25
STATE_FEATURES = 4
DEFAULT_HEADWAY_S = 300.0


class BMTCHoldingEnv(ParallelEnv):
    metadata = {"name": "bmtc_holding_v1", "render_modes": []}

    def __init__(self, scenario: str = "375d_base", predictor=None, hold_penalty: float = 0.1,
                 **scenario_overrides):
        self.scenario_name = scenario
        self.predictor = predictor
        self.hold_penalty = hold_penalty
        self.overrides = dict(policy="rl", **scenario_overrides)
        self.sim = BusSim(make_scenario(scenario, **self.overrides), predictor=predictor)
        self.actions_s = self.sim.actions_s
        self._obs_space = spaces.Box(-5.0, 5.0, (OBS_DIM,), np.float32)
        self._act_space = spaces.Discrete(len(self.actions_s))
        self.state_space = spaces.Box(-5.0, 5.0, (2 * MAX_BUSES_PER_DIRECTION * STATE_FEATURES,), np.float32)
        self.possible_agents = []
        self.agents = []

    def observation_space(self, agent):
        return self._obs_space

    def action_space(self, agent):
        return self._act_space

    # ----------------------------------------------------------------- helpers
    def _vector(self, obs):
        sim, cfg = self.sim, self.sim.cfg
        d = sim.dir_of[obs.bus_id]
        h = obs.scheduled_headway_s or DEFAULT_HEADWAY_S
        return np.array([
            0.0 if obs.fwd_headway_s is None else min(obs.fwd_headway_s / h, 5.0),
            float(obs.fwd_headway_s is not None),
            0.0 if obs.bwd_headway_s is None else min(obs.bwd_headway_s / h, 5.0),
            float(obs.bwd_headway_s is not None),
            float(np.clip(obs.sched_dev_s / h, -5.0, 5.0)),
            obs.load / cfg.capacity,
            min(obs.waiting_at_stop / cfg.capacity, 5.0),
            obs.stop_idx / (d.n - 1),
            float(list(sim.dirs).index(d.name)),
            min((obs.t - cfg.begin) / max(cfg.end - cfg.begin, 1), 5.0),
            0.0 if obs.p_bunch is None else obs.p_bunch,
            float(obs.p_bunch is not None),
        ], dtype=np.float32)

    def _imbalance(self, obs):
        h = obs.scheduled_headway_s or DEFAULT_HEADWAY_S
        if obs.fwd_headway_s is not None and obs.bwd_headway_s is not None:
            return abs(obs.fwd_headway_s - obs.bwd_headway_s) / h
        if obs.fwd_headway_s is not None:
            return abs(obs.fwd_headway_s - h) / h
        return 0.0

    def state(self):
        sim = self.sim
        rows = []
        for d in list(sim.dirs.values())[:2]:
            buses = [t for t in d.trips if t in sim.depart_t and t not in sim.finished]
            feats = []
            for bus in buses[:MAX_BUSES_PER_DIRECTION]:
                k, t_k = sim.last_stop.get(bus, (0, sim.t))
                h = d.sched_hw[bus][k] or DEFAULT_HEADWAY_S
                feats.append([k / (d.n - 1), min((sim.t - t_k) / h, 5.0),
                              len(sim.onboard[bus]) / sim.cfg.capacity,
                              float(np.clip((sim.t - d.sched[bus][k]) / h, -5, 5))])
            feats += [[0.0] * STATE_FEATURES] * (MAX_BUSES_PER_DIRECTION - len(feats))
            rows.extend(feats)
        return np.asarray(rows, dtype=np.float32).ravel()

    def _package(self, pending):
        obs, rewards, infos = {}, {}, {}
        for bus, o in pending.items():
            obs[bus] = self._vector(o)
            prev = self._last_decision.get(bus)
            if prev is None:
                rewards[bus], elapsed = 0.0, 0.0
            else:
                t_prev, hold_prev, h_prev, load_prev = prev
                cost = self.hold_penalty * hold_prev * load_prev / (h_prev * self.sim.cfg.capacity)
                rewards[bus] = -self._imbalance(o) - cost
                elapsed = o.t - t_prev
            infos[bus] = {"bus_state": o, "bus_observation": o, "elapsed_s": elapsed}
        return obs, rewards, infos

    # --------------------------------------------------------------------- API
    def reset(self, seed=None, options=None):
        name = (options or {}).get("scenario", self.scenario_name)
        if name != self.scenario_name:
            self.sim.close()
            self.scenario_name = name
            self.sim = BusSim(make_scenario(name, **self.overrides), predictor=self.predictor)
        self._last_decision = {}
        pending = self.sim.reset(seed=seed)
        self.possible_agents = list(self.sim.all_trips)
        obs, _, infos = self._package(pending)
        self.agents = list(obs)
        return obs, infos

    def step(self, actions):
        holds = {}
        for bus in self.agents:
            hold = self.actions_s[int(actions.get(bus, 0))]
            holds[bus] = hold
            o = self.sim.pending[bus][0]
            self._last_decision[bus] = (o.t, hold, o.scheduled_headway_s or DEFAULT_HEADWAY_S, o.load)
        pending = self.sim.step(holds)
        obs, rewards, infos = self._package(pending)
        terminations = {bus: False for bus in obs}
        truncations = {bus: False for bus in obs}
        if self.sim.done:
            for bus in self._last_decision:
                obs.setdefault(bus, np.zeros(OBS_DIM, np.float32))
                rewards.setdefault(bus, 0.0)
                infos.setdefault(bus, {"elapsed_s": 0.0})
                terminations[bus] = True
                truncations[bus] = False
            self.agents = []
        else:
            self.agents = list(pending)
        return obs, rewards, terminations, truncations, infos

    def kpis(self):
        return self.sim.kpis()

    def close(self):
        self.sim.close()


BusHoldingEnv = BMTCHoldingEnv   # old name
