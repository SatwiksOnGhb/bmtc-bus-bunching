"""Translate qualified OSM way-hour speeds to SUMO edge-hour overrides."""

import argparse
import re
from pathlib import Path
from xml.etree import ElementTree as ET

import pandas as pd

OSM_EDGE_ID = re.compile(r"-?([1-9]\d*)(?:#\d+)?\Z")


def edge_way_mapping(network: Path) -> dict[str, str]:
    """Use original IDs when present. Skip merged or ambiguous ways."""
    result = {}
    events = ET.iterparse(network, events=("start", "end"))
    _, root = next(events)
    depth = 0
    for event, element in events:
        if event == "start":
            depth += 1
            continue
        depth -= 1
        if depth != 0:
            continue
        if element.tag != "edge":
            root.clear()
            continue
        edge_id = element.attrib["id"]
        if not edge_id.startswith(":") and not element.get("function"):
            original = [param.get("value", "") for param in element.findall(".//param")
                        if param.get("key") in {"origID", "origId"}]
            tokens = " ".join(original).split() if original else [edge_id]
            parsed = [OSM_EDGE_ID.fullmatch(token) for token in tokens]
            if parsed and all(parsed):
                way_ids = {match.group(1) for match in parsed}
                if len(way_ids) == 1:
                    result[edge_id] = next(iter(way_ids))
        root.clear()
    return result


def sumo_speed_overrides(network: Path, speeds_csv: Path) -> pd.DataFrame:
    mapping = pd.DataFrame(edge_way_mapping(network).items(), columns=["edge_id", "osm_way_id"])
    speeds = pd.read_csv(speeds_csv, dtype={"osm_way_id": str})
    if speeds.duplicated(["osm_way_id", "hour_ist"]).any():
        raise ValueError("Speeds must have one row per osm_way_id/hour_ist")
    return mapping.merge(speeds, on="osm_way_id", how="inner").sort_values(["edge_id", "hour_ist"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--net", required=True, type=Path)
    parser.add_argument("--speeds", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    overrides = sumo_speed_overrides(args.net, args.speeds)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    overrides.to_csv(args.out, index=False)
    print(f"Exported {len(overrides)} edge-hour rows on {overrides.edge_id.nunique()} SUMO edges")


if __name__ == "__main__":
    main()
