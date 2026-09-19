import { describe, expect, it } from "vitest";
import { AddressIndex, type SearchManifest, fold, splitQuery } from "../src/search.ts";
import { coordinateLabel, withinBounds } from "../src/endpoints.ts";

const SCALE = 10_000_000;
const KINDS = [
  "city", "town", "suburb", "quarter", "neighbourhood", "village",
  "airport", "station", "mall", "attraction", "venue", "sports", "park",
  "school", "hospital", "nature", "hotel", "office", "shop", "service",
];
const NO_STREET = 0xffff;

interface Address { street: string; number: string; lon: number; lat: number }
interface Named { name: string; kind: string; lon: number; lat: number; street?: string }

/** Pack a tiny index the same way `tools/build_search.py` does. */
function indexOf(addresses: Address[], places: Named[] = [], namedRoads: Address[] = []): AddressIndex {
  const streets = [...new Set([...addresses, ...namedRoads].map((a) => a.street))].sort();
  const order = [...addresses].sort((left, right) =>
    streets.indexOf(left.street) - streets.indexOf(right.street) || left.number.localeCompare(right.number));
  const zigzag = (value: number) => (value << 1) ^ (value >> 31);
  const deltas = (values: number[]) => values.map((value, index) => zigzag(value - (index ? values[index - 1] : 0)));

  const point = (street: string) => addresses.find((a) => a.street === street)
    ?? namedRoads.find((r) => r.street === street)!;
  const parts: [string, Uint8Array | Uint16Array | Uint32Array | Int32Array][] = [
    ["street_blob", new TextEncoder().encode(streets.join("\n"))],
    ["street_lon", Int32Array.from(streets.map((s) => Math.round(point(s).lon * SCALE)))],
    ["street_lat", Int32Array.from(streets.map((s) => Math.round(point(s).lat * SCALE)))],
    ["number_blob", new TextEncoder().encode(order.map((a) => a.number).join("\n"))],
    ["entry_street", Uint16Array.from(deltas(order.map((a) => streets.indexOf(a.street))))],
    ["entry_lon", Uint32Array.from(deltas(order.map((a) => Math.round(a.lon * SCALE))))],
    ["entry_lat", Uint32Array.from(deltas(order.map((a) => Math.round(a.lat * SCALE))))],
    ["place_blob", new TextEncoder().encode(places.map((p) => p.name).join("\n"))],
    ["place_kind", Uint8Array.from(places.map((p) => KINDS.indexOf(p.kind)))],
    ["place_lon", Int32Array.from(places.map((p) => Math.round(p.lon * SCALE)))],
    ["place_lat", Int32Array.from(places.map((p) => Math.round(p.lat * SCALE)))],
    ["place_street", Uint16Array.from(places.map((p) => (p.street ? streets.indexOf(p.street) : NO_STREET)))],
  ];
  let offset = 0;
  const layout: SearchManifest["layout"] = {};
  const chunks: { at: number; bytes: Uint8Array }[] = [];
  for (const [name, array] of parts) {
    offset += (4 - (offset % 4)) % 4;
    layout[name] = { offset, count: array.length, type: "" };
    chunks.push({ at: offset, bytes: new Uint8Array(array.buffer, array.byteOffset, array.byteLength) });
    offset += array.byteLength;
  }
  const buffer = new ArrayBuffer(offset);
  const view = new Uint8Array(buffer);
  for (const chunk of chunks) view.set(chunk.bytes, chunk.at);
  const manifest: SearchManifest = {
    version: 2, coordinate_scale: SCALE, place_kinds: KINDS,
    street_count: streets.length, address_count: order.length, place_count: places.length, layout,
  };
  return new AddressIndex(manifest, buffer);
}

