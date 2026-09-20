"""Build the browser routing graph for the Helsinki bike router from an OSM extract.

This service is deliberately standalone. The cost model below was derived for the
Helsinki housing map's cycling layer (CROW / Fietsbalans thresholds, calibrated
against BRouter), but the code is not shared with it: a page that has to keep
working on its own should not break because a pipeline it does not ship was
refactored. The constants are duplicated on purpose, and `test_build_graph.py`
pins them so a silent drift shows up as a failing test rather than as routes that
quietly disagree with the map they came from.

What it does: parse the extract, keep the ways a bicycle may ride, then contract
every run of degree-2 nodes -- bends inside a way, where a rider never chooses --
into a single polyline edge. Roughly three quarters of OSM's nodes are those, so
the graph shrinks from ~2 M nodes to ~320 k while keeping the only topology the
cost model reads: junctions, and the bearings of the ways meeting at them.

    python tools/build_graph.py <extract.osm.pbf> [output_dir]
"""
from __future__ import annotations

import gzip
import json
import math
import sys
import time
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
import osmium
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components

# --- what a bicycle may ride -------------------------------------------------
CYCLING_HIGHWAYS = frozenset({
    "cycleway", "path", "residential", "living_street", "service",
    "tertiary", "secondary", "primary", "unclassified", "track",
})
# Pedestrian streets and footways are rideable only where cycling is explicitly
# allowed, and they are always shared with people on foot. Leaving them out
# inflates inner-city routes badly: Kamppi -> Central Station comes out at 1.70 km
# instead of the real ~1.1 km, because the direct connections through the
# pedestrianised core are invisible.
SHARED_HIGHWAYS = frozenset({"footway", "pedestrian"})
RIDEABLE_SHARED = frozenset({"yes", "designated"})
# `oneway=yes` binds a bicycle too, but only where nothing says otherwise: a Helsinki
# one-way street very often carries a contraflow cycle lane, tagged either as
# `oneway:bicycle=no` or, in the older style, as a `cycleway=opposite*` lane.
ONEWAY_FORWARD = frozenset({"yes", "true", "1"})
ONEWAY_BACKWARD = frozenset({"-1", "reverse"})
CONTRAFLOW_KEYS = ("cycleway", "cycleway:left", "cycleway:right", "cycleway:both")

# A carriageway whose cycle traffic belongs on a path beside it. `use_sidepath` is
# the explicit statement -- 19,745 ways in the region carry it, 1,774 km -- and a
# `cycleway=track|separate|sidepath` says the same thing from the road's side: the
# cycle facility is mapped as its own way, so the road itself is for cars.
SIDEPATH_CYCLEWAYS = frozenset({"track", "opposite_track", "separate", "sidepath"})
CYCLEWAY_KEYS = ("cycleway", "cycleway:right", "cycleway:left", "cycleway:both")

# Surfaces that force you to slow down. Anything untagged is assumed rideable:
# OSM surface coverage is partial, so only an *explicit* slow surface is penalised.
SLOW_SURFACES = frozenset({
    "gravel", "fine_gravel", "ground", "dirt", "earth", "grass", "sand", "mud",
    "wood", "pebblestone", "unpaved", "cobblestone", "sett", "compacted",
})

# How much of the traffic a rider is in. Both things a cyclist means by "riding with
# cars" -- how many there are and how fast -- follow the road's class closely enough
# in this region that it stands in for both, and unlike `maxspeed` or `lanes` it is
# tagged on essentially every way.
TRAFFIC_FREE, TRAFFIC_CALM, TRAFFIC_MODERATE, TRAFFIC_BUSY, TRAFFIC_ARTERIAL = 0, 1, 2, 3, 4
TRAFFIC_CLASS = {
    "cycleway": TRAFFIC_FREE, "path": TRAFFIC_FREE, "track": TRAFFIC_FREE,
    "footway": TRAFFIC_FREE, "pedestrian": TRAFFIC_FREE,
    "living_street": TRAFFIC_CALM, "service": TRAFFIC_CALM, "residential": TRAFFIC_CALM,
    "unclassified": TRAFFIC_MODERATE, "tertiary": TRAFFIC_MODERATE,
    "secondary": TRAFFIC_BUSY,
    "primary": TRAFFIC_ARTERIAL,
}

# The two halves of what used to be one "slow" flag. They are kept disjoint -- a
# gravel path shared with walkers counts as unpaved and not as shared -- so that the
# two lengths still add up to the metres ridden at the slow-surface factor, and the
# speed model is unchanged by the split.
SURFACE_UNPAVED, SURFACE_SHARED = 1, 2

# How bad the unpaved is. One factor for everything not asphalt charged a compacted
# park path the same as a mud track, which under-rates 1 300 km of the region's
# network and over-rates 1 731 km of it.
GRADE_PAVED, GRADE_FIRM, GRADE_ROUGH, GRADE_LOOSE = 0, 1, 2, 3
SURFACE_GRADE = {
    # Rolls nearly like asphalt once it is dry.
    "compacted": GRADE_FIRM, "fine_gravel": GRADE_FIRM, "gravel": GRADE_FIRM,
    "pebblestone": GRADE_FIRM,
    # Firm underneath, but it shakes the bicycle and the rider slows for it.
    "cobblestone": GRADE_ROUGH, "sett": GRADE_ROUGH, "wood": GRADE_ROUGH,
    # Loose, and slower again in the wet.
    "ground": GRADE_LOOSE, "dirt": GRADE_LOOSE, "earth": GRADE_LOOSE,
    "grass": GRADE_LOOSE, "sand": GRADE_LOOSE, "mud": GRADE_LOOSE,
    "unpaved": GRADE_LOOSE,
}

# What a rider meets at a barrier. Contraction dissolves every degree-2 node, so a
# bollard mid-block would vanish exactly as a traffic light would; they are counted
# per edge as well as kept at junctions, the same way signals are.
BARRIER_NONE, BARRIER_SLOW, BARRIER_STOP = 0, 1, 2
# Squeeze past, without stopping.
BARRIER_SLOW_KINDS = frozenset({"bollard", "block", "chicane", "planter", "jersey_barrier"})
# Stop, and usually put a foot down. A `cycle_barrier` is built to force exactly that.
BARRIER_STOP_KINDS = frozenset({
    "gate", "lift_gate", "swing_gate", "stile", "kissing_gate", "cycle_barrier",
    "turnstile", "full-height_turnstile",
})


def barrier_kind(tags) -> int:
    """How much a node in the way costs, 0 not at all.

    A barrier a bicycle may not pass at all is left as a cost rather than a closure:
    OSM's access tagging on barriers is thin, and a route that cannot connect is a
    worse answer than one that overstates a gate -- the same reason sidepath roads
    are priced rather than forbidden.
    """
    barrier = tags.get("barrier")
    if barrier in BARRIER_STOP_KINDS:
        return BARRIER_STOP
    if barrier in BARRIER_SLOW_KINDS:
        return BARRIER_SLOW
    # A raised kerb is a bump to bounce over or a foot down; lowered and flush are
    # what good design looks like and cost nothing.
    if tags.get("kerb") == "raised" or barrier == "kerb" and tags.get("kerb") not in ("lowered", "flush"):
        return BARRIER_SLOW
    return BARRIER_NONE

# --- cost model --------------------------------------------------------------
# A heading change at a junction below this is a bend in the road, not a decision.
TURN_DEGREES = 40.0
# What a signposted route is worth to the search, as a share of an ordinary way's
# cost. Not a claim that a baana is 10% faster in the legs: it is built to be ridden
# without stopping and is signposted end to end, so between two routes of nearly
# equal time it is the one a rider can follow. Routes are reported at their true
# cost, so this never shortens the minutes on screen.
NETWORK_BONUS = 0.9
# Direction changes closer together than this are one manoeuvre. Measured, not
# charged: the browser prices turns during the search, where a path-dependent
# debounce has no clean home. Shipped so the page can explain the difference.
TURN_MERGE_M = 25.0
# A random arrival at a Helsinki signal waits C(1-g)^2/2 -- 20-30 s at 90-120 s
# cycles with a ~0.3 cyclist green share -- plus 5-8 s losing and rebuilding speed.
SIGNAL_DELAY_S = 30.0
# A cyclist turning scrubs ~15 to ~8 km/h and rebuilds it (~5 s), and has to read the
# junction and check for people before committing. Raising this alone does not pay:
# `scripts/bench_turns.mjs` sweeps it, and past ~12 s the routes start dodging turns
# onto signalled roads and the total ride gets worse again. It stays at the housing
# map's value.
TURN_PENALTY_S = 10.0
# What does pay is charging the two directions differently. A left turn crosses the
# opposing traffic, and in Finland a cyclist usually takes it in two goes -- ride to
# the far corner, stop, cross -- while the Dutch GPS study found right-turning
# cyclists largely do not stop at all. At 1.5 the benchmark routes lose 6% of their
# manoeuvres and 9% of their left turns at the lowest measured cost of the settings
# swept, and a left plus a right still costs less than the 30 s light it dodges,
# which is the calibration `test_build_graph.py` pins.
TURN_LEFT_FACTOR = 1.5
# An unsignalised crossing costs a glance, not a brake. Measured at 5 s this was far
# too heavy: central routes carry ~11 tagged crossings per km, because OSM tags one
# per carriageway and marks every minor side street.
CROSSING_DELAY_S = 2.0
# Rough or pedestrian-shared surface costs speed rather than a fixed delay.
SLOW_SPEED_FACTOR = 0.65

