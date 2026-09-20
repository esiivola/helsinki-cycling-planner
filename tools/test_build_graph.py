from __future__ import annotations

from pathlib import Path

import numpy as np

from build_graph import (
    CROSSING_DELAY_S,
    TURN_LEFT_FACTOR,
    SIGNAL_DELAY_S,
    SLOW_SPEED_FACTOR,
    TURN_DEGREES,
    TURN_MERGE_M,
    TURN_PENALTY_S,
    build_routing_graph,
    export_routing_graph,
    read_network,
)

# 1 -- 2 -- 3 runs due east; 4 sits north of 3 and 5 further east of it, so node 3
# is a three-armed junction and node 2 is a pass-through the contraction absorbs.
# Node 6 sits north of 2, used where a chain has to bend between its ends.
NODES = (
    '<node id="1" lat="60.170" lon="24.940"/>'
    '<node id="2" lat="60.170" lon="24.942"/>'
    '<node id="3" lat="60.170" lon="24.944"/>'
    '<node id="4" lat="60.172" lon="24.944"/>'
    '<node id="5" lat="60.170" lon="24.946"/>'
    '<node id="6" lat="60.172" lon="24.942"/>'
)
JUNCTION_WAYS = "{chain}" + '<way id="11"><nd ref="3"/><nd ref="4"/><tag k="highway" v="residential"/></way>'
JUNCTION_WAYS += '<way id="12"><nd ref="3"/><nd ref="5"/><tag k="highway" v="residential"/></way>'


def _write(path: Path, nodes: str, ways: str) -> Path:
    path.write_text(f'<osm version="0.6">{nodes}{ways}</osm>')
    return path


def _way(identifier: int, refs: tuple[int, ...], **tags: str) -> str:
    body = "".join(f'<nd ref="{ref}"/>' for ref in refs)
    body += '<tag k="highway" v="residential"/>' if "highway" not in tags else ""
    body += "".join(f'<tag k="{key}" v="{value}"/>' for key, value in tags.items())
    return f'<way id="{identifier}">{body}</way>'


def _graph(tmp_path: Path, nodes: str, ways: str, register: list[dict] | None = None):
    network = read_network(_write(tmp_path / "graph.osm", nodes, ways))
    return build_routing_graph(network, None, register)


def _longest(graph) -> int:
    return int(np.argmax(graph.edge_length))


def test_a_run_of_pass_through_nodes_becomes_one_edge(tmp_path: Path) -> None:
    # Only 1, 3, 4 and 5 are places a rider chooses; node 2 survives as shape, not
    # as a node, and its edge carries the summed length of both segments.
    graph = _graph(tmp_path, NODES, JUNCTION_WAYS.format(chain=_way(10, (1, 2, 3))))

    assert len(graph.lon) == 4
    chain = _longest(graph)
    assert 200 < graph.edge_length[chain] < 230  # two ~111 m segments, not the straight line
    assert graph.shape_count[chain] == 1  # node 2 survives as shape, not as a node


def test_an_interior_signal_is_counted_on_the_edge_not_a_node(tmp_path: Path) -> None:
    # The light sits at node 2, inside the chain. Nothing in the contracted graph
    # stands at that spot any more, so the edge has to carry the count.
    nodes = NODES.replace(
        '<node id="2" lat="60.170" lon="24.942"/>',
        '<node id="2" lat="60.170" lon="24.942"><tag k="highway" v="traffic_signals"/></node>',
    )
    graph = _graph(tmp_path, nodes, JUNCTION_WAYS.format(chain=_way(10, (1, 2, 3))))

    assert graph.edge_signals[_longest(graph)] == 1
    assert graph.edge_crossings.sum() == 0
    assert graph.node_kind.max() == 0


def test_an_interior_signal_keeps_its_position_on_the_shape(tmp_path: Path) -> None:
    # Counting the light is not enough to draw it: the shape point it was collapsed
    # into has to say what it was, or the map can only show the lights that happen
    # to stand at a junction -- under half of them.
    nodes = NODES.replace(
        '<node id="2" lat="60.170" lon="24.942"/>',
        '<node id="2" lat="60.170" lon="24.942"><tag k="highway" v="traffic_signals"/></node>',
    )
    graph = _graph(tmp_path, nodes, JUNCTION_WAYS.format(chain=_way(10, (1, 2, 3))))

    chain = _longest(graph)
    start = int(np.concatenate([[0], np.cumsum(graph.shape_count)])[chain])
    assert graph.shape_kind[start] == 2
    assert graph.shape_lon[start] == 24.942


