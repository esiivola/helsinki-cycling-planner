/* Route a set of origin/destination pairs and print what the browser would show. */
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeGraph } from "../src/graph.ts";
import { Router } from "../src/route.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../public/graph");
const manifest = JSON.parse(readFileSync(resolve(dir, "graph.json"), "utf8"));
const raw = gunzipSync(readFileSync(resolve(dir, "graph.bin.gz")));
const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

let started = performance.now();
const graph = decodeGraph(manifest, bytes);
const router = new Router(graph);
const setup = performance.now() - started;

const pairs = JSON.parse(readFileSync(resolve(here, "pairs.json"), "utf8"));
const speed = Number(process.argv[2] ?? 15);
const chargeTurns = process.argv[3] !== "noturns";
const results = [];
started = performance.now();
for (const pair of pairs) {
  const t0 = performance.now();
  const route = router.route(pair.from[0], pair.from[1], pair.to[0], pair.to[1], { speedKmh: speed, chargeTurns });
  results.push({ name: pair.name, ms: performance.now() - t0, route: route && {
    minutes: route.seconds / 60, km: route.metres / 1000, riding: route.ridingSeconds / 60,
    signals: route.signals, crossings: route.crossings, turns: route.turns, slowM: route.slowMetres,
    points: route.path.length,
  } });
}
const total = performance.now() - started;
console.log(JSON.stringify({ setup_ms: setup, total_ms: total, charge_turns: chargeTurns, speed_kmh: speed, results }, null, 1));