# --- wire format -------------------------------------------------------------
# Junction coordinates need absolute values the router indexes at random, so they
# stay int32 at 1e-7 degrees (~11 mm). Shape points are only ever walked in order
# along their own edge, so they ship as deltas at 1e-6 degrees (~11 cm) -- ample
# for drawing, and small enough that every delta in the HSY network fits a uint16.
# What kind of way an edge is, for avoiding the carriageway where a path runs beside
# it and for saying afterwards how much of the ride was on a cycleway.
EDGE_DEDICATED = 1
EDGE_SIDEPATH = 2
# Part of a signposted cycle network -- in this region the baanas and the regional
# routes, which OSM carries as `route=bicycle` relations. 598 km of the extract.
EDGE_NETWORK = 4

COORDINATE_SCALE = 10_000_000
SHAPE_SCALE = 1_000_000
# A bearing only ever feeds a "did this bend 40 degrees" test, so 1.4 degrees of
# resolution costs nothing and halves the field.
BEARING_STEPS = 256

_ENCODING = {
    "lon": "int32 degrees * 1e7",
    "lat": "int32 degrees * 1e7",
    "node_kind": "uint8 junction: 0 plain, 1 uncontrolled crossing, 2 traffic signal, 3 signal crossed in two stages",
    "degree": "uint8 arms meeting at the junction, capped at 255",
    "edge_a": "uint32 node index",
    "edge_b": "uint32 node index",
    "edge_length": "uint16 decimetres",
    "edge_unpaved": "uint16 decimetres ridden on a rough surface",
    "edge_shared": "uint16 decimetres paved but shared with people on foot; disjoint from edge_unpaved, and the two together are the metres ridden at the slow-surface factor",
    "edge_traffic": "uint8 motor traffic shared with: 0 none, 1 calm, 2 moderate, 3 busy, 4 arterial",
    "edge_lit": "uint16 decimetres explicitly tagged as lit",
    "edge_grade": "uint8 roughness of the unpaved part: 0 paved, 1 firm, 2 rough, 3 loose",
    "edge_barriers": "uint8 barriers passed inside this edge, weighted 1 slow and 2 stop",
    "node_barrier": "uint8 barrier at the junction: 0 none, 1 squeeze past, 2 stop and put a foot down",
    "edge_signals": "uint8 traffic signals passed inside this edge",
    "edge_name": "uint32 index into name_blob's newline-separated list; 0 is unnamed",
    "edge_access": "uint8 bit 0: rideable a to b, bit 1: rideable b to a",
    "edge_class": "uint8 bit 0: built for bicycles, bit 1: carriageway with a path beside it, bit 2: on a signposted cycle route",
    "edge_crossings": "uint8 uncontrolled crossings passed inside this edge",
    "bearing_a": f"uint8 heading leaving a towards b, in 360/{BEARING_STEPS} degree steps",
    "bearing_b": f"uint8 heading arriving at b from a, in 360/{BEARING_STEPS} degree steps",
    "shape_count": "uint16 interior points on this edge",
    "shape_kind": "uint8 kind of each shape point, as node_kind",
    "name_blob": "uint8 utf-8 street names, newline separated, the first one empty",
    "shape_delta": (
        "uint16 zigzag deltas, lon and lat interleaved, degrees * 1e6; the first point "
        "of each edge is relative to node a, the rest to the previous point"
    ),
}

# Helsinki, Espoo, Vantaa and Kauniainen, with room for routes that bulge outside.
HSY_BOUNDS = (24.40, 60.05, 25.40, 60.45)
# Ways are dropped this far outside the bounds while reading, so a national extract
# can be built from directly rather than clipped first. It is not zero because a
# junction whose third arm leaves the bounds still has to read as a junction --
# clipping must not invent turns -- and 0.15 deg is ~16 km of slack for that.
READ_MARGIN_DEG = 0.15


def is_signal(tags) -> bool:
    """A node where the rider has to stop for a light.

    Counting only ``highway=traffic_signals`` misses most cyclist stops: in the HSL
    extract that tag covers 3,534 nodes, while a further 4,771 signalised
    *crossings* -- the ones a rider on a cycleway actually meets -- are tagged
    ``highway=crossing`` with ``crossing=traffic_signals``/``crossing:signals=yes``.
    """
    if tags.get("highway") == "traffic_signals":
        return True
    return tags.get("highway") == "crossing" and (
        tags.get("crossing") == "traffic_signals" or tags.get("crossing:signals") == "yes"
    )


def has_sidepath(tags) -> bool:
    """Whether a rider on this way belongs on a separate path beside it instead."""
    if tags.get("bicycle") == "use_sidepath":
        return True
    return any(tags.get(key) in SIDEPATH_CYCLEWAYS for key in CYCLEWAY_KEYS)


def is_dedicated(tags, highway: str) -> bool:
    """A way built for bicycles, as opposed to one they are merely allowed on."""
    return highway == "cycleway" or (highway == "path" and tags.get("bicycle") == "designated")


def bicycle_direction(tags) -> int:
    """1 if a bicycle may only ride the way's own direction, -1 against it, 0 either.

    8.3% of the region's rideable ways are one-way for a bicycle, and they are not a
    rounding error: they are the arterials mapped as two carriageways and the
    one-way cycleways beside them, where riding against the arrow is not a detour
    saved but a route nobody would follow.
    """
    explicit = tags.get("oneway:bicycle")
    if explicit in ONEWAY_FORWARD:
        return 1
    if explicit in ONEWAY_BACKWARD:
        return -1
    if explicit == "no":
        return 0
    if any("opposite" in (tags.get(key) or "") for key in CONTRAFLOW_KEYS):
        return 0
    value = tags.get("oneway")
    if value in ONEWAY_FORWARD:
        return 1
    if value in ONEWAY_BACKWARD:
        return -1
    # A roundabout is one-way whether or not anyone tagged it as one.
    return 1 if value is None and tags.get("junction") == "roundabout" else 0


def surface_kind(tags, highway: str, shared_way: bool) -> int:
    """Why a stretch is slow: a rough surface, people on it, or neither.

    One flag each, and unpaved wins where both apply, so the two never double-count
    the same metre. What the *speed* model sees is unchanged: it is still "is this
    metre slow at all", which is either flag being set.
    """
    if tags.get("surface") in SLOW_SURFACES:
        return SURFACE_UNPAVED
    shared = (
        shared_way
        or tags.get("segregated") == "no"
        or (highway == "path" and tags.get("segregated") is None and tags.get("foot") != "no")
    )
    return SURFACE_SHARED if shared else 0


def surface_grade(tags) -> int:
    """How rough the surface is, 0 paved. Unknown reads as paved: coverage is 69% and
    only an explicit bad surface has ever been penalised here."""
    return SURFACE_GRADE.get(tags.get("surface"), GRADE_PAVED)


def traffic_class(highway: str) -> int:
    """How much motor traffic a rider shares the way with, 0 none to 4 arterial."""
    return TRAFFIC_CLASS.get(highway, TRAFFIC_MODERATE)


@dataclass(frozen=True)
class OsmNetwork:
    """The rideable graph straight out of the extract, before contraction."""

    coordinates: np.ndarray       # degrees, one row per node
    edge_first: np.ndarray        # node index
    edge_second: np.ndarray       # node index
    edge_length: np.ndarray       # metres
    edge_surface: np.ndarray      # SURFACE_UNPAVED | SURFACE_SHARED, or 0
    edge_grade: np.ndarray        # GRADE_PAVED .. GRADE_LOOSE
    edge_traffic: np.ndarray      # TRAFFIC_FREE .. TRAFFIC_ARTERIAL
    edge_lit: np.ndarray          # bool, explicitly lit
    edge_name: np.ndarray         # index into `names`
    edge_class: np.ndarray        # EDGE_DEDICATED | EDGE_SIDEPATH
    edge_forward: np.ndarray      # bool, rideable first -> second
    edge_backward: np.ndarray     # bool, rideable second -> first
    node_kind: np.ndarray         # 0 plain, 1 crossing, 2 signal
    node_barrier: np.ndarray      # BARRIER_NONE | BARRIER_SLOW | BARRIER_STOP
    degree: np.ndarray
    names: tuple[str, ...]        # street names; index 0 is the unnamed one
    node_roads: dict[int, frozenset[int]]   # node index -> the carriageways meeting it
    elevated_nodes: frozenset[int]          # nodes on a bridge or in a tunnel