def test_an_edge_is_named_after_the_way_carrying_most_of_it(tmp_path: Path) -> None:
    # The chain runs over two ways: a long named street and a short unnamed stub at
    # the end. The rider knows the street, so the name has to survive the merge.
    ways = _way(10, (1, 2), name="Hämeentie") + _way(13, (2, 3))
    graph = _graph(tmp_path, NODES, JUNCTION_WAYS.format(chain=ways))

    assert graph.names[graph.edge_name[_longest(graph)]] == "Hämeentie"


def test_an_unnamed_edge_points_at_the_empty_name(tmp_path: Path) -> None:
    graph = _graph(tmp_path, NODES, JUNCTION_WAYS.format(chain=_way(10, (1, 2, 3))))

    assert graph.names[0] == ""
    assert graph.edge_name[_longest(graph)] == 0


# A one-way edge only survives where a rider can get back: 1 -> 2 -> 3 one way, and
# 3 -- 6 -- 1 back again, with a stub at 8 that keeps node 1 a junction.
LOOP_NODES = NODES + '<node id="8" lat="60.170" lon="24.938"/>'
LOOP_WAYS = _way(16, (3, 6, 1)) + _way(17, (1, 8))


def _only_one_way(graph) -> int:
    """The single edge the fixture tagged one-way, whichever end contraction took."""
    found = [index for index, access in enumerate(graph.edge_access) if access != 3]
    assert len(found) == 1
    return found[0]


def test_a_one_way_chain_is_rideable_only_one_way(tmp_path: Path) -> None:
    graph = _graph(tmp_path, LOOP_NODES, JUNCTION_WAYS.format(chain=_way(10, (1, 2, 3), oneway="yes") + LOOP_WAYS))

    edge = _only_one_way(graph)
    assert graph.edge_access[edge] in (1, 2)  # which bit depends on which end is `a`
    assert 200 < graph.edge_length[edge] < 230  # and it is the chain through node 2


def test_a_contraflow_cycle_lane_keeps_the_street_two_way(tmp_path: Path) -> None:
    # A Helsinki one-way street with a contraflow lane: one-way for a car, both ways
    # for a bicycle. Reading only `oneway` would send riders the long way round.
    for tags in ({"oneway": "yes", "oneway:bicycle": "no"}, {"oneway": "yes", "cycleway": "opposite_lane"}):
        graph = _graph(tmp_path, LOOP_NODES, JUNCTION_WAYS.format(chain=_way(10, (1, 2, 3), **tags) + LOOP_WAYS))

        assert (graph.edge_access == 3).all()


def test_a_roundabout_is_one_way_even_untagged(tmp_path: Path) -> None:
    graph = _graph(tmp_path, LOOP_NODES, JUNCTION_WAYS.format(chain=_way(10, (1, 2, 3), junction="roundabout") + LOOP_WAYS))

    assert graph.edge_access[_only_one_way(graph)] in (1, 2)


def test_a_pocket_reachable_only_the_wrong_way_is_dropped(tmp_path: Path) -> None:
    # Node 6 hangs off node 2 by a one-way way pointing *out* of the network, so a
    # rider can leave for it but never come back -- and, from 6, never reach 1 at
    # all. Undirected connectivity keeps it; strong connectivity does not.
    nodes = NODES + '<node id="7" lat="60.174" lon="24.942"/>'
    ways = _way(10, (1, 2, 3)) + _way(14, (2, 6), oneway="yes") + _way(15, (6, 7))
    graph = _graph(tmp_path, nodes, JUNCTION_WAYS.format(chain=ways))

    assert (graph.edge_access == 3).all()  # only two-way edges survive


