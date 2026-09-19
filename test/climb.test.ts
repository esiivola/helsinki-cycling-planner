import { describe, expect, it } from "vitest";
import type { Climb } from "../src/climb.ts";
import { CLIMB_S_PER_M, DESCENT_CREDIT_S_PER_M, Router } from "../src/route.ts";
import { type EdgeSpec, graphOf } from "./graph-fixture.ts";
import { defaultTaste } from "../src/profile.ts";

// Two ways east: over the hill, or the long way round it.
//
//   0 ============ 1     the direct edge, which climbs
//   |              |
//   2 ------------ 3     the way round: longer, and flat
const NODES: [number, number][] = [
  [24.9300, 60.1720], [24.9372, 60.1720],
  [24.9300, 60.1740], [24.9372, 60.1740],
];
const OVER: EdgeSpec = { a: 0, b: 1 };
const AROUND: EdgeSpec[] = [{ a: 0, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 1 }];
const EDGES = [OVER, ...AROUND];
const at = (node: number) => NODES[node];

function climbOf(ascent: number[], descent: number[], height = NODES.map(() => 0)): Climb {
  return {
    manifest: {
      version: 3, edge_count: ascent.length, node_count: height.length,
      shape_point_count: 0, scale: 10,
      source: "test", sampled_m: 25, threshold_m: 2, layout: {},
    },
    ascent: Float32Array.from(ascent),
    descent: Float32Array.from(descent),
    height: Float32Array.from(height),
    shapeHeight: new Float32Array(0),
  };
}

/** `ascent` is per edge in the a-to-b direction, in the order of EDGES. */
function router(ascent: number[], descent = ascent.map(() => 0)): Router {
  const made = new Router(graphOf(NODES, EDGES));
  made.attachClimb(climbOf(ascent, descent));
  return made;
}

const ride = (made: Router, from: number, to: number, taste?: Record<string, number>) =>
  made.route(at(from)[0], at(from)[1], at(to)[0], at(to)[1],
    { speedKmh: 18, ...(taste ? { taste } : {}) })!;

describe("a hill costs time", () => {
  it("is free until the data arrives", () => {
    const flat = new Router(graphOf(NODES, EDGES));
    expect(flat.hasClimb).toBe(false);
    const route = ride(flat, 0, 1);
    expect(route.ascentMetres).toBe(0);
    expect(route.descentMetres).toBe(0);
  });

  it("charges the shipped seconds for every metre climbed", () => {
    const level = ride(router([0, 0, 0, 0]), 0, 1);
    const steep = ride(router([20, 0, 0, 0]), 0, 1);
    expect(steep.edges).toEqual(level.edges); // still the only sensible way
    expect(steep.seconds - level.seconds).toBeCloseTo(20 * CLIMB_S_PER_M, 6);
    expect(steep.ascentMetres).toBe(20);
  });

  it("counts the climb as riding, not as a delay", () => {
    const steep = ride(router([20, 0, 0, 0]), 0, 1);
    // A hill is time in the saddle. Filed under "pysähtely ja käännökset" it would
    // show up in the readout as friction the rider could avoid by not stopping.
    expect(steep.seconds).toBeCloseTo(steep.ridingSeconds, 6);
  });

  it("goes the long way round once the hill is dear enough", () => {
    const easy = ride(router([2, 0, 0, 0]), 0, 1);
    const hard = ride(router([60, 0, 0, 0]), 0, 1);
    expect(easy.edges).toHaveLength(1);
    expect(hard.edges.length).toBeGreaterThan(1);
    expect(hard.ascentMetres).toBe(0);
    expect(hard.metres).toBeGreaterThan(easy.metres);
  });
});

describe("which way you ride it", () => {
  it("swaps ascent and descent", () => {
    const made = router([30, 0, 0, 0], [5, 0, 0, 0]);
    const up = ride(made, 0, 1);
    const down = ride(made, 1, 0);
    expect(up.ascentMetres).toBe(30);
    expect(up.descentMetres).toBe(5);
    expect(down.ascentMetres).toBe(5);
    expect(down.descentMetres).toBe(30);
    expect(down.seconds).toBeLessThan(up.seconds);
  });

  it("pays a descent back against the same edge's climb, and no further", () => {
    const rolling = ride(router([10, 0, 0, 0], [10, 0, 0, 0]), 0, 1);
    const flat = ride(router([0, 0, 0, 0]), 0, 1);
    const charged = 10 * CLIMB_S_PER_M - 10 * DESCENT_CREDIT_S_PER_M;
    expect(rolling.seconds - flat.seconds).toBeCloseTo(charged, 6);
  });

  it("never makes an edge quicker than the same edge flat", () => {
    // Freewheeling downhill through a city does not beat flat, and a negative cost
    // would make A*'s heuristic optimistic.
    const downhill = ride(router([0, 0, 0, 0], [200, 0, 0, 0]), 0, 1);
    const flat = ride(router([0, 0, 0, 0]), 0, 1);
    expect(downhill.seconds).toBeCloseTo(flat.seconds, 6);
  });
});

describe("disliking hills is taste, not time", () => {
  it("steers around a climb the plain cost would have ridden over", () => {
    const made = router([25, 0, 0, 0]);
    const indifferent = ride(made, 0, 1, defaultTaste() as unknown as Record<string, number>);
    const averse = ride(made, 0, 1, { ...defaultTaste(), hill: 8 } as unknown as Record<string, number>);
    expect(indifferent.edges).toHaveLength(1);
    expect(averse.edges.length).toBeGreaterThan(1);
  });

  it("reports the detour at what it really costs", () => {
    const made = router([25, 0, 0, 0]);
    const averse = ride(made, 0, 1, { ...defaultTaste(), hill: 8 } as unknown as Record<string, number>);
    // The way round is flat, so its price is its riding time and nothing else. An
    // aversion that had leaked into the total would show here as eight times a hill
    // the rider never climbed.
    expect(averse.seconds).toBeCloseTo(averse.ridingSeconds, 6);
    expect(averse.ascentMetres).toBe(0);
  });
});

describe("data that does not fit", () => {
  it("is refused rather than silently misread", () => {
    const made = new Router(graphOf(NODES, EDGES));
    expect(() => made.attachClimb(climbOf([1], [1]))).toThrow(/does not match/);
    expect(made.hasClimb).toBe(false);
  });

  it("refuses heights that belong to another graph", () => {
    const made = new Router(graphOf(NODES, EDGES));
    expect(() => made.attachClimb(climbOf([0, 0, 0, 0], [0, 0, 0, 0], [1, 2])))
      .toThrow(/heights do not match/);
  });
});

describe("the profile", () => {
  it("is one point per junction, from zero to the full length", () => {
    const made = router([10, 0, 0, 0], [0, 0, 0, 0]);
    const route = ride(made, 0, 1);
    expect(route.profile).toHaveLength(2);
    expect(route.profile[0][0]).toBe(0);
    expect(route.profile[route.profile.length - 1][0]).toBeCloseTo(route.metres, 6);
  });

  it("reads the terrain at each junction, the way round it is ridden", () => {
    const made = new Router(graphOf(NODES, EDGES));
    made.attachClimb(climbOf([0, 0, 0, 0], [0, 0, 0, 0], [5, 25, 0, 0]));
    expect(ride(made, 0, 1).profile.map((point) => point[1])).toEqual([5, 25]);
    expect(ride(made, 1, 0).profile.map((point) => point[1])).toEqual([25, 5]);
  });

  it("stays empty without climb data", () => {
    expect(ride(new Router(graphOf(NODES, EDGES)), 0, 1).profile).toEqual([]);
  });
});
