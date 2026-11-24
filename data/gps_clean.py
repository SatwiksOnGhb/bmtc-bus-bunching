"""Calibrate hourly OSM way speeds from a normalized GPS CSV and a corridor road extract."""

import argparse
import json
import re
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import numpy as np
import pandas as pd
import shapely
from shapely.geometry import LineString, shape
from shapely.strtree import STRtree

from common.settings import DEFAULT_CONFIG, load_settings
from data.gtfs_clean import distance_m, read_table
from data.cni import parse_times, checksum

M_PER_LAT_DEG = 111_195
M_PER_LON_DEG = M_PER_LAT_DEG * np.cos(np.deg2rad(13.0))
ROAD_CLASSES = set("motorway trunk primary secondary tertiary unclassified residential living_street service road".split())
ROAD_CLASSES.update(f"{road}_link" for road in ("motorway", "trunk", "primary", "secondary", "tertiary"))
GPS_COLUMNS = {"bus_id", "timestamp", "lat", "lon"}
WAY_ID = re.compile(r"[1-9]\d*\Z")


def project(lon, lat, z=None):
    return (np.asarray(lon) - 77.6) * M_PER_LON_DEG, (np.asarray(lat) - 13.0) * M_PER_LAT_DEG


def read_ways(source):
    if source.suffix.lower() == ".osm":
        root = ET.parse(source).getroot()
        nodes = {node.attrib["id"]: (float(node.attrib["lon"]), float(node.attrib["lat"])) for node in root.iter("node")}
        for way in root.iter("way"):
            tags = {tag.attrib["k"]: tag.attrib["v"] for tag in way.iter("tag")}
            refs = [node.attrib["ref"] for node in way.iter("nd")]
            if tags.get("highway") in ROAD_CLASSES and len(refs) >= 2 and all(ref in nodes for ref in refs):
                yield way.attrib["id"], LineString([nodes[ref] for ref in refs])
    else:
        features = json.loads(source.read_text(encoding="utf-8"))["features"]
        for feature in features:
            props = feature.get("properties") or {}
            raw_id = str(props.get("osm_way_id", props.get("id", feature.get("id", ""))))
            geom = feature.get("geometry") or {}
            if props.get("highway", "road") in ROAD_CLASSES and geom.get("type") in ("LineString", "MultiLineString"):
                yield raw_id.removeprefix("way/"), shape(geom)


def corridor_geometries(selected_gtfs):
    with ZipFile(selected_gtfs) as feed:
        trips = read_table(feed, "trips.txt")
        stops = read_table(feed, "stops.txt").set_index("stop_id")
        times = read_table(feed, "stop_times.txt")
        shapes = read_table(feed, "shapes.txt", optional=True)
    by_shape = {}
    if not shapes.empty:
        shapes["order"] = pd.to_numeric(shapes.shape_pt_sequence)
        for shape_id, rows in shapes.sort_values("order").groupby("shape_id"):
            if len(rows) >= 2:
                by_shape[shape_id] = LineString(rows[["shape_pt_lon", "shape_pt_lat"]].astype(float).to_numpy())
    by_route = {}
    for route_id, route_trips in trips.groupby("route_id"):
        shape_ids = set(route_trips.get("shape_id", [])) & by_shape.keys()
        lines = [by_shape[shape_id] for shape_id in sorted(shape_ids)]
        missing_shape = route_trips[~route_trips.get("shape_id", pd.Series("", index=route_trips.index)).isin(shape_ids)]
        if not missing_shape.empty:
            selected = times[times.trip_id.isin(missing_shape.trip_id)].copy()
            selected["order"] = pd.to_numeric(selected.stop_sequence)
            sequences = selected.sort_values("order").groupby("trip_id").stop_id.agg(tuple).unique()
            for sequence in sequences:
                positions = stops.loc[list(sequence), ["stop_lon", "stop_lat"]].astype(float)
                lines.append(LineString(positions.to_numpy()))
        by_route[route_id] = shapely.union_all(shapely.transform(lines, project, interleaved=False))
    return by_route


def index_roads(source, corridors, buffer_m):
    roads = {}
    for way_id, geom in read_ways(source):
        if WAY_ID.fullmatch(way_id) and geom.is_valid and not geom.is_empty:
            roads.setdefault(way_id, []).append(shapely.transform(geom, project, interleaved=False))
    if not roads:
        raise ValueError("Road input contains no usable OSM way IDs with line geometry")
    road_ids = list(roads)
    tree = STRtree([shapely.union_all(roads[way_id]) for way_id in road_ids])
    matching = {}
    for route_id, corridor in corridors.items():
        for index in tree.query(corridor, predicate="dwithin", distance=buffer_m):
            matching.setdefault(int(index), []).append(route_id)
    indices = sorted(matching)
    if not indices:
        raise ValueError("No OSM roads intersect the selected corridor buffers. Check extent and CRS (WGS84).")
    way_routes = {road_ids[idx]: matching[idx] for idx in indices}
    corridor_area = shapely.buffer(shapely.union_all(list(corridors.values())), buffer_m)
    clipped_roads = shapely.intersection(tree.geometries[indices], corridor_area)
    return STRtree(clipped_roads), np.asarray([road_ids[idx] for idx in indices]), way_routes