def test_a_crossing_at_a_junction_stays_on_the_node(tmp_path: Path) -> None:
    # At node 3 a rider can turn, so the junction survives and keeps its own delay.
    # Charging it to one edge would make the cost depend on the direction of approach.
    nodes = NODES.replace(
        '<node id="3" lat="60.170" lon="24.944"/>',
        '<node id="3" lat="60.170" lon="24.944"><tag k="highway" v="crossing"/></node>',
    )
    graph = _graph(tmp_path, nodes, JUNCTION_WAYS.format(chain=_way(10, (1, 2, 3))))

    assert list(graph.node_kind).count(1) == 1
    assert graph.edge_signals.sum() == 0 and graph.edge_crossings.sum() == 0


def test_both_ends_of_a_bending_edge_keep_their_own_bearing(tmp_path: Path) -> None:
    # The chain 1 -- 2 -- 6 leaves node 1 heading east and arrives at node 6 heading
    # north. One bearing per edge would misprice the turn at whichever end it dropped.
    graph = _graph(tmp_path, NODES, _way(10, (1, 2, 6)))

    bend = _longest(graph)
    assert 88 < graph.bearing_a[bend] < 92
    assert graph.bearing_b[bend] < 2 or graph.bearing_b[bend] > 358


def test_slow_metres_are_measured_over_the_chain_not_the_whole_edge(tmp_path: Path) -> None:
    # Half the chain is gravel. The edge has to say how much of it is slow: a single
    # boolean would either free the gravel half or condemn the paved one.
    chain = _way(10, (1, 2)) + _way(13, (2, 3), surface="gravel")
    graph = _graph(tmp_path, NODES, JUNCTION_WAYS.format(chain=chain))

    edge = _longest(graph)
    assert 0.4 < graph.edge_unpaved[edge] / graph.edge_length[edge] < 0.6
    assert graph.edge_shared[edge] == 0


def test_rough_and_crowded_are_told_apart_and_never_counted_twice(tmp_path: Path) -> None:
    # A gravel path full of walkers is one slow stretch, not two. Counting it under
    # both headings would make the two lengths overrun the edge they sit on.
    chain = _way(10, (1, 2), highway="path", foot="yes") + _way(13, (2, 3), surface="gravel")
    graph = _graph(tmp_path, NODES, JUNCTION_WAYS.format(chain=chain))

    edge = _longest(graph)
    assert graph.edge_unpaved[edge] > 0
    assert graph.edge_shared[edge] > 0
    total = graph.edge_unpaved[edge] + graph.edge_shared[edge]
    assert total <= graph.edge_length[edge] + 1e-6


def test_the_edge_takes_the_traffic_class_carrying_most_of_its_metres(tmp_path: Path) -> None:
    # A long residential street crossed by a short service stub is a residential
    # street; letting the stub speak for the whole edge is how a quiet route gets
    # marked as traffic.
    chain = _way(10, (1, 2), highway="residential") + _way(13, (2, 3), highway="service")
    graph = _graph(tmp_path, NODES, JUNCTION_WAYS.format(chain=chain))

    edge = _longest(graph)
    assert graph.edge_traffic[edge] == 1  # both are calm, so calm either way


def test_an_arterial_is_not_a_cul_de_sac(tmp_path: Path) -> None:
    chain = _way(10, (1, 2, 3), highway="primary")
    graph = _graph(tmp_path, NODES, JUNCTION_WAYS.format(chain=chain))
    assert graph.edge_traffic[_longest(graph)] == 4

    chain = _way(10, (1, 2, 3), highway="cycleway")
    graph = _graph(tmp_path, NODES, JUNCTION_WAYS.format(chain=chain))
    assert graph.edge_traffic[_longest(graph)] == 0


def test_an_island_is_excluded_from_the_main_component(tmp_path: Path) -> None:
    # Snapping a query onto a disconnected stub is how a whole layer once went blank.
    nodes = NODES + '<node id="90" lat="60.200" lon="24.990"/><node id="91" lat="60.200" lon="24.992"/>'
    ways = JUNCTION_WAYS.format(chain=_way(10, (1, 2, 3))) + _way(99, (90, 91))
    graph = _graph(tmp_path, nodes, ways)

    assert len(graph.lon) == 4  # the two island nodes never reach the exported graph
    assert not (graph.lat > 60.19).any()


