"""Fetch Maanmittauslaitos korkeusmalli 10 m tiles covering the built graph.

    MML_API_KEY=... python tools/fetch_dem.py <dem-dir> [graph-dir]

Works out which 1:25 000 map sheets the graph's bounds touch, asks MML's file
service for them, and writes the GeoTIFFs into `dem-dir` for `build_climb.py`.
The key is read from `MML_API_KEY`, or from `tools/.mml-key` if that file exists --
which is gitignored, so it never reaches the repository. A free key comes from
https://www.maanmittauslaitos.fi/rajapinnat/api-avaimen-ohje.

Two things here are not in MML's own documentation, and both cost an afternoon:

* Its OpenAPI describes the execute body as `*/*` of type `string`, which describes
  nothing. What the service actually wants is the older OGC draft shape, with `id`,
  `mode` and `response` beside `inputs`. Every other form returns a bare `HTTP 400`
  with no hint as to why.

* The 1:25 000 sheet names run `1 = SW, 2 = NW, 3 = SE, 4 = NE` from an easting
  origin of -76 000 -- not the bottom-row-first order the obvious reading suggests.
  Getting it wrong is quiet rather than loud: the wrong sheets download happily, at
  the right resolution and plausible sizes, and read 0.3 m everywhere because they
  are open sea a hundred kilometres west. Every tile is therefore checked against the
  sheet it was asked for before it is kept.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import zipfile
from pathlib import Path

import numpy as np
import rasterio
import requests
from pyproj import Transformer

# Where the key is kept when it is not in the environment. Gitignored, so the
# convenience of not retyping it does not become a credential in a public repo.
KEY_FILE = Path(__file__).parent / ".mml-key"

BASE = "https://avoin-paikkatieto.maanmittauslaitos.fi/tiedostopalvelu/ogcproc/v1"
PROCESS = "korkeusmalli_10m_karttalehti"
SHEET_LIMIT = 100

# The TM35 sheet division. Row K starts at N = 6 570 000 and column 2 at E = -76 000;
# each 1:200 000 sheet is 192 x 96 km and quarters three times down to 24 x 12 km.
LETTERS = "KLMNPQRSTUVWX"
E0, N0, W, H = -76000.0, 6570000.0, 192000.0, 96000.0
# A sheet has to overlap the bounds by more than this to be worth a download.
EDGE_SLACK_M = 500.0


def sheet_at(x: float, y: float, level: int = 3) -> tuple[str, tuple[float, float, float, float]]:
    """The 1:25 000 sheet covering a TM35FIN point, and the box it covers."""
    column = int((x - E0) // W)
    row = int((y - N0) // H)
    if not 0 <= row < len(LETTERS):
        raise SystemExit(f"{x:.0f},{y:.0f} is outside the Finnish sheet grid")
    name = f"{LETTERS[row]}{column + 2}"
    x0, y0, width, height = E0 + column * W, N0 + row * H, W, H
    for _ in range(level):
        width, height = width / 2, height / 2
        right = 1 if x >= x0 + width else 0
        top = 1 if y >= y0 + height else 0
        # 1 SW, 2 NW, 3 SE, 4 NE -- columns before rows, which is the part that is
        # easy to get backwards.
        name += str(1 + 2 * right + top)
        x0 += right * width
        y0 += top * height
    return name, (x0, y0, x0 + width, y0 + height)


def sheets_for(bounds: tuple[float, float, float, float]) -> dict[str, tuple]:
    """Every sheet touching a WGS84 bounding box."""
    west, south, east, north = bounds
    to_tm35 = Transformer.from_crs("EPSG:4326", "EPSG:3067", always_xy=True)
    # The whole boundary, not just the corners: the projection is not axis-aligned,
    # so a corner-only box misses a strip along the middle of each edge.
    edge = np.linspace(0, 1, 200)
    lons = np.concatenate([west + (east - west) * edge, west + (east - west) * edge,
                           np.full(200, west), np.full(200, east)])
    lats = np.concatenate([np.full(200, south), np.full(200, north),
                           south + (north - south) * edge, south + (north - south) * edge])
    xs, ys = to_tm35.transform(lons, lats)
    x0, x1 = xs.min() - EDGE_SLACK_M, xs.max() + EDGE_SLACK_M
    y0, y1 = ys.min() - EDGE_SLACK_M, ys.max() + EDGE_SLACK_M
    found: dict[str, tuple] = {}
    for x in np.arange(x0, x1 + 12000, 12000):
        for y in np.arange(y0, y1 + 6000, 6000):
            name, box = sheet_at(float(x), float(y))
            found[name] = box
    return found


def request_sheets(names: list[str], key: str) -> list[dict]:
    auth = (key, "")
    body = {
        "id": PROCESS,
        "inputs": {"mapSheetInput": names, "fileFormatInput": "TIFF"},
        # `mode` and `response` are what the service insists on; without them every
        # body is rejected as a bare HTTP 400.
        "mode": "async",
        "response": "document",
    }
    started = requests.post(f"{BASE}/processes/{PROCESS}/execution", json=body, auth=auth, timeout=120)
    if started.status_code == 401:
        raise SystemExit("MML rejected the API key")
    started.raise_for_status()
    job = started.json()["jobID"]
    print(f"job {job}: {len(names)} sheets", file=sys.stderr)
    while True:
        status = requests.get(f"{BASE}/jobs/{job}", auth=auth, timeout=60).json()
        state = status.get("status")
        print(f"  {state} {status.get('progress', '')}%", file=sys.stderr)
        if state in ("successful", "failed", "dismissed"):
            break
        time.sleep(5)
    if state != "successful":
        raise SystemExit(f"job {state}: {status.get('statusMessage')}")
    results = requests.get(f"{BASE}/jobs/{job}/results", auth=auth, timeout=60).json()
    return results if isinstance(results, list) else results.get("results", results.get("value", []))


def save(item: dict, out: Path, key: str) -> list[Path]:
    url = item.get("path") or item.get("href")
    if not url:
        # A sheet with nothing in it: open sea, or outside the flown area.
        return []
    got = requests.get(url, auth=(key, ""), timeout=900)
    got.raise_for_status()
    name = url.split("/")[-1].split("?")[0]
    if not name.endswith(".zip"):
        (out / name).write_bytes(got.content)
        return [out / name]
    written = []
    with zipfile.ZipFile(io.BytesIO(got.content)) as archive:
        for member in archive.namelist():
            if member.lower().endswith((".tif", ".tiff")):
                target = out / Path(member).name
                target.write_bytes(archive.read(member))
                written.append(target)
    return written


def check(path: Path, expected: dict[str, tuple]) -> bool:
    """Is this raster really the sheet its name claims?

    The one check that catches a wrong sheet grid, which is otherwise silent.
    """
    name = path.stem
    with rasterio.open(path) as source:
        left, bottom, right, top = source.bounds
    got, _ = sheet_at((left + right) / 2, (bottom + top) / 2)
    if got != name:
        print(f"  {name}: raster is really {got} -- the sheet grid is wrong", file=sys.stderr)
        return False
    if name in expected:
        want = expected[name]
        if max(abs(left - want[0]), abs(bottom - want[1])) > 1.0:
            print(f"  {name}: bounds {left:.0f},{bottom:.0f} do not match {want[0]:.0f},{want[1]:.0f}",
                  file=sys.stderr)
            return False
    return True


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", type=Path, help="where to write the GeoTIFFs")
    parser.add_argument("graph", type=Path, nargs="?", default=Path("public/graph"),
                        help="the built graph, for its bounds")
    args = parser.parse_args(argv)

    key = os.environ.get("MML_API_KEY") or (
        KEY_FILE.read_text().strip() if KEY_FILE.exists() else ""
    )
    if not key:
        raise SystemExit(
            f"no API key: set MML_API_KEY, or put one in {KEY_FILE}.\n"
            "A free key comes from maanmittauslaitos.fi/rajapinnat/api-avaimen-ohje"
        )
    manifest = json.loads((args.graph / "graph.json").read_text())
    wanted = sheets_for(tuple(manifest["bounds"]))
    args.out.mkdir(parents=True, exist_ok=True)
    have = {path.stem for path in args.out.glob("*.tif")}
    missing = sorted(set(wanted) - have)
    print(f"{len(wanted)} sheets cover the graph; {len(have)} already here", file=sys.stderr)
    if not missing:
        print("nothing to fetch", file=sys.stderr)
        return 0
    if len(missing) > SHEET_LIMIT:
        raise SystemExit(f"{len(missing)} sheets exceeds MML's limit of {SHEET_LIMIT} a request")

    written: list[Path] = []
    for item in request_sheets(missing, key):
        for path in save(item, args.out, key):
            written.append(path)
            print(f"  {path.name} {path.stat().st_size / 1e6:.1f} MB", file=sys.stderr)

    bad = [path for path in written if not check(path, wanted)]
    if bad:
        for path in bad:
            path.unlink()
        raise SystemExit(f"{len(bad)} tiles did not match the sheet asked for; removed")
    print(f"{len(written)} rasters in {args.out}, all matching their sheet", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
