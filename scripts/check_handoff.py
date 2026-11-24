"""Check the shipped GPS and OSM inputs against their provenance and SUMO outputs."""
import hashlib
import json
from pathlib import Path

import pandas as pd


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def verify_sha256(path, expected):
    with path.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    require(actual == expected, f"SHA-256 mismatch: {path.name}")


def main():
    root = Path(__file__).resolve().parents[1]
    raw = root / "data/raw"
    gps = root / "runs/gps"
    gtfs = root / "data/processed/gtfs"
    quality = read_json(gps / "gps_quality.json")
    cni = read_json(raw / "cni_provenance.json")
    roads = read_json(raw / "corridors_provenance.json")
    verify_sha256(raw / "cni_normalized.csv", cni["normalized_sha256"])
    verify_sha256(raw / "corridors.osm", roads["sha256"])
    verify_sha256(gtfs / "selected_gtfs.zip", roads["selected_gtfs_sha256"])
    require(quality["osm_sha256"] == roads["sha256"], "GPS results use a different OSM extract")
    require(cni["source_sha256"] == quality["source_sha256"], "CNI source hash differs")
    require(quality["historical_data_year"] == cni["source_year"] == 2019, "Unexpected GPS year")
    require(cni["source_rows"] - sum(cni["dropped_rows"].values()) == cni["normalized_rows"]
            == quality["valid_rows"], "GPS row counts do not reconcile")
    require(quality["matched_gps_points"] + quality["unmatched_gps_points"] == quality["valid_rows"],
            "GPS matching counts do not reconcile")
    speeds = pd.read_csv(gps / "osm_way_speeds.csv")
    keys = ["osm_way_id", "hour_ist"]
    require(len(speeds) == quality["speed_rows"] and not speeds.duplicated(keys).any(),
            "Missing or duplicated speed bins")
    limits = quality["filters"]
    require(speeds.samples.ge(limits["min_samples"]).all() and speeds.unique_buses.ge(limits["min_buses"]).all(),
            "Speed table contains a sparse bin")
    edges = pd.read_csv(root / "runs/sumo/edge_hour_speeds.csv")
    joined = edges[keys].drop_duplicates().merge(speeds[keys], on=keys, how="inner")
    print(f"{len(speeds):,} historical way-hours on {speeds.osm_way_id.nunique():,} ways. "
          f"{len(joined):,} way-hours join to {edges.edge_id.nunique():,} SUMO edges.")
    for route in read_json(gtfs / "route_manifest.json")["selected_routes"]:
        route_id = route["route_id"]
        require(roads["corridor_intersecting_ways"].get(route_id, 0) > 0, f"No road coverage for {route_id}")
        bins = speeds[speeds.route_ids.str.split("|",regex=False).map(lambda ids: route_id in ids)]
        print(f"{route['route_short_name']}: {len(bins):,} way-hours, {bins.osm_way_id.nunique():,} ways")
    print("Input checksums, counts and sampling thresholds verified.")


if __name__ == "__main__":
    main()
