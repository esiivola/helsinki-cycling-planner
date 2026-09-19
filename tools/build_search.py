"""Build the offline address index the page searches.

The obvious way to add search is to call a geocoder. Every option costs something
this service cannot pay:

* Digitransit (what HSL Reittiopas itself uses) requires a subscription key, and a
  static page can only ship that key to the client, where anyone can lift it.
* Nominatim's usage policy caps you at 1 request/second and forbids autocomplete-
  style querying outright -- search-as-you-type is exactly what it rules out.
* Photon's public instance offers no availability guarantee and throttles or bans
  heavy use.
* DVV's national address extract, the authoritative free bulk source, stopped being
  distributed as open data in March 2025.

So the index is built here instead, from the same OSM extract the routing graph
comes from, and shipped with it: 122 k addresses in under a megabyte. No key, no
rate limit, no third party, and it keeps working when the page is offline -- which
matters for a tool people open on a phone mid-ride.

The regional address list published by Helsinki, Espoo, Vantaa and Kauniainen
(hri.fi "Pääkaupunkiseudun osoiteluettelo", CC BY 4.0) is the authoritative
alternative and would be a worthwhile upgrade; it needs a WFS fetch and its own
licence notice, which OSM -- already attributed for the routing graph -- does not.

    python tools/build_search.py <extract.osm.pbf> [output_dir]
"""
from __future__ import annotations

import gzip
import json
import sys
import time
from pathlib import Path

import math

import numpy as np
import osmium

from build_graph import COORDINATE_SCALE, CYCLING_HIGHWAYS, HSY_BOUNDS, RIDEABLE_SHARED, SHARED_HIGHWAYS

# Places worth offering as a destination in their own right, most prominent first:
# the districts a rider names ("Kallio", "Tapiola"), then the things they ride *to*.
# The order is the ranking: two names that match equally are offered in this order,
# so "Kamppi" is the district and the shopping centre before it is a bus stop.
PLACE_KINDS = (
    "city", "town", "suburb", "quarter", "neighbourhood", "village",
    "airport", "mall", "attraction", "venue", "sports", "park", "nature",
    # Below the landmarks on purpose: a stop is named after the place it serves, so
    # "Korkeasaari" typed in full means the island, not the ferry berth 9 km away
    # that borrowed its name.
    "station", "school", "hospital", "hotel", "office", "shop", "service",
)
DISTRICT_KINDS = frozenset(PLACE_KINDS[:6])

# A destination is named by more than its `name`: Oodi is tagged
# `Helsingin keskustakirjasto Oodi` with `short_name=Oodi`, and Swedish names are
# what half the region's signage says. Every one of them is indexed at the point.
NAME_KEYS = ("name", "short_name", "alt_name", "loc_name", "official_name", "name:sv", "name:en")

# What a bare name most likely means, in the order the tags are tested. A feature is
# offered only if it lands in one of these: an unnamed bench or a named driveway is
# not a destination, and indexing everything named would bury the places that are.
_POI_RULES: tuple[tuple[str, str, frozenset[str] | None], ...] = (
    ("airport", "aeroway", frozenset({"aerodrome", "terminal"})),
    ("station", "railway", frozenset({"station", "halt"})),
    ("station", "public_transport", frozenset({"station"})),
    ("mall", "shop", frozenset({"mall", "department_store"})),
    ("attraction", "tourism", frozenset({"museum", "gallery", "attraction", "zoo", "theme_park", "viewpoint"})),
    ("attraction", "historic", None),
    ("venue", "amenity", frozenset({
        "theatre", "cinema", "library", "arts_centre", "community_centre",
        "place_of_worship", "marketplace", "townhall", "exhibition_centre", "conference_centre",
    })),
    ("sports", "leisure", frozenset({"sports_centre", "stadium", "swimming_pool", "ice_rink", "fitness_centre", "sports_hall", "track"})),
    ("park", "leisure", frozenset({"park", "garden", "nature_reserve", "playground", "pitch", "marina"})),
    ("school", "amenity", frozenset({"university", "college", "school"})),
    ("hospital", "amenity", frozenset({"hospital", "clinic", "doctors"})),
    ("nature", "natural", frozenset({"beach", "island", "peak", "spring"})),
    # An island is tagged `place`, not `natural`: Korkeasaari and Seurasaari are
    # places people ride to, and without this the only match left is a ferry stop
    # somewhere else that borrowed the name.
    ("nature", "place", frozenset({"island", "islet", "peninsula", "archipelago"})),
    ("hotel", "tourism", frozenset({"hotel", "hostel", "guest_house", "camp_site"})),
    ("shop", "shop", None),
    ("service", "amenity", None),
    ("office", "office", None),
)


