"""Validate Satwik's stop-event Parquet and append nullable future-bunching labels."""

import argparse
from pathlib import Path

import pandas as pd

from common.labels import label_arrivals
from common.schemas import StopArrival
from common.settings import DEFAULT_CONFIG, load_settings


def load_arrivals(path: Path) -> tuple[pd.DataFrame, list[StopArrival]]:
    frame = pd.read_parquet(path)
    fields = list(StopArrival.model_fields)
    required = {name for name, field in StopArrival.model_fields.items() if field.is_required()}
    missing = required - set(frame.columns)
    if missing:
        raise ValueError(f"Missing StopArrival columns: {', '.join(sorted(missing))}")
    inputs = frame[[name for name in fields if name in frame]].astype(object)
    return frame, [StopArrival.model_validate(record) for record in inputs.where(inputs.notna(), None).to_dict("records")]


def add_labels(input_path: Path, output_path: Path, config):
    frame, arrivals = load_arrivals(input_path)
    labels = label_arrivals(arrivals, config)
    for k in config.horizons_stops:
        column = f"bunch_next_{k}"
        frame[column] = pd.array([row[column] for row in labels], dtype="boolean")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_parquet(output_path, index=False)
    return len(frame)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    args = parser.parse_args()
    print(f"Labelled {add_labels(args.input, args.out, load_settings(args.config).bunching)} stop events")


if __name__ == "__main__":
    main()
