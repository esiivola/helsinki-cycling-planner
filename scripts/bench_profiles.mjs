/* What does each preference actually buy, and what does it cost to get it?
 *
 * Sweeps one taste multiplier at a time over the benchmark pairs and reports what
 * moves. Every row is re-priced at the *shipped* cost model, exactly as
 * `bench_turns.mjs` does, so the minutes are comparable across settings rather than
 * each route being scored by the rule that produced it -- a route found by hating
 * gravel is still a route that takes as long as it takes.
 *
 * The column that decides a "hard no" is `fail`. Forbidding a way outright is what
 * `SIDEPATH_PENALTY` was written to avoid: it left four of these ten pairs unable to
 * connect at all. A stop that cannot route is not a strong preference, it is a bug,
 * so the strongest stop is the last one before `fail` moves off zero.
 *
 *     node --experimental-strip-types scripts/bench_profiles.mjs [speed]
 */
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { decodeClimb } from "../src/climb.ts";
import { decodeGraph } from "../src/graph.ts";
import { Router } from "../src/route.ts";
import { ROWS, defaultTaste } from "../src/profile.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../public/graph");
const raw = gunzipSync(readFileSync(resolve(dir, "graph.bin.gz")));
const manifest = JSON.parse(readFileSync(resolve(dir, "graph.json"), "utf8"));
const graph = decodeGraph(manifest, raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const router = new Router(graph);
// Hills only exist if the sidecar has been built; without it the climb row sweeps
// a multiplier over nothing, so say so rather than printing a flat column.
const climbPath = resolve(dir, "climb.bin.gz");
if (existsSync(climbPath)) {
  const raw = gunzipSync(readFileSync(climbPath));
  router.attachClimb(decodeClimb(
    JSON.parse(readFileSync(resolve(dir, "climb.json"), "utf8")),
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
  ));
} else {
  console.log("no climb.bin.gz: the mäet row will not move\n");
}
const speedKmh = Number(process.argv[2] ?? 18);
const pairs = JSON.parse(readFileSync(resolve(here, "pairs.json"), "utf8"));
const cost = manifest.cost;

/** The shipped model's price for a route, whatever preference found it. */
const reference = (route) =>
  route.ridingSeconds
  + route.signals * cost.signal_delay_s
  + route.crossings * cost.crossing_delay_s
  + route.turns * cost.turn_penalty_s;

function measure(taste) {
  const total = {
    metres: 0, dedicated: 0, unpaved: 0, shared: 0, sidepath: 0, network: 0,
    signals: 0, turns: 0, ascent: 0, reference: 0, fail: 0,
  };
  for (const pair of pairs) {
    const route = router.route(pair.from[0], pair.from[1], pair.to[0], pair.to[1], { speedKmh, taste });
    if (!route || route.edges.length === 0) { total.fail += 1; continue; }
    total.metres += route.metres;
    total.dedicated += route.dedicatedMetres;
    total.unpaved += route.unpavedMetres;
    total.shared += route.sharedMetres;
    total.sidepath += route.sidepathMetres;
    total.network += route.networkMetres;
    total.signals += route.signals;
    total.turns += route.turns;
    total.ascent += route.ascentMetres;
    total.reference += reference(route);
  }
  return total;
}

const SWEEP = [0.5, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 2, 2.5, 3, 4, 5, 8, 12, 20, 50];
const base = measure(defaultTaste());
const share = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);

console.log(`shipped defaults: ${(base.metres / 1000).toFixed(1)} km, `
  + `${(base.reference / 60).toFixed(0)} min at the shipped model, `
  + `${share(base.dedicated, base.metres).toFixed(1)}% pyörätietä, `
  + `${share(base.unpaved, base.metres).toFixed(1)}% soraa, ${share(base.shared, base.metres).toFixed(1)}% jaettua, `
  + `${base.signals} waits, ${base.turns} turns, ${base.ascent.toFixed(0)} m of climb\n`);

const head = `${"×".padStart(6)} ${"km".padStart(7)} ${"min".padStart(6)} ${"detour".padStart(7)}`
  + ` ${"pyörätie".padStart(9)} ${"sora".padStart(7)} ${"jaettu".padStart(7)} ${"vierus".padStart(7)} ${"baana".padStart(7)}`
  + ` ${"waits".padStart(6)} ${"turns".padStart(6)} ${"nousu".padStart(7)} ${"fail".padStart(5)}`;

for (const row of ROWS) {
  console.log(`\n--- ${row.key}: ${row.label} ---`);
  console.log(head);
  for (const value of SWEEP) {
    const taste = { ...defaultTaste(), [row.key]: value };
    const total = measure(taste);
    const detour = ((total.reference - base.reference) / base.reference) * 100;
    console.log(
      `${value.toString().padStart(6)} ${(total.metres / 1000).toFixed(1).padStart(7)}`
      + ` ${(total.reference / 60).toFixed(0).padStart(6)} ${`${detour >= 0 ? "+" : ""}${detour.toFixed(1)}%`.padStart(7)}`
      + ` ${`${share(total.dedicated, total.metres).toFixed(1)}%`.padStart(9)}`
      + ` ${`${share(total.unpaved, total.metres).toFixed(1)}%`.padStart(7)}`
      + ` ${`${share(total.shared, total.metres).toFixed(1)}%`.padStart(7)}`
      + ` ${`${share(total.sidepath, total.metres).toFixed(1)}%`.padStart(7)}`
      + ` ${`${share(total.network, total.metres).toFixed(1)}%`.padStart(7)}`
      + ` ${String(total.signals).padStart(6)} ${String(total.turns).padStart(6)}`
      + ` ${`${total.ascent.toFixed(0)} m`.padStart(7)}`
      + ` ${String(total.fail).padStart(5)}${total.fail ? "  <-- cannot route" : ""}`,
    );
  }
}