def test_the_export_round_trips_through_the_manifest(tmp_path: Path) -> None:
    manifest = export_routing_graph(
        _write(tmp_path / "graph.osm", NODES, JUNCTION_WAYS.format(chain=_way(10, (1, 2, 3)))),
        tmp_path / "out",
    )

    assert manifest["node_count"] == 4
    assert manifest["cost"]["signal_delay_s"] == SIGNAL_DELAY_S
    assert manifest["layout"]["node_kind"]["type"] == "uint8"
    assert (tmp_path / "out" / "graph.bin.gz").is_file()
    for section in manifest["layout"].values():
        assert section["offset"] % 4 == 0  # typed-array views cannot straddle alignment


def test_the_cost_model_still_matches_the_housing_map() -> None:
    """The constants are duplicated from the housing map's cycling layer on purpose.

    This service ships separately and must keep working on its own, but two copies
    of a calibrated model drift silently. Pinning them means a deliberate change
    here fails loudly and has to be mirrored there -- or consciously not.

    Every shared constant still matches. The left-turn factor is an addition rather
    than a divergence: the housing map measures turns after routing and cannot tell
    the two directions apart, while this router prices them inside the search.
    """
    assert (SIGNAL_DELAY_S, TURN_PENALTY_S, CROSSING_DELAY_S) == (30.0, 10.0, 2.0)
    assert (TURN_DEGREES, TURN_MERGE_M, SLOW_SPEED_FACTOR) == (40.0, 25.0, 0.65)
    # Not in the housing map's model at all; swept in `scripts/bench_turns.mjs`.
    assert TURN_LEFT_FACTOR == 1.5
    # A left plus a right must stay cheaper than the light such a detour dodges.
    assert TURN_PENALTY_S * (1 + TURN_LEFT_FACTOR) < SIGNAL_DELAY_S


def test_the_manifest_bounds_enclose_the_graph(tmp_path: Path) -> None:
    """The page refuses a GPS fix outside these bounds, so they must be real.

    `min(initial=0.0)` returns the lesser of the array and zero, which for positive
    coordinates is always zero -- and a west/south of 0 accepts most of the planet.
    """
    manifest = export_routing_graph(
        _write(tmp_path / "graph.osm", NODES, JUNCTION_WAYS.format(chain=_way(10, (1, 2, 3)))),
        tmp_path / "out",
    )
    west, south, east, north = manifest["bounds"]

    assert 24.9 < west <= east < 25.0
    assert 60.1 < south <= north < 60.2


def test_a_road_with_a_cycleway_alongside_is_marked_even_when_untagged(tmp_path: Path) -> None:
    # Helsinginkatu carries cycle tracks its carriageway never mentions, so tags
    # alone leave riders on the carriageway. The geometry is what settles it.
    nodes = NODES + (
        '<node id="20" lat="60.16990" lon="24.940"/>'   # ~11 m south of node 1
        '<node id="21" lat="60.16990" lon="24.944"/>'
    )
    ways = _way(10, (1, 2, 3)) + _way(18, (20, 21), highway="cycleway")
    graph = _graph(tmp_path, nodes, JUNCTION_WAYS.format(chain=ways))

    road = _longest(graph)
    assert graph.names[graph.edge_name[road]] == ""
    assert graph.edge_class[road] & 2  # EDGE_SIDEPATH


def test_a_cycleway_merely_crossing_does_not_mark_the_road(tmp_path: Path) -> None:
    # A path crossing at right angles is not a path beside the road; marking it
    # would close streets that have no cycle facility at all.
    nodes = NODES + (
        '<node id="22" lat="60.1695" lon="24.9421"/>'
        '<node id="23" lat="60.1705" lon="24.9421"/>'
    )
    ways = _way(10, (1, 2, 3)) + _way(19, (22, 23), highway="cycleway")
    graph = _graph(tmp_path, nodes, JUNCTION_WAYS.format(chain=ways))

    assert not graph.edge_class[_longest(graph)] & 2


