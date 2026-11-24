"""Named, seeded scenarios: "<route>_<condition>", for example "375d_base", "378_rain", "401m_breakdown".

Routes come from config.yaml sim.routes and their roles from Varun's route_manifest.json
(375-D and 378 for training, 401-M held out for zero-shot transfer).

    base       weekday 07:00-11:00 with mixed traffic, GPS road speeds and Poisson passengers
    rain       every road slower by sim.rain_speed_factor
    breakdown  one bus, picked by the seed, leaves service sim.breakdown_window_s after the start;
               its passengers wait at that stop for the next bus
"""
import json

from sim.bus_sim import SETTINGS, SimConfig
from sim.scenario import ROOT

CONDITIONS = ("base", "rain", "breakdown")
ROUTES = tuple(SETTINGS.sim.routes)


def _roles():
    manifest = json.loads((ROOT / SETTINGS.gtfs.route_manifest).read_text(encoding="utf-8"))
    by_id = {r["route_id"]: r for r in manifest["selected_routes"]}
    return {key: by_id[rid] for key, rid in SETTINGS.sim.routes.items()}


ROUTE_INFO = _roles()
TRAIN_ROUTES = tuple(k for k, r in ROUTE_INFO.items() if r["role"] == "train")
HELD_OUT_ROUTES = tuple(k for k, r in ROUTE_INFO.items() if r["role"] != "train")
SCENARIOS = tuple(f"{r}_{c}" for r in ROUTES for c in CONDITIONS)


def route_label(route):
    return ROUTE_INFO[route]["route_short_name"]


def make_scenario(name: str, seed: int = 1, **overrides) -> SimConfig:
    """Return the SimConfig for a named scenario. Extra keyword arguments override config.yaml."""
    route, _, condition = name.rpartition("_")
    if route not in ROUTES or condition not in CONDITIONS:
        raise ValueError(f"Unknown scenario {name!r}. Choose from {', '.join(SCENARIOS)}")
    return SimConfig(route=route, condition=condition, seed=seed, **overrides)