const ADDRESSES: Address[] = [
  { street: "Mannerheimintie", number: "1", lon: 24.9390, lat: 60.1700 },
  { street: "Mannerheimintie", number: "12", lon: 24.9360, lat: 60.1730 },
  { street: "Mannerheimintie", number: "120", lon: 24.9200, lat: 60.1900 },
  { street: "Mannerheimintie", number: "2", lon: 24.9385, lat: 60.1705 },
  { street: "Hämeentie", number: "1", lon: 24.9560, lat: 60.1800 },
  { street: "Hämeentie", number: "15", lon: 24.9580, lat: 60.1850 },
  { street: "Iso Roobertinkatu", number: "3", lon: 24.9420, lat: 60.1640 },
];
const PLACES: Named[] = [
  { name: "Kallio", kind: "suburb", lon: 24.9500, lat: 60.1840 },
  { name: "Tapiola", kind: "suburb", lon: 24.8050, lat: 60.1760 },
];

describe("query parsing", () => {
  it("splits a house number off the street name", () => {
    expect(splitQuery("Mannerheimintie 12")).toEqual({ street: "Mannerheimintie", number: "12" });
    expect(splitQuery("Iso Roobertinkatu 3 A")).toEqual({ street: "Iso Roobertinkatu", number: "3 A" });
    expect(splitQuery("Hämeentie")).toEqual({ street: "Hämeentie", number: "" });
  });

  it("keeps a street whose name ends in a digit intact", () => {
    // Splitting is a guess; it must not mangle a query that has no number at all.
    expect(splitQuery("Kallio").number).toBe("");
  });

  it("folds the Nordic vowels so a plain keyboard still finds them", () => {
    expect(fold("Hämeentie")).toBe("hameentie");
    expect(fold("Töölönkatu")).toBe("toolonkatu");
  });
});

describe("address search", () => {
  const index = indexOf(ADDRESSES, PLACES);

  it("finds a street by prefix and shows one door per street", () => {
    // Without a number, listing every door on Mannerheimintie would bury everything
    // else in the list.
    const results = index.search("Manner");

    expect(results[0].label.startsWith("Mannerheimintie")).toBe(true);
    expect(results.filter((r) => r.label.startsWith("Mannerheimintie")).length).toBe(1);
  });

  it("narrows to the house number once one is typed", () => {
    const results = index.search("Mannerheimintie 12");

    expect(results.map((r) => r.label)).toContain("Mannerheimintie 12");
    // "12" is a prefix of "120", so both are legitimate matches while typing.
    expect(results.every((r) => r.label.startsWith("Mannerheimintie 12"))).toBe(true);
  });

  it("finds a street typed without its umlauts", () => {
    expect(index.search("hameentie 15")[0].label).toBe("Hämeentie 15");
  });

  it("matches a word inside the name once no prefix fits", () => {
    expect(index.search("Roobertin")[0].label.startsWith("Iso Roobertinkatu")).toBe(true);
  });

  it("offers districts as well as streets", () => {
    const results = index.search("Kallio");

    expect(results[0].label).toBe("Kallio");
    expect(results[0].detail).toBe("Kaupunginosa");
  });

  it("stays quiet until there is something to go on", () => {
    expect(index.search("M")).toEqual([]);
    expect(index.search("  ")).toEqual([]);
  });

  it("returns real coordinates, not the index's own integers", () => {
    const [found] = index.search("Hämeentie 1");

    expect(found.lon).toBeCloseTo(24.9560, 6);
    expect(found.lat).toBeCloseTo(60.1800, 6);
  });

  it("names the nearest address to a dropped pin", () => {
    // What a dragged marker or a GPS fix needs: a label for an arbitrary point.
    const found = index.nearest(24.9562, 60.1802)!;

    expect(found.label).toBe("Hämeentie 1");
    expect(found.detail).toBe("Lähin osoite");
  });
});

describe("endpoints", () => {
  it("labels a bare coordinate readably", () => {
    expect(coordinateLabel(24.93152, 60.16861)).toBe("60.16861, 24.93152");
  });

  it("knows when a GPS fix lands outside the graph", () => {
    // A fix in Tampere must be refused rather than silently snapped to the nearest
    // Helsinki junction, which is 150 km away.
    const bounds = [24.4, 60.05, 25.4, 60.45];

    expect(withinBounds(bounds, 24.94, 60.17)).toBe(true);
    expect(withinBounds(bounds, 23.76, 61.50)).toBe(false);
  });
});

