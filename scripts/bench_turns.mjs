/* How much does the turn penalty actually change the routes it prices?
 *
 * Sweeps `turn_penalty_s` over the benchmark pairs and reports what each setting
 * buys. Every row is re-priced at a common reference (10 s a turn, the shipped
 * value) so the totals are comparable rather than each route being scored by the
 * rule that produced it.
 *
 *     node --experimental-strip-types scripts/bench_turns.mjs [speed]
 */
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeGraph } from "../src/graph.ts";
import { Router } from "../src/route.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../public/graph");
const raw = gunzipSync(readFileSync(resolve(dir, "graph.bin.gz")));
const manifest = JSON.parse(readFileSync(resolve(dir, "graph.json"), "utf8"));
const graph = decodeGraph(manifest, raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const router = new Router(graph);
const speedKmh = Number(process.argv[2] ?? 18);
const pairs = JSON.parse(readFileSync(resolve(here, "pairs.json"), "utf8"));
const REFERENCE_TURN_S = 10;

console.log(`${"turn penalty".padEnd(18)} ${"km".padStart(7)} ${"turns".padStart(6)} ${"per km".padStart(7)} ${"left".padStart(5)} ${"waits".padStart(6)} ${"riding".padStart(8)} ${"at 10 s a turn".padStart(15)}`);
const settings = [
  [10, 1], [12, 1], [15, 1],
  [10, 1.25], [10, 1.5], [10, 2],
  [11, 1.25], [11, 1.5],
  [12, 1.25], [12, 1.5],
];
for (const [penalty, leftFactor] of settings) {
  graph.manifest.cost.turn_penalty_s = penalty;
  graph.manifest.cost.turn_left_factor = leftFactor;
  let metres = 0;
  let turns = 0;
  let signals = 0;
  let riding = 0;
  let reference = 0;
  let lefts = 0;
  for (const pair of pairs) {
    const route = router.route(pair.from[0], pair.from[1], pair.to[0], pair.to[1], { speedKmh });
    if (!route) continue;
    metres += route.metres;
    turns += route.turns;
    lefts += route.steps.filter((step) => step.maneuver === "left" || step.maneuver === "sharp-left").length;
    signals += route.signals;
    riding += route.ridingSeconds;
    // Re-price on one scale: the route's own cost includes whatever penalty made it.
    reference += route.ridingSeconds
      + route.signals * manifest.cost.signal_delay_s
      + route.crossings * manifest.cost.crossing_delay_s
      + route.turns * REFERENCE_TURN_S;
  }
  console.log(
    `${`${penalty} s, left x${leftFactor}`.padEnd(18)} ${(metres / 1000).toFixed(1).padStart(7)} ${String(turns).padStart(6)}`
    + ` ${(turns / (metres / 1000)).toFixed(2).padStart(7)} ${String(lefts).padStart(5)} ${String(signals).padStart(6)}`
    + ` ${(riding / 60).toFixed(0).padStart(6)} min ${(reference / 60).toFixed(0).padStart(12)} min`
    // The repo's calibration fixture: dodging a light by a left and a right must
    // stay worth it, or the model has decided two corners are as bad as a wait.
    + `   two corners ${(penalty * (1 + leftFactor)).toFixed(0).padStart(2)} s vs a 30 s light`
    + `${penalty * (1 + leftFactor) < 30 ? "" : "  <-- breaks it"}`,
  );
}
