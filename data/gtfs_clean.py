"""Clean a dated GTFS schedule and export the selected SUMO corridors."""

import argparse
import hashlib
import json
from datetime import datetime
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import numpy as np
import pandas as pd

from common.settings import DEFAULT_CONFIG, load_settings


def read_table(archive, name, columns=None, optional=False, **kwargs):
    if optional and name not in archive.namelist():
        return pd.DataFrame()
    with archive.open(name) as stream:
        return pd.read_csv(stream, usecols=columns, dtype=str, keep_default_na=False, **kwargs)


def active_services(archive, service_date):
    weekday = datetime.strptime(service_date, "%Y%m%d").strftime("%A").lower()
    calendar = read_table(archive, "calendar.txt", optional=True)
    active = set()
    if not calendar.empty:
        mask = calendar.start_date.le(service_date) & calendar.end_date.ge(service_date) & calendar[weekday].eq("1")
        active.update(calendar.loc[mask, "service_id"])
    exceptions = read_table(archive, "calendar_dates.txt", optional=True)
    if not exceptions.empty:
        day = exceptions[exceptions.date.eq(service_date)]
        active.update(day.loc[day.exception_type.eq("1"), "service_id"])
        active.difference_update(day.loc[day.exception_type.eq("2"), "service_id"])
    if not active:
        raise ValueError(f"No service found for {service_date}. Pick a date in this feed's active calendar.")
    return active


def parse_gtfs_seconds(values):
    valid = values.str.fullmatch(r"\d{1,3}:[0-5]\d:[0-5]\d")
    return pd.to_timedelta(values.where(valid), errors="coerce").dt.total_seconds()


def distance_m(lat1, lon1, lat2, lon2):
    d_lat = np.radians(lat2 - lat1)
    d_lon = np.radians(lon2 - lon1)
    a = np.sin(d_lat / 2) ** 2 + np.cos(np.radians(lat1)) * np.cos(np.radians(lat2)) * np.sin(d_lon / 2) ** 2
    return 12_742_000 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def clean_timetable(times, stops, max_kmh):
    times = times.copy()
    times["stop_sequence_num"] = pd.to_numeric(times.stop_sequence, errors="coerce")
    times["arrival_s"] = parse_gtfs_seconds(times.arrival_time)
    times["departure_s"] = parse_gtfs_seconds(times.departure_time)
    times["lat"] = times.stop_id.map(stops.set_index("stop_id").stop_lat.astype(float))
    times["lon"] = times.stop_id.map(stops.set_index("stop_id").stop_lon.astype(float))
    times = times.sort_values(["trip_id", "stop_sequence_num"], kind="stable")
    trip_groups = times.groupby("trip_id", sort=False)
    previous = trip_groups[["lat", "lon", "departure_s"]].shift()
    travel_s = times.arrival_s - previous.departure_s
    segment_m = distance_m(previous.lat, previous.lon, times.lat, times.lon)
    bad = (
        times[["stop_sequence_num", "arrival_s", "departure_s", "lat", "lon"]].isna().any(axis=1)
        | times.stop_sequence_num.lt(0) | times.stop_sequence_num.mod(1).ne(0)
        | times.duplicated(["trip_id", "stop_sequence_num"], keep=False)
        | times.departure_s.lt(times.arrival_s) | travel_s.lt(0)
        | (segment_m.gt(30) & segment_m.mul(3.6).gt(max_kmh * travel_s))
    )
    bounds = trip_groups.agg(n=("stop_id", "size"), first_departure=("departure_s", "first"),
                             last_arrival=("arrival_s", "last"))
    bounds["trip_time_s"] = bounds.last_arrival - bounds.first_departure
    valid_ids = bounds.index[bounds.n.ge(2) & bounds.trip_time_s.gt(0)].difference(times.loc[bad, "trip_id"])
    clean = times[times.trip_id.isin(valid_ids)].copy()
    clean["stop_idx"] = clean.groupby("trip_id", sort=False).cumcount()
    return clean, bounds.loc[valid_ids, "trip_time_s"]


def with_stop_patterns(times, trips):
    sequences = times.groupby("trip_id", sort=False).stop_id.agg(tuple).rename("stop_ids")
    trips = trips.join(sequences, on="trip_id")
    keys = trips[["route_id", "direction_id", "stop_ids"]].drop_duplicates().copy()
    keys["pattern_id"] = [hashlib.sha256(json.dumps(key).encode()).hexdigest()[:16]
                          for key in keys.itertuples(index=False, name=None)]
    return trips.merge(keys, on=["route_id", "direction_id", "stop_ids"], validate="many_to_one")


