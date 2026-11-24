from datetime import datetime, timedelta
import json
from zipfile import ZipFile

import pandas as pd
import pytest
from pydantic import ValidationError

from common.kpis import compute_kpis
from common.labels import label_arrivals
from common.schemas import PassengerTrip, Snapshot, StopArrival, VehicleTrip
from common.settings import load_settings
from control.baselines import BaselinePolicy, hold_indices
from data.gps_clean import calibrate
from data.gtfs_clean import clean_gtfs, parse_gtfs_seconds
from data.label_arrivals import add_labels
from data.sumo_speeds import sumo_speed_overrides

CFG = load_settings()


def event(stop_idx=0, gap=120, **changes):
    values = dict(bus_id="bus-1", route_id="A", t=stop_idx * 60, stop_idx=stop_idx, lat=13, lon=77.6,
                  fwd_headway_s=gap, bwd_headway_s=300, sched_dev_s=-45, load=20, waiting_at_stop=7,
                  scheduled_headway_s=120, episode_id="e1", trip_id="t1", pattern_id="A:outbound", stop_id=f"s{stop_idx}",
                  scenario="normal", policy="no_control", seed=7, dwell_s=15, hour_ist=8, data_source="synthetic_fixture")
    return StopArrival.model_validate(values | changes)


@pytest.mark.parametrize("name,expected", [("no_control", 0), ("schedule", 45), ("daganzo", 60), ("two_headway", 90)])
def test_policies_return_seconds_and_runner_converts_to_index(name, expected):
    row = event(gap=20)
    policy = BaselinePolicy(name, CFG.holding)
    assert policy.act({row.bus_id: row}) == {"bus-1": expected}
    assert hold_indices({"bus-1": expected}, CFG.holding.actions_s) == {"bus-1": CFG.holding.actions_s.index(expected)}
    assert policy.act({row.bus_id: event(gap=20, can_hold=False)}) == {"bus-1": 0}
    assert policy.act({}) == {}


def test_missing_leader_and_late_bus_do_not_hold():
    obs = {"bus-1": event(gap=None, sched_dev_s=45)}
    for name in ("schedule", "daganzo", "two_headway"):
        assert BaselinePolicy(name, CFG.holding).act(obs) == {"bus-1": 0}
    with pytest.raises(ValueError, match="does not match"):
        BaselinePolicy("no_control", CFG.holding).act({"wrong": obs["bus-1"]})


def test_contract_serializes_snapshot_and_rejects_bad_probabilities():
    row = event(gap=None)
    snapshot = Snapshot(t=0, policy="no_control", scenario="normal", buses=[row], predictions=[], holds={}, kpis={"headway_cv": None})
    assert Snapshot.model_validate_json(snapshot.model_dump_json()).buses[0].fwd_headway_s is None
    with pytest.raises(ValidationError):
        event(p_bunch=1.2)
    with pytest.raises(ValidationError):
        event(gap=float("inf"))


def test_future_labels_strict_boundary_and_missing_tail():
    rows = [event(i, {0: 5, 2: 24, 4: 23}.get(i, 100)) for i in range(9)]
    labels = label_arrivals(rows, CFG.bunching)
    assert labels[0] == {"bunch_next_3": False, "bunch_next_5": True, "bunch_next_8": True}
    assert labels[4] == {"bunch_next_3": False, "bunch_next_5": None, "bunch_next_8": None}
    assert labels[-1] == {"bunch_next_3": None, "bunch_next_5": None, "bunch_next_8": None}


def test_labels_do_not_cross_trip_pattern_or_episode():
    rows = [event(0), event(1, 5, episode_id="other"), event(1, 5, pattern_id="other"), event(2, 5, trip_id="other")]
    assert label_arrivals(rows, CFG.bunching)[0]["bunch_next_3"] is None
    assert label_arrivals([event(0), event(2, 6)], CFG.bunching)[0]["bunch_next_3"] is True
    with pytest.raises(ValueError, match="Duplicate"):
        label_arrivals([event(0), event(0)], CFG.bunching)