# A carriageway running east-west with its signal at node 31, and node 33 eleven
# metres west of it where something else meets the road. 0.0002 deg of longitude is
# ~11 m here, 0.001 deg of latitude ~111 m.
SIGNAL_NODES = (
    '<node id="30" lat="60.1700" lon="24.9400"/>'
    '<node id="33" lat="60.1700" lon="24.9418"><tag k="highway" v="crossing"/></node>'
    '<node id="31" lat="60.1700" lon="24.9420"><tag k="highway" v="traffic_signals"/></node>'
    '<node id="32" lat="60.1700" lon="24.9440"/>'
    '<node id="34" lat="60.1710" lon="24.9418"/>'
    '<node id="35" lat="60.1690" lon="24.9418"/>'
    '<node id="36" lat="60.1700" lon="24.9380"/>'
)
ROAD = _way(40, (30, 33, 31, 32))


def _signalled(graph) -> list[int]:
    """Junctions the rider waits at: 2 is one wait, 3 is a crossing made in two."""
    return [index for index, kind in enumerate(graph.node_kind) if kind in (2, 3)]


def _lit(graph) -> set[tuple[float, float]]:
    """Every point with a light, junctions and the ones contraction swallowed alike.

    A light often lands on a pass-through node, which survives as a shape point
    rather than a node; counting only nodes misses most of them.
    """
    points = {(round(float(graph.lon[n]), 7), round(float(graph.lat[n]), 7)) for n in _signalled(graph)}
    points |= {
        (round(float(x), 7), round(float(y), 7))
        for x, y, kind in zip(graph.shape_lon, graph.shape_lat, graph.shape_kind) if kind in (2, 3)
    }
    return points


def test_a_rider_crossing_a_signalled_road_waits_at_its_light(tmp_path: Path) -> None:
    # The light is tagged on the carriageway, as 52% of the region's are, and the
    # cycleway crossing carries no signal tag of its own. Without this the junction
    # is free to a rider and the route is priced 30 s short.
    graph = _graph(tmp_path, SIGNAL_NODES, ROAD + _way(41, (34, 33, 35), highway="cycleway"))

    assert len(_signalled(graph)) == 1
    assert graph.lon[_signalled(graph)[0]] == 24.9418  # the crossing, not the signal


def test_a_light_beside_a_cycleway_going_the_same_way_is_not_the_riders(tmp_path: Path) -> None:
    # The cycleway joins the road at node 33 but runs the same way it does, so the
    # light at 31 faces the cars. Charging the rider 30 s for it would invent a
    # stop that never happens.
    graph = _graph(tmp_path, SIGNAL_NODES, ROAD + _way(42, (36, 33), highway="cycleway"))

    assert _signalled(graph) == []


def test_a_crossing_with_a_refuge_island_is_two_waits(tmp_path: Path) -> None:
    # One set of lights, two goes: the rider clears the first carriageway, waits on
    # the island, and crosses the second. Charging it once prices the junction short.
    nodes = SIGNAL_NODES.replace(
        '<node id="33" lat="60.1700" lon="24.9418"><tag k="highway" v="crossing"/></node>',
        '<node id="33" lat="60.1700" lon="24.9418">'
        '<tag k="highway" v="crossing"/><tag k="crossing" v="traffic_signals"/>'
        '<tag k="crossing:island" v="yes"/></node>',
    )
    graph = _graph(tmp_path, nodes, ROAD + _way(41, (34, 33, 35), highway="cycleway"))

    assert len(_signalled(graph)) == 1
    assert graph.node_kind[_signalled(graph)[0]] == 3


def test_the_two_carriageways_of_a_dual_road_are_two_waits(tmp_path: Path) -> None:
    # Two crossing nodes 22 m apart, one per carriageway, each picking up the light
    # on its own road. They are one junction but two waits -- what makes crossing
    # Mannerheimintie cost what it does -- so neither may suppress the other.
    nodes = (
        '<node id="50" lat="60.1700" lon="24.9400"/>'
        '<node id="51" lat="60.1700" lon="24.9418"><tag k="highway" v="crossing"/></node>'
        '<node id="52" lat="60.1700" lon="24.9420"><tag k="highway" v="traffic_signals"/></node>'
        '<node id="53" lat="60.1700" lon="24.9440"/>'
        '<node id="54" lat="60.1704" lon="24.9400"/>'
        '<node id="55" lat="60.1704" lon="24.9418"><tag k="highway" v="crossing"/></node>'
        '<node id="56" lat="60.1704" lon="24.9420"><tag k="highway" v="traffic_signals"/></node>'
        '<node id="57" lat="60.1704" lon="24.9440"/>'
        '<node id="58" lat="60.1690" lon="24.9418"/>'
        '<node id="59" lat="60.1710" lon="24.9418"/>'
    )
    ways = (
        _way(60, (50, 51, 52, 53), oneway="yes")        # one carriageway
        + _way(61, (54, 55, 56, 57), oneway="yes")      # the other, ~44 m north
        + _way(62, (58, 51, 55, 59), highway="cycleway")  # the rider, crossing both
    )
    graph = _graph(tmp_path, nodes, ways)

    assert len(_signalled(graph)) == 2


