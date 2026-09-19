import { describe, expect, it } from "vitest";
import { Router } from "../src/route.ts";
import { COST, type EdgeSpec, graphOf } from "./graph-fixture.ts";
import {
  DEFAULT_SPEED_KMH, KNOBS, PRESETS, ROWS,
  applyPreset, decodeProfile, defaultProfile, defaultTaste, encodeProfile, presetOf, rowOf, stopOf,
} from "../src/profile.ts";

// Two ways east: a short gravel run, and a paved way round that is longer.
const NODES: [number, number][] = [
  [24.9300, 60.1720], [24.9372, 60.1720],
  [24.9300, 60.1735], [24.9372, 60.1735],
];
const GRAVEL: EdgeSpec = { a: 0, b: 1, slow: 1 };
const PAVED: EdgeSpec[] = [{ a: 0, b: 2 }, { a: 2, b: 3 }, { a: 3, b: 1 }];
const at = (node: number) => NODES[node];

const graph = graphOf(NODES, [GRAVEL, ...PAVED]);
const ride = (taste?: Record<string, number>) =>
  new Router(graph).route(at(0)[0], at(0)[1], at(1)[0], at(1)[1],
    { speedKmh: 15, ...(taste ? { taste } : {}) })!;

describe("the shipped profile changes nothing", () => {
  it("routes exactly as a request with no profile at all", () => {
    const bare = ride();
    const withDefaults = ride(defaultTaste() as unknown as Record<string, number>);
    expect(withDefaults.edges).toEqual(bare.edges);
    expect(withDefaults.seconds).toBeCloseTo(bare.seconds, 9);
  });

  it("puts every row on a stop, and the shipped one is a real stop", () => {
    for (const row of ROWS) {
      expect(row.values).toHaveLength(row.labels.length);
      expect(row.standard).toBeGreaterThanOrEqual(0);
      expect(row.standard).toBeLessThan(row.values.length);
      expect(stopOf(row.key, defaultTaste()[row.key])).toBe(row.standard);
    }
  });

  it("agrees with the graph's own model where the two overlap", () => {
    // A default that drifted from the manifest would route every first-time visitor
    // by a rule nobody chose.
    expect(rowOf("network").values[rowOf("network").standard]).toBe(COST.network_bonus);
  });
});

describe("taste steers the search without touching the price", () => {
  it("takes the long paved way once gravel is avoided hard enough", () => {
    const easy = ride();
    const fussy = ride({ ...defaultTaste(), unpaved: 20 } as unknown as Record<string, number>);
    expect(easy.slowMetres).toBeGreaterThan(0);
    expect(fussy.slowMetres).toBe(0);
    expect(fussy.metres).toBeGreaterThan(easy.metres);
  });

  it("reports the detour at what it really costs, not at the penalised cost", () => {
    const fussy = ride({ ...defaultTaste(), unpaved: 20 } as unknown as Record<string, number>);
    // Priced from the route itself: riding time plus the delays actually met. If the
    // aversion had leaked into the total, this would come out 20x too dear.
    const honest = fussy.ridingSeconds
      + fussy.signals * COST.signal_delay_s
      + fussy.crossings * COST.crossing_delay_s
      + fussy.turns * COST.turn_penalty_s;
    expect(fussy.seconds).toBeCloseTo(honest, 6);
  });

  it("leaves a preference no cheaper than the ride it discounts", () => {
    // A discount below the free-flow speed would make A*'s heuristic optimistic.
    const kind = ride({ ...defaultTaste(), network: 0.5 } as unknown as Record<string, number>);
    expect(kind.seconds).toBeGreaterThanOrEqual(kind.ridingSeconds);
  });
});

describe("the link", () => {
  it("writes nothing for the shipped profile", () => {
    expect(encodeProfile(defaultProfile())).toBe("");
  });

  it("round-trips every row and every knob", () => {
    const profile = defaultProfile();
    for (const row of ROWS) profile.taste[row.key] = row.values[row.values.length - 1];
    for (const knob of KNOBS) (profile.cost as Record<string, number>)[knob.key] = knob.min;
    const back = decodeProfile(encodeProfile(profile));
    expect(back.taste).toEqual(profile.taste);
    expect(back.cost).toEqual(profile.cost);
  });

  it("drops what it cannot trust rather than refusing the link", () => {
    const back = decodeProfile("u2zzz9999S99999q-5");
    expect(back.taste.unpaved).toBe(2);
    expect(back.cost.signal_delay_s).toBeUndefined();
    expect(back.taste).toMatchObject({ turn: 1, signal: 1 });
  });

  it("keeps the rider's speed, which travels in its own parameter", () => {
    const back = decodeProfile("u2", { ...defaultProfile(), speedKmh: 24 });
    expect(back.speedKmh).toBe(24);
    expect(DEFAULT_SPEED_KMH).toBe(18);
  });
});

describe("every knob and row can travel", () => {
  it("gives each one a letter of its own", () => {
    // A field with no code is silently dropped from a shared link, which is how the
    // two climb knobs first escaped.
    const profile = defaultProfile();
    for (const knob of KNOBS) (profile.cost as Record<string, number>)[knob.key] = knob.max;
    for (const row of ROWS) profile.taste[row.key] = row.values[0];
    const token = encodeProfile(profile);
    for (const knob of KNOBS) expect(decodeProfile(token).cost[knob.key]).toBe(knob.max);
    for (const row of ROWS) expect(decodeProfile(token).taste[row.key]).toBe(row.values[0]);
  });
});

describe("presets", () => {
  it("names itself back", () => {
    for (const preset of PRESETS) expect(presetOf(applyPreset(preset))?.id).toBe(preset.id);
  });

  it("starts on the balanced one", () => {
    expect(presetOf(defaultTaste())?.id).toBe("balanced");
  });
});
