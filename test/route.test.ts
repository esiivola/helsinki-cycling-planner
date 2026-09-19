import { describe, expect, it } from "vitest";
import { Router } from "../src/route.ts";
import { COST, type EdgeSpec, graphOf, metresBetween } from "./graph-fixture.ts";

// Node 0 in the west, node 2 in the east, and two ways between them.
//
//          1                 the direct road, bowed north: longer, but node 1 has
//        /   \               two arms, so its bend is a curve and never a turn
//   0 ---------- 2
//   |            |           the bypass: two 2 m slip roads onto a straight run,
//   3 ---------- 5           so it is shorter -- at the price of a corner at each
//   |            |           end, where the stubs 6 and 7 make a real junction
//   6            7
const WEST = 24.9300;
const EAST = 24.9372;
const MAIN = 60.1720;
const BYPASS = 60.17198; // ~2 m south of the main road
const NODES: [number, number][] = [
  [WEST, MAIN], [(WEST + EAST) / 2, MAIN + 0.0009], [EAST, MAIN],
  [WEST, BYPASS], [(WEST + EAST) / 2, BYPASS], [EAST, BYPASS],
  [WEST, BYPASS - 0.001], [EAST, BYPASS - 0.001],
];
const STUBS: EdgeSpec[] = [{ a: 3, b: 6 }, { a: 5, b: 7 }];
const BOWED: EdgeSpec[] = [{ a: 0, b: 1 }, { a: 1, b: 2 }];
const BYPASS_ROAD: EdgeSpec[] = [{ a: 3, b: 4 }, { a: 4, b: 5 }];
const SLIPS: EdgeSpec[] = [{ a: 0, b: 3 }, { a: 2, b: 5 }];
const at = (node: number) => NODES[node];

function route(graph: ReturnType<typeof graphOf>, from: number, to: number, chargeTurns = true) {
  return new Router(graph).route(at(from)[0], at(from)[1], at(to)[0], at(to)[1], { speedKmh: 15, chargeTurns });
}

/** Exhaustive search over the same state space, to check what A* prunes away. */
function bestByBruteForce(graph: ReturnType<typeof graphOf>, start: number, target: number): number {
  const metresPerSecond = (15 * 1000) / 3600;
  const edgeSeconds = (edge: number) => {
    const slow = graph.edgeSlow[edge];
    return (graph.edgeLength[edge] - slow) / metresPerSecond
      + slow / (metresPerSecond * COST.slow_speed_factor)
      + graph.edgeSignals[edge] * COST.signal_delay_s
      + graph.edgeCrossings[edge] * COST.crossing_delay_s;
  };
  const nodeSeconds = (node: number) =>
    graph.nodeKind[node] === 2 ? COST.signal_delay_s : graph.nodeKind[node] === 1 ? COST.crossing_delay_s : 0;
  const head = (state: number) => ((state & 1) === 0 ? graph.edgeB : graph.edgeA)[state >> 1];
  const arrival = (state: number) =>
    (state & 1) === 0 ? graph.bearingB[state >> 1] : (graph.bearingA[state >> 1] + 180) % 360;
  const departure = (state: number) =>
    (state & 1) === 0 ? graph.bearingA[state >> 1] : (graph.bearingB[state >> 1] + 180) % 360;
  const swing = (from: number, to: number) => ((to - from + 540) % 360) - 180;
  // Mirrors the router: a left turn costs more than a right one.
  const turnCost = (change: number) => COST.turn_penalty_s * (change < 0 ? COST.turn_left_factor : 1);

  let best = Infinity;
  const walk = (state: number, seconds: number, seen: Set<number>) => {
    if (seconds >= best) return;
    if (head(state) === target) { best = seconds; return; }
    const node = head(state);
    for (let slot = graph.adjacencyStart[node]; slot < graph.adjacencyStart[node + 1]; slot += 1) {
      const edge = graph.adjacency[slot];
      const next = edge * 2 + (graph.edgeA[edge] === node ? 0 : 1);
      if (seen.has(next)) continue;
      const change = swing(arrival(state), departure(next));
      const turn = graph.degree[node] >= 3 && Math.abs(change) >= COST.turn_degrees;
      seen.add(next);
      walk(next, seconds + nodeSeconds(node) + edgeSeconds(edge) + (turn ? turnCost(change) : 0), seen);
      seen.delete(next);
    }
  };
  for (let slot = graph.adjacencyStart[start]; slot < graph.adjacencyStart[start + 1]; slot += 1) {
    const edge = graph.adjacency[slot];
    const state = edge * 2 + (graph.edgeA[edge] === start ? 0 : 1);
    walk(state, edgeSeconds(edge), new Set([state]));
  }
  return best;
}