def test_a_junction_in_the_city_register_gets_its_light(tmp_path: Path) -> None:
    # OSM has nothing signalised here; the city says the junction is. The light goes
    # on the node where the rider's path meets the road, not on the register's own
    # point, which is the middle of the junction.
    graph = _graph(
        tmp_path, SIGNAL_NODES,
        _way(40, (30, 33, 31, 32)) + _way(41, (34, 33, 35), highway="cycleway"),
        register=[{"lon": 24.9419, "lat": 60.1700, "city": "Helsinki", "name": "test"}],
    )

    assert graph.node_kind[_signalled(graph)[0]] == 2
    assert graph.lon[_signalled(graph)[0]] == 24.9418  # the crossing the rider makes


def test_the_register_does_not_double_a_light_osm_already_has(tmp_path: Path) -> None:
    nodes = SIGNAL_NODES.replace(
        '<node id="33" lat="60.1700" lon="24.9418"><tag k="highway" v="crossing"/></node>',
        '<node id="33" lat="60.1700" lon="24.9418">'
        '<tag k="highway" v="crossing"/><tag k="crossing" v="traffic_signals"/></node>',
    )
    ways = _way(40, (30, 33, 31, 32)) + _way(41, (34, 33, 35), highway="cycleway")

    without = _graph(tmp_path, nodes, ways)
    with_register = _graph(
        tmp_path, nodes, ways,
        register=[{"lon": 24.9419, "lat": 60.1700, "city": "Helsinki", "name": "test"}],
    )

    assert len(_signalled(with_register)) == len(_signalled(without)) == 1


def test_a_register_junction_with_no_crossing_nearby_is_left_alone(tmp_path: Path) -> None:
    # A junction ~450 m from anything the rider crosses, on a road with no signal of
    # its own. Reaching for the nearest node regardless would drop a light on a
    # street corner the register never meant.
    nodes = SIGNAL_NODES.replace('<tag k="highway" v="traffic_signals"/>', "")
    graph = _graph(
        tmp_path, nodes,
        _way(40, (30, 33, 31, 32)) + _way(41, (34, 33, 35), highway="cycleway"),
        register=[{"lon": 24.9500, "lat": 60.1700, "city": "Helsinki", "name": "far away"}],
    )

    assert _signalled(graph) == []


# A junction where the cycleway runs through without sharing a node with the road --
# the commonest orphan, 52 of the region's 67 -- plus a link west so the path is part
# of the network. 0.0003 deg of latitude is ~33 m, inside the register's 40 m reach.
# A signalised crossroads with a cycleway crossing it that shares no node with the
# road, joined to it a few metres away -- which is what a big Helsinki junction looks
# like. The link is short on purpose: measured over the real register, 95% of
# junctions put their nearest cycleway node within 57 m of the road to ride.
CROSSING_NODES = (
    '<node id="70" lat="60.1700" lon="24.9400"/>'
    '<node id="76" lat="60.1700" lon="24.9414"/>'
    '<node id="71" lat="60.1700" lon="24.9418"/>'
    '<node id="72" lat="60.1700" lon="24.9440"/>'
    '<node id="73" lat="60.17015" lon="24.9418"/>'
    '<node id="74" lat="60.16985" lon="24.9418"/>'
    '<node id="75" lat="60.17015" lon="24.9414"/>'
)
CROSSING_REGISTER = [{"lon": 24.9418, "lat": 60.1700, "city": "Helsinki", "name": "test"}]


