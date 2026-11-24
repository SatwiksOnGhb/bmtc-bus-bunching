"""Exercise the route manifest and the Python policy interface with an example event."""

import json

import pandas as pd

from common.schemas import BusObservation
from common.settings import load_settings
from control.baselines import BaselinePolicy, hold_indices


def main():
    config = load_settings()
    manifest_path = config.gtfs.route_manifest
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    route = next(row for row in manifest["selected_routes"] if row["role"] == "train")
    arrivals = pd.read_csv(manifest_path.with_name("scheduled_arrivals.csv"))
    eligible = arrivals[(arrivals.route_id == route["route_id"]) & arrivals.stop_idx.eq(1)
                        & arrivals.scheduled_headway_s.gt(90)]
    arrival = eligible.iloc[0]
    stops = pd.read_csv(manifest_path.with_name("pattern_stops.csv"))
    stop = stops[(stops.pattern_id == arrival.pattern_id) & (stops.stop_idx == arrival.stop_idx)].iloc[0]
    bus = BusObservation(bus_id="example-bus", route_id=route["route_id"], t=120, stop_idx=int(stop.stop_idx),
                         lat=stop.lat, lon=stop.lon, fwd_headway_s=20, bwd_headway_s=300, sched_dev_s=-45,
                         load=20, waiting_at_stop=7, scheduled_headway_s=arrival.scheduled_headway_s)
    print(f"Example event at {stop.stop_name} on {route['route_short_name']} ({bus.route_id})")
    for name in ("no_control", "schedule", "daganzo", "two_headway"):
        holds = BaselinePolicy(name, config.holding).act({bus.bus_id: bus})
        actions = hold_indices(holds, config.holding.actions_s)
        print(f"{name:12} {holds[bus.bus_id]:2d} seconds  action index {actions[bus.bus_id]}")


if __name__ == "__main__":
    main()