def timestamp_utc(value, timezone):
    try:
        if not value or not re.match(r"^\d{4}-\d\d-\d\d[T ]\d\d:\d\d", value):
            return pd.NaT
        timestamp = pd.Timestamp(value)
        return timestamp.tz_localize(timezone).tz_convert("UTC") if timestamp.tzinfo is None else timestamp.tz_convert("UTC")
    except (ValueError, OverflowError):
        return pd.NaT


def clean_points(source, config):
    chunks = []
    count = invalid_coord = invalid_time = 0
    for raw in pd.read_csv(source, usecols=lambda col: col in GPS_COLUMNS, dtype={"bus_id": "string"},
                           keep_default_na=False, chunksize=200000, float_precision="round_trip"):
        missing = GPS_COLUMNS - set(raw)
        if missing:
            raise ValueError(f"GPS input is missing columns: {sorted(missing)}")
        raw["timestamp"] = parse_times(raw.timestamp, config.timezone)
        raw["bus_id"] = raw.bus_id.str.strip()
        for col in ("lat", "lon"):
            raw[col] = pd.to_numeric(raw[col], errors="coerce")
        coordinates = raw.lat.between(-90, 90) & raw.lon.between(-180, 180)
        count += len(raw)
        invalid_coord += int((~coordinates).sum())
        invalid_time += int(raw.timestamp.isna().sum())
        valid_records = raw.loc[coordinates & raw.timestamp.notna() & raw.bus_id.ne("")].copy()
        valid_records["bus_id"] = valid_records.bus_id.astype("category")
        chunks.append(valid_records)
    bus_ids = pd.api.types.union_categoricals([chunk.bus_id for chunk in chunks])
    for chunk in chunks:
        chunk.drop(columns="bus_id", inplace=True)
    points = pd.concat(chunks, ignore_index=True)
    points["bus_id"] = bus_ids
    del chunks
    valid = len(points)
    points = points.drop_duplicates().drop_duplicates(["bus_id", "timestamp"], keep=False)
    points = points.sort_values(["bus_id", "timestamp"]).reset_index(drop=True)
    previous = points.groupby("bus_id", sort=False, observed=True)[["timestamp", "lat", "lon"]].shift()
    elapsed = (points.timestamp - previous.timestamp).dt.total_seconds()
    displacement = distance_m(previous.lat, previous.lon, points.lat, points.lon)
    points["speed_kmh"] = (3.6 * displacement / elapsed).where(elapsed.gt(0) & elapsed.le(config.max_ping_gap_s))
    report = {"raw_pings": count, "invalid_pings": count - valid, "invalid_coordinate_rows": invalid_coord,
              "invalid_timestamp_rows": invalid_time, "valid_rows": len(points), "duplicate_or_conflicting_pings": valid - len(points),
              "unique_buses": points.bus_id.nunique(), "pairs_without_valid_time_gap": int(points.speed_kmh.isna().sum()),
              "pairs_below_min_speed": int(points.speed_kmh.lt(config.min_speed_kmh).sum()),
              "pairs_above_max_speed": int(points.speed_kmh.gt(config.max_speed_kmh).sum())}
    return points, report


def match_ways(points, tree, way_ids, config):
    matches = pd.Series(pd.NA, index=points.index, dtype="string")
    ambiguous = 0
    for start in range(0, len(points), 25_000):
        window = points.iloc[start:start + 25_000]
        geometry = shapely.points(*project(window.lon, window.lat))
        point_indices, road_indices = tree.query(geometry, predicate="dwithin", distance=config.max_match_distance_m)
        distances = shapely.distance(geometry[point_indices], tree.geometries[road_indices])
        candidates = pd.DataFrame({"point": point_indices, "road": road_indices, "distance": distances})
        candidates = candidates.sort_values(["point", "distance", "road"])
        nearest = candidates.drop_duplicates("point").set_index("point")
        second = candidates[candidates.groupby("point").cumcount().eq(1)].set_index("point").distance
        separation = second.reindex(nearest.index) - nearest.distance
        reliable = nearest[separation.isna() | separation.ge(config.ambiguity_margin_m)]
        ambiguous += len(nearest) - len(reliable)
        matches.iloc[start + reliable.index.to_numpy(dtype=int)] = way_ids[reliable.road.to_numpy(dtype=int)]
    return matches, ambiguous


