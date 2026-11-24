"""KPIs derived from stop events, completed passenger journeys and completed bus trips."""

from collections import defaultdict
from collections.abc import Iterable
from statistics import mean, pstdev

from common.labels import is_bunched
from common.schemas import PassengerTrip, StopArrival, VehicleTrip


def compute_kpis(
    arrivals: Iterable[StopArrival],
    passengers: Iterable[PassengerTrip] = (),
    trips: Iterable[VehicleTrip] = (),
    *,
    bunching_ratio: float,
) -> dict[str, float | None]:
    stop_headways = defaultdict(list)
    bunching_flags = []
    for row in arrivals:
        if row.fwd_headway_s is not None:
            key = (row.episode_id, row.route_id, row.pattern_id, row.stop_idx)
            stop_headways[key].append(row.fwd_headway_s)
        flag = is_bunched(row.fwd_headway_s, row.scheduled_headway_s, bunching_ratio)
        if flag is not None:
            bunching_flags.append(flag)
    cvs = [(pstdev(gaps) / mean(gaps), len(gaps)) for gaps in stop_headways.values()
           if len(gaps) >= 2 and mean(gaps) > 0]
    cv_count = sum(count for _, count in cvs)
    journeys = list(passengers)
    delays = [p.in_vehicle_s - p.reference_in_vehicle_s for p in journeys
              if p.reference_in_vehicle_s is not None]
    trip_times = [trip.arrival_s - trip.departure_s for trip in trips]
    return {
        "headway_cv": sum(cv * count for cv, count in cvs) / cv_count if cv_count else None,
        "headway_cv_n": cv_count,
        "bunched_arrivals_pct": 100 * mean(bunching_flags) if bunching_flags else None,
        "bunched_arrivals_n": sum(bunching_flags),
        "eligible_arrivals_n": len(bunching_flags),
        "mean_passenger_wait_s": mean(p.wait_s for p in journeys) if journeys else None,
        "mean_in_vehicle_delay_s": mean(delays) if delays else None,
        "mean_trip_time_s": mean(trip_times) if trip_times else None,
        "passenger_journeys_n": len(journeys),
        "passenger_delay_n": len(delays),
        "completed_trips_n": len(trip_times),
    }
