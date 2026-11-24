"""Rule-based Part 1 policies with no simulator dependency."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from common.schemas import BusObservation
from common.settings import HoldingSettings

PolicyName = Literal["no_control", "schedule", "daganzo", "two_headway"]


def no_control(_: BusObservation) -> float:
    return 0.0


def schedule_hold(obs: BusObservation) -> float:
    return max(0.0, -obs.sched_dev_s)


def forward_hold(obs: BusObservation, gain: float) -> float:
    if obs.fwd_headway_s is None or obs.scheduled_headway_s is None:
        return 0.0
    return max(0.0, gain * (obs.scheduled_headway_s - obs.fwd_headway_s))


def two_headway_hold(obs: BusObservation, gain: float) -> float:
    if obs.fwd_headway_s is None or obs.bwd_headway_s is None:
        return 0.0
    return max(0.0, gain * (obs.bwd_headway_s - obs.fwd_headway_s) / 2)


@dataclass(frozen=True)
class BaselinePolicy:
    name: PolicyName
    config: HoldingSettings

    def __post_init__(self):
        if self.name not in ("no_control", "schedule", "daganzo", "two_headway"):
            raise ValueError(f"Unknown policy {self.name!r}")

    def act(self, obs: Mapping[str, BusObservation]) -> dict[str, int]:
        rules = {
            "no_control": no_control,
            "schedule": schedule_hold,
            "daganzo": lambda bus: forward_hold(bus, self.config.forward_gain),
            "two_headway": lambda bus: two_headway_hold(bus, self.config.two_headway_gain),
        }
        holds = {}
        for bus_id, bus in obs.items():
            if bus_id != bus.bus_id:
                raise ValueError(f"Observation key {bus_id!r} does not match bus_id {bus.bus_id!r}")
            desired = rules[self.name](bus) if bus.can_hold else 0.0
            # Round down so quantization cannot hold past the rule's requested time.
            holds[bus_id] = max(seconds for seconds in self.config.actions_s if seconds <= desired)
        return holds


def hold_indices(holds_s: Mapping[str, int], actions_s: Sequence[int]) -> dict[str, int]:
    """Call this at the runner boundary, before PettingZoo env.step(...)."""
    index_by_seconds = {seconds: idx for idx, seconds in enumerate(actions_s)}
    return {bus_id: index_by_seconds[seconds] for bus_id, seconds in holds_s.items()}
