/** Offline address search over the index `tools/build_search.py` writes.
 *
 * Everything runs locally: 122 k addresses, no geocoder request, no API key, and
 * search-as-you-type stays legal (Nominatim's policy forbids it, Digitransit's key
 * cannot be shipped to a browser). A linear scan over 12 k street names is well
 * under a millisecond, so there is no index structure beyond sorting.
 */

export interface SearchManifest {
  version: number;
  coordinate_scale: number;
  place_kinds: string[];
  street_count: number;
  addressed_street_count?: number;
  address_count: number;
  place_count: number;
  district_count?: number;
  layout: Record<string, { offset: number; count: number; type: string }>;
}

export interface Place {
  /** What to show in the field and the suggestion list. */
  label: string;
  /** Secondary line: the kind of place, or the city-less context we have. */
  detail: string;
  lon: number;
  lat: number;
}

/** Fold case and the Nordic vowels, so "hameentie" finds "Hämeentie".
 *  People type these without a Finnish keyboard often enough to matter. */
export function fold(text: string): string {
  return text.toLowerCase()
    .replace(/[äå]/g, "a").replace(/ö/g, "o").replace(/[éè]/g, "e")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split "Mannerheimintie 12 A" into its street and house-number halves. */
export function splitQuery(query: string): { street: string; number: string } {
  const match = /^(.*?)[\s,]+(\d+\s*[a-zA-ZäöåÄÖÅ]?(?:\s*-\s*\d+)?)\s*$/.exec(query.trim());
  return match ? { street: match[1], number: match[2] } : { street: query.trim(), number: "" };
}

const unzigzag = (value: number) => (value >>> 1) ^ -(value & 1);

/** `place_street` for a place with no street near enough to name it by. */
const NO_STREET = 0xffff;

function text(bytes: ArrayBuffer, entry: { offset: number; count: number }): string[] {
  return new TextDecoder().decode(new Uint8Array(bytes, entry.offset, entry.count)).split("\n");
}

export class AddressIndex {
  private readonly streets: string[];
  private readonly foldedStreets: string[];
  /** A point for every street, including those with no addressed building. */
  private readonly streetLon: Int32Array;
  private readonly streetLat: Int32Array;
  private readonly numbers: string[];
  private readonly entryStreet: Int32Array;
  private readonly lon: Int32Array;
  private readonly lat: Int32Array;
  /** First entry for each street; entries are sorted by street. */
  private readonly streetStart: Int32Array;
  private readonly places: string[];
  private readonly foldedPlaces: string[];
  private readonly placeKind: Uint8Array;
  /** Street each place stands on, for the line under its name; 0xFFFF for none. */
  private readonly placeStreet: Uint16Array;
  private readonly placeLon: Int32Array;
  private readonly placeLat: Int32Array;
  private readonly kinds: string[];
  private readonly scale: number;

  constructor(manifest: SearchManifest, bytes: ArrayBuffer) {
    // 2 added destinations beside the districts. A version 1 index has none of them,
    // and the page would quietly go back to answering only with street names.
    if (manifest.version !== 2) throw new Error(`unsupported search index version ${manifest.version}`);
    const layout = manifest.layout;
    this.scale = manifest.coordinate_scale;
    this.kinds = manifest.place_kinds;
    this.streets = text(bytes, layout.street_blob);
    this.foldedStreets = this.streets.map(fold);
    this.streetLon = new Int32Array(bytes, layout.street_lon.offset, layout.street_lon.count);
    this.streetLat = new Int32Array(bytes, layout.street_lat.offset, layout.street_lat.count);
    this.numbers = text(bytes, layout.number_blob);
    this.places = text(bytes, layout.place_blob).filter((name) => name.length > 0);
    this.foldedPlaces = this.places.map(fold);
    this.placeKind = new Uint8Array(bytes, layout.place_kind.offset, layout.place_kind.count);
    this.placeStreet = new Uint16Array(bytes, layout.place_street.offset, layout.place_street.count);
    this.placeLon = new Int32Array(bytes, layout.place_lon.offset, layout.place_lon.count);
    this.placeLat = new Int32Array(bytes, layout.place_lat.offset, layout.place_lat.count);

    const streetDelta = new Uint16Array(bytes, layout.entry_street.offset, layout.entry_street.count);
    const lonDelta = new Uint32Array(bytes, layout.entry_lon.offset, layout.entry_lon.count);
    const latDelta = new Uint32Array(bytes, layout.entry_lat.offset, layout.entry_lat.count);
    const count = streetDelta.length;
    this.entryStreet = new Int32Array(count);
    this.lon = new Int32Array(count);
    this.lat = new Int32Array(count);
    let street = 0;
    let lon = 0;
    let lat = 0;
    this.streetStart = new Int32Array(this.streets.length + 1).fill(-1);
    for (let entry = 0; entry < count; entry += 1) {
      street += unzigzag(streetDelta[entry]);
      lon += unzigzag(lonDelta[entry]);
      lat += unzigzag(latDelta[entry]);
      this.entryStreet[entry] = street;
      this.lon[entry] = lon;
      this.lat[entry] = lat;
      if (this.streetStart[street] < 0) this.streetStart[street] = entry;
    }
    this.streetStart[this.streets.length] = count;
    // Streets with no entries would leave -1 behind; fill backwards so every slot
    // points at the start of the next street that does have one.
    for (let street = this.streets.length - 1; street >= 0; street -= 1) {
      if (this.streetStart[street] < 0) this.streetStart[street] = this.streetStart[street + 1];
    }
  }

  private at(entry: number): { lon: number; lat: number } {
    return { lon: this.lon[entry] / this.scale, lat: this.lat[entry] / this.scale };
  }

  /** Best matches for what the user has typed so far, most relevant first.
   *
   * Ranking is by match *kind* rather than a blended score, because the kinds mean
   * different things to a person: a district named exactly what you typed is what
   * you meant, and streets that merely begin with the same letters are not. Typing
   * one more character ("Kalliotie") drops the district out on its own, since a
   * shorter name stops being a prefix of a longer query.
   */
  search(query: string, limit = 7): Place[] {
    const raw = query.trim();
    if (raw.length < 2) return [];
    const { street, number } = splitQuery(raw);
    const needle = fold(street);
    const foldedNumber = fold(number);
    if (!needle) return [];

    const placeExact: number[] = [];
    const placePrefix: number[] = [];
    const placeInside: number[] = [];
    // A house number means the user is after a door, not a place.
    if (!foldedNumber) {
      for (let index = 0; index < this.foldedPlaces.length; index += 1) {
        const name = this.foldedPlaces[index];
        if (name === needle) placeExact.push(index);
        else if (name.startsWith(needle)) placePrefix.push(index);
        else if (name.includes(needle)) placeInside.push(index);
      }
    }
    // Within one match class, the more prominent kind first -- the index is ordered
    // by prominence -- and then the shorter name, which is the more exact answer.
    const byKind = (left: number, right: number) =>
      this.placeKind[left] - this.placeKind[right]
      || this.foldedPlaces[left].length - this.foldedPlaces[right].length;
    placeExact.sort(byKind);
    placePrefix.sort(byKind);
    placeInside.sort(byKind);

    const streetPrefix: number[] = [];
    const streetInside: number[] = [];
    for (let index = 0; index < this.foldedStreets.length; index += 1) {
      const name = this.foldedStreets[index];
      if (name.startsWith(needle)) streetPrefix.push(index);
      else if (name.includes(needle)) streetInside.push(index);
      if (streetPrefix.length >= 200) break;
    }
    const byLength = (left: number, right: number) => this.foldedStreets[left].length - this.foldedStreets[right].length;
    streetPrefix.sort(byLength);
    streetInside.sort(byLength);

    const results: Place[] = [];
    const addPlaces = (indices: number[]) => {
      for (const index of indices) {
        if (results.length >= limit) return;
        const street = this.placeStreet[index];
        const kind = this.kindLabel(this.placeKind[index]);
        results.push({
          label: this.places[index],
          detail: street === NO_STREET ? kind : `${kind} · ${this.streets[street]}`,
          lon: this.placeLon[index] / this.scale,
          lat: this.placeLat[index] / this.scale,
        });
      }
    };
    const addStreets = (indices: number[]) => {
      for (const index of indices) {
        if (results.length >= limit) return;
        const start = this.streetStart[index];
        const end = this.streetStart[index + 1];
        // Without a number, one hit per street: a search for "Man" should offer
        // other streets, not 370 doors on Mannerheimintie.
        const perStreet = foldedNumber ? limit : 1;
        let taken = 0;
        for (let entry = start; entry < end && taken < perStreet && results.length < limit; entry += 1) {
          if (foldedNumber && !fold(this.numbers[entry]).startsWith(foldedNumber)) continue;
          taken += 1;
          const label = this.numbers[entry] ? `${this.streets[index]} ${this.numbers[entry]}` : this.streets[index];
          results.push({ label, detail: "Osoite", ...this.at(entry) });
        }
        // No door fits -- either the number does not exist, or the road has no
        // addressed buildings at all. Offering the street beats offering nothing.
        if (!taken) {
          results.push({
            label: this.streets[index],
            detail: end > start ? "Katu" : "Tie",
            lon: this.streetLon[index] / this.scale,
            lat: this.streetLat[index] / this.scale,
          });
        }
      }
    };

    // A place named exactly what was typed is what the rider meant -- "Oodi" is not
    // a prefix of anything else. After that streets come first: typing a street name
    // is still the commonest thing anyone does here, and "Manner" is how you start
    // typing Mannerheimintie, not how you look for the statue on it.
    addPlaces(placeExact);
    addStreets(streetPrefix);
    addPlaces(placePrefix);
    addStreets(streetInside);
    addPlaces(placeInside);
    return results.slice(0, limit);
  }

  private kindLabel(kind: number): string {
    const names: Record<string, string> = {
      city: "Kaupunki", town: "Kaupunki", suburb: "Kaupunginosa",
      quarter: "Kaupunginosa", neighbourhood: "Alue", village: "Kylä",
      airport: "Lentoasema", station: "Asema", mall: "Kauppakeskus",
      attraction: "Nähtävyys", venue: "Kulttuuri", sports: "Liikunta",
      park: "Puisto", school: "Oppilaitos", hospital: "Terveys",
      nature: "Luonto", hotel: "Majoitus", office: "Toimisto",
      shop: "Kauppa", service: "Palvelu",
    };
    return names[this.kinds[kind]] ?? "Paikka";
  }

  /** Closest known address to a point, for labelling a dragged or GPS pin. */
  nearest(lon: number, lat: number): Place | null {
    const targetLon = lon * this.scale;
    const targetLat = lat * this.scale;
    // Latitude degrees are ~2x longitude degrees in metres at this latitude, so
    // compare in a squared space that is at least roughly isotropic.
    const stretch = Math.cos((lat * Math.PI) / 180);
    let best = -1;
    let bestDistance = Infinity;
    for (let entry = 0; entry < this.lon.length; entry += 1) {
      const east = (this.lon[entry] - targetLon) * stretch;
      const north = this.lat[entry] - targetLat;
      const distance = east * east + north * north;
      if (distance < bestDistance) { bestDistance = distance; best = entry; }
    }
    if (best < 0) return null;
    const street = this.entryStreet[best];
    const number = this.numbers[best];
    return {
      label: number ? `${this.streets[street]} ${number}` : this.streets[street],
      detail: "Lähin osoite",
      ...this.at(best),
    };
  }
}

export async function loadSearchIndex(baseUrl: string): Promise<AddressIndex> {
  const manifest = (await (await fetch(`${baseUrl}/search.json`)).json()) as SearchManifest;
  const response = await fetch(`${baseUrl}/search.bin.gz`);
  if (!response.ok) throw new Error("search index request failed");
  const bytes = await response.arrayBuffer();
  const header = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  if (header[0] !== 0x1f || header[1] !== 0x8b) return new AddressIndex(manifest, bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new AddressIndex(manifest, await new Response(stream).arrayBuffer());
}