class _RouteHandler(osmium.SimpleHandler):
    """Ways that belong to a signposted cycle route.

    Relations come after ways in a PBF, so this is its own pass over the file: the
    way callback has to know the answer before it has seen the relation.
    """

    def __init__(self) -> None:
        super().__init__()
        self.ways: set[int] = set()

    def relation(self, relation) -> None:
        tags = relation.tags
        if tags.get("type") != "route" or tags.get("route") != "bicycle":
            return
        for member in relation.members:
            if member.type == "w":
                self.ways.add(member.ref)


class _Handler(osmium.SimpleHandler):
    def __init__(self, bounds: tuple[float, float, float, float] | None, routes: set[int] | None = None) -> None:
        super().__init__()
        self.routes = routes or set()
        self.edges: list[tuple[int, int, int, int, int, int, int, int]] = []
        self.coordinates: dict[int, tuple[float, float]] = {}
        self.signals: set[int] = set()
        self.crossings: set[int] = set()
        # Bollards, gates and raised kerbs, by node id and how much they cost.
        self.barriers: dict[int, int] = {}
        # Which carriageways meet each crossing node. Two crossing nodes of one
        # junction are two waits when they are two different carriageways -- a dual
        # road -- and one wait when they are the same one tagged twice.
        self.node_roads: dict[int, set[int]] = {}
        # A crossing with a refuge in the middle is crossed in two goes, and the
        # second half is a second wait however many lights the junction has.
        self.islands: set[int] = set()
        # Nodes on a bridge or in a tunnel. A rider passing under a signalised
        # junction passes no signal, and the register cannot tell you that.
        self.elevated: set[int] = set()
        self.names: list[str] = [""]
        self._name_index: dict[str, int] = {"": 0}
        self._bounds = None if bounds is None else (
            bounds[0] - READ_MARGIN_DEG, bounds[1] - READ_MARGIN_DEG,
            bounds[2] + READ_MARGIN_DEG, bounds[3] + READ_MARGIN_DEG,
        )

    def node(self, node) -> None:
        # Coordinates come from the way callback instead, which sees only the nodes
        # of ways we keep: holding every node of a national extract in a dict costs
        # gigabytes, and all but a few per cent of them are never referenced.
        if is_signal(node.tags):
            self.signals.add(node.id)
        elif node.tags.get("highway") == "crossing":
            self.crossings.add(node.id)
        if node.tags.get("crossing:island") == "yes":
            self.islands.add(node.id)
        kind = barrier_kind(node.tags)
        if kind:
            self.barriers[node.id] = kind

    def _name_id(self, name: str | None) -> int:
        if not name:
            return 0
        index = self._name_index.get(name)
        if index is None:
            index = len(self.names)
            self._name_index[name] = index
            self.names.append(name)
        return index

    def _inside(self, lon: float, lat: float) -> bool:
        if self._bounds is None:
            return True
        west, south, east, north = self._bounds
        return west <= lon <= east and south <= lat <= north

    def way(self, way) -> None:
        highway = way.tags.get("highway")
        bicycle = way.tags.get("bicycle")
        rideable = highway in CYCLING_HIGHWAYS and bicycle != "no"
        shared = highway in SHARED_HIGHWAYS and bicycle in RIDEABLE_SHARED
        if not (rideable or shared):
            return
        located = [(node.ref, node.location) for node in way.nodes if node.location.valid()]
        # A way is kept whole as soon as any of it is in range, so an edge is never
        # cut halfway and left with a dangling end.
        if not any(self._inside(location.lon, location.lat) for _, location in located):
            return
        for reference, location in located:
            self.coordinates[reference] = (location.lon, location.lat)
        if not is_dedicated(way.tags, highway):
            for reference, _ in located:
                if reference in self.signals or reference in self.crossings:
                    self.node_roads.setdefault(reference, set()).add(way.id)
        layer = way.tags.get("layer")
        if way.tags.get("bridge") or way.tags.get("tunnel") or (layer and layer not in ("0", "")):
            self.elevated.update(reference for reference, _ in located)
        # Riding among pedestrians is always slow, whatever the surface says.
        surface = surface_kind(way.tags, highway, shared)
        traffic = traffic_class(highway)
        # Only an explicit `lit=yes` counts. Coverage is 79% on cycleways and 27% on
        # roads, so treating silence as unlit would penalise whatever nobody has
        # surveyed rather than whatever is dark.
        lit = way.tags.get("lit") == "yes"
        grade = surface_grade(way.tags)
        name = self._name_id(way.tags.get("name"))
        direction = bicycle_direction(way.tags)
        kind = (
            (EDGE_DEDICATED if is_dedicated(way.tags, highway) else 0)
            | (EDGE_SIDEPATH if has_sidepath(way.tags) else 0)
            | (EDGE_NETWORK if way.id in self.routes else 0)
        )
        references = [reference for reference, _ in located]
        self.edges.extend(
            (start, end, surface, grade, traffic, lit, name, direction, kind)
            for start, end in zip(references, references[1:])
        )


def _distance_m(start: tuple[float, float], end: tuple[float, float]) -> float:
    mean_latitude = math.radians((start[1] + end[1]) / 2)
    east = (end[0] - start[0]) * math.cos(mean_latitude) * 111_320
    return float(math.hypot(east, (end[1] - start[1]) * 110_540))


def read_network(path: Path, bounds: tuple[float, float, float, float] | None = HSY_BOUNDS) -> OsmNetwork:
    routes = _RouteHandler()
    routes.apply_file(str(path))
    handler = _Handler(bounds, routes.ways)
    handler.apply_file(str(path), locations=True)
    nodes = sorted({node for start, end, *_ in handler.edges for node in (start, end) if node in handler.coordinates})
    position = {node: index for index, node in enumerate(nodes)}
    coordinates = np.array([handler.coordinates[node] for node in nodes], dtype=float).reshape(len(nodes), 2)

    merged: dict[tuple[int, int], tuple[float, int, int, int, bool, bool, int]] = {}
    for start, end, surface, grade, traffic, lit, name, direction, kind in handler.edges:
        if start not in position or end not in position or start == end:
            continue
        first, second = position[start], position[end]
        ascending = first < second
        key = (first, second) if ascending else (second, first)
        # Permissions are stored in the key's own orientation, so a way listed the
        # other way round has its direction flipped to match.
        along = direction >= 0
        against = direction <= 0
        forward, backward = (along, against) if ascending else (against, along)
        length = _distance_m(handler.coordinates[start], handler.coordinates[end])
        previous = merged.get(key)
        # A stretch mapped twice keeps the pessimistic (slow) reading, and whichever
        # of the two ways carries a name -- a named street crossed by an unnamed
        # service way should still be called by its name. Directions are unioned
        # instead: if either mapping says a bicycle may ride it, it may.
        merged[key] = (
            (length,
             # Pessimistic on both counts: the rougher surface and the busier road
             # win, because a stretch mapped twice is one stretch and the rider meets
             # whichever reading is true.
             (surface or previous[1]) if not (surface & SURFACE_UNPAVED or previous[1] & SURFACE_UNPAVED)
             else SURFACE_UNPAVED,
             max(grade, previous[2]),
             max(traffic, previous[3]),
             lit or previous[4],
             previous[5] or name, forward or previous[6], backward or previous[7],
             # A stretch mapped as both a cycleway and a road-with-sidepath is the
             # cycleway: being built for bicycles outranks being closed to them.
             (previous[8] | kind) & ~(EDGE_SIDEPATH if (previous[8] | kind) & EDGE_DEDICATED else 0))
            if previous else (length, surface, grade, traffic, lit, name, forward, backward, kind)
        )

    keys = sorted(merged)
    first = np.array([key[0] for key in keys], dtype=np.int64)
    second = np.array([key[1] for key in keys], dtype=np.int64)
    degree = np.zeros(len(nodes), dtype=np.int64)
    np.add.at(degree, first, 1)
    np.add.at(degree, second, 1)
    barrier = np.array([handler.barriers.get(node, 0) for node in nodes], dtype=np.int64)
    kind = np.zeros(len(nodes), dtype=np.int64)
    for index, node in enumerate(nodes):
        kind[index] = 2 if node in handler.signals else 1 if node in handler.crossings else 0
        if kind[index] == 2 and node in handler.islands:
            kind[index] = 3
    return OsmNetwork(
        coordinates=coordinates, edge_first=first, edge_second=second,
        edge_length=np.array([merged[key][0] for key in keys]),
        edge_surface=np.array([merged[key][1] for key in keys], dtype=np.int64),
        edge_grade=np.array([merged[key][2] for key in keys], dtype=np.int64),
        edge_traffic=np.array([merged[key][3] for key in keys], dtype=np.int64),
        edge_lit=np.array([merged[key][4] for key in keys], dtype=bool),
        edge_name=np.array([merged[key][5] for key in keys], dtype=np.int64),
        edge_class=np.array([merged[key][8] for key in keys], dtype=np.int64),
        edge_forward=np.array([merged[key][6] for key in keys], dtype=bool),
        edge_backward=np.array([merged[key][7] for key in keys], dtype=bool),
        node_kind=kind, node_barrier=barrier, degree=degree, names=tuple(handler.names),
        node_roads={
            position[node]: frozenset(ways)
            for node, ways in handler.node_roads.items() if node in position
        },
        elevated_nodes=frozenset(position[node] for node in handler.elevated if node in position),
    )


