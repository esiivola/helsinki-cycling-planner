import { describe, expect, it } from "vitest";
import { BARRIER_DELAY_S, Router } from "../src/route.ts";
import { type EdgeSpec, graphOf } from "./graph-fixture.ts";
import { defaultTaste } from "../src/profile.ts";

// Two ways east. The direct one has a gate across it; the long way round is clear.
//
//   2 ---------- 3      clear, longer
//   0 ---------- 1      direct, with whatever node 4 carries
const NODES: [number, number][] = [
  [24.9300, 60.1720], [24.9372, 60.1720],
  [24.9300, 60.1729], [24.9372, 60.1729],
];
const DIRECT: EdgeSpec[] = [{ a: 0, b: 1 }];
const ROUND: EdgeSpec[] = [{ a: 0, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 1 }];
const at = (node: number) => NODES[node];

const taste = (over: Record<string, number> = {}) =>
  ({ ...defaultTaste(), ...over }) as unknown as Record<string, number>;

describe("a barrier inside an edge", () => {
  const clear = new Router(graphOf(NODES, [{ a: 0, b: 1 }]));
  const gated = new Router(graphOf(NODES, [{ a: 0, b: 1, barriers: 2 }]));
  const ride = (made: Router) =>
    made.route(at(0)[0], at(0)[1], at(1)[0], at(1)[1], { speedKmh: 18 })!;

  it("costs what a stop costs", () => {
    // Contraction dissolves the node a mid-block bollard sits on, so the count has
    // to travel on the edge or it is lost entirely.
    expect(ride(gated).seconds - ride(clear).seconds).toBeCloseTo(2 * BARRIER_DELAY_S, 6);
  });

  it("is reported, so a rider can see why the estimate moved", () => {
    expect(ride(gated).barriers).toBe(2);
    expect(ride(clear).barriers).toBe(0);
  });

  it("counts as riding time lost, not as distance", () => {
    expect(ride(gated).metres).toBeCloseTo(ride(clear).metres, 6);
  });
});

describe("a barrier at a junction", () => {
  it("is charged when the route passes through it", () => {
    const plain = new Router(graphOf(NODES, [...DIRECT, ...ROUND]));
    const blocked = new Router(graphOf(NODES, [...DIRECT, ...ROUND], [], [0, 0, 2, 0]));
    const ask = (made: Router) =>
      made.route(at(0)[0], at(0)[1], at(3)[0], at(3)[1], { speedKmh: 18 })!;
    expect(blocked.hasClimb).toBe(false);
    expect(ask(blocked).seconds).toBeGreaterThan(ask(plain).seconds);
  });
});

describe("avoiding barriers", () => {
  const graph = graphOf(NODES, [{ a: 0, b: 1, barriers: 2 }, ...ROUND]);
  const made = new Router(graph);
  const go = (over: Record<string, number>) =>
    made.route(at(0)[0], at(0)[1], at(1)[0], at(1)[1], { speedKmh: 18, taste: taste(over) })!;

  it("rides through them when the rider does not mind", () => {
    expect(go({}).edges).toHaveLength(1);
  });

  it("goes round once they are disliked enough", () => {
    expect(go({ barrier: 6 }).edges.length).toBeGreaterThan(1);
  });

  it("still reports the detour at its honest cost", () => {
    const round = go({ barrier: 6 });
    expect(round.barriers).toBe(0);
    expect(round.seconds).toBeCloseTo(round.ridingSeconds, 6);
  });
});

describe("lighting", () => {
  // The lit way is barely longer here on purpose. The strongest stop discounts a lit
  // metre by a fifth, so it can only win a detour of under about a quarter -- which
  // is the point: a preference for light should not send anyone the long way round.
  const LIT_NODES: [number, number][] = [
    [24.9300, 60.1720], [24.9372, 60.1720],
    [24.9300, 60.17204], [24.9372, 60.17204],
  ];
  const where = (node: number) => LIT_NODES[node];
  const graph = graphOf(LIT_NODES, [
    { a: 0, b: 1 }, { a: 0, b: 2, lit: 1 }, { a: 2, b: 3, lit: 1 }, { a: 3, b: 1, lit: 1 },
  ]);
  const made = new Router(graph);
  const go = (over: Record<string, number>) =>
    made.route(where(0)[0], where(0)[1], where(1)[0], where(1)[1], { speedKmh: 18, taste: taste(over) })!;

  it("takes the short dark way when lighting does not matter", () => {
    expect(go({}).edges).toHaveLength(1);
  });

  it("takes the longer lit way when it does", () => {
    const lit = go({ lit: 0.8 });
    expect(lit.edges.length).toBeGreaterThan(1);
    expect(lit.litMetres).toBeGreaterThan(0);
  });

  it("never reports a lit route as faster than riding it", () => {
    // The discount steers the search; it must not leak into the minutes, or a lit
    // detour would be reported as quicker than the straight line it replaced.
    const lit = go({ lit: 0.8 });
    expect(lit.seconds).toBeCloseTo(lit.ridingSeconds, 6);
    expect(lit.seconds).toBeGreaterThan(go({}).seconds);
  });
});
