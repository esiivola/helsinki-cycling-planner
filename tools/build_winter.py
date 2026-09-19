"""Helsinki's prioritised winter-maintenance network, matched onto the built graph.

    python tools/build_winter.py [out-dir] [--source cached.json]

The city publishes the routes it keeps rideable through the winter, on the same open
WFS this project already takes the traffic-signal registers from. Two tiers:

    harjasuolaus       brush-salted, swept to bare pavement and kept that way
    tehostettu auraus  ploughed early and often, but still snow

178 km of it, against 21 641 km of network -- so this is not a preference that
reshapes every route, it is one that matters enormously on the days it matters.

Written as a sidecar, on the same terms as climb: the city's own geometry changes on
its own schedule and has nothing to do with OSM, so binding it into the graph would
mean rebuilding the graph to pick up a gritting change.

Matching is the whole problem. The city's lines are its own centrelines, drawn to its
own standards, and they do not share nodes with OSM -- so an edge is claimed when the
city's line runs close to it *and in the same direction* for most of its length. The
bearing test is what stops a route being credited for the cycleway on the far side of
the street it happens to run beside.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import sys
from pathlib import Path

import numpy as np
import requests
from pyproj import Transformer

WFS = ("https://kartta.hel.fi/ws/geoserver/avoindata/wfs?service=WFS&version=2.0.0"
       "&request=GetFeature&typeNames=avoindata:Talvihoidon_priorisoitu_reitisto"
       "&outputFormat=application/json")
SOURCE_CRS = "EPSG:3879"

WINTER_NONE, WINTER_PLOUGHED, WINTER_SALTED = 0, 1, 2
TIERS = {"harjasuolaus": WINTER_SALTED, "tehostettu auraus": WINTER_PLOUGHED}

# How far from the city's centreline an edge may sit and still be the same street.
# A two-way street with a cycleway each side is about 20 m across, so beyond this the
# match is the wrong side of the road.
REACH_M = 14.0
# And how far from parallel. The city draws a corridor; OSM draws the ways in it.
BEARING_DEGREES = 35.0
# Samples along the city's line. Finer than this buys nothing: the graph's own shape
# points are about 20 m apart.
STEP_M = 10.0
# Share of an edge's own length that has to be claimed before it counts. Without it a
# route brushing the end of a long edge would mark the whole of it.
CLAIM_SHARE = 0.4

EARTH_NORTH_M = 110_540.0
EARTH_EAST_M = 111_320.0


def read_graph(directory: Path) -> dict:
    manifest = json.loads((directory / "graph.json").read_text())
    blob = gzip.decompress((directory / "graph.bin.gz").read_bytes())

    def section(name: str, dtype: str) -> np.ndarray:
        entry = manifest["layout"][name]
        return np.frombuffer(blob, dtype=dtype, count=entry["count"], offset=entry["offset"])

    shape_count = section("shape_count", "uint16").astype(np.int64)
    shape_start = np.zeros(len(shape_count) + 1, dtype=np.int64)
    np.cumsum(shape_count, out=shape_start[1:])
    return {
        "manifest": manifest,
        "lon": section("lon", "int32") / manifest["coordinate_scale"],
        "lat": section("lat", "int32") / manifest["coordinate_scale"],
        "edge_a": section("edge_a", "uint32"),
        "edge_b": section("edge_b", "uint32"),
        "edge_length": section("edge_length", "uint16") / 10,
        "shape_count": shape_count,
        "shape_start": shape_start,
        "shape_delta": section("shape_delta", "uint16"),
        "shape_scale": manifest["shape_scale"],
    }


def unzigzag(values: np.ndarray) -> np.ndarray:
    values = values.astype(np.int64)
    return (values >> 1) ^ -(values & 1)


def edge_points(graph: dict, edge: int) -> np.ndarray:
    a, b = graph["edge_a"][edge], graph["edge_b"][edge]
    scale = graph["shape_scale"]
    points = [(graph["lon"][a], graph["lat"][a])]
    start, count = graph["shape_start"][edge], graph["shape_count"][edge]
    if count:
        deltas = unzigzag(graph["shape_delta"][start * 2:(start + count) * 2])
        lon = round(graph["lon"][a] * scale) + np.cumsum(deltas[0::2])
        lat = round(graph["lat"][a] * scale) + np.cumsum(deltas[1::2])
        points.extend(zip(lon / scale, lat / scale))
    points.append((graph["lon"][b], graph["lat"][b]))
    return np.asarray(points, dtype=float)


def bearing(a: tuple[float, float], b: tuple[float, float]) -> float:
    east = (b[0] - a[0]) * math.cos(math.radians((a[1] + b[1]) / 2)) * EARTH_EAST_M
    return math.degrees(math.atan2(east, (b[1] - a[1]) * EARTH_NORTH_M)) % 180.0


def resample(points: np.ndarray, step: float) -> list[tuple[float, float, float]]:
    """Points every `step` metres along the line, each with the line's heading."""
    out = []
    for first, second in zip(points, points[1:]):
        east = (second[0] - first[0]) * math.cos(math.radians((first[1] + second[1]) / 2)) * EARTH_EAST_M
        span = math.hypot(east, (second[1] - first[1]) * EARTH_NORTH_M)
        if span <= 0:
            continue
        heading = bearing(first, second)
        for index in range(max(int(span // step), 1)):
            share = (index * step) / span
            out.append((first[0] + (second[0] - first[0]) * share,
                        first[1] + (second[1] - first[1]) * share, heading))
    return out


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", type=Path, nargs="?", default=Path("public/graph"))
    parser.add_argument("--source", type=Path, help="a cached WFS response, instead of fetching")
    args = parser.parse_args(argv)

    if args.source and args.source.exists():
        data = json.loads(args.source.read_text())
        print(f"winter routes: {args.source}", file=sys.stderr)
    else:
        print("fetching the city's winter network…", file=sys.stderr)
        response = requests.get(WFS, timeout=180)
        response.raise_for_status()
        data = response.json()
        if args.source:
            args.source.parent.mkdir(parents=True, exist_ok=True)
            args.source.write_text(json.dumps(data))

    to_wgs84 = Transformer.from_crs(SOURCE_CRS, "EPSG:4326", always_xy=True)
    graph = read_graph(args.out)
    edge_count = graph["manifest"]["edge_count"]

    # A grid over the graph's shape points, so each city sample only has to look at
    # the edges actually near it.
    cell = 0.002  # about 220 m of latitude
    buckets: dict[tuple[int, int], set[int]] = {}
    segments: list[list[tuple[float, float, float]]] = []
    for edge in range(edge_count):
        points = edge_points(graph, edge)
        pieces = []
        for first, second in zip(points, points[1:]):
            pieces.append((float(first[0]), float(first[1]), bearing(first, second)))
            key = (int(first[0] / cell), int(first[1] / cell))
            buckets.setdefault(key, set()).add(edge)
            buckets.setdefault((int(second[0] / cell), int(second[1] / cell)), set()).add(edge)
        segments.append(pieces)

    claimed = np.zeros(edge_count, dtype=np.float64)
    tier_of = np.zeros(edge_count, dtype=np.uint8)
    matched_samples = 0
    total_samples = 0

    for feature in data["features"]:
        tier = TIERS.get((feature["properties"].get("hoitotapa") or "").strip().lower())
        if not tier or not feature.get("geometry"):
            continue
        raw = np.asarray(feature["geometry"]["coordinates"], dtype=float)
        lon, lat = to_wgs84.transform(raw[:, 0], raw[:, 1])
        for x, y, heading in resample(np.column_stack((lon, lat)), STEP_M):
            total_samples += 1
            best, best_metres = -1, REACH_M
            key = (int(x / cell), int(y / cell))
            near: set[int] = set()
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    near |= buckets.get((key[0] + dx, key[1] + dy), set())
            for edge in near:
                for px, py, pb in segments[edge]:
                    gap = abs(pb - heading)
                    if min(gap, 180 - gap) > BEARING_DEGREES:
                        continue
                    east = (px - x) * math.cos(math.radians(y)) * EARTH_EAST_M
                    metres = math.hypot(east, (py - y) * EARTH_NORTH_M)
                    if metres < best_metres:
                        best, best_metres = edge, metres
            if best >= 0:
                matched_samples += 1
                claimed[best] += STEP_M
                tier_of[best] = max(tier_of[best], tier)

    # An edge counts as maintained only if enough of it was claimed.
    keep = claimed >= np.minimum(graph["edge_length"] * CLAIM_SHARE, graph["edge_length"])
    winter = np.where(keep, tier_of, 0).astype(np.uint8)

    blob = winter.tobytes()
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "winter.bin.gz").write_bytes(gzip.compress(blob, compresslevel=9, mtime=0))
    (args.out / "winter.json").write_text(json.dumps({
        "version": 1,
        "edge_count": edge_count,
        "source": "Helsinki/RYA, talvihoidon priorisoitu reitistö (CC BY 4.0)",
        "reach_m": REACH_M,
        "bearing_degrees": BEARING_DEGREES,
        "claim_share": CLAIM_SHARE,
        "bytes": len(blob),
        "layout": {"edge_winter": {"offset": 0, "count": edge_count, "type": "uint8"}},
    }, indent=1) + "\n")

    length = graph["edge_length"]
    for name, tier in (("brush-salted", WINTER_SALTED), ("ploughed", WINTER_PLOUGHED)):
        print(f"  {name:14} {length[winter == tier].sum() / 1000:6.1f} km"
              f" over {(winter == tier).sum():,} edges", file=sys.stderr)
    print(f"  {matched_samples / max(total_samples, 1):.0%} of the city's samples found an edge",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