@dataclass(frozen=True)
class RoutingGraph:
    """A junction-only graph in natural units, plus the polylines that draw its edges.

    Restricted to the largest connected component: an island is unroutable, and
    snapping a query onto one silently strands it.
    """

    lon: np.ndarray
    lat: np.ndarray
    node_kind: np.ndarray
    degree: np.ndarray
    edge_a: np.ndarray
    edge_b: np.ndarray
    edge_length: np.ndarray    # metres
    edge_grade: np.ndarray     # roughness of the unpaved part, GRADE_PAVED..GRADE_LOOSE
    edge_lit: np.ndarray       # metres of the above explicitly lit
    edge_barriers: np.ndarray  # weighted barriers met inside the edge
    node_barrier: np.ndarray   # barrier at each kept junction
    edge_unpaved: np.ndarray   # metres of the above on a rough surface
    edge_shared: np.ndarray    # metres of it paved but shared with people on foot
    edge_traffic: np.ndarray   # the class carrying most of the edge's metres
    edge_signals: np.ndarray
    edge_crossings: np.ndarray
    edge_name: np.ndarray      # index into `names`
    edge_class: np.ndarray     # EDGE_DEDICATED | EDGE_SIDEPATH
    edge_access: np.ndarray    # bit 0: rideable a -> b, bit 1: rideable b -> a
    bearing_a: np.ndarray      # degrees, heading leaving a towards b
    bearing_b: np.ndarray      # degrees, heading arriving at b from a
    shape_count: np.ndarray
    shape_lon: np.ndarray
    shape_lat: np.ndarray
    shape_kind: np.ndarray     # kind of each shape point, as node_kind
    names: tuple[str, ...]


def _adjacency(network: OsmNetwork) -> tuple[np.ndarray, np.ndarray]:
    count = len(network.coordinates)
    rows = np.concatenate([network.edge_first, network.edge_second])
    columns = np.concatenate([network.edge_second, network.edge_first])
    order = np.argsort(rows, kind="stable")
    offsets = np.zeros(count + 1, dtype=np.int64)
    np.add.at(offsets, rows + 1, 1)
    return np.cumsum(offsets), columns[order]


def _bearing(start: np.ndarray, end: np.ndarray) -> float:
    mean_latitude = math.radians((start[1] + end[1]) / 2)
    east = (end[0] - start[0]) * math.cos(mean_latitude)
    return math.degrees(math.atan2(east, end[1] - start[1])) % 360.0


def _contract(network: OsmNetwork, bounds: tuple[float, float, float, float] | None) -> RoutingGraph:
    coordinates = network.coordinates
    offsets, neighbours = _adjacency(network)
    degree, node_kind, node_barrier = network.degree, network.node_kind, network.node_barrier
    count = len(coordinates)
    attribute = {
        (int(a), int(b)): (float(length), int(surface), int(grade), int(traffic), bool(lit),
                           int(name), bool(forward), bool(backward), int(kind))
        for a, b, length, surface, grade, traffic, lit, name, forward, backward, kind in zip(
            network.edge_first, network.edge_second, network.edge_length,
            network.edge_surface, network.edge_grade, network.edge_traffic, network.edge_lit,
            network.edge_name, network.edge_forward, network.edge_backward, network.edge_class,
        )
    }

    def look_up(first: int, second: int):
        """Length, surface, grade, traffic, lit, name, the permissions and the class."""
        if first < second:
            length, surface, grade, traffic, lit, name, forward, backward, kind = attribute[(first, second)]
        else:
            length, surface, grade, traffic, lit, name, backward, forward, kind = attribute[(second, first)]
        return length, surface, grade, traffic, lit, name, forward, backward, kind

    inside = np.ones(count, dtype=bool)
    if bounds is not None:
        west, south, east, north = bounds
        inside = (
            (coordinates[:, 0] >= west) & (coordinates[:, 0] <= east)
            & (coordinates[:, 1] >= south) & (coordinates[:, 1] <= north)
        )
    # Degrees come from the uncontracted network, so a junction whose third arm
    # leaves `bounds` still reads as a junction: clipping must not invent turns.
    junction = (degree != 2) & inside
    kept = [int(node) for node in np.nonzero(junction)[0]]
    node_index = {node: index for index, node in enumerate(kept)}

    edge_a: list[int] = []
    edge_b: list[int] = []
    edge_length: list[float] = []
    edge_grade: list[int] = []
    edge_lit: list[float] = []
    edge_barriers: list[int] = []
    edge_unpaved: list[float] = []
    edge_shared: list[float] = []
    edge_traffic: list[int] = []
    edge_signals: list[int] = []
    edge_crossings: list[int] = []
    edge_name: list[int] = []
    edge_class: list[int] = []
    edge_access: list[int] = []
    bearing_a: list[float] = []
    bearing_b: list[float] = []
    shape_count: list[int] = []
    shape_lon: list[float] = []
    shape_lat: list[float] = []
    shape_kind: list[int] = []
    seen: set[tuple[int, int, int]] = set()

    for start in kept:
        for first_step in neighbours[offsets[start]:offsets[start + 1]]:
            previous, current = start, int(first_step)
            total, unpaved_total, shared_total, lit_total = 0.0, 0.0, 0.0, 0.0
            signals, crossings, barriers = 0, 0, 0
            interior: list[int] = []
            # A contracted edge can run through several ways, and some of them are
            # unnamed connectors, so the name is the one carrying the most metres
            # rather than the first: the rider knows the street, not the way.
            metres_by_name: dict[int, float] = {}
            length, surface, grade, traffic, lit, name, forward, backward, kind = look_up(previous, current)
            total += length
            unpaved_total += length if surface & SURFACE_UNPAVED else 0.0
            shared_total += length if surface & SURFACE_SHARED else 0.0
            lit_total += length if lit else 0.0
            metres_by_name[name] = metres_by_name.get(name, 0.0) + length
            # Like the name, and for the same reason: 20 m of service road crossing a
            # residential street does not make the whole edge a service road.
            metres_by_traffic: dict[int, float] = {traffic: length}
            metres_by_grade: dict[int, float] = {grade: length}
            # Like the name: what the edge *is* follows the metres, so one flagged
            # link in a long chain does not condemn the whole of it.
            metres_by_class: dict[int, float] = {kind: length}
            # A chain is rideable one way only if every segment in it is: one one-way
            # block closes the whole contracted edge in that direction.
            rideable_forward, rideable_backward = forward, backward
            while not junction[current] and degree[current] == 2 and inside[current]:
                interior.append(current)
                signals += 2 if node_kind[current] == 3 else int(node_kind[current] == 2)
                crossings += int(node_kind[current] == 1)
                # Counted here for the same reason signals are: contraction is about
                # to dissolve this node, and a bollard nobody can see is a bollard
                # nobody is charged for.
                barriers += int(node_barrier[current])
                onward = [int(other) for other in neighbours[offsets[current]:offsets[current + 1]] if other != previous]
                if not onward:
                    break
                previous, current = current, onward[0]
                length, surface, grade, traffic, lit, name, forward, backward, kind = look_up(previous, current)
                total += length
                unpaved_total += length if surface & SURFACE_UNPAVED else 0.0
                shared_total += length if surface & SURFACE_SHARED else 0.0
                lit_total += length if lit else 0.0
                metres_by_name[name] = metres_by_name.get(name, 0.0) + length
                metres_by_traffic[traffic] = metres_by_traffic.get(traffic, 0.0) + length
                metres_by_grade[grade] = metres_by_grade.get(grade, 0.0) + length
                metres_by_class[kind] = metres_by_class.get(kind, 0.0) + length
                rideable_forward = rideable_forward and forward
                rideable_backward = rideable_backward and backward
            if current not in node_index:
                continue
            # Both ends walk the same chain, in opposite orders, so the interior has
            # to be identified by something order-independent: keying on its first
            # node kept every chain twice and doubled the download.
            marker = min(interior[0], interior[-1]) if interior else -1
            signature = (min(start, current), max(start, current), marker)
            if signature in seen:
                continue
            seen.add(signature)
            path = [start, *interior, current]
            edge_a.append(node_index[start])
            edge_b.append(node_index[current])
            edge_length.append(total)
            edge_unpaved.append(unpaved_total)
            edge_shared.append(shared_total)
            edge_lit.append(lit_total)
            edge_barriers.append(min(barriers, 255))
            edge_traffic.append(max(metres_by_traffic, key=metres_by_traffic.get))
            # The grade of the rough part, not of the edge: a paved street with 30 m
            # of gravel on it should say how bad that 30 m is.
            rough = {g: m for g, m in metres_by_grade.items() if g}
            edge_grade.append(max(rough, key=rough.get) if rough else GRADE_PAVED)
            edge_signals.append(signals)
            edge_crossings.append(crossings)
            named = {key: metres for key, metres in metres_by_name.items() if key}
            edge_name.append(max(named, key=named.get) if named else 0)
            edge_access.append(int(rideable_forward) | (int(rideable_backward) << 1))
            # Sidepath follows the metres, but being part of a signposted route is a
            # property of the road rather than of most of it: a baana interrupted by
            # 20 m of ordinary path is still the baana.
            leading = max(metres_by_class, key=metres_by_class.get)
            edge_class.append(leading | (EDGE_NETWORK if any(k & EDGE_NETWORK for k in metres_by_class) else 0))
            bearing_a.append(_bearing(coordinates[path[0]], coordinates[path[1]]))
            bearing_b.append(_bearing(coordinates[path[-2]], coordinates[path[-1]]))
            shape_count.append(len(interior))
            shape_lon.extend(coordinates[node][0] for node in interior)
            shape_lat.extend(coordinates[node][1] for node in interior)
            # The interior nodes are exactly the shape points, so shipping their kind
            # keeps the position of every light the contraction swallowed -- without
            # it the page can say a route passes six, but only draw the two that
            # happen to sit on a junction.
            shape_kind.extend(int(node_kind[node]) for node in interior)

    return RoutingGraph(
        lon=coordinates[kept, 0], lat=coordinates[kept, 1],
        node_kind=node_kind[kept], node_barrier=network.node_barrier[kept], degree=degree[kept],
        edge_a=np.array(edge_a, dtype=np.int64), edge_b=np.array(edge_b, dtype=np.int64),
        edge_length=np.array(edge_length),
        edge_unpaved=np.array(edge_unpaved), edge_shared=np.array(edge_shared),
        edge_lit=np.array(edge_lit),
        edge_grade=np.array(edge_grade, dtype=np.int64),
        edge_barriers=np.array(edge_barriers, dtype=np.int64),
        edge_traffic=np.array(edge_traffic, dtype=np.int64),
        edge_signals=np.array(edge_signals, dtype=np.int64),
        edge_crossings=np.array(edge_crossings, dtype=np.int64),
        edge_name=np.array(edge_name, dtype=np.int64),
        edge_access=np.array(edge_access, dtype=np.int64),
        edge_class=np.array(edge_class, dtype=np.int64),
        bearing_a=np.array(bearing_a), bearing_b=np.array(bearing_b),
        shape_count=np.array(shape_count, dtype=np.int64),
        shape_lon=np.array(shape_lon), shape_lat=np.array(shape_lat),
        shape_kind=np.array(shape_kind, dtype=np.int64), names=network.names,
    )


