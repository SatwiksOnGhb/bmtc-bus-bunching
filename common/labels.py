"""Offline labels from subsequent stops in the same bus trip and episode."""

from collections import defaultdict
from collections.abc import Sequence

from common.schemas import StopArrival
from common.settings import BunchingSettings


def is_bunched(forward_s: float | None, scheduled_s: float | None, ratio: float) -> bool | None:
    if forward_s is None or scheduled_s is None:
        return None
    return forward_s < ratio * scheduled_s


def label_arrivals(rows: Sequence[StopArrival], config: BunchingSettings) -> list[dict[str, bool | None]]:
    """Return label columns in input order. Missing observations yield nullable labels."""
    trips = defaultdict(dict)
    for row in rows:
        key = (row.episode_id, row.route_id, row.pattern_id, row.bus_id, row.trip_id)
        if row.stop_idx in trips[key]:
            raise ValueError(f"Duplicate stop_idx {row.stop_idx} for {key}")
        trips[key][row.stop_idx] = row
    for key, trip in trips.items():
        ordered = [trip[idx].t for idx in sorted(trip)]
        if any(a >= b for a, b in zip(ordered, ordered[1:])):
            raise ValueError(f"Stop arrival timestamps must increase within {key}")

    result = []
    for row in rows:
        key = (row.episode_id, row.route_id, row.pattern_id, row.bus_id, row.trip_id)
        trip = trips[key]
        future = []
        for offset in range(1, max(config.horizons_stops) + 1):
            event = trip.get(row.stop_idx + offset)
            future.append(is_bunched(event.fwd_headway_s, event.scheduled_headway_s, config.ratio) if event else None)
        result.append({f"bunch_next_{k}": True if True in future[:k] else None if None in future[:k] else False
                       for k in config.horizons_stops})
    return result