def rank_routes(routes, trips, config):
    summary = trips.groupby("route_id").agg(daily_trips=("trip_id", "size"), patterns=("pattern_id", "nunique"),
                                            mean_trip_min=("trip_time_s", lambda s: round(s.mean() / 60, 2)))
    ranking = routes[["route_id", "route_short_name", "route_long_name"]].join(summary, on="route_id", how="inner")
    ranking = ranking.sort_values(["daily_trips", "route_id"], ascending=[False, True]).reset_index(drop=True)
    ranking.insert(0, "rank", ranking.index + 1)
    ranking["role"] = "candidate"
    candidates = ranking[ranking.daily_trips.ge(config.min_daily_trips)].copy()
    # Choose distinct rider-facing services, even if a feed splits one name into several route IDs.
    name = candidates.route_short_name.str.strip().str.casefold().str.replace(r"[^a-z0-9]+", "", regex=True)
    name = name.mask(name.eq(""), candidates.route_id)
    chosen = candidates.loc[~name.duplicated()].head(config.train_count + config.transfer_count)
    if len(chosen) != config.train_count + config.transfer_count:
        raise ValueError("Too few distinct high-frequency routes for the configured split")
    ranking.loc[chosen.index[:config.train_count], "role"] = "train"
    ranking.loc[chosen.index[config.train_count:], "role"] = "held_out_transfer"
    return ranking


def write_selected(archive, output, routes, stops, trips, times, service_date):
    raw_trip_fields = read_table(archive, "trips.txt").columns.tolist()
    raw_time_fields = [name for name in times.columns if name not in
                       {"stop_sequence_num", "arrival_s", "departure_s", "lat", "lon", "stop_idx"}]
    selected_stops = stops[stops.stop_id.isin(times.stop_id)]
    if "parent_station" in selected_stops:
        while True:
            parents = stops[stops.stop_id.isin(selected_stops.parent_station) & ~stops.stop_id.isin(selected_stops.stop_id)]
            if parents.empty:
                break
            selected_stops = pd.concat([selected_stops, parents])
    with ZipFile(output / "selected_gtfs.zip", "w", compression=ZIP_DEFLATED) as feed:
        for name in ("agency.txt", "attributions.txt"):
            if name in archive.namelist():
                feed.writestr(name, archive.read(name))
        for name, rows in (("routes.txt", routes), ("trips.txt", trips[raw_trip_fields]),
                           ("stop_times.txt", times[raw_time_fields]), ("stops.txt", selected_stops)):
            feed.writestr(name, rows.to_csv(index=False))
        exceptions = pd.DataFrame({"service_id": sorted(trips.service_id.unique()), "date": service_date, "exception_type": 1})
        weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        # SUMO versions may expect both calendar tables in the feed.
        calendar = exceptions[["service_id"]].assign(**dict.fromkeys(weekdays, 0), start_date=service_date, end_date=service_date)
        feed.writestr("calendar.txt", calendar.to_csv(index=False))
        feed.writestr("calendar_dates.txt", exceptions.to_csv(index=False))
        if "shapes.txt" in archive.namelist() and "shape_id" in trips:
            with archive.open("shapes.txt") as stream, feed.open("shapes.txt", "w") as destination:
                wanted = set(trips.shape_id) - {""}
                for i, chunk in enumerate(pd.read_csv(stream, dtype=str, keep_default_na=False, chunksize=200_000)):
                    destination.write(chunk[chunk.shape_id.isin(wanted)].to_csv(index=False, header=i == 0).encode())


def export_eda(output, selected_trips, times, stops, ratios):
    times = times.join(selected_trips.set_index("trip_id")[["route_id", "pattern_id"]], on="trip_id")
    keys = ["route_id", "pattern_id", "stop_idx"]
    times = times.sort_values(keys + ["arrival_s", "trip_id"], kind="stable")
    gaps = times.groupby(keys, sort=False).arrival_s.diff()
    times["planned_gap_s"] = gaps.astype("Int64")
    gaps = times[times.planned_gap_s.gt(0)]
    pattern_target = gaps.groupby(keys).planned_gap_s.median()
    times = times.join(pattern_target.rename("pattern_stop_median_headway_s"), on=keys)
    times["scheduled_headway_s"] = times.planned_gap_s.astype("Float64").where(
        times.planned_gap_s.gt(0), times.pattern_stop_median_headway_s
    )
    times[["route_id", "pattern_id", "trip_id", "stop_idx", "stop_id", "arrival_s", "departure_s",
           "planned_gap_s", "scheduled_headway_s"]].to_csv(output / "scheduled_arrivals.csv", index=False)
    metrics = gaps.groupby("route_id").planned_gap_s.agg(
        eligible_gaps="size", p10_s=lambda s: s.quantile(.10), p50_s="median", p90_s=lambda s: s.quantile(.90),
    )
    for ratio in ratios:
        metrics[f"planned_below_{ratio:g}_share"] = gaps.join(pattern_target.rename("target"), on=keys).assign(
            below=lambda frame: frame.planned_gap_s.lt(ratio * frame.target)
        ).groupby("route_id").below.mean()
    metrics.round(4).to_csv(output / "scheduled_headway_eda.csv")
    selected_trips[["route_id", "pattern_id", "trip_id", "trip_time_s"]].to_csv(output / "scheduled_trip_times.csv", index=False)
    patterns = selected_trips.groupby(["route_id", "pattern_id"]).trip_id.agg(representative_trip_id="first", trips="size")
    patterns.join(selected_trips.set_index("trip_id")[["direction_id"]], on="representative_trip_id").to_csv(output / "patterns.csv")
    pattern_stops = times.drop_duplicates(keys).join(stops.set_index("stop_id")[["stop_name"]], on="stop_id")
    pattern_stops[keys + ["stop_id", "stop_name", "lat", "lon"]].to_csv(output / "pattern_stops.csv", index=False)