describe("turn-aware routing", () => {
  it("rides further to avoid two corners", () => {
    const graph = graphOf(NODES, [...BOWED, ...BYPASS_ROAD, ...SLIPS, ...STUBS]);
    const bowed = metresBetween(at(0), at(1)) + metresBetween(at(1), at(2));
    const bypass = 2 * metresBetween(at(0), at(3)) + metresBetween(at(3), at(4)) + metresBetween(at(4), at(5));
    expect(bypass).toBeLessThan(bowed); // the turning route really is the shorter one

    const chosen = route(graph, 0, 2)!;
    expect(chosen.turns).toBe(0);
    expect(chosen.metres).toBeCloseTo(bowed, 0);

    // With turns free the search takes the short way -- which is what the pipeline's
    // node-based routing does, and why the turn counts it measures run high.
    const zigzag = route(graph, 0, 2, false)!;
    expect(zigzag.metres).toBeCloseTo(bypass, 0);
    expect(zigzag.turns).toBe(2);
  });

  it("weighs a traffic light against the detour that avoids it", () => {
    // A straight direct road with a light at its midpoint, and a bypass running
    // parallel `offset` degrees to one side. Node 1 sits only on the direct road,
    // so the bypass genuinely escapes the light rather than sharing its junction.
    // `side` is +1 for a bypass to the north, which is reached by two right turns,
    // and -1 for one to the south, which takes two lefts.
    const lit = (offset: number, side: 1 | -1 = -1) => {
      const shift = side * offset;
      const nodes: [number, number][] = [
        [WEST, MAIN], [(WEST + EAST) / 2, MAIN], [EAST, MAIN],
        [WEST, MAIN + shift], [(WEST + EAST) / 2, MAIN + shift], [EAST, MAIN + shift],
        [WEST, MAIN + shift + side * 0.001], [EAST, MAIN + shift + side * 0.001],
      ];
      return graphOf(
        nodes,
        [{ a: 0, b: 1 }, { a: 1, b: 2 }, ...BYPASS_ROAD, ...SLIPS, ...STUBS],
        [0, 2, 0, 0, 0, 0],
      );
    };

    // Two right turns cost 20 s, so a bypass 2 m away is worth it to dodge 30 s.
    expect(route(lit(0.00002, 1), 0, 2)!.signals).toBe(0);
    // Two *left* turns cost 30 s, and the light costs 30 s: the model no longer
    // pays to dodge it, which is the boundary the left-turn factor puts there.
    expect(COST.turn_penalty_s * 2 * COST.turn_left_factor).toBe(COST.signal_delay_s);
    expect(route(lit(0.00002, -1), 0, 2)!.signals).toBe(1);
    // A bypass 400 m away costs 800 m of extra riding: the light is the lesser evil
    // whichever way you turn into it.
    expect(route(lit(0.0036, 1), 0, 2)!.signals).toBe(1);
  });

  it("charges an unpaved stretch at the slow-surface factor", () => {
    const graph = graphOf(NODES, [{ a: 0, b: 2, slow: 1 }, ...STUBS]);
    const metres = metresBetween(at(0), at(2));

    const ridden = route(graph, 0, 2)!;
    expect(ridden.slowMetres).toBeCloseTo(metres, 0);
    expect(ridden.ridingSeconds).toBeCloseTo(metres / ((15 * 1000) / 3600) / COST.slow_speed_factor, 1);
  });

  it("costs the same ride in both directions", () => {
    const graph = graphOf(NODES, [...BOWED, ...BYPASS_ROAD, ...SLIPS, ...STUBS], [0, 0, 0, 0, 1, 0]);

    expect(route(graph, 0, 7)!.seconds).toBeCloseTo(route(graph, 7, 0)!.seconds, 6);
  });

  it("never counts a bend at a pass-through node as a turn", () => {
    // Node 1 has two arms, so its bend is a curve in the road, not a decision --
    // the rule the whole metric rests on.
    const graph = graphOf(NODES, BOWED);

    expect(graph.degree[1]).toBe(2);
    expect(route(graph, 0, 2)!.turns).toBe(0);
  });

  it("returns the same cost as an exhaustive search of every path", () => {
    // A* is only trustworthy while its heuristic stays admissible; one that
    // overestimates returns a cheap-looking wrong route rather than failing.
    const graph = graphOf(
      NODES,
      [...BOWED, ...BYPASS_ROAD, ...SLIPS, ...STUBS, { a: 1, b: 4, signals: 1 }],
      [0, 0, 0, 1, 0, 2],
    );

    for (const target of [2, 4, 5, 7]) {
      const found = new Router(graph).route(at(0)[0], at(0)[1], at(target)[0], at(target)[1], { speedKmh: 15 })!;
      expect(found.seconds).toBeCloseTo(bestByBruteForce(graph, 0, target), 6);
    }
  });

  it("breaks the ride into steps at the turns, named after the street", () => {
    // Riding up the stub to node 3, east along the bypass, then north to node 2:
    // a corner at each end of the bypass, so three steps and the arrival.
    const graph = graphOf(
      NODES,
      [...BYPASS_ROAD, ...SLIPS, ...STUBS].map((edge) => ({ ...edge, name: "Ohitustie" })),
    );

    const ridden = route(graph, 6, 2)!;

    expect(ridden.steps.map((step) => step.maneuver)).toEqual(["start", "right", "left", "arrive"]);
    expect(ridden.steps[1].name).toBe("Ohitustie");
    expect(ridden.steps.reduce((total, step) => total + step.metres, 0)).toBeCloseTo(ridden.metres, 6);
  });

  it("reads two turns within turn_merge_m as one manoeuvre", () => {
    // The slip road onto the bypass is ~2 m long, well inside the 25 m the cost
    // model calls one manoeuvre: setting off and turning onto it is one move, so the
    // ride from 0 to 5 reads as a single step even though it corners at node 3.
    const graph = graphOf(NODES, [...BYPASS_ROAD, ...SLIPS, ...STUBS]);

    expect(metresBetween(at(0), at(3))).toBeLessThan(COST.turn_merge_m);
    expect(route(graph, 0, 5)!.turns).toBe(1);
    expect(route(graph, 0, 5)!.steps.map((step) => step.maneuver)).toEqual(["start", "arrive"]);
  });

  it("puts every light on the route, wherever it was tagged", () => {
    // One light at the junction 3, one swallowed into an edge's interior. A count
    // cannot place the second; the shape point it became has to say what it was.
    const graph = graphOf(NODES, [{ a: 0, b: 3, signals: 1 }, { a: 3, b: 5 }, ...STUBS], [0, 0, 0, 2]);

    const found = route(graph, 0, 5)!;

    expect(found.signals).toBe(2);
    // Only the junction's position is known here: the fixture ships no shape points,
    // which is exactly the case the graph rebuild fixed for the real network.
    expect(found.signalPoints).toEqual([at(3)]);
  });

  it("offers the other way round as an alternative", () => {
    // The bowed road and the bypass are the only two ways from 0 to 2, and the
    // router picks the bowed one; the alternative has to be the one it rejected.
    const graph = graphOf(NODES, [...BOWED, ...BYPASS_ROAD, ...SLIPS, ...STUBS]);

    const found = new Router(graph).routes(at(0)[0], at(0)[1], at(2)[0], at(2)[1], { speedKmh: 15, limit: 3 });

    expect(found.length).toBe(2);
    expect(found[0].turns).toBe(0);
    expect(found[1].turns).toBe(2);
    // Each is priced at what it really costs, not at the inflated cost that made
    // the search look elsewhere -- and the best one stays first.
    expect(found[0].seconds).toBe(route(graph, 0, 2)!.seconds);
    expect(found[0].seconds).toBeLessThan(found[1].seconds);
  });

  it("offers one way only when there is one way", () => {
    const graph = graphOf(NODES, BOWED);

    expect(new Router(graph).routes(at(0)[0], at(0)[1], at(2)[0], at(2)[1], { speedKmh: 15, limit: 3 }).length).toBe(1);
  });

  it("will not ride a one-way edge against its arrow", () => {
    // The bowed road is the route the search wants, and it is now one-way eastbound.
    // Going east it still rides it; coming back it has to take the bypass, corners
    // and all -- which is what a rider meeting a no-entry sign actually does.
    const eastbound = BOWED.map((edge) => ({ ...edge, oneway: 1 as const }));
    const graph = graphOf(NODES, [...eastbound, ...BYPASS_ROAD, ...SLIPS, ...STUBS]);

    expect(route(graph, 0, 2)!.turns).toBe(0);
    expect(route(graph, 2, 0)!.turns).toBe(2);
  });

  it("finds no route at all when every way out is one-way against", () => {
    const graph = graphOf(NODES, BOWED.map((edge) => ({ ...edge, oneway: 1 as const })));

    expect(route(graph, 2, 0)).toBeNull();
  });

  it("returns nothing when the destination cannot be reached", () => {
    const graph = graphOf([...NODES, [25.5, 60.5]], BOWED);

    expect(new Router(graph).route(24.93, 60.172, 25.5, 60.5, { speedKmh: 15 })).toBeNull();
  });
});

