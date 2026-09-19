"""Per-edge ascent and descent, sampled from a terrain model.

    python tools/build_climb.py <dem.tif | dem-dir> [output_dir]

Reads the graph that is already built, walks every edge's shape, samples the terrain
under it and writes `climb.bin.gz` and `climb.json` beside it. Nothing here needs the
OSM extract: the graph carries the full geometry of all 424,926 edges, so climb is a
sidecar rather than a reason to rebuild and bump the graph version.

Ascent is *not* the sum of every rise. A terrain model has vertical noise, and summing
each positive difference accumulates it into climb that is not there -- on the probe
routes that inflated totals by 15-20%. A rise is therefore committed only once it has
been given back by `--threshold` metres, which is the usual hysteresis fix and the
number the output is most sensitive to. It is recorded in the manifest for that reason.

The model is expected in ETRS-TM35FIN (EPSG:3067), which is what Maanmittauslaitos
ships; any CRS rasterio can read works, and points are reprojected to meet it.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import sys
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer

# Decimetres per stored unit: a uint16 then spans 6.5 km of climb, which no edge in
# any plausible graph approaches.
SCALE = 10
EARTH_NORTH_M = 110_540.0
EARTH_EAST_M = 111_320.0


def read_graph(directory: Path) -> dict:
    manifest = json.loads((directory / "graph.json").read_text())
    blob = gzip.decompress((directory / "graph.bin.gz").read_bytes())

    def section(name: str, dtype: str) -> np.ndarray:
        entry = manifest["layout"][name]
        if entry["type"] != dtype:
            raise SystemExit(f"graph section {name} is {entry['type']}, expected {dtype}")
        return np.frombuffer(blob, dtype=dtype, count=entry["count"], offset=entry["offset"])

    shape_count = section("shape_count", "uint16").astype(np.int64)
    shape_start = np.zeros(len(shape_count) + 1, dtype=np.int64)
    np.cumsum(shape_count, out=shape_start[1:])
    return {
        "manifest": manifest,
        "coordinate_scale": manifest["coordinate_scale"],
        "lon": section("lon", "int32"),
        "lat": section("lat", "int32"),
        "edge_a": section("edge_a", "uint32"),
        "edge_b": section("edge_b", "uint32"),
        "shape_count": shape_count,
        "shape_start": shape_start,
        "shape_delta": section("shape_delta", "uint16"),
    }


def unzigzag(values: np.ndarray) -> np.ndarray:
    values = values.astype(np.int64)
    return (values >> 1) ^ -(values & 1)


def edge_shape(graph: dict, edge: int) -> np.ndarray:
    """The polyline of one edge as [[lon, lat], ...] in degrees."""
    scale = graph["manifest"]["coordinate_scale"]
    shape_scale = graph["manifest"]["shape_scale"]
    a, b = graph["edge_a"][edge], graph["edge_b"][edge]
    start, count = graph["shape_start"][edge], graph["shape_count"][edge]
    points = [(graph["lon"][a] / scale, graph["lat"][a] / scale)]
    lon = round(graph["lon"][a] / scale * shape_scale)
    lat = round(graph["lat"][a] / scale * shape_scale)
    if count:
        deltas = unzigzag(graph["shape_delta"][start * 2:(start + count) * 2])
        lons = lon + np.cumsum(deltas[0::2])
        lats = lat + np.cumsum(deltas[1::2])
        points.extend(zip(lons / shape_scale, lats / shape_scale))
    points.append((graph["lon"][b] / scale, graph["lat"][b] / scale))
    return np.asarray(points, dtype=np.float64)


def resample(points: np.ndarray, spacing: float) -> np.ndarray:
    """Points every `spacing` metres along the polyline, so the profile is evenly
    sampled rather than dense wherever the geometry happens to be."""
    if len(points) < 2:
        return points
    mid_lat = float(points[:, 1].mean())
    east = (points[:, 0] - points[0, 0]) * math.cos(math.radians(mid_lat)) * EARTH_EAST_M
    north = (points[:, 1] - points[0, 1]) * EARTH_NORTH_M
    run = np.concatenate(([0.0], np.cumsum(np.hypot(np.diff(east), np.diff(north)))))
    if run[-1] <= 0:
        return points[:1]
    # Both ends always sampled: an edge shorter than the spacing still has a gradient.
    wanted = np.arange(0.0, run[-1], spacing)
    wanted = np.append(wanted, run[-1])
    return np.column_stack((
        np.interp(wanted, run, points[:, 0]),
        np.interp(wanted, run, points[:, 1]),
    ))


def gain_and_loss(profile: np.ndarray, threshold: float) -> tuple[float, float]:
    """Climb and drop, counting a move only once it has been given back by
    `threshold`. At threshold 0 this is the naive sum, which the noise inflates."""
    clean = profile[np.isfinite(profile)]
    if len(clean) < 2:
        return 0.0, 0.0
    gain = loss = 0.0
    anchor = extreme = float(clean[0])
    rising = True
    for height in clean[1:]:
        height = float(height)
        if rising:
            if height >= extreme:
                extreme = height
            elif extreme - height > threshold:
                gain += extreme - anchor
                anchor, extreme, rising = extreme, height, False
        else:
            if height <= extreme:
                extreme = height
            elif height - extreme > threshold:
                loss += anchor - extreme
                anchor, extreme, rising = extreme, height, True
    if rising and extreme > anchor:
        gain += extreme - anchor
    elif not rising and extreme < anchor:
        loss += anchor - extreme
    return gain, loss


class Terrain:
    """One or more rasters, sampled together. Held in memory: the region at 10 m is
    about 100 MB, which is cheaper than a windowed read per point by a wide margin."""

    def __init__(self, paths: list[Path]) -> None:
        self.tiles = []
        crs = None
        for path in paths:
            with rasterio.open(path) as source:
                if crs is None:
                    crs = source.crs
                elif source.crs != crs:
                    raise SystemExit(f"{path} is in {source.crs}, expected {crs}")
                self.tiles.append({
                    "band": source.read(1, masked=True).filled(np.nan).astype(np.float32),
                    "transform": ~source.transform,
                    "bounds": source.bounds,
                })
        if not self.tiles:
            raise SystemExit("no rasters given")
        self.to_dem = Transformer.from_crs("EPSG:4326", crs, always_xy=True)

    def sample(self, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
        x, y = self.to_dem.transform(lon, lat)
        out = np.full(len(x), np.nan, dtype=np.float32)
        for tile in self.tiles:
            left, bottom, right, top = tile["bounds"]
            inside = (x >= left) & (x < right) & (y > bottom) & (y <= top) & np.isnan(out)
            if not inside.any():
                continue
            columns, rows = tile["transform"] @ (x[inside], y[inside])
            rows = np.clip(rows.astype(np.int64), 0, tile["band"].shape[0] - 1)
            columns = np.clip(columns.astype(np.int64), 0, tile["band"].shape[1] - 1)
            out[inside] = tile["band"][rows, columns]
        return out


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dem", type=Path, help="a GeoTIFF, or a directory of them")
    parser.add_argument("out", type=Path, nargs="?", default=Path("public/graph"))
    parser.add_argument("--spacing", type=float, default=25.0, help="sample spacing, metres")
    parser.add_argument("--threshold", type=float, default=2.0, help="ignore a rise given back within this")
    parser.add_argument("--source", default="Maanmittauslaitos, korkeusmalli 10 m (CC BY 4.0)")
    args = parser.parse_args(argv)

    paths = sorted(args.dem.glob("*.tif")) if args.dem.is_dir() else [args.dem]
    if not paths:
        raise SystemExit(f"no .tif files under {args.dem}")
    print(f"terrain: {len(paths)} raster(s)", file=sys.stderr)

    graph = read_graph(args.out)
    edge_count = graph["manifest"]["edge_count"]
    terrain = Terrain(paths)

    # Every edge's samples in one flat array, so the raster is indexed once rather
    # than 425k times. Roughly a million points over this region.
    offsets = [0]
    chunks = []
    for edge in range(edge_count):
        chunks.append(resample(edge_shape(graph, edge), args.spacing))
        offsets.append(offsets[-1] + len(chunks[-1]))
    points = np.concatenate(chunks)
    print(f"sampling {len(points):,} points along {edge_count:,} edges", file=sys.stderr)
    heights = terrain.sample(points[:, 0], points[:, 1])

    missing = int(np.isnan(heights).sum())
    if missing:
        print(f"warning: {missing:,} points ({missing / len(heights):.1%}) fell outside"
              " the terrain model and were skipped", file=sys.stderr)

    # Height at every junction, so the page can draw a profile rather than only
    # report a total. Ascent alone gives the shape of a ride but not its datum, and a
    # profile with no datum is a chart nobody can read a hill off.
    scale = graph["manifest"]["coordinate_scale"]
    node_heights = terrain.sample(graph["lon"] / scale, graph["lat"] / scale)
    node_missing = int(np.isnan(node_heights).sum())
    if node_missing:
        print(f"warning: {node_missing:,} junctions have no terrain under them", file=sys.stderr)
    # Decimetres above the model's datum, clamped into the section's range. Below sea
    # level is a handful of metres in this region, and a clamp at zero is closer to
    # the truth than wrapping a negative into 65 000 would be.
    node_metres = np.nan_to_num(node_heights, nan=0.0)
    node_height = np.clip(np.round(node_metres * SCALE), 0, np.iinfo(np.uint16).max).astype(np.uint16)

    # And at every shape point, because a junction-only profile misses whatever the
    # road does between junctions -- on the benchmark routes that lost a third of the
    # climb, so the chart contradicted the total printed beside it.
    interior = np.concatenate([edge_shape(graph, edge)[1:-1] for edge in range(edge_count)]
                              + [np.empty((0, 2))])
    shape_heights = terrain.sample(interior[:, 0], interior[:, 1]) if len(interior) else np.empty(0)
    raw = np.round(np.nan_to_num(shape_heights, nan=0.0) * SCALE).astype(np.int64)
    # Stored as zigzag deltas from the point before, the way the shape coordinates
    # themselves are. Adjacent points are about 20 m apart and the ground between
    # them rarely moves a metre, so almost every delta is a byte or two of near-zero
    # that gzip eats: absolute heights cost 1.9 MB, these cost a fraction of it.
    starts = graph["shape_start"][:-1]
    previous = np.empty(len(raw), dtype=np.int64)
    if len(raw):
        previous[1:] = raw[:-1]
        previous[0] = 0
        # The first point of each edge is relative to that edge's own start node.
        first = starts[graph["shape_count"] > 0]
        previous[first] = node_height[graph["edge_a"][graph["shape_count"] > 0]].astype(np.int64)
    # One byte each. 78 of 899,848 deltas exceed what that holds -- bridges and
    # tunnels, where the terrain model steps -- and they are clamped. The chain
    # restarts from each edge's own start node, so a clamped point cannot drift
    # further than the end of its edge before the next junction snaps it back.
    delta = np.clip(raw - previous, -127, 127)
    shape_height = ((delta << 1) ^ (delta >> 63)).astype(np.uint8)

    ascent = np.zeros(edge_count, dtype=np.uint16)
    descent = np.zeros(edge_count, dtype=np.uint16)
    limit = np.iinfo(np.uint16).max
    for edge in range(edge_count):
        gain, loss = gain_and_loss(heights[offsets[edge]:offsets[edge + 1]], args.threshold)
        ascent[edge] = min(round(gain * SCALE), limit)
        descent[edge] = min(round(loss * SCALE), limit)

    blob = bytearray()
    layout = {}
    for name, array in (("edge_ascent", ascent), ("edge_descent", descent),
                        ("node_height", node_height), ("shape_height", shape_height)):
        layout[name] = {"offset": len(blob), "count": len(array),
                        "type": "uint8" if array.dtype == np.uint8 else "uint16"}
        blob.extend(array.tobytes())

    args.out.mkdir(parents=True, exist_ok=True)
    # `mtime=0` as the other two builders do: without it the gzip header carries the
    # build time, so an unchanged rebuild still writes a different file and shows up
    # as a diff in a directory that is committed.
    (args.out / "climb.bin.gz").write_bytes(gzip.compress(bytes(blob), compresslevel=9, mtime=0))
    (args.out / "climb.json").write_text(json.dumps({
        "version": 3,
        "edge_count": edge_count,
        "node_count": len(node_height),
        "shape_point_count": len(shape_height),
        "scale": SCALE,
        "source": args.source,
        "sampled_m": args.spacing,
        "threshold_m": args.threshold,
        "bytes": len(blob),
        "layout": layout,
    }, indent=1) + "\n")

    total_up = ascent.astype(np.int64).sum() / SCALE
    print(f"wrote {args.out/'climb.bin.gz'}"
          f" ({(args.out/'climb.bin.gz').stat().st_size/1e6:.1f} MB gzipped)", file=sys.stderr)
    print(f"{total_up/1000:,.0f} km of climb over the network;"
          f" {(ascent > 0).sum()/edge_count:.0%} of edges rise at all", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
