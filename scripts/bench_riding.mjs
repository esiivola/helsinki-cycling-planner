/* Where do the routes actually ride?
 *
 * A cycleway mapped beside a road is a separate way, so a router that treats both as
 * rideable will happily send you down the carriageway: same direction, same corner,
 * wrong side of the kerb. This reports the split, per pair, so the choice is visible
 * rather than inferred from the map.
 *
 *     node --experimental-strip-types scripts/bench_riding.mjs [speed] [allow]
 *
 * `allow` prices the carriageway as rideable again, which is what the router did
 * before, for comparison.
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
const graph = decodeGraph(
  JSON.parse(readFileSync(resolve(dir, "graph.json"), "utf8")),
  raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
);
const router = new Router(graph);
const speedKmh = Number(process.argv[2] ?? 18);
const avoidSidepathRoads = process.argv[3] !== "allow";

const pairs = JSON.parse(readFileSync(resolve(here, "pairs.json"), "utf8"));
const share = (part, whole) => `${((part / Math.max(whole, 1)) * 100).toFixed(0)}%`;

let metres = 0;
let dedicated = 0;
let network = 0;
let sidepath = 0;
let seconds = 0;
console.log(`speed ${speedKmh} km/h, carriageway beside a cycleway: ${avoidSidepathRoads ? "avoided" : "allowed"}`);
for (const pair of pairs) {
  const route = router.route(pair.from[0], pair.from[1], pair.to[0], pair.to[1], { speedKmh, avoidSidepathRoads });
  if (!route) { console.log(`${pair.name.padEnd(38)} no route`); continue; }
  metres += route.metres;
  dedicated += route.dedicatedMetres;
  network += route.networkMetres;
  sidepath += route.sidepathMetres;
  seconds += route.seconds;
  console.log(
    `${pair.name.padEnd(38)} ${(route.metres / 1000).toFixed(1).padStart(5)} km`
    + `  ${(route.seconds / 60).toFixed(0).padStart(3)} min`
    + `  cycleway ${share(route.dedicatedMetres, route.metres).padStart(4)}`
    + `  signposted ${share(route.networkMetres, route.metres).padStart(4)}`
    + `  car road beside one ${share(route.sidepathMetres, route.metres).padStart(4)}`
    + ` (${(route.sidepathMetres / 1000).toFixed(2)} km)`,
  );
}
console.log(
  `${"total".padEnd(38)} ${(metres / 1000).toFixed(1).padStart(5)} km  ${(seconds / 60).toFixed(0).padStart(3)} min`
  + `  cycleway ${share(dedicated, metres).padStart(4)}  signposted ${share(network, metres).padStart(4)}`
  + `  car road beside one ${share(sidepath, metres).padStart(4)}`,
);
