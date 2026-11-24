"""Live runner: steps SUMO, asks a policy (and optionally a predictor) at every bus arrival, and
streams one Snapshot per simulated second (or every `every_s` seconds).

    from sim.runner import Runner
    runner = Runner("375d_base", seed=1, policy="two_headway")
    for snap in runner.stream():
        ...                                  # Snapshot: t, policy, scenario, buses, predictions, holds, kpis
    runner.set_policy("daganzo")             # swap the policy live (also any object with act(obs))
    runner.trigger("rain")                   # what-if events: "rain", "clear", "breakdown"

    for a, b in side_by_side("375d_base", 1, "no_control", "daganzo"):
        ...                                  # two identical seeded simulations, one per policy

Policies follow Part 1's Policy protocol: act({bus_id: BusObservation}) -> {bus_id: hold_s}.
Predictors follow predict(history: list[StopArrival]) -> Prediction (Part 3).
"""
from common.schemas import Snapshot
from control.baselines import BaselinePolicy
from sim.bus_sim import SETTINGS, BusSim
from sim.scenarios import make_scenario

KPI_EVERY_S = 60


def as_policy(policy):
    if isinstance(policy, str):
        return policy, BaselinePolicy(policy, SETTINGS.holding)
    return getattr(policy, "name", type(policy).__name__), policy


class Runner:
    def __init__(self, scenario="375d_base", seed=1, policy="no_control", predictor=None,
                 every_s=1, **overrides):
        self.scenario = scenario
        self.seed = seed
        self.every_s = every_s
        self.predictor = predictor
        self.policy_name, self.policy = as_policy(policy)
        self.sim = BusSim(make_scenario(scenario, seed=seed, policy=self.policy_name, **overrides),
                          predictor=predictor)
        self._kpis, self._kpi_t = {}, None
        self.started = False

    def set_policy(self, policy):
        self.policy_name, self.policy = as_policy(policy)
        self.sim.cfg.policy = self.policy_name

    def trigger(self, event):
        self.sim.trigger(event)

    def snapshot(self):
        sim = self.sim
        if self._kpi_t is None or sim.t - self._kpi_t >= KPI_EVERY_S or sim.done:
            self._kpis = {k: (None if v is None else float(v)) for k, v in sim.kpis().items()}
            self._kpi_t = sim.t
        holding = {bus: float(sim.hold_log.get(bus, 0)) for bus in sim.release if bus in sim.hold_log}
        states = sim.bus_states()
        active = {b.bus_id for b in states}
        return Snapshot(t=sim.t, policy=self.policy_name, scenario=self.scenario, buses=states,
                        predictions=[p for b, p in sim.predictions.items() if b in active],
                        holds=holding, kpis=self._kpis)

    def start(self):
        pending = self.sim.reset(seed=self.seed) if not self.started else {}
        self.started = True
        if pending:
            self.sim.apply(self.policy.act(pending))

    def advance(self, seconds=1):
        """Run `seconds` simulated seconds (the dashboard calls this once per refresh)."""
        if not self.started:
            self.start()
        for _ in range(int(seconds)):
            if self.sim.done:
                break
            pending = self.sim.tick()
            if pending:
                self.sim.apply(self.policy.act(pending))
        return self.snapshot()

    def stream(self, max_seconds=None):
        """Yield one Snapshot every `every_s` simulated seconds until the episode ends."""
        elapsed = 0
        try:
            while not self.sim.done and (max_seconds is None or elapsed < max_seconds):
                yield self.advance(self.every_s)
                elapsed += self.every_s
        finally:
            if self.sim.done or max_seconds is not None:
                self.close()

    @property
    def done(self):
        return self.sim.done

    def close(self):
        self.sim.close()


def side_by_side(scenario, seed, policy_a, policy_b, every_s=1, max_seconds=None, **overrides):
    """Two identical seeded simulations (same traffic and passengers), one per policy."""
    a = Runner(scenario, seed, policy_a, every_s=every_s, **overrides)
    b = Runner(scenario, seed, policy_b, every_s=every_s, **overrides)
    elapsed = 0
    try:
        while not (a.done and b.done) and (max_seconds is None or elapsed < max_seconds):
            yield a.advance(every_s), b.advance(every_s)
            elapsed += every_s
    finally:
        a.close()
        b.close()
