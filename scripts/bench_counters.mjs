/* Does the router send people where people actually ride?
 *
 * Helsinki counts bicycles at 427 places and publishes the daily totals. That is far
 * too sparse to route on -- 427 points against 425 000 edges would be a preference
 * that touches nothing -- but it is exactly the right size to check the model
 * against, which is the more valuable use of it.
 *
 * The test: route a few hundred trips across the region, count how often each edge is
 * used, and compare that with the counts observed at the edges carrying a counter. A
 * model that puts riders where riders are should rank the busy places above the quiet
 * ones. Reported as Spearman's rank correlation, because the two quantities are not
 * in the same units and only the ordering is meaningful.
 *
 *     node --experimental-strip-types scripts/bench_counters.mjs [trips]
 */
import { gunzipSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeGraph } from "../src/graph.ts";
import { Router } from "../src/route.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../public/graph");
const source = resolve(here, "../data/counters.json");
if (!existsSync(source)) {
  console.error("no data/counters.json; run tools/fetch_counters.py first");
  process.exit(2);
}
const raw = gunzipSync(readFileSync(resolve(dir, "graph.bin.gz")));
const manifest = JSON.parse(readFileSync(resolve(dir, "graph.json"), "utf8"));
const graph = decodeGraph(manifest, raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const router = new Router(graph);
const trips = Number(process.argv[2] ?? 300);

const scale = manifest.coordinate_scale;
const metres = (aLon, aLat, bLon, bLat) => {
  const east = (bLon - aLon) * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180)) * 111_320;
  return Math.hypot(east, (bLat - aLat) * 110_540);
};

/* Coordinates come already in WGS84: `data/counters.json` is written by pyproj, which
   the build tools already depend on. Hand-rolling the inverse of a transverse
   Mercator here produced points in the Atlantic, which is the sort of thing a
   projection library exists to prevent. */

// The newest reading at each place, so a site counted for years is not counted twice.
const newest = new Map();
for (const reading of JSON.parse(readFileSync(source, "utf8"))) {
  const previous = newest.get(reading.place);
  if (!previous || Number(reading.year) > Number(previous.year)) newest.set(reading.place, reading);
}
const counters = [...newest.values()];

// Nearest edge to each counter, by its endpoints.
const REACH_M = 40;
const at = [];
for (const counter of counters) {
  let best = -1, bestM = REACH_M;
  const node = router.nearestNode(counter.lon, counter.lat);
  if (node < 0) continue;
  for (let slot = graph.adjacencyStart[node]; slot < graph.adjacencyStart[node + 1]; slot += 1) {
    const edge = graph.adjacency[slot];
    const a = graph.edgeA[edge], b = graph.edgeB[edge];
    const d = Math.min(
      metres(counter.lon, counter.lat, graph.lon[a] / scale, graph.lat[a] / scale),
      metres(counter.lon, counter.lat, graph.lon[b] / scale, graph.lat[b] / scale),
    );
    if (d < bestM) { best = edge; bestM = d; }
  }
  if (best >= 0) at.push({ ...counter, edge: best });
}

/* The demand model, stated openly because it is the weak half of this benchmark.
 *
 * Trips between uniformly random junctions gave a correlation of 0.27 and sent zero
 * trips past the busiest counters in the city, which says nothing about the router
 * and everything about the demand: cycling in this region is radial, and uniform
 * pairs almost never cross the centre. Destinations are therefore drawn from the
 * places people actually ride to. It is still a crude gravity model, and the number
 * below should be read as "given roughly realistic demand", not as a property of the
 * router alone.
 *
 * The list is written by hand, which is worth being uncomfortable about, so the
 * obvious replacement was measured: split the counter sites in two down the ranking
 * by daily flow, draw destinations from one half weighted by what it counts, and
 * score on the other half that no trip was aimed at. Demand from the data, no list.
 * Scored on the same held-out sites it is the worse model -- 0.385, 0.375, 0.371 at
 * 400, 800 and 1 500 trips against 0.384, 0.394, 0.382 for the list -- and the reason is
 * plain once seen: a counter is a point on a link, and a link is not a place anybody
 * rides to. Rautatientori is a destination; the loop that counts bicycles 200 m
 * short of it is a turnstile. The list stays because it knows something the counts
 * do not. */
const DESTINATIONS = [
  [24.9414, 60.1710], // Rautatientori
  [24.9320, 60.1690], // Kamppi
  [24.9260, 60.1990], // Pasila
  [24.9490, 60.1600], // Kauppatori
  [24.8319, 60.1841], // Otaniemi
  [24.8050, 60.1760], // Tapiola
  [25.0440, 60.2925], // Tikkurila
  [24.8130, 60.2190], // Leppävaara
  [24.9650, 60.2100], // Käpylä
  [25.0780, 60.2070], // Itäkeskus
];
const use = new Map();
const nodes = manifest.node_count;
let seed = 20260918;
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
let routed = 0;
for (let trip = 0; trip < trips; trip += 1) {
  const from = Math.floor(random() * nodes);
  const [toLon, toLat] = DESTINATIONS[Math.floor(random() * DESTINATIONS.length)];
  const fromLon = graph.lon[from] / scale, fromLat = graph.lat[from] / scale;
  const span = metres(fromLon, fromLat, toLon, toLat);
  if (span < 1500 || span > 20000) { trip -= 1; continue; }
  const route = router.route(fromLon, fromLat, toLon, toLat, { speedKmh: 18 });
  if (!route) continue;
  routed += 1;
  for (const edge of route.edges) use.set(edge, (use.get(edge) ?? 0) + 1);
}

const rank = (values) => {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
    const mean = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[order[k][1]] = mean;
    i = j + 1;
  }
  return out;
};

const observed = at.map((c) => c.daily);
const modelled = at.map((c) => use.get(c.edge) ?? 0);
const ro = rank(observed), rm = rank(modelled);
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const mo = mean(ro), mm = mean(rm);
const cov = ro.reduce((s, r, i) => s + (r - mo) * (rm[i] - mm), 0);
const sd = (xs, m) => Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0));
const rho = cov / (sd(ro, mo) * sd(rm, mm));

console.log(`${counters.length} counter sites, ${at.length} matched to an edge within ${REACH_M} m`);
console.log(`${routed} trips routed, ${use.size.toLocaleString()} distinct edges used\n`);
console.log(`Spearman rank correlation, observed daily count vs modelled usage: ${rho.toFixed(3)}`);
const busiest = [...at].sort((a, b) => b.daily - a.daily).slice(0, 12);
console.log(`\n${"place".padEnd(30)} ${"counted/day".padStart(11)} ${"trips".padStart(6)}`);
for (const c of busiest) {
  console.log(`${c.place.slice(0, 30).padEnd(30)} ${String(c.daily).padStart(11)} ${String(use.get(c.edge) ?? 0).padStart(6)}`);
}
