from pathlib import Path
from typing import Annotated

import yaml
from pydantic import Field, model_validator

from common.schemas import ContractModel, Probability

DEFAULT_CONFIG = Path(__file__).with_name("config.yaml")
Positive = Annotated[float, Field(gt=0)]
PositiveInt = Annotated[int, Field(gt=0)]


class GtfsSettings(ContractModel):
    service_date: Annotated[str, Field(pattern=r"^\d{8}$")]
    route_manifest: Path
    source: str
    max_segment_speed_kmh: Positive
    min_daily_trips: PositiveInt
    train_count: PositiveInt
    transfer_count: PositiveInt


class BunchingSettings(ContractModel):
    ratio: Annotated[float, Field(gt=0, lt=1)]
    horizons_stops: tuple[PositiveInt, ...]
    sensitivity_ratios: tuple[Annotated[float, Field(gt=0, lt=1)], ...]

    @model_validator(mode="after")
    def validate_options(self):
        if not self.horizons_stops or tuple(sorted(set(self.horizons_stops))) != self.horizons_stops:
            raise ValueError("horizons_stops must be unique, positive and ascending")
        if self.ratio not in self.sensitivity_ratios:
            raise ValueError("sensitivity_ratios must include the label ratio")
        return self


class HoldingSettings(ContractModel):
    actions_s: tuple[int, ...]
    forward_gain: Probability
    two_headway_gain: Probability

    @model_validator(mode="after")
    def validate_actions(self):
        if not self.actions_s or self.actions_s[0] != 0 or tuple(sorted(set(self.actions_s))) != self.actions_s:
            raise ValueError("actions_s must start at zero and be strictly increasing")
        return self


class GpsSettings(ContractModel):
    timezone: str
    min_speed_kmh: Positive
    max_speed_kmh: Positive
    max_ping_gap_s: Positive
    max_match_distance_m: Positive
    ambiguity_margin_m: Positive
    corridor_buffer_m: Positive
    min_samples: PositiveInt
    min_buses: PositiveInt

    @model_validator(mode="after")
    def validate_speed_range(self):
        if self.min_speed_kmh >= self.max_speed_kmh:
            raise ValueError("min_speed_kmh must be less than max_speed_kmh")
        return self


class SimSettings(ContractModel):
    """Part 2 simulation settings (Satwik). Optional, so Part 1 configs without it still load."""
    begin_s: Annotated[int, Field(ge=0)]
    end_s: PositiveInt
    routes: dict[str, str]                      # short key -> GTFS route_id
    demand_per_min: Annotated[float, Field(ge=0)]
    peak_factor: Annotated[float, Field(ge=0)]
    capacity: PositiveInt
    dwell_fixed_s: Annotated[float, Field(ge=0)]
    board_s: Annotated[float, Field(ge=0)]
    alight_s: Annotated[float, Field(ge=0)]
    min_departure_gap_s: Annotated[int, Field(ge=0)]
    speed_dev: Annotated[float, Field(ge=0, lt=1)]
    traffic_veh_per_hour: Annotated[float, Field(ge=0)]
    traffic_mix: dict[str, Annotated[float, Field(ge=0)]]
    rain_speed_factor: Annotated[float, Field(gt=0, le=1)]
    speed_calibration: Annotated[float, Field(gt=0)]
    breakdown_window_s: tuple[int, int]
    seeds_train: tuple[int, ...]
    seeds_test: tuple[int, ...]

    @model_validator(mode="after")
    def validate_sim(self):
        if self.end_s <= self.begin_s:
            raise ValueError("end_s must be after begin_s")
        if set(self.traffic_mix) - {"car", "motorcycle", "auto"}:
            raise ValueError("traffic_mix keys must be car, motorcycle, auto")
        return self


class Settings(ContractModel):
    gtfs: GtfsSettings
    bunching: BunchingSettings
    holding: HoldingSettings
    gps: GpsSettings
    sim: SimSettings | None = None


def load_settings(path: Path = DEFAULT_CONFIG) -> Settings:
    return Settings.model_validate(yaml.safe_load(path.read_text(encoding="utf-8")))