def poi_kind(tags) -> str | None:
    """Which kind of destination this feature is, or None if it is not one."""
    for kind, key, values in _POI_RULES:
        value = tags.get(key)
        if value and (values is None or value in values):
            return kind
    return None


def notability(tags) -> int:
    """How much OSM says this is *the* place of its name: 2 the one, 1 known, 0 not.

    Two places really do share a name -- Korkeasaari is the Helsinki island with the
    zoo on it and a bare skerry off Espoo, and both carry a `wikidata` tag, so mere
    notability cannot separate them. Wikipedia's own title does: the Helsinki island
    is `fi:Korkeasaari` and the skerry is `fi:Korkeasaari (Espoo)`, a parenthetical
    that is literally the encyclopaedia saying which one needs disambiguating. Used
    for nothing but ordering namesakes.
    """
    article = tags.get("wikipedia") or ""
    title = article.split(":", 1)[1] if ":" in article else article
    if title and any(title == name for name in names_of(tags)):
        return 2
    return 1 if article or tags.get("wikidata") else 0


def names_of(tags) -> list[str]:
    """Every name a rider might type for this feature, the primary one first."""
    found: list[str] = []
    for key in NAME_KEYS:
        value = tags.get(key)
        # `alt_name` holds several names separated by semicolons often enough to split.
        for name in (value or "").split(";"):
            name = name.strip()
            if name and name not in found:
                found.append(name)
    return found

_ENCODING = {
    "street_blob": "utf-8 street names, newline separated, sorted",
    "street_lon": "int32 degrees * 1e7, a representative point for the street",
    "street_lat": "int32 degrees * 1e7, a representative point for the street",
    "number_blob": "utf-8 house numbers, newline separated, one per address",
    "entry_street": "uint16 zigzag delta of the street index; entries are sorted by street",
    "entry_lon": "uint32 zigzag delta of degrees * 1e7 against the previous entry",
    "entry_lat": "uint32 zigzag delta of degrees * 1e7 against the previous entry",
    "place_blob": "utf-8 place names, newline separated",
    "place_kind": "uint8 index into the manifest's place_kinds",
    "place_lon": "int32 degrees * 1e7",
    "place_lat": "int32 degrees * 1e7",
    "place_street": "uint16 index into street_blob of the nearest street, or 65535 for none",
}


