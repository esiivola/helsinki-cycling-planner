"""Fetch the cities' traffic-signal registers into one file the graph build reads.

OSM is the only source for everything else here, and for signals it is not enough:
audited against Helsinki's own register, 8% of the city's signalised junctions had no
light a rider would meet -- about half missing from OSM altogether, the rest tagged
only on the carriageway. The cities publish the junctions themselves, and the router
is better for using them.

Each city publishes locations only -- no cycle times, no phases -- so this fixes
*which* junctions are signalised, not what a wait costs.

    python tools/fetch_signals.py [output.geojson]

Sources, all CC BY 4.0:
  Helsinki  https://hri.fi/data/dataset/helsingin-liikenne-ja-varoitusvaloliittymat
  Espoo     https://hri.fi/data/dataset/espoon-liikennevaloliittymat
  Vantaa    https://hri.fi/data/dataset/vantaan-liikennevaloliittymat
"""
from __future__ import annotations

import json
import sys
import urllib.request
import xml.etree.ElementTree as ElementTree
from pathlib import Path

TIMEOUT_S = 180

HELSINKI = (
    "https://kartta.hel.fi/ws/geoserver/avoindata/wfs?service=WFS&version=2.0.0"
    "&request=GetFeature&typeName=avoindata:Liikennevalot_piste"
    "&outputFormat=application/json&srsName=EPSG:4326"
)
ESPOO = (
    "https://kartat.espoo.fi/teklaogcweb/wfs.ashx?service=WFS&version=1.1.0"
    "&request=GetFeature&typeName=GIS:Liikennevaloristeykset&srsName=EPSG:4326"
)
VANTAA = (
    "https://matti.vantaa.fi/server2/rest/services/Hosted/Liikennevaloliittym%C3%A4t"
    "/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson"
)


def _read(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=TIMEOUT_S) as response:
        return response.read()


def _from_geojson(raw: bytes, city: str, name_keys: tuple[str, ...], live_key: str | None) -> list[dict]:
    found = []
    for feature in json.loads(raw).get("features", []):
        geometry = feature.get("geometry")
        properties = feature.get("properties") or {}
        if not geometry or geometry.get("type") != "Point":
            continue
        # Helsinki marks junctions still being built; they are not stops yet.
        if live_key and (properties.get(live_key) or "") not in ("Liikennevalot", ""):
            continue
        name = next((properties.get(key) for key in name_keys if properties.get(key)), None)
        lon, lat = geometry["coordinates"][:2]
        found.append({"lon": round(float(lon), 7), "lat": round(float(lat), 7), "city": city, "name": name})
    return found


def _from_gml(raw: bytes, city: str) -> list[dict]:
    """Espoo answers WFS 1.1 in GML. It declares EPSG:4326, whose axis order is
    latitude first, and then writes `lon lat` anyway -- so the order is checked
    against the region rather than trusted."""
    tree = ElementTree.fromstring(raw)
    gml = "{http://www.opengis.net/gml}"
    found = []
    for position in tree.iter(f"{gml}pos"):
        parts = (position.text or "").split()
        if len(parts) < 2:
            continue
        first, second = float(parts[0]), float(parts[1])
        lon, lat = (first, second) if first < second else (second, first)
        found.append({"lon": round(lon, 7), "lat": round(lat, 7), "city": city, "name": None})
    return found


def fetch() -> list[dict]:
    signals = _from_geojson(_read(HELSINKI), "Helsinki", ("risteys",), "tyyppi")
    signals += _from_gml(_read(ESPOO), "Espoo")
    signals += _from_geojson(_read(VANTAA), "Vantaa", ("nimi",), None)
    # The same junction can sit in two registers on a city boundary.
    unique: dict[tuple[float, float], dict] = {}
    for signal in signals:
        unique.setdefault((round(signal["lon"], 4), round(signal["lat"], 4)), signal)
    return sorted(unique.values(), key=lambda s: (s["city"], s["lon"], s["lat"]))


# Helsinki, Espoo, Vantaa and a margin; a point outside it means a service changed
# its coordinates under us, which is worth failing over rather than shipping.
REGION = (24.3, 59.9, 25.5, 60.5)


def main(argv: list[str]) -> int:
    out = Path(argv[0]) if argv else Path(__file__).resolve().parents[1] / "tools" / "signals.json"
    signals = fetch()
    west, south, east, north = REGION
    stray = [s for s in signals if not (west <= s["lon"] <= east and south <= s["lat"] <= north)]
    assert not stray, f"{len(stray)} signals outside the region, e.g. {stray[0]}"
    out.write_text(json.dumps({
        "attribution": "Helsinki, Espoo ja Vantaa, CC BY 4.0",
        "note": "signalised junctions; locations only, the registers carry no timing",
        "signals": signals,
    }, ensure_ascii=False, indent=1))
    counts: dict[str, int] = {}
    for signal in signals:
        counts[signal["city"]] = counts.get(signal["city"], 0) + 1
    print(f"{len(signals):,} signalised junctions -> {out}")
    print("  " + ", ".join(f"{city} {count:,}" for city, count in sorted(counts.items())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