describe("where the route rides", () => {
  // The bowed road is a carriageway with a cycleway mapped beside it; the bypass is
  // the cycleway. Both go the same way, and only one of them is for bicycles.
  const SIDEPATH = BOWED.map((edge) => ({ ...edge, kind: 2 }));
  const CYCLEWAY = BYPASS_ROAD.map((edge) => ({ ...edge, kind: 1 }));

  it("takes the cycleway over the carriageway beside it, corners and all", () => {
    // Without this the search picks the bowed road: it is the one with no turns on
    // it, and 37% of every benchmark route used to be exactly this mistake.
    const graph = graphOf(NODES, [...SIDEPATH, ...CYCLEWAY, ...SLIPS, ...STUBS]);

    const ridden = route(graph, 0, 2)!;

    expect(ridden.sidepathMetres).toBe(0);
    expect(ridden.dedicatedMetres).toBeGreaterThan(0);
    expect(ridden.turns).toBe(2); // it pays two corners to stay off the road
  });

  it("still rides the carriageway when it is the only way through", () => {
    // The cycleway is not always mapped through. Forbidding the road outright made
    // four of ten benchmark routes fail to connect at all, and a route that exists
    // beats a refusal.
    const graph = graphOf(NODES, [...SIDEPATH, ...STUBS]);

    const ridden = route(graph, 0, 2)!;

    expect(ridden.sidepathMetres).toBeGreaterThan(0);
    // Priced at what it really costs, not at the eight times the search paid to
    // look for a way round first.
    expect(ridden.seconds).toBeCloseTo(route(graph, 0, 2, true)!.seconds, 6);
  });
});