# How far from a cycle crossing a road's traffic signal may stand and still be the
# light the rider waits at. A signalised junction puts its signal node on the
# carriageway; the cycleway crosses it a kerb and a verge away.
CROSSING_SIGNAL_METRES = 25.0
# How sharply the rider's path must cut across the road the signal stands on. A
# signal between a carriageway and a cycleway running the *same* way faces the cars
# and says nothing to the rider beside it; one the rider crosses does. 45 degrees
# splits those two cases and is what keeps the light off parallel paths.
CROSSING_SIGNAL_DEGREES = 45.0
# How far apart two crossing nodes can be and still be one junction. Within it, the
# carriageways decide: crossing a dual road is two waits at one set of lights -- the
# island in the middle is where the first one ends -- while the same carriageway
# tagged twice is one. Mannerheimintie and Hämeentie are the former.
SIGNAL_MERGE_M = 30.0
# How far from a junction in the cities' register a rider's crossing may be and still
# be the crossing that junction controls. Wider than the rule above, because the
# register gives one point for the whole junction rather than one per signal.
REGISTER_REACH_M = 40.0
# A motorway interchange is signalised at its ramps, and its register point sits in
# the middle of the whole thing -- Vihdintien ympyrä, Kehä I/Kontulantie, the VT3
# ramps -- so the nearest place a rider crosses it is 50 to 80 m from that point.
# Junctions that find nothing at all inside 40 m get a second look this far out, and
# the build names every one it had to reach for. Not further: past ~80 m the nearest
# path stops being one that passes the junction, and a light there is a wait that
# never happens.
REGISTER_FALLBACK_M = 80.0
# How far a rider may be from the junction *along the network* and still be at it.
#
# This is what tells a cycleway crossing a road apart from a cycleway passing under
# it. Both are metres away in plan view; only one is metres away to ride. The Baana
# runs in a cutting beneath the streets it crosses, and its nodes sit 42 m from a
# signalised junction and 333 m from it to ride -- eight times as far, because you
# must climb a ramp and come back. Tags cannot see this: the Baana is not a tunnel
# and carries no `layer`, because it is the *street* overhead that is the bridge.
#
# The budget is set to keep honest junctions rather than to catch every false one. A
# Finnish suburban crossroads often joins its cycleway well back from the corner --
# Kontulantie at 164 m, Vaskivuorentie 175 m, Rajatorpantie 200 m, every one of them
# at grade -- while what this is meant to exclude sits at 284 m and beyond. The two
# populations separate, but not by much, so the line is drawn above the honest ones:
# a light wrongly kept costs a rider 30 s of pessimism, and a light wrongly dropped
# makes a route that stops look like one that does not.
#
# The terrain model cannot help, which is worth recording because it looks as though
# it should. MML's korkeusmalli is a *ground* model with bridge decks removed, so the
# street over the Baana and the Baana beneath it both read 13,5 m.
REGISTER_WALK_M = 240.0

# How close a cycleway has to run, and how nearly parallel, to count as the path
# beside a road. 20 m clears a carriageway plus a verge without reaching the next
# street; 30 degrees keeps a cycleway that merely crosses from counting.
PARALLEL_METRES = 20.0
PARALLEL_DEGREES = 30.0
# How much of a road has to have that path beside it before the road is one to keep
# riders off. Below this it is a road that happens to pass a cycleway.
PARALLEL_SHARE = 0.7
# One sample per this much of an edge, so a long edge is judged along its length
# rather than by its middle.
SAMPLE_METRES = 25.0


