"""Build the per-route SUMO scenarios from Varun's corridor map and GTFS stops.

Run once from the bmtc folder (needs SUMO's netconvert, plus pyproj and rtree):

    python -m sim.scenario --full     # netconvert on data/raw/corridors.osm + GPS speed join (~2 min)
    python -m sim.scenario            # per-route networks, stops and routes (~5 min)

For each direction of each route, every GTFS stop is snapped to a nearby bus road, choosing the
road and the side of the road that give the shortest route through all stops in order. (SUMO's
gtfs2pt.py put several stops on the opposite side of the road, which made buses U-turn, and its
shape matching takes hours on this map.) The network is then cut down to the roads the route uses.

Outputs, per route key in common/config.yaml (375d, 378, 401m), in runs/sumo/<key>/:
    net.xml          road network with only that route's roads
    stops.add.xml    bus stops of both directions on the correct side of the road
    routes.json      GTFS pattern, SUMO edges and stop ids for each direction
and runs/sumo/full/edge_hour_speeds.csv (Varun's GPS speeds joined to the network).
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
if "SUMO_HOME" in os.environ:
    sys.path.append(os.path.join(os.environ["SUMO_HOME"], "tools"))
import sumolib  # noqa: E402

from common.settings import load_settings  # noqa: E402

SUMO_DIR = ROOT / "runs" / "sumo"
FULL_DIR = SUMO_DIR / "full"
GTFS_DIR = ROOT / "data" / "processed" / "gtfs"
OSM = ROOT / "data" / "raw" / "corridors.osm"
FULL_NET = FULL_DIR / "bmtc.net.xml"
EDGE_SPEEDS = FULL_DIR / "edge_hour_speeds.csv"
CORRIDOR_SPEEDS = ROOT / "runs" / "gps" / "corridor_hour_speeds.csv"
SCHEDULE = GTFS_DIR / "scheduled_arrivals.csv"
STOP_LENGTH = 15.0
DIRECTION_NAMES = {0: "outbound", 1: "inbound"}


def route_dir(key):
    return SUMO_DIR / key


def load_route(key):
    """{direction: {"pattern_id", "edges", "stops", "headsign"}} for a built route."""
    return json.loads((route_dir(key) / "routes.json").read_text(encoding="utf-8"))


def reverse_id(edge_id):
    return edge_id[1:] if edge_id.startswith("-") else "-" + edge_id


def build_full():
    FULL_DIR.mkdir(parents=True, exist_ok=True)
    netconvert = sumolib.checkBinary("netconvert")
    # --junctions.join merges OSM junctions drawn as several nodes a few metres apart; left split,
    # their zero-length links and double signals gridlock traffic (seen on 401-M).
    subprocess.run([netconvert, "--osm-files", str(OSM), "--output.original-names", "true",
                    "--junctions.join", "true", "--tls.join", "true",
                    "-o", str(FULL_NET), "--no-warnings", "true"], check=True)


def build_speeds():
    subprocess.run([sys.executable, "-m", "data.sumo_speeds", "--net", str(FULL_NET),
                    "--speeds", str(ROOT / "runs" / "gps" / "osm_way_speeds.csv"),
                    "--out", str(EDGE_SPEEDS)], check=True, cwd=ROOT)


def snap_direction(net, stops, radius=60.0, max_candidates=4):
    """Choose a road (and side of the road) for each stop so the route through all of them is shortest.

    stops: list of (name, lon, lat) in travel order. Returns (edges, [(edge, pos, name)]).
    """
    def candidates(lon, lat):
        x, y = net.convertLonLat2XY(lon, lat)
        near = sorted((d, e) for e, d in net.getNeighboringEdges(x, y, radius) if e.allows("bus"))
        out, seen = [], set()
        for _, e in near[:max_candidates]:
            pos = sumolib.geomhelper.polygonOffsetWithMinimumDistanceToPoint((x, y), e.getShape())
            for edge, p in ((e, pos), (net.getEdge(reverse_id(e.getID())) if net.hasEdge(reverse_id(e.getID()))
                                       else None, None)):
                if edge is None or edge.getID() in seen or not edge.allows("bus"):
                    continue
                seen.add(edge.getID())
                if p is None:
                    p = edge.getLength() - pos
                out.append((edge, min(max(p, 0.0), edge.getLength())))
        if not out:
            raise RuntimeError(f"No bus road within {radius} m of ({lon}, {lat})")
        return out

    cands = [candidates(lon, lat) for _, lon, lat in stops]
    cache = {}

    def link(a, b):
        (ea, pa), (eb, pb) = a, b
        if ea == eb and pb >= pa:
            return pb - pa, [ea]
        key = (ea.getID(), eb.getID())
        if key not in cache:
            cache[key] = net.getShortestPath(ea, eb, vClass="bus", maxCost=8000)
        path, cost = cache[key]
        if path is None:
            return float("inf"), None
        return cost - pa - (eb.getLength() - pb), list(path)

    best = [{j: (0.0, None, None) for j in range(len(cands[0]))}]
    for i in range(1, len(cands)):
        layer = {}
        for j, cur in enumerate(cands[i]):
            options = []
            for jp, (cost, _, _) in best[-1].items():
                c, path = link(cands[i - 1][jp], cur)
                options.append((cost + c, jp, path))
            layer[j] = min(options, key=lambda o: o[0])
        best.append(layer)

    j = min(best[-1], key=lambda k: best[-1][k][0])
    if best[-1][j][0] == float("inf"):
        raise RuntimeError("No bus route connects the stops")
    chosen, paths = [], []
    for i in range(len(cands) - 1, -1, -1):
        chosen.append(cands[i][j])
        _, jp, path = best[i][j]
        paths.append(path)
        j = jp
    chosen.reverse()
    paths.reverse()
    edges = [chosen[0][0].getID()]
    for path in paths[1:]:
        for e in path:
            if e.getID() != edges[-1]:
                edges.append(e.getID())
    return edges, [(e.getID(), p, name) for (e, p), (name, _, _) in zip(chosen, stops)]


def main_patterns(route_id):
    """Most frequent pattern in each GTFS direction of a route."""
    patterns = pd.read_csv(GTFS_DIR / "patterns.csv")
    rows = patterns[patterns.route_id == route_id]
    return {DIRECTION_NAMES[int(d)]: g.sort_values("trips", ascending=False).iloc[0].pattern_id
            for d, g in rows.groupby("direction_id")}


def build_routes():
    settings = load_settings()
    stop_table = pd.read_csv(GTFS_DIR / "pattern_stops.csv")
    print("Reading the full network...")
    net = sumolib.net.readNet(str(FULL_NET))
    for key, route_id in settings.sim.routes.items():
        out = route_dir(key)
        out.mkdir(parents=True, exist_ok=True)
        routes, stop_lines, all_edges = {}, [], set()
        for direction, pattern_id in main_patterns(route_id).items():
            gtfs_stops = stop_table[stop_table.pattern_id == pattern_id].sort_values("stop_idx")
            stops = list(zip(gtfs_stops.stop_name, gtfs_stops.lon, gtfs_stops.lat))
            edges, snapped = snap_direction(net, stops)
            ids = []
            for k, (edge_id, pos, stop_name) in enumerate(snapped):
                length = net.getEdge(edge_id).getLength()
                end = min(length, max(pos + STOP_LENGTH / 2, min(STOP_LENGTH, length)))
                start = max(0.0, end - STOP_LENGTH)
                sid = f"{key}_{direction}_{k:02d}"
                ids.append(sid)
                name = str(stop_name).replace('"', "").replace("&", "and")
                stop_lines.append(f'    <busStop id="{sid}" lane="{edge_id}_0" startPos="{start:.2f}" '
                                  f'endPos="{end:.2f}" friendlyPos="true" name="{name}"/>')
            uturns = sum(edges[i + 1] == reverse_id(edges[i]) for i in range(len(edges) - 1))
            length_km = sum(net.getEdge(e).getLength() for e in edges) / 1000
            print(f"{key} {direction}: {len(ids)} stops, {len(edges)} edges, {length_km:.1f} km, "
                  f"{uturns} U-turns", flush=True)
            routes[direction] = {"pattern_id": pattern_id, "edges": edges, "stops": ids,
                                 "first_stop": str(gtfs_stops.stop_name.iloc[0]),
                                 "last_stop": str(gtfs_stops.stop_name.iloc[-1])}
            all_edges.update(edges)

        edge_file = out / "edges.txt"
        edge_file.write_text("\n".join(sorted(all_edges)), encoding="utf-8")
        subprocess.run([sumolib.checkBinary("netconvert"), "-s", str(FULL_NET),
                        "--keep-edges.input-file", str(edge_file), "-o", str(out / "net.xml"),
                        "--no-warnings", "true"], check=True)
        (out / "stops.add.xml").write_text("<additional>\n" + "\n".join(stop_lines) + "\n</additional>\n",
                                           encoding="utf-8")
        (out / "routes.json").write_text(json.dumps({"route_id": route_id, "directions": routes}, indent=1),
                                         encoding="utf-8")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true", help="also run netconvert and gtfs2pt on the OSM map")
    args = ap.parse_args()
    if args.full:
        build_full()
    if args.full or not EDGE_SPEEDS.exists():
        build_speeds()
    build_routes()