def test_kpis_have_known_values_and_eligibility_counts():
    rows = [event(gap=20), event(gap=100, bus_id="bus-2"), event(gap=None)]
    passengers = [PassengerTrip(wait_s=30, in_vehicle_s=80, reference_in_vehicle_s=70),
                  PassengerTrip(wait_s=50, in_vehicle_s=70)]
    metrics = compute_kpis(rows, passengers, [VehicleTrip(departure_s=20, arrival_s=120)], bunching_ratio=.25)
    expected = dict(headway_cv=2/3, bunched_arrivals_pct=50, mean_passenger_wait_s=40,
                    mean_in_vehicle_delay_s=10, mean_trip_time_s=100, eligible_arrivals_n=2, passenger_delay_n=1)
    for key, value in expected.items():
        assert metrics[key] == pytest.approx(value)
    assert compute_kpis([], bunching_ratio=.25)["mean_passenger_wait_s"] is None


def test_parquet_round_trip_preserves_columns_and_null_labels(tmp_path):
    raw, labelled = tmp_path / "arrivals.parquet", tmp_path / "labelled.parquet"
    pd.DataFrame([event(i, gap=None if i == 2 else 20).model_dump() | {"extra_feature": i} for i in range(4)]).to_parquet(raw)
    assert add_labels(raw, labelled, CFG.bunching) == 4
    result = pd.read_parquet(labelled)
    assert result.bunch_next_3.iloc[0]
    assert pd.isna(result.bunch_next_3.iloc[-1])
    assert list(result.extra_feature) == list(range(4))


@pytest.fixture
def tiny_gtfs(tmp_path):
    tables = {
        "routes.txt": "route_id,route_short_name,route_long_name,route_type\nA,A,A route,3\nB,B,B route,3\nC,C,C route,3\nD,D,D route,3\nE,E,E route,3\n",
        "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\ns1,First,13,77.6000\ns2,Second,13,77.6030\ns3,Unused,13,77.6050\n",
        "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nregular,1,1,1,1,1,1,1,20261101,20261130\nremoved,1,1,1,1,1,1,1,20261101,20261130\n",
        "calendar_dates.txt": "service_id,date,exception_type\nremoved,20261116,2\nextra,20261116,1\n",
    }
    trips = ["route_id,service_id,trip_id,direction_id"]
    times = ["trip_id,arrival_time,departure_time,stop_id,stop_sequence"]
    for route, count, service in [("A", 4, "regular"), ("B", 3, "regular"), ("C", 2, "extra"), ("D", 6, "removed"), ("E", 1, "regular")]:
        for idx in range(count):
            trip = f"{route}{idx}"
            trips.append(f"{route},{service},{trip},0")
            departure = f"25:{idx*5:02}:00"
            arrival = f"25:{idx*5+2:02}:00" if route != "E" else "24:00:00"
            times.extend([f"{trip},{departure},{departure},s1,1", f"{trip},{arrival},{arrival},s2,5"])
    tables.update({"trips.txt": "\n".join(trips), "stop_times.txt": "\n".join(times)})
    source = tmp_path / "raw.zip"
    with ZipFile(source, "w") as bundle:
        for filename, content in tables.items():
            bundle.writestr(filename, content)
    output = tmp_path / "gtfs"
    report = clean_gtfs(source, output, CFG.gtfs.model_copy(update={"min_daily_trips": 2}), CFG.bunching.sensitivity_ratios)
    return output, report


def test_gtfs_cleaning_calendar_and_route_ranking(tiny_gtfs):
    output, report = tiny_gtfs
    assert [(row["route_id"], row["daily_trips"], row["role"]) for row in report["selected_routes"]] == [
        ("A", 4, "train"), ("B", 3, "train"), ("C", 2, "held_out_transfer")]
    assert report["routes_with_no_scheduled_service"] == 1
    assert report["trips_dropped_invalid_or_missing_timetable"] == 1
    assert report["stops_unused_or_invalid"] == 1
    arrivals = pd.read_csv(output / "scheduled_arrivals.csv")
    assert set(arrivals.stop_idx) == {0, 1}
    assert set(arrivals.scheduled_headway_s) == {300}
    with ZipFile(output / "selected_gtfs.zip") as feed:
        assert b"Unused" not in feed.read("stops.txt")
        assert b"extra,20261116,1" in feed.read("calendar_dates.txt")
    values = parse_gtfs_seconds(pd.Series(["25:01:00", "26:60:00"]))
    assert values.iloc[0] == 90060 and pd.isna(values.iloc[1])