def _mark_parallel_roads(graph: RoutingGraph) -> np.ndarray:
    """Flag roads that a mapped cycleway runs alongside, however OSM tagged them.

    `bicycle=use_sidepath` covers 1,774 km of the region and is the honest signal,
    but it is not everywhere: Helsinginkatu carries cycle tracks its carriageway
    never mentions, and a router reading tags alone puts riders on the carriageway
    for a third of every trip. So the geometry is asked directly -- is there a
    cycleway within 20 m, running the same way, along most of this edge?
    """
    cell = 0.002  # ~220 m of latitude
    dedicated = (graph.edge_class & EDGE_DEDICATED).astype(bool)
    shapes = [_polyline(graph, edge) for edge in range(len(graph.edge_a))]

    grid: dict[tuple[int, int], list[tuple[float, float, float, float]]] = {}
    for edge in np.nonzero(dedicated)[0]:
        for first, second in zip(shapes[edge], shapes[edge][1:]):
            for key in {(int(point[0] // cell), int(point[1] // cell)) for point in (first, second)}:
                grid.setdefault(key, []).append((first[0], first[1], second[0], second[1]))

    marked = graph.edge_class.copy()
    for edge in range(len(graph.edge_a)):
        if dedicated[edge] or graph.edge_class[edge] & EDGE_SIDEPATH:
            continue
        points = _samples(shapes[edge], graph.edge_length[edge])
        if not points:
            continue
        beside = 0
        for lon, lat, bearing in points:
            key = (int(lon // cell), int(lat // cell))
            east = math.cos(math.radians(lat)) * 111_320
            found = False
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for segment in grid.get((key[0] + dx, key[1] + dy), ()):
                        if _segment_metres(lon, lat, segment, east) > PARALLEL_METRES:
                            continue
                        other = _bearing(np.array(segment[:2]), np.array(segment[2:]))
                        if abs(((other - bearing + 540) % 360) - 180) % 180 <= PARALLEL_DEGREES:
                            found = True
                            break
                    if found:
                        break
                if found:
                    break
            beside += found
        if beside / len(points) >= PARALLEL_SHARE:
            marked[edge] |= EDGE_SIDEPATH
    return marked


def _polyline(graph: RoutingGraph, edge: int) -> list[tuple[float, float]]:
    start = int(np.concatenate([[0], np.cumsum(graph.shape_count)])[edge])
    interior = [
        (float(graph.shape_lon[start + step]), float(graph.shape_lat[start + step]))
        for step in range(int(graph.shape_count[edge]))
    ]
    a, b = int(graph.edge_a[edge]), int(graph.edge_b[edge])
    return [(float(graph.lon[a]), float(graph.lat[a])), *interior, (float(graph.lon[b]), float(graph.lat[b]))]


def _samples(points: list[tuple[float, float]], length: float) -> list[tuple[float, float, float]]:
    """Points along the edge with the local heading, one per SAMPLE_METRES."""
    if len(points) < 2:
        return []
    step = max(1, int(len(points) // max(1, round(length / SAMPLE_METRES))))
    found = []
    for index in range(0, len(points) - 1, step):
        first, second = points[index], points[index + 1]
        middle = ((first[0] + second[0]) / 2, (first[1] + second[1]) / 2)
        found.append((middle[0], middle[1], _bearing(np.array(first), np.array(second))))
    return found


def _segment_metres(lon: float, lat: float, segment: tuple[float, float, float, float], east: float) -> float:
    """Distance from a point to a segment, in metres, on a locally flat earth."""
    x, y = lon * east, lat * 110_540
    x1, y1 = segment[0] * east, segment[1] * 110_540
    x2, y2 = segment[2] * east, segment[3] * 110_540
    dx, dy = x2 - x1, y2 - y1
    span = dx * dx + dy * dy
    along = 0.0 if span == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / span))
    return math.hypot(x - (x1 + along * dx), y - (y1 + along * dy))


def _signalise_cycle_crossings(network: OsmNetwork) -> np.ndarray:
    """Give a cycle crossing the light that governs it but was tagged on the road.

    52% of the region's traffic signals (3,751 of 7,225) sit on a carriageway and on
    no cycleway at all, so a rider on the path beside it meets none of them and the
    route is priced as if the junction were free. Only 311 signals say which way they
    face, so the direction has to come from the geometry: the rider is charged only
    where their own path cuts across the road the signal stands on, which is exactly
    the case where they have to wait for it. A signal beside a cycleway running the
    same way is a signal for the cars, and is left alone.
    """
    coordinates = network.coordinates
    kind = network.node_kind.copy()
    dedicated = (network.edge_class & EDGE_DEDICATED).astype(bool)
    offsets, neighbours = _adjacency(network)
    lengths = network.edge_length
    # Which edges meet each node, in the same order `_adjacency` lists the neighbours,
    # so the walk below can charge each step its real length.
    edge_at = np.concatenate([np.arange(len(lengths)), np.arange(len(lengths))])
    edge_at = edge_at[np.argsort(np.concatenate([network.edge_first, network.edge_second]), kind="stable")]

    def within_walk(start: int, budget: float = REGISTER_WALK_M) -> dict[int, float]:
        """Every node reachable from `start` inside `budget` metres of riding.

        Small and bounded: a junction's neighbourhood is a few dozen nodes, and the
        search stops at the budget rather than exploring the city.
        """
        seen = {int(start): 0.0}
        queue = [(0.0, int(start))]
        while queue:
            queue.sort(reverse=True)
            metres, node = queue.pop()
            if metres > seen.get(node, math.inf):
                continue
            for slot in range(offsets[node], offsets[node + 1]):
                other = int(neighbours[slot])
                step = metres + float(lengths[edge_at[slot]])
                if step <= budget and step < seen.get(other, math.inf):
                    seen[other] = step
                    queue.append((step, other))
        return seen

    cycle_bearings: dict[int, list[float]] = {}
    road_bearings: dict[int, list[float]] = {}
    for first, second, is_cycle in zip(network.edge_first, network.edge_second, dedicated):
        first, second = int(first), int(second)
        heading = _bearing(coordinates[first], coordinates[second])
        target = cycle_bearings if is_cycle else road_bearings
        target.setdefault(first, []).append(heading)
        target.setdefault(second, []).append((heading + 180.0) % 360.0)

    cell = 0.001  # ~110 m of latitude
    grid: dict[tuple[int, int], list[int]] = {}
    for node in np.nonzero((kind == 2) | (kind == 3))[0]:
        point = coordinates[node]
        grid.setdefault((int(point[0] // cell), int(point[1] // cell)), []).append(int(node))

    def crosses(here: float, there: float) -> bool:
        between = abs(((here - there + 540.0) % 360.0) - 180.0)
        return min(between, 180.0 - between) >= CROSSING_SIGNAL_DEGREES

    # Where a light has been given, and to the crossing of which carriageways, so a
    # second crossing node can tell "the other side of the same road" from "the
    # other carriageway of a dual road".
    added: list[tuple[np.ndarray, frozenset[int]]] = []
    for node in sorted(cycle_bearings):
        # Only where the rider actually meets road traffic: a junction with a road,
        # or a node someone tagged as a crossing. A cycleway merely passing a
        # junction 20 m away is not waiting at it.
        # 3 is already a two-wait crossing; giving it the road's light would lose
        # the second wait rather than add anything.
        if kind[node] in (2, 3) or not (node in road_bearings or kind[node] == 1):
            continue
        point = coordinates[node]
        east = math.cos(math.radians(point[1])) * 111_320
        key = (int(point[0] // cell), int(point[1] // cell))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for signal in grid.get((key[0] + dx, key[1] + dy), ()):
                    other = coordinates[signal]
                    metres = math.hypot((other[0] - point[0]) * east, (other[1] - point[1]) * 110_540)
                    if metres > CROSSING_SIGNAL_METRES:
                        continue
                    if not any(
                        crosses(mine, theirs)
                        for mine in cycle_bearings[node]
                        for theirs in road_bearings.get(signal, ())
                    ):
                        continue
                    roads = network.node_roads.get(node, frozenset())
                    if any(
                        math.hypot((was[0] - point[0]) * east, (was[1] - point[1]) * 110_540) < SIGNAL_MERGE_M
                        and (not roads or not other_roads or roads & other_roads)
                        for was, other_roads in added
                    ):
                        break
                    kind[node] = 2
                    added.append((point, network.node_roads.get(node, frozenset())))
                    break
                if kind[node] == 2:
                    break
            if kind[node] == 2:
                break
    return kind


def _signalise_from_register(network: OsmNetwork, register: list[dict]) -> np.ndarray:
    """Add the lights the cities know about and OSM does not.

    Audited against the three registers, 7% of the region's signalised junctions had
    no light a rider would meet: some are absent from OSM altogether, and in the rest
    the signal is tagged on the carriageway with nothing on the cycleway beside it,
    where neither the tags nor the geometry rule reaches it.

    A junction in the register is one point for the whole junction, so the light goes
    on the nearest place a rider passes through it, preferring somewhere they visibly
    meet the road -- a node their way shares with a carriageway, or one already
    tagged as a crossing -- and otherwise taking the nearest node of the way itself.
    A cycleway within 40 m of a signalised junction's centre crosses one of its arms;
    that is what a signalised junction *is*.

    Two things are never given a light. A bridge or a tunnel: a rider passing under
    the junction passes no signal, and the register cannot tell you which it is. And
    a junction with no rideable way near it at all, which is a motorway interchange
    where no rider goes. Everything else is accounted for, and the build says so.
    """
    coordinates = network.coordinates
    kind = network.node_kind.copy()
    dedicated = (network.edge_class & EDGE_DEDICATED).astype(bool)
    offsets, neighbours = _adjacency(network)
    lengths = network.edge_length
    # Which edges meet each node, in the same order `_adjacency` lists the neighbours,
    # so the walk below can charge each step its real length.
    edge_at = np.concatenate([np.arange(len(lengths)), np.arange(len(lengths))])
    edge_at = edge_at[np.argsort(np.concatenate([network.edge_first, network.edge_second]), kind="stable")]

    def within_walk(start: int, budget: float = REGISTER_WALK_M) -> dict[int, float]:
        """Every node reachable from `start` inside `budget` metres of riding.

        Small and bounded: a junction's neighbourhood is a few dozen nodes, and the
        search stops at the budget rather than exploring the city.
        """
        seen = {int(start): 0.0}
        queue = [(0.0, int(start))]
        while queue:
            queue.sort(reverse=True)
            metres, node = queue.pop()
            if metres > seen.get(node, math.inf):
                continue
            for slot in range(offsets[node], offsets[node + 1]):
                other = int(neighbours[slot])
                step = metres + float(lengths[edge_at[slot]])
                if step <= budget and step < seen.get(other, math.inf):
                    seen[other] = step
                    queue.append((step, other))
        return seen

    # The two ways a rider can be on through a junction, kept apart on purpose. At a
    # big junction the cycleway and the carriageway often share no node at all, which
    # is why these junctions were orphans: a light on the road is met by nobody on
    # the path beside it. Each gets its own, and a rider passes one of them.
    on_cycleway: set[int] = set()
    on_road: set[int] = set()
    for first, second, is_cycle in zip(network.edge_first, network.edge_second, dedicated):
        target = on_cycleway if is_cycle else on_road
        target.add(int(first))
        target.add(int(second))

    cell = 0.002

    def index(nodes):
        grid: dict[tuple[int, int], list[int]] = {}
        for node in nodes:
            point = coordinates[node]
            grid.setdefault((int(point[0] // cell), int(point[1] // cell)), []).append(int(node))
        return grid

    # A bridge or a tunnel is never it: a rider passing under a signalised junction
    # passes no signal, and the register cannot tell you which of the two it is.
    at_grade = lambda nodes: (node for node in nodes if node not in network.elevated_nodes)
    candidates = {
        "cycleway": index(at_grade(on_cycleway)),
        "road": index(at_grade(on_road)),
    }
    signalled = {
        "cycleway": index(node for node in on_cycleway if kind[node] in (2, 3)),
        "road": index(node for node in on_road if kind[node] in (2, 3)),
    }

    def nearby(grid, lon, lat, east, reach=REGISTER_REACH_M):
        span = int(reach / (cell * 60_000)) + 1
        key = (int(lon // cell), int(lat // cell))
        for dx in range(-span, span + 1):
            for dy in range(-span, span + 1):
                for node in grid.get((key[0] + dx, key[1] + dy), ()):
                    point = coordinates[node]
                    metres = math.hypot((point[0] - lon) * east, (point[1] - lat) * 110_540)
                    if metres <= reach:
                        yield metres, node

    census = {"already known": 0, "added": 0, "reached further": 0,
              "grade separated": 0, "unreachable": 0}
    orphans = []
    stretched = []
    for junction in register:
        lon, lat = junction["lon"], junction["lat"]
        east = math.cos(math.radians(lat)) * 111_320
        # The junction is a place on the road, so the road is the anchor: whatever a
        # rider meets here, they meet it within a short ride of that point. Anything
        # further to ride than `REGISTER_WALK_M` is passing over or under, not through.
        anchor = list(nearby(candidates["road"], lon, lat, east, REGISTER_FALLBACK_M))
        walkable = within_walk(int(min(anchor)[1])) if anchor else {}
        at_junction = lambda found: [(metres, node) for metres, node in found if node in walkable]

        reached = False
        for way_kind in ("cycleway", "road"):
            # At the ordinary radius: a light 100 m away belongs to the next
            # junction along, and treating it as this one's leaves this one dark.
            if at_junction(nearby(signalled[way_kind], lon, lat, east)):
                census["already known"] += 1
                reached = True
                continue
            found = at_junction(nearby(candidates[way_kind], lon, lat, east))
            if not found:
                found = at_junction(nearby(candidates[way_kind], lon, lat, east, REGISTER_FALLBACK_M))
                if found:
                    census["reached further"] += 1
                    stretched.append((junction, min(found)[0], way_kind))
            if not found:
                census["grade separated"] += 1
                continue
            node = int(min(found)[1])
            kind[node] = 2
            signalled[way_kind].setdefault((int(lon // cell), int(lat // cell)), []).append(node)
            census["added"] += 1
            reached = True
        if not reached:
            census["unreachable"] += 1
            orphans.append(junction)
    print(
        f"    register: {census['added']:,} lights added, {census['already known']:,} already known, "
        f"{census['reached further']:,} beyond {REGISTER_REACH_M:.0f} m, "
        f"{census['grade separated']:,} over or under rather than through, "
        f"{census['unreachable']:,} junctions no rider reaches"
    )
    for junction, metres, way_kind in stretched:
        print(f"      reached {metres:>4.0f} m for the {way_kind}: {junction['city']} {junction.get('name') or ''}")
    for junction in orphans:
        print(f"      unreached: {junction['city']} {junction.get('name') or ''} "
              f"({junction['lat']:.5f},{junction['lon']:.5f})")
    return kind


def _largest_component(graph: RoutingGraph) -> np.ndarray:
    """The largest *strongly* connected component.

    Undirected connectivity is not enough once edges have a direction: a cul-de-sac
    reachable only by riding the wrong way up a one-way street looks connected while
    being unroutable, and snapping a query onto it strands the query silently.
    """
    count = len(graph.lon)
    if not count or not len(graph.edge_a):
        return np.zeros(count, dtype=bool)
    forward = (graph.edge_access & 1).astype(bool)
    backward = (graph.edge_access & 2).astype(bool)
    rows = np.concatenate([graph.edge_a[forward], graph.edge_b[backward]])
    columns = np.concatenate([graph.edge_b[forward], graph.edge_a[backward]])
    if not len(rows):
        return np.zeros(count, dtype=bool)
    matrix = csr_matrix((np.ones(len(rows)), (rows, columns)), shape=(count, count))
    labels = connected_components(matrix, directed=True, connection="strong")[1]
    return labels == np.bincount(labels).argmax()


def _restrict(graph: RoutingGraph, keep: np.ndarray) -> RoutingGraph:
    renumbered = np.full(len(graph.lon), -1, dtype=np.int64)
    renumbered[keep] = np.arange(int(keep.sum()))
    edges = keep[graph.edge_a] & keep[graph.edge_b]
    offsets = np.concatenate([[0], np.cumsum(graph.shape_count)])
    points = (
        np.concatenate([np.arange(offsets[index], offsets[index + 1]) for index in np.nonzero(edges)[0]]).astype(np.int64)
        if edges.any() else np.zeros(0, dtype=np.int64)
    )
    return RoutingGraph(
        lon=graph.lon[keep], lat=graph.lat[keep],
        node_kind=graph.node_kind[keep], node_barrier=graph.node_barrier[keep], degree=graph.degree[keep],
        edge_a=renumbered[graph.edge_a[edges]], edge_b=renumbered[graph.edge_b[edges]],
        edge_length=graph.edge_length[edges],
        edge_unpaved=graph.edge_unpaved[edges], edge_shared=graph.edge_shared[edges],
        edge_lit=graph.edge_lit[edges], edge_barriers=graph.edge_barriers[edges],
        edge_grade=graph.edge_grade[edges],
        edge_traffic=graph.edge_traffic[edges],
        edge_signals=graph.edge_signals[edges], edge_crossings=graph.edge_crossings[edges],
        edge_name=graph.edge_name[edges], edge_access=graph.edge_access[edges],
        edge_class=graph.edge_class[edges],
        bearing_a=graph.bearing_a[edges], bearing_b=graph.bearing_b[edges],
        shape_count=graph.shape_count[edges],
        shape_lon=graph.shape_lon[points], shape_lat=graph.shape_lat[points],
        shape_kind=graph.shape_kind[points], names=graph.names,
    )


def build_routing_graph(
    network: OsmNetwork,
    bounds: tuple[float, float, float, float] | None = None,
    register: list[dict] | None = None,
) -> RoutingGraph:
    """Contract every degree-2 run into one edge and keep the largest component."""
    network = replace(network, node_kind=_signalise_cycle_crossings(network))
    if register:
        network = replace(network, node_kind=_signalise_from_register(network, register))
    graph = _contract(network, bounds)
    graph = replace(graph, edge_class=_mark_parallel_roads(graph))
    return _restrict(graph, _largest_component(graph))


def _zigzag(values: np.ndarray) -> np.ndarray:
    return ((values << 1) ^ (values >> 63)).astype(np.uint64)


def _shape_deltas(graph: RoutingGraph) -> np.ndarray:
    """Interleaved zigzag lon/lat deltas at SHAPE_SCALE, restarting at each edge."""
    if not len(graph.shape_lon):
        return np.zeros(0, dtype=np.uint16)
    lon = np.round(graph.shape_lon * SHAPE_SCALE).astype(np.int64)
    lat = np.round(graph.shape_lat * SHAPE_SCALE).astype(np.int64)
    anchor_lon = np.round(graph.lon[graph.edge_a] * SHAPE_SCALE).astype(np.int64)
    anchor_lat = np.round(graph.lat[graph.edge_a] * SHAPE_SCALE).astype(np.int64)
    has_shape = graph.shape_count > 0
    starts = np.zeros(len(lon), dtype=bool)
    starts[np.concatenate([[0], np.cumsum(graph.shape_count)])[:-1][has_shape]] = True
    base_lon = np.where(starts, np.repeat(anchor_lon, graph.shape_count), np.concatenate([[0], lon[:-1]]))
    base_lat = np.where(starts, np.repeat(anchor_lat, graph.shape_count), np.concatenate([[0], lat[:-1]]))
    deltas = np.stack([_zigzag(lon - base_lon), _zigzag(lat - base_lat)], axis=1).ravel()
    assert deltas.max(initial=0) <= np.iinfo(np.uint16).max, "a shape delta no longer fits uint16"
    return deltas.astype(np.uint16)


def _quantise(graph: RoutingGraph) -> list[tuple[str, np.ndarray]]:
    """Pack every field into its wire type, checking rather than clamping.

    A value that no longer fits is a broken assumption about the network; truncating
    it silently would surface as a wrong route rather than an error.
    """
    def fit(values: np.ndarray, dtype, what: str) -> np.ndarray:
        assert values.min(initial=0) >= 0 and values.max(initial=0) <= np.iinfo(dtype).max, \
            f"{what} no longer fits {dtype.__name__}"
        return values.astype(dtype)

    step = 360.0 / BEARING_STEPS
    return [
        ("lon", np.round(graph.lon * COORDINATE_SCALE).astype(np.int32)),
        ("lat", np.round(graph.lat * COORDINATE_SCALE).astype(np.int32)),
        ("node_kind", fit(graph.node_kind, np.uint8, "a junction kind")),
        ("degree", np.minimum(graph.degree, np.iinfo(np.uint8).max).astype(np.uint8)),
        ("edge_a", fit(graph.edge_a, np.uint32, "a node index")),
        ("edge_b", fit(graph.edge_b, np.uint32, "a node index")),
        ("edge_length", fit(np.round(graph.edge_length * 10), np.uint16, "an edge length")),
        ("edge_unpaved", fit(np.round(graph.edge_unpaved * 10), np.uint16, "an unpaved length")),
        ("edge_shared", fit(np.round(graph.edge_shared * 10), np.uint16, "a shared length")),
        ("edge_traffic", fit(graph.edge_traffic, np.uint8, "a traffic class")),
        ("edge_lit", fit(np.round(graph.edge_lit * 10), np.uint16, "a lit length")),
        ("edge_grade", fit(graph.edge_grade, np.uint8, "a surface grade")),
        ("edge_barriers", fit(graph.edge_barriers, np.uint8, "a barrier count")),
        ("node_barrier", fit(graph.node_barrier, np.uint8, "a barrier kind")),
        ("edge_signals", fit(graph.edge_signals, np.uint8, "an interior signal count")),
        ("edge_crossings", fit(graph.edge_crossings, np.uint8, "an interior crossing count")),
        ("edge_name", fit(graph.edge_name, np.uint32, "a street-name index")),
        ("edge_access", fit(graph.edge_access, np.uint8, "an access bitfield")),
        ("edge_class", fit(graph.edge_class, np.uint8, "a way class")),
        ("bearing_a", (np.round(graph.bearing_a / step) % BEARING_STEPS).astype(np.uint8)),
        ("bearing_b", (np.round(graph.bearing_b / step) % BEARING_STEPS).astype(np.uint8)),
        ("shape_count", fit(graph.shape_count, np.uint16, "a shape-point count")),
        ("shape_delta", _shape_deltas(graph)),
        ("shape_kind", fit(graph.shape_kind, np.uint8, "a shape-point kind")),
        ("name_blob", np.frombuffer("\n".join(graph.names).encode("utf-8"), dtype=np.uint8)),
    ]


def write_routing_graph(graph: RoutingGraph, directory: Path) -> dict[str, object]:
    """Write ``graph.bin.gz`` plus the manifest that tells the browser how to read it.

    One blob rather than a file per array: the page needs all of it before it can
    answer anything, so a single request beats fourteen.
    """
    directory.mkdir(parents=True, exist_ok=True)
    blob = bytearray()
    layout: dict[str, object] = {}
    for name, array in _quantise(graph):
        blob.extend(b"\0" * (-len(blob) % 4))  # typed-array views need their own alignment
        layout[name] = {
            "offset": len(blob), "count": int(array.size),
            "type": array.dtype.name, "encoding": _ENCODING[name],
        }
        blob.extend(array.tobytes())
    (directory / "graph.bin.gz").write_bytes(gzip.compress(bytes(blob), compresslevel=9, mtime=0))

    manifest = {
        # 2 added a name per edge and a kind per shape point; 3 which way round each
        # edge may be ridden; 4 what kind of way it is; 5 which signals are crossed
        # in two goes. The page refuses an older graph rather than drawing routes
        # with their lights missing, riding the wrong way up them, sending riders
        # down a carriageway beside a cycleway, or charging one wait for two.
        # 6 added the signposted cycle network.
        "version": 9,
        "coordinate_scale": COORDINATE_SCALE,
        "shape_scale": SHAPE_SCALE,
        "bearing_steps": BEARING_STEPS,
        "node_count": int(graph.lon.size),
        "edge_count": int(graph.edge_a.size),
        "shape_point_count": int(graph.shape_lon.size),
        "name_count": len(graph.names),
        "oneway_edge_count": int((graph.edge_access != 3).sum()),
        "dedicated_edge_count": int((graph.edge_class & EDGE_DEDICATED).astype(bool).sum()),
        "sidepath_edge_count": int((graph.edge_class & EDGE_SIDEPATH).astype(bool).sum()),
        "barrier_node_count": int((graph.node_barrier > 0).sum()),
        "barrier_inside_edges": int(graph.edge_barriers.sum()),
        "network_edge_count": int((graph.edge_class & EDGE_NETWORK).astype(bool).sum()),
        "two_stage_signal_count": int((graph.node_kind == 3).sum()) + int((graph.shape_kind == 3).sum()),
        "attribution": "OpenStreetMap contributors; traffic signals also Helsinki, Espoo and Vantaa (CC BY 4.0)",
        # Not min(initial=0.0): that returns the smaller of the array and zero, which
        # for positive coordinates is always zero. The page refuses a GPS fix outside
        # these bounds, so a zeroed west/south silently accepted half the planet.
        "bounds": [
            float(graph.lon.min()), float(graph.lat.min()),
            float(graph.lon.max()), float(graph.lat.max()),
        ] if graph.lon.size else [0.0, 0.0, 0.0, 0.0],
        "bytes": len(blob),
        "layout": layout,
        # The page prices routes from these, so a recalibrated penalty ships with
        # the graph instead of being copied into the JavaScript.
        "cost": {
            "signal_delay_s": SIGNAL_DELAY_S,
            "crossing_delay_s": CROSSING_DELAY_S,
            "turn_penalty_s": TURN_PENALTY_S,
            "turn_left_factor": TURN_LEFT_FACTOR,
            "turn_degrees": TURN_DEGREES,
            "turn_merge_m": TURN_MERGE_M,
            "slow_speed_factor": SLOW_SPEED_FACTOR,
            "network_bonus": NETWORK_BONUS,
        },
    }
    (directory / "graph.json").write_text(json.dumps(manifest, indent=2, sort_keys=True))
    return manifest


SIGNAL_REGISTER = Path(__file__).resolve().parent / "signals.json"


def read_register(path: Path = SIGNAL_REGISTER) -> list[dict]:
    """The cities' signalised junctions, as `tools/fetch_signals.py` wrote them."""
    if not path.is_file():
        print(f"    no signal register at {path}; run tools/fetch_signals.py")
        return []
    return json.loads(path.read_text())["signals"]


def export_routing_graph(pbf: Path, directory: Path, bounds=HSY_BOUNDS) -> dict[str, object]:
    graph = build_routing_graph(read_network(pbf, bounds), bounds, read_register())
    return write_routing_graph(graph, directory)


def main(argv: list[str]) -> int:
    arguments = [value for value in argv if not value.startswith("--")]
    if not arguments:
        print(__doc__)
        return 2
    pbf = Path(arguments[0])
    directory = Path(arguments[1]) if len(arguments) > 1 else Path(__file__).resolve().parents[1] / "public" / "graph"
    started = time.time()
    manifest = export_routing_graph(pbf, directory, None if "--full" in argv else HSY_BOUNDS)
    size = (directory / "graph.bin.gz").stat().st_size
    print(
        f"{manifest['node_count']:,} nodes, {manifest['edge_count']:,} edges, "
        f"{manifest['shape_point_count']:,} shape points\n"
        f"{manifest['bytes'] / 1e6:.1f} MB raw -> {size / 1e6:.1f} MB gzipped "
        f"in {time.time() - started:.0f}s -> {directory}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