describe("crossings made in two goes", () => {
  it("charges two waits where the rider crosses in two stages", () => {
    // Node kind 3: a dual carriageway, or a crossing with a refuge island. One set
    // of lights, but the rider stops on the island and waits again.
    const once = graphOf(NODES, BOWED, [0, 2, 0]);
    const twice = graphOf(NODES, BOWED, [0, 3, 0]);

    const single = route(once, 0, 2)!;
    const staged = route(twice, 0, 2)!;

    expect(single.signals).toBe(1);
    expect(staged.signals).toBe(2);
    expect(staged.seconds - single.seconds).toBeCloseTo(COST.signal_delay_s, 6);
  });

  it("marks it once on the map, because it is one place you stop", () => {
    const graph = graphOf(NODES, BOWED, [0, 3, 0]);

    const ridden = route(graph, 0, 2)!;

    expect(ridden.signals).toBe(2);
    expect(ridden.signalPoints.length).toBe(1);
  });
});

describe("the cost of turning", () => {
  // Three nodes in a line with a spur, so a route can go straight on or turn off.
  it("charges a left turn more than a right one", () => {
    // A left crosses the opposing traffic; in Finland a rider usually takes it in
    // two goes. Pricing both the same made the search treat them as interchangeable.
    const nodes: [number, number][] = [
      [24.9400, 60.1700], [24.9420, 60.1700], [24.9420, 60.1710], [24.9420, 60.1690], [24.9440, 60.1700],
    ];
    const graph = graphOf(nodes, [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 1, b: 3 }, { a: 1, b: 4 }]);
    const at = (node: number) => nodes[node];
    const ride = (target: number) =>
      new Router(graph).route(at(0)[0], at(0)[1], at(target)[0], at(target)[1], { speedKmh: 15 })!;

    const left = ride(2);   // northwards off an eastbound road
    const right = ride(3);  // southwards, the same geometry mirrored
    expect(left.turns).toBe(1);
    expect(right.turns).toBe(1);
    expect(left.seconds - right.seconds).toBeCloseTo(
      COST.turn_penalty_s * (COST.turn_left_factor - 1), 4,
    );
  });
});

describe("the signposted network", () => {
  it("counts the signposted metres without discounting the clock", () => {
    // The bonus is a discount to the search, not to the ride: a route along a baana
    // must still report the seconds it really takes, exactly as the sidepath penalty
    // and the alternative search do.
    const plain = graphOf(NODES, BOWED);
    const signposted = graphOf(NODES, BOWED.map((edge) => ({ ...edge, kind: 4 })));

    const ordinary = route(plain, 0, 2)!;
    const network = route(signposted, 0, 2)!;

    expect(ordinary.networkMetres).toBe(0);
    expect(network.networkMetres).toBeCloseTo(network.metres, 6);
    expect(network.seconds).toBeCloseTo(ordinary.seconds, 6);
  });

  it("takes the signposted way when the two are otherwise a tie", () => {
    // Two ways between the same pair of junctions, identical in every respect but
    // one being signposted. Nothing else can decide this, and the rider can follow
    // the signs, so the search should take them.
    const graph = graphOf(NODES, [{ a: 0, b: 2 }, { a: 0, b: 2, kind: 4 }, ...STUBS]);

    expect(route(graph, 0, 2)!.networkMetres).toBeGreaterThan(0);
  });
});