class _Handler(osmium.SimpleHandler):
    """Collect one point per distinct (street, number) inside the bounds.

    Most Helsinki addresses sit on the building polygon rather than a node -- 41 k
    addressed nodes against 249 k addressed areas -- so areas carry the bulk of it
    and a node-only pass would miss two thirds of the city.
    """

    def __init__(self, bounds: tuple[float, float, float, float]) -> None:
        super().__init__()
        self.bounds = bounds
        self.addresses: dict[tuple[str, str], tuple[float, float]] = {}
        self.places: dict[str, tuple[float, float, str]] = {}
        # (name, kind) -> points, each with how notable OSM considers it. A chain
        # has the same name in thirty places, so the name alone cannot be the key;
        # the nearest-street context tells them apart.
        self.points: dict[tuple[str, str], list[tuple[float, float, int]]] = {}
        # A fifth of the named roads a bicycle may use carry no addressed building --
        # through-roads, paths, park routes. Kauklahdenväylä is one. Indexing the way
        # itself keeps them findable; the point is the middle of the way.
        self.roads: dict[str, tuple[float, float]] = {}

    def _inside(self, lon: float, lat: float) -> bool:
        west, south, east, north = self.bounds
        return west <= lon <= east and south <= lat <= north

    def _address(self, tags, lon: float, lat: float) -> None:
        street = tags.get("addr:street")
        if not street or not self._inside(lon, lat):
            return
        # First one wins: a block with several entrances is one address to search for.
        self.addresses.setdefault((street, tags.get("addr:housenumber") or ""), (lon, lat))

    def _poi(self, tags, lon: float, lat: float) -> None:
        if not self._inside(lon, lat):
            return
        kind = poi_kind(tags)
        if not kind:
            return
        notable = notability(tags)
        for name in names_of(tags):
            points = self.points.setdefault((name, kind), [])
            # One name in one spot is one place however many ways OSM maps it: a
            # museum tagged on both its building and a node is not two destinations.
            for index, (x, y, was_notable) in enumerate(points):
                if abs(lon - x) < 1e-4 and abs(lat - y) < 1e-4:
                    points[index] = (x, y, max(was_notable, notable))
                    break
            else:
                points.append((lon, lat, notable))

    def node(self, node) -> None:
        self._address(node.tags, node.location.lon, node.location.lat)
        kind = node.tags.get("place")
        name = node.tags.get("name")
        if kind in DISTRICT_KINDS and name and self._inside(node.location.lon, node.location.lat):
            self.places.setdefault(name, (node.location.lon, node.location.lat, kind))
        self._poi(node.tags, node.location.lon, node.location.lat)

    def way(self, way) -> None:
        name = way.tags.get("name")
        highway = way.tags.get("highway")
        if not name or not highway:
            return
        bicycle = way.tags.get("bicycle")
        rideable = highway in CYCLING_HIGHWAYS and bicycle != "no"
        shared = highway in SHARED_HIGHWAYS and bicycle in RIDEABLE_SHARED
        if not (rideable or shared):
            return
        try:
            node = way.nodes[len(way.nodes) // 2]
            lon, lat = node.lon, node.lat
        except (IndexError, osmium.InvalidLocationError):
            return
        if self._inside(lon, lat):
            self.roads.setdefault(name, (lon, lat))

    def area(self, area) -> None:
        if not (area.tags.get("addr:street") or names_of(area.tags)):
            return
        try:
            ring = next(area.outer_rings())
        except (StopIteration, RuntimeError):
            return
        points = [(node.lon, node.lat) for node in ring]
        if not points:
            return
        lon = sum(point[0] for point in points) / len(points)
        lat = sum(point[1] for point in points) / len(points)
        # A park or a campus is an area, not a point; its centre is what you ride to.
        self._address(area.tags, lon, lat)
        self._poi(area.tags, lon, lat)


# Far enough to name the street a place stands on, close enough that the name still
# describes it: beyond this a park's centre picks up whatever road passes nearby.
CONTEXT_RADIUS_M = 250.0
# How many places may share one name. A supermarket chain would otherwise fill the
# list on its own, and nobody scrolls past the third identical row.
PER_NAME_LIMIT = 5
NO_STREET = 0xFFFF


def _nearest_streets(
    places: list[tuple[float, float]],
    addresses: dict[tuple[str, str], tuple[float, float]],
    street_index: dict[str, int],
) -> list[int]:
    """The street each place stands on, for the line under its name.

    Two places called `Alepa` are told apart by the street, which is what the rider
    recognises. Addresses are bucketed into a coarse grid first: 120 k of them
    against 40 k places is four billion comparisons done directly.
    """
    cell = 0.01  # ~1.1 km of latitude
    grid: dict[tuple[int, int], list[tuple[float, float, int]]] = {}
    for (street, _), (lon, lat) in addresses.items():
        key = (int(lon // cell), int(lat // cell))
        grid.setdefault(key, []).append((lon, lat, street_index[street]))

    found = []
    for lon, lat in places:
        east = math.cos(math.radians(lat)) * 111_320
        best, best_metres = NO_STREET, CONTEXT_RADIUS_M
        home = (int(lon // cell), int(lat // cell))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for other_lon, other_lat, street in grid.get((home[0] + dx, home[1] + dy), ()):
                    metres = math.hypot((other_lon - lon) * east, (other_lat - lat) * 110_540)
                    if metres < best_metres:
                        best, best_metres = street, metres
        found.append(best)
    return found


def _zigzag(values: np.ndarray) -> np.ndarray:
    return ((values << 1) ^ (values >> 63)).astype(np.uint64)


def _sections(handler: _Handler) -> tuple[list[tuple[str, np.ndarray]], dict[str, int]]:
    addressed = {street for street, _ in handler.addresses}
    # One list for everything a rider can name: streets with doors on them, and roads
    # that have only a name. Both get a representative point, so a match can be
    # offered even when no house number fits -- typing "Kauniaistentie 5" where no
    # number 5 exists should still land you on Kauniaistentie.
    streets = sorted(addressed | set(handler.roads))
    street_index = {street: index for index, street in enumerate(streets)}
    # Sorting by street then number makes the street column almost entirely zeroes
    # and keeps each street's addresses spatially adjacent, so the coordinate deltas
    # stay small: the whole index gzips to well under a megabyte.
    rows = sorted(handler.addresses.items(), key=lambda row: (street_index[row[0][0]], row[0][1]))

    street_ids = np.array([street_index[street] for (street, _), _ in rows], dtype=np.int64)
    lon = np.array([round(point[0] * COORDINATE_SCALE) for _, point in rows], dtype=np.int64)
    lat = np.array([round(point[1] * COORDINATE_SCALE) for _, point in rows], dtype=np.int64)

    def delta(values: np.ndarray, dtype) -> np.ndarray:
        packed = _zigzag(np.diff(values, prepend=0))
        assert packed.max(initial=0) <= np.iinfo(dtype).max, f"a delta no longer fits {dtype.__name__}"
        return packed.astype(dtype)

    representative = {}
    for (street, _), point in rows:
        representative.setdefault(street, point)
    for street, point in handler.roads.items():
        representative.setdefault(street, point)

    # Districts and destinations share one table: both answer "where do you mean?",
    # and the kind is what tells them apart in the list.
    # (name, kind, lon, lat, notable); a district is notable by being a district.
    entries: list[tuple[str, str, float, float, int]] = [
        (name, kind, place_lon, place_lat, 2) for name, (place_lon, place_lat, kind) in handler.places.items()
    ]
    for (name, kind), points in handler.points.items():
        if name in handler.places:
            continue  # a district by that name is already the better answer
        # A chain with fifty branches is not fifty suggestions. Keep a handful --
        # spread across the region rather than the first few by longitude, which
        # offered five branches all in the same western suburb.
        ordered = sorted(points)
        stride = max(1, len(ordered) // PER_NAME_LIMIT)
        kept = sorted(ordered, key=lambda point: -point[2])[:PER_NAME_LIMIT] + ordered[::stride]
        seen_points: set[tuple[float, float]] = set()
        for place_lon, place_lat, notable in kept[:PER_NAME_LIMIT]:
            if (place_lon, place_lat) in seen_points:
                continue
            seen_points.add((place_lon, place_lat))
            entries.append((name, kind, place_lon, place_lat, notable))
    # Kind first, then whichever namesake OSM says people have heard of, so the two
    # Korkeasaaris come out in the order a rider means them.
    entries.sort(key=lambda entry: (PLACE_KINDS.index(entry[1]), -entry[4], entry[0]))
    assert len(streets) <= NO_STREET, "the street index no longer fits the place_street field"
    place_streets = _nearest_streets(
        [(entry[2], entry[3]) for entry in entries], handler.addresses, street_index,
    )
    places = [entry[0] for entry in entries]
    as_bytes = lambda text: np.frombuffer(text.encode("utf-8"), dtype=np.uint8)
    coordinate = lambda values: np.array([round(value * COORDINATE_SCALE) for value in values], dtype=np.int32)
    return [
        ("street_blob", as_bytes("\n".join(streets))),
        ("street_lon", coordinate([representative[street][0] for street in streets])),
        ("street_lat", coordinate([representative[street][1] for street in streets])),
        ("number_blob", as_bytes("\n".join(number for (_, number), _ in rows))),
        ("entry_street", delta(street_ids, np.uint16)),
        ("entry_lon", delta(lon, np.uint32)),
        ("entry_lat", delta(lat, np.uint32)),
        ("place_blob", as_bytes("\n".join(places))),
        ("place_kind", np.array([PLACE_KINDS.index(entry[1]) for entry in entries], dtype=np.uint8)),
        ("place_lon", coordinate([entry[2] for entry in entries])),
        ("place_lat", coordinate([entry[3] for entry in entries])),
        ("place_street", np.array(place_streets, dtype=np.uint16)),
    ], {
        "street_count": len(streets),
        "addressed_street_count": len(addressed),
        "address_count": len(rows),
        "place_count": len(places),
        "district_count": len(handler.places),
        "place_kind_counts": {
            kind: sum(1 for entry in entries if entry[1] == kind)
            for kind in PLACE_KINDS if any(entry[1] == kind for entry in entries)
        },
    }


def write_search_index(handler: _Handler, directory: Path) -> dict[str, object]:
    directory.mkdir(parents=True, exist_ok=True)
    sections, counts = _sections(handler)
    blob = bytearray()
    layout: dict[str, object] = {}
    for name, array in sections:
        blob.extend(b"\0" * (-len(blob) % 4))  # typed-array views need their own alignment
        layout[name] = {
            "offset": len(blob), "count": int(array.size),
            "type": array.dtype.name, "encoding": _ENCODING[name],
        }
        blob.extend(array.tobytes())
    (directory / "search.bin.gz").write_bytes(gzip.compress(bytes(blob), compresslevel=9, mtime=0))

    manifest = {
        # 2 added destinations -- museums, stations, parks, shops -- alongside the
        # districts, each with the street it stands on.
        "version": 2,
        "coordinate_scale": COORDINATE_SCALE,
        "place_kinds": list(PLACE_KINDS),
        **counts,
        "bytes": len(blob),
        "layout": layout,
        "attribution": "© OpenStreetMap contributors",
    }
    (directory / "search.json").write_text(json.dumps(manifest, indent=2, sort_keys=True))
    return manifest


def build_search_index(pbf: Path, bounds=HSY_BOUNDS) -> _Handler:
    handler = _Handler(bounds)
    handler.apply_file(str(pbf), locations=True)
    return handler


def main(argv: list[str]) -> int:
    arguments = [value for value in argv if not value.startswith("--")]
    if not arguments:
        print(__doc__)
        return 2
    directory = Path(arguments[1]) if len(arguments) > 1 else Path(__file__).resolve().parents[1] / "public" / "graph"
    started = time.time()
    bounds = None if "--full" in argv else HSY_BOUNDS
    manifest = write_search_index(build_search_index(Path(arguments[0]), bounds), directory)
    size = (directory / "search.bin.gz").stat().st_size
    print(
        f"{manifest['address_count']:,} addresses on {manifest['addressed_street_count']:,} streets "
        f"(+{manifest['street_count'] - manifest['addressed_street_count']:,} named roads without one), "
        f"{manifest['district_count']:,} districts and "
        f"{manifest['place_count'] - manifest['district_count']:,} destinations\n"
        f"{manifest['place_kind_counts']}\n"
        f"{manifest['bytes'] / 1e6:.1f} MB raw -> {size / 1e6:.2f} MB gzipped "
        f"in {time.time() - started:.0f}s -> {directory}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
