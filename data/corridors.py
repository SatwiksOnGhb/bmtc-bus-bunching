"""Build a reference-complete, WGS84 bus-road extract via Overpass."""
import argparse
import json
import math
import shutil
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import numpy as np
import shapely
from shapely.geometry import LineString

from data.cni import checksum
from data.gps_clean import project, ROAD_CLASSES, corridor_geometries, index_roads
from data.gtfs_clean import read_table

SOURCE = "https://overpass.private.coffee/api/interpreter"
FEED = Path("data/processed/gtfs/selected_gtfs.zip")
OUT = Path("data/raw/corridors.osm")


def bounds(feed, buffer_m):
    if buffer_m <= 0:
        raise ValueError("Buffer must be positive")
    with ZipFile(feed) as archive:
        stops = read_table(archive, "stops.txt")
        points = [stops[["stop_lon", "stop_lat"]].astype(float).to_numpy()]
        shapes = read_table(archive, "shapes.txt", optional=True)
        if not shapes.empty:
            points.append(shapes[["shape_pt_lon", "shape_pt_lat"]].astype(float).to_numpy())
    points = np.concatenate(points)
    west, south = points.min(axis=0)
    east, north = points.max(axis=0)
    dy = math.ceil(buffer_m / 111000 * 1e5) / 1e5
    dx = math.ceil(buffer_m / (111195 * math.cos(math.radians(max(abs(south), abs(north)) + dy))) * 1e5) / 1e5
    return [west - dx, south - dy, east + dx, north + dy]


def validate(path, feed):
    nodes = ways = 0
    known = set()
    for _, obj in ET.iterparse(path, events=("end",)):
        if obj.tag == "node":
            nodes += 1
            known.add(obj.get("id"))
            obj.clear()
        elif obj.tag == "way":
            ways += 1
            if any(nd.get("ref") not in known for nd in obj.findall("nd")):
                raise ValueError(f"Incomplete geometry in way {obj.get('id')}")
            obj.clear()
    corridors = corridor_geometries(feed)
    _, _, by_way = index_roads(path, corridors, 120)
    counts = {route: sum(route in routes for routes in by_way.values()) for route in corridors}
    if not all(counts.values()):
        raise ValueError(f"Missing roads for selected corridors: {counts}")
    return dict(nodes=nodes, ways=ways, corridor_intersecting_ways=counts)


def clip_download(response, target, feed, buffer_m):
    """Keep complete motor-road ways intersecting the buffered GTFS routes and stops."""
    corridors = list(corridor_geometries(feed).values())
    with ZipFile(feed) as archive:
        stops = read_table(archive, "stops.txt")
    stop_points = shapely.points(*project(stops.stop_lon.astype(float), stops.stop_lat.astype(float)))
    mask = shapely.buffer(shapely.union_all(corridors + list(stop_points)), buffer_m)
    shapely.prepare(mask)
    nodes, keep_nodes, keep_ways = {}, set(), set()
    snapshot = None
    for _, element in ET.iterparse(response, events=("end",)):
        if element.tag == "meta":
            snapshot = element.get("osm_base")
        if element.tag == "node":
            nodes[element.get("id")] = (float(element.get("lon")), float(element.get("lat")))
            element.clear()
        if element.tag == "way":
            tags = {t.get("k"):t.get("v") for t in element.findall("tag")}
            refs = [n.get("ref") for n in element.findall("nd")]
            if tags.get("highway") in ROAD_CLASSES and len(refs) >= 2:
                xy = np.array([nodes[r] for r in refs])
                line = LineString(np.column_stack(project(xy[:,0], xy[:,1])))
                if shapely.intersects(mask, line):
                    keep_ways.add(element.get("id"))
                    keep_nodes.update(refs)
            element.clear()
    with target.open("wb") as out:
        out.write(b'<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="BMTC corridor extractor">\n')
        for _, element in ET.iterparse(response, events=("end",)):
            if element.tag in ("node", "way", "note", "meta"):
                if (element.tag in ("note", "meta") or
                        element.get("id") in (keep_nodes if element.tag == "node" else keep_ways)):
                    out.write(ET.tostring(element, encoding="utf-8"))
                element.clear()
        out.write(b'</osm>\n')
    return snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-url", default=SOURCE)
    parser.add_argument("--selected-gtfs", type=Path, default=FEED)
    parser.add_argument("--response", type=Path, help="Previously downloaded XML response to this query")
    parser.add_argument("--download-date", help="UTC acquisition date for saved response")
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--buffer-m", type=float, default=1000)
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    extent = bounds(args.selected_gtfs, args.buffer_m)
    temp = args.out.with_suffix(".partial.osm")
    temp.unlink(missing_ok=True)
    west, south, east, north = extent
    query = (f'[out:xml][timeout:150];way["highway"]'
             f'({south:.5f},{west:.5f},{north:.5f},{east:.5f});(._;>;);out body;')
    if args.response:
        if not args.download_date:
            parser.error("--response requires --download-date")
        downloaded = args.response
    else:
        downloaded = args.out.with_suffix(".download.osm")
        with urlopen(args.source_url + "?" + urlencode({"data": query}), timeout=240) as response, downloaded.open("wb") as stream:
            shutil.copyfileobj(response, stream)
    acquired = datetime.now(timezone.utc).date().isoformat()
    snapshot = clip_download(downloaded, temp, args.selected_gtfs, args.buffer_m)
    info = validate(temp, args.selected_gtfs)
    info.update(osm_snapshot_utc=snapshot, query_response_sha256=checksum(downloaded), source_url=args.source_url, download_date=args.download_date if args.response else acquired, query=query, crs="EPSG:4326",
                bbox_west_south_east_north=extent, buffer_m=args.buffer_m,
                sha256=checksum(temp), 
                selected_gtfs_sha256=checksum(args.selected_gtfs),
                attribution="© OpenStreetMap contributors, ODbL 1.0; via Overpass",
                command=f"python -m data.corridors --source-url {args.source_url} --buffer-m {args.buffer_m}")
    if not args.response:
        downloaded.unlink()
    temp.replace(args.out)
    args.out.with_name("corridors_provenance.json").write_text(json.dumps(info, indent=2)+"\n")
    print(json.dumps(info, indent=2))


if __name__ == "__main__":
    main()
