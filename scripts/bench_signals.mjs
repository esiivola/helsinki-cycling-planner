/* What do the lights cost, and how many of them are one junction crossed twice?
 *
 * A wide street is two carriageways with an island between them, and a rider waits
 * on the island: one set of lights, two waits. This reports waits against stops, so
 * the difference is visible rather than assumed.
 *
 *     node --experimental-strip-types scripts/bench_signals.mjs [speed]
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

let km = 0;
let waits = 0;
let stops = 0;
let waited = 0;
let seconds = 0;
for (const pair of pairs) {
  const route = router.route(pair.from[0], pair.from[1], pair.to[0], pair.to[1], { speedKmh });
  if (!route) { console.log(`${pair.name.padEnd(38)} no route`); continue; }
  const cost = route.signals * manifest.cost.signal_delay_s;
  km += route.metres / 1000;
  waits += route.signals;
  stops += route.signalPoints.length;
  waited += cost;
  seconds += route.seconds;
  console.log(
    `${pair.name.padEnd(38)} ${(route.metres / 1000).toFixed(1).padStart(5)} km`
    + `  ${String(route.signals).padStart(3)} waits at ${String(route.signalPoints.length).padStart(3)} stops`
    + `  ${(cost / 60).toFixed(1).padStart(5)} min waiting`
    + `  ${((cost / route.seconds) * 100).toFixed(0).padStart(2)}% of the ride`,
  );
}
console.log(
  `${"total".padEnd(38)} ${km.toFixed(1).padStart(5)} km  ${String(waits).padStart(3)} waits at ${String(stops).padStart(3)} stops`
  + `  ${(waited / 60).toFixed(1).padStart(5)} min waiting  ${((waited / seconds) * 100).toFixed(0).padStart(2)}% of the ride`
  + `  ${(waits / km).toFixed(2)} waits/km`,
);
