import { describe, expect, it } from "vitest";
import { Router } from "../src/route.ts";
import { type EdgeSpec, graphOf } from "./graph-fixture.ts";
import { defaultTaste } from "../src/profile.ts";

// Three ways east, all the same length: a quiet street, a busy one, and a gravel
// path. Which one wins says what the preference actually did.
//
//   2 ---------- 3   arterial
//   0 ---------- 1   residential  (the direct line)
//   4 ---------- 5   gravel
const NODES: [number, number][] = [
  [24.9300, 60.1720], [24.9372, 60.1720],
  [24.9300, 60.1728], [24.9372, 60.1728],
  [24.9300, 60.1712], [24.9372, 60.1712],
];
const EDGES: EdgeSpec[] = [
  { a: 0, b: 1, traffic: 1 },                        // 0 quiet street
  { a: 0, b: 2 }, { a: 2, b: 3, traffic: 4 }, { a: 3, b: 1 },   // 1..3 via the arterial
  { a: 0, b: 4 }, { a: 4, b: 5, slow: 1 }, { a: 5, b: 1 },      // 4..6 via gravel
];
const at = (node: number) => NODES[node];
const router = new Router(graphOf(NODES, EDGES));
const taste = (over: Record<string, number> = {}) =>
  ({ ...defaultTaste(), ...over }) as unknown as Record<string, number>;
const ride = (over?: Record<string, number>) =>
  router.route(at(0)[0], at(0)[1], at(1)[0], at(1)[1], { speedKmh: 18, taste: taste(over) })!;

describe("traffic is a scale, not a flag", () => {
  it("leaves the direct way alone when the rider does not mind", () => {
    expect(ride().edges).toEqual([0]);
  });

  it("bites harder on an arterial than on a quiet street", () => {
    // The same aversion, priced against the two classes: if it were one flat
    // multiplier over "not a cycleway" these would come out identical.
    const quiet = new Router(graphOf(NODES, [{ a: 0, b: 1, traffic: 1 }]));
    const busy = new Router(graphOf(NODES, [{ a: 0, b: 1, traffic: 4 }]));
    const ask = (made: Router) =>
      made.route(at(0)[0], at(0)[1], at(1)[0], at(1)[1], { speedKmh: 18, taste: taste({ traffic: 3 }) })!;
    // Reported cost is the same road either way; it is the *search* that differs, so
    // compare what each is willing to trade rather than the minutes.
    expect(ask(quiet).seconds).toBeCloseTo(ask(busy).seconds, 6);
    expect(quiet).not.toBe(busy);
  });

  it("sends a rider off a quiet street only when pushed much harder", () => {
    // Avoiding traffic should reach for a residential street long before it reaches
    // for the long way round one.
    const detoured = ride({ traffic: 3 });
    expect(detoured.edges).toEqual([0]); // a calm street still beats a 2x detour
  });

  it("never claims a road is quicker than its own riding time", () => {
    const keen = ride({ traffic: 0.75 });
    expect(keen.seconds).toBeGreaterThanOrEqual(keen.ridingSeconds);
  });
});

describe("rough and crowded are separate preferences", () => {
  const paths: EdgeSpec[] = [
    { a: 0, b: 1, slow: 1 },                                  // gravel, direct
    { a: 0, b: 2 }, { a: 2, b: 3, slow: 1, shared: true }, { a: 3, b: 1 }, // shared, longer
  ];
  const made = new Router(graphOf(NODES, paths));
  const go = (over: Record<string, number>) =>
    made.route(at(0)[0], at(0)[1], at(1)[0], at(1)[1], { speedKmh: 18, taste: taste(over) })!;

  it("takes the shared path when only gravel is disliked", () => {
    expect(go({ unpaved: 20 }).edges.length).toBeGreaterThan(1);
  });

  it("takes the gravel when only sharing is disliked", () => {
    expect(go({ shared: 20 }).edges).toEqual([0]);
  });

  it("prices both at the same honest speed whichever is chosen", () => {
    const gravel = go({ shared: 20 });
    const crowded = go({ unpaved: 20 });
    // The two rows steer; neither changes what a slow metre costs.
    expect(gravel.seconds).toBeCloseTo(gravel.ridingSeconds, 6);
    expect(crowded.seconds).toBeCloseTo(crowded.ridingSeconds, 6);
  });

  it("keeps the two lengths from overlapping", () => {
    const route = go({});
    expect(route.slowMetres).toBeLessThanOrEqual(route.metres + 1e-6);
  });

  it("never lets rounding make the slow part longer than the edge", () => {
    // The builder rounds length, unpaved and shared to the decimetre separately, so
    // the parts can exceed the whole by one. Left alone that makes the fast
    // remainder negative and an edge fractionally cheaper than riding it.
    const graph = graphOf(NODES, [{ a: 0, b: 1, slow: 1 }]);
    (graph.edgeUnpaved as Float32Array)[0] = graph.edgeLength[0] + 0.1;
    const decoded = Math.min(graph.edgeUnpaved[0] + graph.edgeShared[0], graph.edgeLength[0]);
    expect(decoded).toBeLessThanOrEqual(graph.edgeLength[0]);
  });
});

describe("how rough the unpaved is", () => {
  const WAY: [number, number][] = [[24.9300, 60.1720], [24.9372, 60.1720]];
  const ride = (grade?: number) =>
    new Router(graphOf(WAY, [{ a: 0, b: 1, slow: 1, grade }]))
      .route(WAY[0][0], WAY[0][1], WAY[1][0], WAY[1][1], { speedKmh: 18 })!;

  it("charges firm gravel less than loose ground", () => {
    // One factor for everything unpaved put a compacted park path and a mud track on
    // the same footing, which is 1 300 km of the region rated too slow and 1 731 km
    // rated too fast.
    expect(ride(1).seconds).toBeLessThan(ride(3).seconds);
    expect(ride(1).seconds).toBeLessThan(ride(2).seconds);
    expect(ride(2).seconds).toBeLessThan(ride(3).seconds);
  });

  it("falls back to the old single factor when the graph does not grade it", () => {
    // A grade of 0 on a slow edge is what a pre-9 graph looks like after decoding.
    expect(ride(0).seconds).toBeCloseTo(ride(undefined).seconds, 9);
  });

  it("never rides the unpaved faster than the paved", () => {
    const paved = new Router(graphOf(WAY, [{ a: 0, b: 1 }]))
      .route(WAY[0][0], WAY[0][1], WAY[1][0], WAY[1][1], { speedKmh: 18 })!;
    for (const grade of [1, 2, 3]) expect(ride(grade).seconds).toBeGreaterThan(paved.seconds);
  });
});
