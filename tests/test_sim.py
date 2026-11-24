"""Part 2 contract tests: scenarios, environment, runner and dataset rows. Skipped without SUMO."""
import os
import shutil

import numpy as np
import pytest

sumo_available = bool(os.environ.get("SUMO_HOME")) or shutil.which("sumo")
pytestmark = pytest.mark.skipif(not sumo_available, reason="SUMO not installed")
SHORT = dict(end=27000)   # departures 07:00-07:30 only


def test_scenarios_built_without_u_turns():
    from sim import scenario
    from sim.scenarios import ROUTES
    for route in ROUTES:
        for name, d in scenario.load_route(route)["directions"].items():
            edges = d["edges"]
            uturns = sum(edges[i + 1] == scenario.reverse_id(edges[i]) for i in range(len(edges) - 1))
            assert uturns <= 1, (route, name, uturns)   # 378 has one through a 3 m stub


def test_make_scenario_names():
    from sim.scenarios import SCENARIOS, make_scenario
    assert "375d_base" in SCENARIOS and "401m_breakdown" in SCENARIOS
    cfg = make_scenario("378_rain", seed=4)
    assert (cfg.route, cfg.condition, cfg.seed, cfg.scenario) == ("378", "rain", 4, "378_rain")
    with pytest.raises(ValueError):
        make_scenario("375d_snow")


@pytest.mark.parametrize("name", ["375d_base", "375d_breakdown"])
def test_baseline_episode(name):
    from control.baselines import BaselinePolicy
    from sim.bus_sim import BusSim
    from sim.scenarios import make_scenario
    sim = BusSim(make_scenario(name, seed=1, policy="two_headway", **SHORT))
    policy = BaselinePolicy("two_headway", sim.settings.holding)
    obs = sim.reset()
    while not sim.done:
        assert all(o.can_hold for o in obs.values())
        obs = sim.step(policy.act(obs))
    k = sim.kpis()
    assert k["bus_teleports"] <= 1
    assert k["completed_trips_n"] >= len(sim.all_trips) - (1 if name.endswith("breakdown") else 0)


def test_same_seed_is_reproducible():
    from sim.bus_sim import BusSim
    from sim.scenarios import make_scenario
    results = []
    for _ in range(2):
        sim = BusSim(make_scenario("375d_base", seed=3, **SHORT))
        sim.reset()
        while not sim.done:
            sim.step({})
        results.append(sim.kpis()["mean_trip_time_s"])
    assert results[0] == results[1]


def test_env_contract():
    from common.schemas import BusObservation, Prediction
    from sim.env import OBS_DIM, BMTCHoldingEnv

    class Predictor:
        def predict(self, history):
            return Prediction(bus_id=history[-1].bus_id, p_bunch=0.5, horizon_stops=3)

    env = BMTCHoldingEnv("375d_base", predictor=Predictor(), **SHORT)
    obs, infos = env.reset(seed=1, options={"scenario": "375d_rain"})
    assert env.sim.cfg.scenario == "375d_rain"
    rng = np.random.default_rng(0)
    steps = 0
    while env.agents:
        for a in env.agents:
            assert obs[a].shape == (OBS_DIM,) and np.isfinite(obs[a]).all()
            assert isinstance(infos[a]["bus_state"], BusObservation)
            assert infos[a]["bus_state"].p_bunch == 0.5 and obs[a][10] == 0.5
        assert env.state().shape == env.state_space.shape
        obs, rewards, terms, truncs, infos = env.step(
            {a: int(rng.integers(env.action_space(a).n)) for a in env.agents})
        assert set(rewards) == set(obs)
        steps += 1
    assert steps > 0 and all(terms.values())


def test_runner_stream_and_side_by_side():
    from common.schemas import Snapshot
    from sim.runner import Runner, side_by_side
    runner = Runner("375d_base", seed=1, policy="daganzo", every_s=60, **SHORT)
    snaps = list(runner.stream(max_seconds=1800))
    assert len(snaps) == 30 and all(isinstance(s, Snapshot) for s in snaps)
    assert snaps[-1].buses and snaps[-1].kpis
    pairs = list(side_by_side("375d_base", 1, "no_control", "daganzo", every_s=300, max_seconds=1800, **SHORT))
    assert pairs[-1][0].t == pairs[-1][1].t and pairs[-1][0].policy == "no_control"
