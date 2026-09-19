/* How often does the offline index find a place someone would actually name?
 *
 * Ground truth is `search-truth.json`: the coordinates OSM itself gives each query,
 * extracted from the same extract the index is built from, so a miss means the index
 * does not carry the place -- not that OSM does not know it. Where two places share a
 * name the pick is a judgement call, made by hand and marked with a `note`: no
 * automatic rule can say that "Korkeasaari" means the island with the zoo, and
 * scoring against a rule the index already uses would only test it against itself.
 *
 *     node --experimental-strip-types scripts/bench_search.mjs [metres]
 */
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AddressIndex } from "../src/search.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../public/graph");
const manifest = JSON.parse(readFileSync(resolve(dir, "search.json"), "utf8"));
const raw = gunzipSync(readFileSync(resolve(dir, "search.bin.gz")));
const index = new AddressIndex(manifest, raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

const truth = JSON.parse(readFileSync(resolve(here, "search-truth.json"), "utf8"));
const tolerance = Number(process.argv[2] ?? 400);

const metresBetween = (a, b) => {
  const east = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)) * 111_320;
  return Math.hypot(east, (b.lat - a.lat) * 110_540);
};

const entries = Object.entries(truth);
const share = (count) => `${count}/${entries.length} (${Math.round((count / entries.length) * 100)}%)`;

/* Two ways of asking: the whole name, and the part of it a person has typed when
 * they expect the list to have caught up. Search-as-you-type is the real case. */
function run(label, shorten) {
  let top1 = 0;
  let top3 = 0;
  let listed = 0;
  let elapsed = 0;
  const misses = [];
  for (const [query, target] of entries) {
    const typed = shorten(query);
    const started = performance.now();
    const found = index.search(typed);
    elapsed += performance.now() - started;
    const rank = found.findIndex((place) => metresBetween(place, target) <= tolerance);
    if (rank === 0) top1 += 1;
    if (rank >= 0 && rank < 3) top3 += 1;
    // The page shows seven suggestions, so anything in the list is one glance away.
    if (rank >= 0) listed += 1;
    if (rank < 0 || rank >= 3) misses.push(`${typed} -> ${found.length ? `${found[0].label} (${found[0].detail})` : "nothing"}`);
  }
  console.log(
    `${label.padEnd(16)} top 1: ${share(top1)}   top 3: ${share(top3)}   in list: ${share(listed)}`
    + `   ${(elapsed / entries.length).toFixed(2)} ms/query`,
  );
  for (const miss of misses) console.log(`  below top 3  ${miss}`);
}

console.log(`within ${tolerance} m of what OSM calls the place`);
run("whole name", (query) => query);
run("60% typed", (query) => query.slice(0, Math.max(3, Math.ceil(query.length * 0.6))));