def _crossing_ways(**cycle_tags: str) -> str:
    return (
        _way(70, (70, 76, 71, 72))                               # the road
        + _way(71, (73, 74), highway="cycleway", **cycle_tags)   # straight through it
        + _way(72, (75, 73), highway="cycleway")                 # a link, so it connects
        + _way(73, (76, 75), highway="cycleway")
    )


def test_a_register_junction_reaches_a_cycleway_that_shares_no_node(tmp_path: Path) -> None:
    graph = _graph(tmp_path, CROSSING_NODES, _crossing_ways(), register=CROSSING_REGISTER)

    # One on the path the rider is on, one on the carriageway: a rider passes one.
    lit = _lit(graph)
    assert (24.9418, 60.17015) in lit or (24.9418, 60.16985) in lit
    assert (24.9418, 60.1700) in lit


def test_a_sidepath_running_alongside_gets_no_light(tmp_path: Path) -> None:
    """A light between a road and the path beside it faces the drivers.

    2,686 of the region's signals are `highway=traffic_signals` standing on a
    carriageway and on nothing else. Where a cycleway runs parallel to that road --
    which is what a sidepath does for most of its length -- the nearest cycleway node
    to the register's point is one the rider rides straight past. Charging them 30 s
    there is inventing a wait that never happens.
    """
    nodes = (
        '<node id="80" lat="60.1700" lon="24.9400"/>'      # road, running east
        '<node id="81" lat="60.1700" lon="24.9418"/>'
        '<node id="82" lat="60.1700" lon="24.9440"/>'
        '<node id="83" lat="60.17018" lon="24.9400"/>'     # cycleway, parallel, 20 m north
        '<node id="84" lat="60.17018" lon="24.9418"/>'
        '<node id="85" lat="60.17018" lon="24.9440"/>'
    )
    ways = _way(80, (80, 81, 82)) + _way(81, (83, 84, 85), highway="cycleway")
    register = [{"lon": 24.9418, "lat": 60.1700, "city": "Helsinki", "name": "parallel"}]
    graph = _graph(tmp_path, nodes, ways, register=register)

    lit = _lit(graph)
    assert (24.9418, 60.17018) not in lit   # the rider never crosses anything here
    assert (24.9418, 60.1700) in lit        # the drivers still get their light


def test_a_cycleway_that_only_passes_beneath_gets_no_light(tmp_path: Path) -> None:
    """The Baana problem, and the reason the register is snapped by riding distance.

    A cycle route in a cutting runs beneath the streets it crosses. Its nodes sit
    within metres of a signalised junction in plan view and a long way from it to
    ride -- 42 m against 333 m on the real Baana -- because reaching the junction
    means climbing a ramp and coming back. Nothing in the tags says so: the cutting
    is not a tunnel and carries no `layer`, because it is the street overhead that is
    the bridge. Only the network distance tells the two apart.
    """
    # Same crossing, but the only way between the cycleway and the road is the long
    # way round, as an underpass would be.
    nodes = CROSSING_NODES + '<node id="77" lat="60.1730" lon="24.9414"/>'
    ways = (
        _way(70, (70, 76, 71, 72))
        + _way(71, (73, 74), highway="cycleway")
        + _way(72, (75, 73), highway="cycleway")
        + _way(74, (77, 75), highway="cycleway")   # a ramp, 330 m north
        + _way(75, (76, 77), highway="cycleway")
    )
    graph = _graph(tmp_path, nodes, ways, register=CROSSING_REGISTER)

    lit = _lit(graph)
    assert (24.9418, 60.17015) not in lit and (24.9418, 60.16985) not in lit
    assert (24.9418, 60.1700) in lit  # the carriageway through the junction still has it


def test_a_rider_passing_under_a_junction_gets_no_light(tmp_path: Path) -> None:
    # An underpass is the one place where passing a signalised junction is not
    # waiting at it, and the register -- one point for the whole junction -- cannot
    # tell the two apart. The carriageway above still gets its light.
    graph = _graph(tmp_path, CROSSING_NODES, _crossing_ways(tunnel="yes"), register=CROSSING_REGISTER)

    lit = _lit(graph)
    assert (24.9418, 60.17015) not in lit and (24.9418, 60.16985) not in lit
    assert (24.9418, 60.1700) in lit  # the carriageway above still has its light
