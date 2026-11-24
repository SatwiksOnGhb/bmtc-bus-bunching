"""Version 1 Python contract for the simulator, dashboard and predictor."""

from typing import Annotated, Literal, Mapping, Protocol, Sequence

from pydantic import BaseModel, ConfigDict, Field, model_validator

NonNegative = Annotated[float, Field(ge=0)]
Count = Annotated[int, Field(ge=0, strict=True)]
Probability = Annotated[float, Field(ge=0, le=1)]
Id = Annotated[str, Field(min_length=1)]


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class BusState(ContractModel):
    bus_id: Id
    route_id: Id
    t: NonNegative
    stop_idx: Count
    lat: Annotated[float, Field(ge=-90, le=90)]
    lon: Annotated[float, Field(ge=-180, le=180)]
    fwd_headway_s: NonNegative | None
    bwd_headway_s: NonNegative | None
    sched_dev_s: float  # Positive is late.
    load: Count
    waiting_at_stop: Count


class BusObservation(BusState):
    scheduled_headway_s: Annotated[float, Field(gt=0)] | None
    p_bunch: Probability | None = None
    can_hold: bool = True


class Prediction(ContractModel):
    bus_id: Id
    p_bunch: Probability
    horizon_stops: Annotated[int, Field(gt=0, strict=True)]


class Snapshot(ContractModel):
    t: NonNegative
    policy: Id
    scenario: Id
    buses: list[BusState]
    predictions: list[Prediction]
    holds: dict[str, NonNegative]
    kpis: dict[str, float | None]


class StopArrival(BusObservation):
    """One logged stop event. stop_idx is zero-based within this trip's pattern."""

    episode_id: Id
    trip_id: Id
    pattern_id: Id
    stop_id: Id
    scenario: Id
    policy: Id
    seed: int
    dwell_s: NonNegative
    hour_ist: Annotated[int, Field(ge=0, le=23, strict=True)]
    data_source: Literal["simulation", "measured", "synthetic_fixture"]


class PassengerTrip(ContractModel):
    """One completed passenger journey with a reference on the same OD."""

    wait_s: NonNegative
    in_vehicle_s: NonNegative
    reference_in_vehicle_s: NonNegative | None = None


class VehicleTrip(ContractModel):
    departure_s: NonNegative
    arrival_s: NonNegative

    @model_validator(mode="after")
    def chronological(self):
        if self.arrival_s < self.departure_s:
            raise ValueError("arrival_s precedes departure_s")
        return self


class Policy(Protocol):
    def act(self, obs: Mapping[str, BusObservation]) -> dict[str, int]:
        """Return hold seconds by bus ID for agents currently at stops."""
        ...


class Predictor(Protocol):
    def predict(self, history: Sequence[StopArrival]) -> Prediction: ...