def test_gps_calibration_and_sumo_way_join(tiny_gtfs, tmp_path):
    output, _ = tiny_gtfs
    roads = tmp_path / "roads.geojson"
    roads.write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": way, "properties": {"highway": "primary"},
         "geometry": {"type": "LineString", "coordinates": [[77.6, lat], [77.603, lat]]}}
        for way, lat in [("way/123", 13), ("way/124", 13.0003), ("way/999", 13.01)]
    ]}))
    records = []
    for bus in ("01", "02"):
        for idx in range(4):
            when = datetime(2026, 11, 16, 8) + timedelta(seconds=idx*10)
            records.append(dict(bus_id=bus, timestamp=when.isoformat(), lat=13, lon=77.6002 + idx*.0004))
    records.append(records[0])
    records.append(dict(bus_id="01", timestamp="bad", lat=13, lon=77.601))
    records.append(dict(bus_id="03", timestamp="2026-11-16T08:00:00", lat=13.00015, lon=77.601))
    records.append(dict(bus_id="03", timestamp="2026-11-16T08:00:10", lat=13.00015, lon=77.6014))
    gps = tmp_path / "pings.csv"
    pd.DataFrame(records).to_csv(gps, index=False)
    report = calibrate(gps, roads, output / "selected_gtfs.zip", tmp_path, CFG.gps, "synthetic_fixture")
    assert report["invalid_pings"] == report["duplicate_or_conflicting_pings"] == 1
    assert report["matched_same_way_pairs"] == 6 and report["speed_rows"] == 1
    speed_file = tmp_path / "osm_way_speeds.csv"
    speeds = pd.read_csv(speed_file)
    assert speeds.iloc[0].hour_ist == 8 and speeds.iloc[0].osm_way_id == 123
    assert speeds.iloc[0].median_speed_mps == pytest.approx(4.33, abs=.03)
    assert report["ambiguous_matches"] == report["unmatched_gps_points"] == 2
    hourly = pd.read_csv(tmp_path / "corridor_hour_speeds.csv")
    assert set(hourly.unique_buses) == {2} and set(hourly.samples) == {6}
    network = tmp_path / "test.net.xml"
    network.write_text('''<net><edge id="123#1"/><edge id="-123#2"/><edge id="custom"><lane><param key="origID" value="123"/></lane></edge>
                       <edge id="123#3"><lane><param key="origID" value="123 124"/></lane></edge><edge id=":123"/></net>''')
    assert set(sumo_speed_overrides(network, speed_file).edge_id) == {"123#1", "-123#2", "custom"}


def test_osm_calibration_does_not_fill_sparse_bins(tiny_gtfs, tmp_path):
    output, _ = tiny_gtfs
    roads = tmp_path / "roads.osm"
    roads.write_text('''<osm><node id="1" lat="13" lon="77.600"/><node id="2" lat="13" lon="77.603"/>
                     <way id="123"><nd ref="1"/><nd ref="2"/><tag k="highway" v="primary"/></way></osm>''')
    gps = tmp_path / "pings.csv"
    gps.write_text("bus_id,timestamp,lat,lon\n01,2026-11-16T02:30:00Z,13,77.6000\n01,2026-11-16T08:00:10+05:30,13,77.6004\n")
    report = calibrate(gps, roads, output / "selected_gtfs.zip", tmp_path, CFG.gps, "synthetic_fixture")
    assert report["matched_same_way_pairs"] == report["insufficient_way_hour_bins"] == 1
    assert report["status"] == "no_bins_with_sufficient_coverage"
    assert pd.read_csv(tmp_path / "osm_way_speeds.csv").empty
