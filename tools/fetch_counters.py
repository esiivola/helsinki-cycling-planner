"""Helsinki's bicycle counts, as WGS84 points for `scripts/bench_counters.mjs`.

    python tools/fetch_counters.py [out.json]

427 counting sites against 425 000 edges is far too sparse to route on -- a
preference built from it would touch almost nothing -- but it is the right size to
*check* the model against: a router that puts riders where riders are should rank the
busy sites above the quiet ones.

The sites are published as short LineStrings across the way, in EPSG:3879, so each is
reduced to its midpoint and reprojected here rather than in the benchmark.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import requests
from pyproj import Transformer

WFS = ("https://kartta.hel.fi/ws/geoserver/avoindata/wfs?service=WFS&version=2.0.0"
       "&request=GetFeature&typeNames=avoindata:polkupyoralaskennat"
       "&outputFormat=application/json")


def main(argv: list[str]) -> int:
    out = Path(argv[0]) if argv else Path("data/counters.json")
    response = requests.get(WFS, timeout=180)
    response.raise_for_status()
    to_wgs84 = Transformer.from_crs("EPSG:3879", "EPSG:4326", always_xy=True)
    readings = []
    for feature in response.json()["features"]:
        geometry, tags = feature.get("geometry"), feature["properties"]
        if not geometry:
            continue
        try:
            daily = float(tags.get("vrk"))
        except (TypeError, ValueError):
            continue
        if daily <= 0:
            continue
        points = geometry["coordinates"]
        x = sum(point[0] for point in points) / len(points)
        y = sum(point[1] for point in points) / len(points)
        lon, lat = to_wgs84.transform(x, y)
        readings.append({"place": tags.get("paikka"), "year": tags.get("vuosi"),
                         "daily": daily, "lon": round(lon, 6), "lat": round(lat, 6)})
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(readings))
    places = len({reading["place"] for reading in readings})
    print(f"{len(readings):,} readings at {places} sites -> {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