def clean_gtfs(source: Path, output: Path, config, ratios, service_date=None):
    date = service_date or config.service_date
    output.mkdir(parents=True, exist_ok=True)
    with ZipFile(source) as archive:
        if "frequencies.txt" in archive.namelist():
            raise ValueError("This pipeline requires explicit scheduled trips. Expand frequency-based trips upstream.")
        raw_routes = read_table(archive, "routes.txt")
        raw_stops = read_table(archive, "stops.txt")
        trips = read_table(archive, "trips.txt")
        feed_info = read_table(archive, "feed_info.txt", optional=True)
        if "direction_id" not in trips:
            trips["direction_id"] = ""
        for rows, key in ((raw_routes, "route_id"), (raw_stops, "stop_id"), (trips, "trip_id")):
            if rows[key].eq("").any() or rows[key].duplicated().any():
                raise ValueError(f"GTFS has empty or duplicate {key}")
        routes = raw_routes[raw_routes.route_type.eq("3")]
        active = trips[trips.service_id.isin(active_services(archive, date)) & trips.route_id.isin(routes.route_id)]
        all_times = read_table(archive, "stop_times.txt")
        times = all_times[all_times.trip_id.isin(active.trip_id)]
        lat, lon = (pd.to_numeric(raw_stops[col], errors="coerce") for col in ("stop_lat", "stop_lon"))
        stops = raw_stops[lat.between(-90, 90) & lon.between(-180, 180)]
        clean_times, durations = clean_timetable(times, stops, config.max_segment_speed_kmh)
        clean_trips = with_stop_patterns(clean_times, active.join(durations, on="trip_id", how="inner"))
        ranking = rank_routes(routes, clean_trips, config)
        chosen = ranking[ranking.role.ne("candidate")]
        selected_trips = clean_trips[clean_trips.route_id.isin(chosen.route_id)]
        selected_times = clean_times[clean_times.trip_id.isin(selected_trips.trip_id)]
        write_selected(archive, output, routes[routes.route_id.isin(chosen.route_id)], stops, selected_trips, selected_times, date)

    ranking.to_csv(output / "cleaned_routes.csv", index=False)
    export_eda(output, selected_trips, selected_times, stops, ratios)
    with source.open("rb") as raw_feed:
        digest = hashlib.file_digest(raw_feed, "sha256").hexdigest()
    report = {
        "data_source": "community_gtfs_schedule", "service_date": date,
        "feed_version": feed_info.iloc[0].get("feed_version") if not feed_info.empty else None,
        "input_sha256": digest,
        "routes_raw": len(raw_routes), "bus_routes": len(routes), "routes_with_no_scheduled_service": len(routes) - active.route_id.nunique(),
        "routes_without_valid_timetable": active.route_id.nunique() - len(ranking), "routes_cleaned": len(ranking),
        "active_trips_before_cleaning": len(active), "trips_dropped_invalid_or_missing_timetable": len(active) - len(clean_trips),
        "stop_times_raw": len(all_times), "active_stop_times_dropped": len(times) - len(clean_times),
        "stops_raw": len(raw_stops), "stops_used_by_clean_schedule": clean_times.stop_id.nunique(),
        "stops_unused_or_invalid": len(raw_stops) - clean_times.stop_id.nunique(),
        "selected_routes": chosen.to_dict("records"),
    }
    (output / "route_manifest.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gtfs", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--date", help="YYYYMMDD, defaults to common/config.yaml")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    args = parser.parse_args()
    config = load_settings(args.config)
    report = clean_gtfs(args.gtfs, args.out, config.gtfs, config.bunching.sensitivity_ratios, args.date)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