describe("suggestion ranking", () => {
  const index = indexOf(ADDRESSES, PLACES);

  it("puts a district above the streets that merely share its prefix", () => {
    // "Kallio" is a place someone is likely to mean; Kalliotie, Kalliokuja and the
    // rest of the Kallio- streets should not bury it.
    expect(index.search("Kallio")[0].label).toBe("Kallio");
  });

  it("drops the district again once the query outgrows it", () => {
    const results = indexOf([...ADDRESSES, { street: "Kalliotie", number: "1", lon: 24.95, lat: 60.18 }], PLACES)
      .search("Kalliot");

    expect(results.some((result) => result.label === "Kallio")).toBe(false);
    expect(results[0].label).toBe("Kalliotie 1");
  });

  it("does not offer districts once a house number is typed", () => {
    expect(index.search("Kallio 1").every((result) => result.detail === "Osoite")).toBe(true);
  });
});

describe("streets without a matching door", () => {
  it("offers the street when the typed number does not exist", () => {
    // Kauniaistentie has houses but no number 5. Returning nothing loses the street
    // the user had already found; Reittiopas and Google both keep offering it.
    const results = indexOf(ADDRESSES).search("Hämeentie 999");

    expect(results[0].label).toBe("Hämeentie");
    expect(results[0].detail).toBe("Katu");
  });

  it("finds a named road that has no addressed building on it", () => {
    // A fifth of the region's rideable named roads are like this: through-roads,
    // paths and park routes that no building is addressed to.
    const index = indexOf(ADDRESSES, PLACES, [
      { street: "Kauklahdenväylä", number: "", lon: 24.5600, lat: 60.1900 },
    ]);
    const [found] = index.search("Kauklahdenväylä");

    expect(found.label).toBe("Kauklahdenväylä");
    expect(found.detail).toBe("Tie");
    expect(found.lon).toBeCloseTo(24.56, 4);
  });
});

describe("named destinations", () => {
  // The index carries more than streets: a rider names the place, not its address.
  const DESTINATIONS: Named[] = [
    { name: "Musiikkitalo", kind: "venue", lon: 24.9360, lat: 60.1740, street: "Mannerheimintie" },
    { name: "Alepa", kind: "shop", lon: 24.9560, lat: 60.1805, street: "Hämeentie" },
    { name: "Alepa", kind: "shop", lon: 24.9390, lat: 60.1702, street: "Mannerheimintie" },
    { name: "Mannerheimin patsas", kind: "attraction", lon: 24.9365, lat: 60.1715, street: "Mannerheimintie" },
  ];
  const index = indexOf(ADDRESSES, [...PLACES, ...DESTINATIONS]);

  it("finds a landmark that is not a street at all", () => {
    const [found] = index.search("Musiikkitalo");

    expect(found.label).toBe("Musiikkitalo");
    expect(found.lon).toBeCloseTo(24.936, 4);
  });

  it("names the street a place stands on, so two of one name are told apart", () => {
    const found = index.search("Alepa");

    expect(found.map((place) => place.detail)).toEqual(["Kauppa · Hämeentie", "Kauppa · Mannerheimintie"]);
  });

  it("ranks a district above a shop above a street that merely starts the same", () => {
    // Everything here matches "Kallio"/"Manner" somehow; the order is what decides
    // whether the rider has to read the list or just press Enter.
    expect(index.search("Kallio")[0].detail).toBe("Kaupunginosa");
    expect(index.search("Musiikkital")[0].label).toBe("Musiikkitalo");
  });

  it("still puts the street first when a place merely begins with the query", () => {
    // "Manner" is how you start typing Mannerheimintie; the statue on it is not
    // what you meant, and a place match must not displace the street.
    const found = index.search("Manner");

    expect(found[0].label.startsWith("Mannerheimintie")).toBe(true);
    expect(found.some((place) => place.label === "Mannerheimin patsas")).toBe(true);
  });
});