def calibrate(gps_csv, roads, selected_gtfs, output, config, source_name):
    tree, way_ids, way_routes = index_roads(roads, corridor_geometries(selected_gtfs), config.corridor_buffer_m)
    points, report = clean_points(gps_csv, config)
    if source_name == "cni_2022":
        prov_path = gps_csv.with_name("cni_provenance.json")
        provenance = json.loads(prov_path.read_text())
        if checksum(gps_csv) != provenance["normalized_sha256"] or provenance["source_year"] != 2019:
            raise ValueError("Historical CNI normalization provenance does not match the GPS input")
        report.update(source_gps_rows=provenance["source_rows"], normalization_drops=provenance["dropped_rows"],
                      source_sha256=provenance["source_sha256"])
    matches, ambiguous = match_ways(points, tree, way_ids, config)
    points["osm_way_id"] = matches.astype("category")
    previous_way = points.groupby("bus_id", sort=False, observed=True).osm_way_id.shift()
    previous_time = points.groupby("bus_id", sort=False, observed=True).timestamp.shift()
    midpoint = previous_time + (points.timestamp - previous_time) / 2
    points["hour_ist"] = midpoint.dt.tz_convert("Asia/Kolkata").dt.hour
    eligible = points[points.speed_kmh.between(config.min_speed_kmh, config.max_speed_kmh)]
    moving = eligible[eligible.osm_way_id.eq(previous_way.reindex(eligible.index))]
    summaries = moving.groupby(["osm_way_id", "hour_ist"], observed=True).agg(
        samples=("speed_kmh", "size"), unique_buses=("bus_id", "nunique"),
        median_speed_kmh=("speed_kmh", "median"), mean_speed_kmh=("speed_kmh", "mean"),
        p25_speed_kmh=("speed_kmh", lambda s: s.quantile(.25)), p75_speed_kmh=("speed_kmh", lambda s: s.quantile(.75)),
    ).reset_index()
    summaries["median_speed_mps"] = summaries.median_speed_kmh / 3.6
    summaries["route_ids"] = summaries.osm_way_id.astype(object).map(lambda way: "|".join(way_routes[way]))
    summaries["source"] = source_name
    enough = summaries.samples.ge(config.min_samples) & summaries.unique_buses.ge(config.min_buses)
    speeds = summaries[enough].round(4)
    report.update(source=source_name, status="ready" if len(speeds) else "no_bins_with_sufficient_coverage",
                  corridor_way_count=len(way_ids), usable_motion_pairs=len(eligible), matched_same_way_pairs=len(moving),
                  insufficient_way_hour_bins=int((~enough).sum()), speed_rows=len(speeds),
                  matched_ways=speeds.osm_way_id.nunique())
    output.mkdir(parents=True, exist_ok=True)
    # Pool original pairs from published bins. Shared ways contribute once to each corridor.
    kept = moving.merge(speeds[["osm_way_id", "hour_ist"]], on=["osm_way_id", "hour_ist"])
    kept["route_id"] = kept.osm_way_id.astype(object).map(way_routes)
    by_hour = kept.explode("route_id").groupby(["route_id", "hour_ist"]).agg(
        samples=("speed_kmh", "size"), unique_buses=("bus_id", "nunique"),
        median_speed_kmh=("speed_kmh", "median"), p25_speed_kmh=("speed_kmh", lambda v: v.quantile(.25)),
        p75_speed_kmh=("speed_kmh", lambda v: v.quantile(.75))).reset_index()
    by_hour.round(4).to_csv(output / "corridor_hour_speeds.csv", index=False)
    times = points.timestamp.dt.tz_convert(config.timezone)
    years = sorted(int(v) for v in times.dt.year.unique())
    covered = sorted(by_hour.route_id.unique())
    report.update(matched_gps_points=int(matches.notna().sum()), unmatched_gps_points=int(matches.isna().sum()),
                  ambiguous_matches=ambiguous, no_candidate_points=int(matches.isna().sum())-ambiguous,
                  matched_osm_ways=int(matches.nunique()), matched_route_ids=covered,
                  minimum_timestamp=str(times.min()), maximum_timestamp=str(times.max()),
                  historical_data_year=years[0] if len(years)==1 else None, input_years=years,
                  speed_outliers=report["pairs_above_max_speed"], osm_sha256=checksum(roads),
                  filters=config.model_dump(),
                  raw_gps_rows=report.get("source_gps_rows",report["raw_pings"]),
                  duplicate_rows=report["duplicate_or_conflicting_pings"] + sum(
                      report.get("normalization_drops",{}).get(key,0) for key in ("identical_duplicate","conflicting_key")))
    speeds.to_csv(output / "osm_way_speeds.csv", index=False)
    (output / "gps_quality.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gps", required=True, type=Path, help="CSV with bus_id,timestamp,lat,lon")
    parser.add_argument("--roads", required=True, type=Path, help="WGS84 OSM .osm XML or road .geojson")
    parser.add_argument("--selected-gtfs", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--source", required=True, help="Trace provenance, e.g. cni_2022 or synthetic_fixture")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    args = parser.parse_args()
    report = calibrate(args.gps, args.roads, args.selected_gtfs, args.out, load_settings(args.config).gps, args.source)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
