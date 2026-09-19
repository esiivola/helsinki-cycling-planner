/** What the rider has told the router about themselves, and how it survives a reload.
 *
 * Two halves, deliberately kept apart:
 *
 *   `cost`  is a claim about the world -- how long a light really holds you, how
 *           much a turn really costs. Changing it changes the minutes on screen.
 *   `taste` is a claim about nothing at all. "I hate gravel" is not a duration, so
 *           it steers the search and never touches what a route is reported to cost.
 *
 * The graph already ships a cost model in its manifest; this only carries the fields
 * a rider has actually moved away from it, so a rebuilt graph with better-calibrated
 * defaults is picked up rather than overridden by a stale copy.
 */
import type { CostModel } from "./graph.ts";

/** Multipliers applied inside the search only. 1 is "no opinion"; below 1 is a
 *  preference, above 1 an aversion. */
export interface Taste {
  /** Every manoeuvre at a junction. */
  turn: number;
  /** Every wait at a light. */
  signal: number;
  /** The metres ridden on a rough surface. */
  unpaved: number;
  /** The metres ridden on a paved way shared with people on foot. */
  shared: number;
  /** Riding among motor traffic, scaled by how much of it there is. */
  traffic: number;
  /** A carriageway that has a cycleway mapped beside it. */
  sidepath: number;
  /** A signposted route: a baana or a regional cycle route. */
  network: number;
  /** The metres climbed. Only bites once climb data has been loaded. */
  hill: number;
  /** Bollards, gates and kerbs. */
  barrier: number;
  /** Metres known to be lit. Below 1 this is a preference, which is how it is meant:
   *  an untagged way is unsurveyed, not dark. */
  lit: number;
  /** The city's prioritised winter network. A preference, in winter a strong one. */
  winter: number;
}

export interface Profile {
  speedKmh: number;
  /** Only the fields moved away from the graph's own model. */
  cost: Partial<CostModel>;
  taste: Taste;
}

export const DEFAULT_SPEED_KMH = 18;

/** Five stops on one scale, the same shape on every row.
 *
 * "Vältä tiukasti" is a large multiplier and deliberately not infinity. Forbidding a
 * way outright is what `SIDEPATH_PENALTY` was written to avoid: excluding sidepath
 * carriageways left four of the ten benchmark pairs unable to connect at all, which
 * sent them back onto the road for the whole ride. A hard no has to stay finite or
 * it stops being a preference and becomes a bug.
 */
/** Five stops on one scale. Rows where wanting *more* of something is meaningful --
 *  more cycleway, more baana -- start at a preference; rows where it is not, like
 *  waiting at lights, start at neutral and only ever avoid.
 *
 * "Vältä tiukasti" is a large multiplier and deliberately not infinity. Forbidding a
 * way outright is what `SIDEPATH_PENALTY` was written to avoid: excluding sidepath
 * carriageways left four of the ten benchmark pairs unable to connect at all, which
 * sent them back onto the road for the whole ride. A hard no has to stay finite or
 * it stops being a preference and becomes a bug.
 */
export const STOP_COUNT = 5;

const AVOID = ["Ei väliä", "Vältä hieman", "Vältä", "Vältä tiukasti", "Vältä kaikin keinoin"] as const;
const EITHER = ["Suosi", "Ei väliä", "Vältä hieman", "Vältä", "Vältä tiukasti"] as const;

export interface Row {
  key: keyof Taste;
  label: string;
  hint: string;
  /** Hidden until the climb data has landed. */
  needsClimb?: boolean;
  /** Hidden until the winter network has landed. */
  needsWinter?: boolean;
  /** One multiplier per stop, weakest first. */
  values: readonly [number, number, number, number, number];
  labels: readonly [string, string, string, string, string];
  /** The stop that ships, as an index. Not always the neutral one: the graph's own
   *  model already prefers a signposted route and already avoids riding the
   *  carriageway where a cycleway is mapped beside it. */
  standard: number;
  /** What moving to the last stop does, from `scripts/bench_profiles.mjs`. */
  effect: string;
}

/* Every number below comes from `scripts/bench_profiles.mjs` over the ten benchmark
   pairs, not from taste. The weakest avoiding stop is where the metric moves but the
   detour stays near nothing; the strongest is the knee, past which more multiplier
   buys almost nothing -- or, for gravel, the point where the search starts escaping
   onto sidepath carriageways instead, which is a worse answer than the gravel was. */
export const ROWS: readonly Row[] = [
  {
    key: "traffic",
    label: "Autojen seassa ajo",
    hint: "Mitä vilkkaampi väylä, sitä kovemmin tämä puree.",
    values: [0.75, 1, 1.5, 3, 8],
    labels: EITHER,
    standard: 1,
    effect: "pyörätietä 78 % → 96 %, matka-aika +7 %",
  },
  {
    key: "unpaved",
    label: "Sora ja muu päällystämätön",
    hint: "Kapeille renkaille ja märälle kelille.",
    values: [0.9, 1, 1.3, 2, 4],
    labels: EITHER,
    standard: 1,
    effect: "soraa 10,5 % → 0,7 %, matka-aika +6 %",
  },
  {
    key: "shared",
    label: "Jalankulkijoiden kanssa jaettu väylä",
    hint: "Yhdistetty pyörätie ja jalkakäytävä.",
    values: [0.9, 1, 1.3, 2, 4],
    labels: EITHER,
    standard: 1,
    effect: "jaettua väylää 40 % → 5 %, matka-aika +14 %",
  },
  {
    key: "network",
    label: "Baanat ja pyöräreitit",
    hint: "Viitoitettu reitti, jota voi seurata katsomatta karttaa.",
    values: [0.6, 0.9, 1, 1.3, 2],
    labels: ["Suosi vahvasti", "Suosi", "Ei väliä", "Vältä", "Vältä tiukasti"],
    standard: 1,
    effect: "viitoitettua reittiä 49 % → 59 %, matka-aika +2 %",
  },
  {
    key: "sidepath",
    label: "Ajorata pyörätien vierellä",
    hint: "Ajorata, jonka vieressä kulkee pyörätie. Oletuksena vältetään tiukasti.",
    values: [1, 2, 4, 8, 20],
    labels: AVOID,
    standard: 3,
    effect: "ajorataa 37 % → 0,2 %",
  },
  {
    key: "hill",
    label: "Mäet",
    needsClimb: true,
    hint: "Nousumetrit. Vaatii korkeusaineiston.",
    values: [1, 2, 4, 8, 20],
    labels: AVOID,
    standard: 0,
    effect: "nousua 2 083 m → 1 067 m, matka-aika +13 %",
  },
  {
    key: "barrier",
    label: "Puomit, pollarit ja reunakivet",
    hint: "Esteet, joissa on hidastettava tai jalka laskettava maahan.",
    values: [1, 1.5, 2, 3, 6],
    labels: AVOID,
    standard: 0,
    effect: "esteitä vähemmän, matka pitenee",
  },
  {
    key: "lit",
    label: "Valaistus",
    hint: "Suosii väyliä, joiden tiedetään olevan valaistuja. Pimeään aikaan.",
    values: [0.8, 0.9, 1, 1, 1],
    labels: ["Suosi vahvasti", "Suosi", "Ei väliä", "Ei väliä", "Ei väliä"],
    standard: 2,
    effect: "valaistua reittiä enemmän",
  },
  {
    key: "winter",
    label: "Talvihoidetut reitit",
    hint: "Kaupungin harjasuolaamat ja tehostetusti auraamat reitit. 149 km.",
    needsWinter: true,
    values: [0.6, 0.8, 1, 1, 1],
    labels: ["Suosi vahvasti", "Suosi", "Ei väliä", "Ei väliä", "Ei väliä"],
    standard: 2,
    effect: "talvihoidettua 21 % → 33 %, matka-aika +3 %",
  },
  {
    key: "turn",
    label: "Käännökset",
    hint: "Jokainen käännös risteyksessä.",
    values: [1, 1.5, 2, 3, 5],
    labels: AVOID,
    standard: 0,
    effect: "käännöksiä 569 → 300, matka-aika +6 %",
  },
  {
    key: "signal",
    label: "Liikennevalot",
    hint: "Jokainen odotus valoissa.",
    values: [1, 1.5, 2, 4, 8],
    labels: AVOID,
    standard: 0,
    effect: "valo-odotuksia 97 → 15, matka-aika +3 %",
  },
];

const ROW = new Map(ROWS.map((row) => [row.key, row]));

export const rowOf = (key: keyof Taste): Row => ROW.get(key)!;

/** Which stop a multiplier sits on, or -1 when it sits between two of them. */
export const stopOf = (key: keyof Taste, value: number): number =>
  rowOf(key).values.findIndex((candidate) => Math.abs(candidate - value) < 1e-9);

export const defaultTaste = (): Taste =>
  Object.fromEntries(ROWS.map((row) => [row.key, row.values[row.standard]])) as unknown as Taste;

export const defaultProfile = (): Profile =>
  ({ speedKmh: DEFAULT_SPEED_KMH, cost: {}, taste: defaultTaste() });

/** The parameters of the graph's own cost model that a rider may sensibly move.
 *
 * `turn_degrees` and `turn_merge_m` are left out on purpose: they define what counts
 * as a turn rather than what one costs, so moving them changes the meaning of the
 * numbers in the readout instead of their size.
 */
export interface Knob {
  key: keyof CostModel;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  /** Hidden until the climb data has landed; without it the knob does nothing. */
  needsClimb?: boolean;
}

export const KNOBS: readonly Knob[] = [
  { key: "signal_delay_s", label: "Odotus liikennevaloissa", unit: "s", min: 0, max: 90, step: 1 },
  { key: "turn_penalty_s", label: "Käännös risteyksessä", unit: "s", min: 0, max: 40, step: 1 },
  { key: "turn_left_factor", label: "Vasen käännös oikeaan verrattuna", unit: "×", min: 1, max: 3, step: 0.1 },
  { key: "crossing_delay_s", label: "Suojatie ilman valoja", unit: "s", min: 0, max: 20, step: 0.5 },
  { key: "slow_speed_factor", label: "Vauhti hitaalla pinnoitteella", unit: "×", min: 0.3, max: 1, step: 0.05 },
  { key: "climb_s_per_m", label: "Nousumetri maksaa", unit: "s", min: 0, max: 8, step: 0.25, needsClimb: true },
  { key: "descent_credit_s_per_m", label: "Laskumetri hyvittää", unit: "s", min: 0, max: 4, step: 0.1, needsClimb: true },
];

const KNOB = new Map(KNOBS.map((knob) => [knob.key, knob]));

// --- presets ------------------------------------------------------------------

export interface Preset {
  id: string;
  label: string;
  hint: string;
  /** Stop index per row; rows left out keep their shipped stop. */
  taste: Partial<Record<keyof Taste, number>>;
}

export const PRESETS: readonly Preset[] = [
  /* No "fastest": the shipped model already minimises perceived time, and dropping
     its preference for signposted routes made the benchmark *slower* (1089 min
     against 1081) -- a baana is not only pleasant, it is quick. A preset that lost
     time while promising to save it would be a lie. */
  { id: "balanced", label: "Tasapainoinen", hint: "Oletusasetukset.", taste: {} },
  {
    id: "calm", label: "Rauhallinen", hint: "Pois autojen seasta, viitoitettua reittiä.",
    taste: { traffic: 3, network: 0, shared: 2 },
  },
  {
    id: "simple", label: "Suoraviivainen", hint: "Vähän käännöksiä ja valo-odotuksia.",
    taste: { turn: 2, signal: 1 },
  },
  {
    id: "paved", label: "Asfaltti", hint: "Kapeat renkaat tai märkä keli.",
    taste: { unpaved: 4 },
  },
  {
    id: "flat", label: "Tasainen", hint: "Vältä nousuja.",
    taste: { hill: 3 },
  },
  {
    id: "winter", label: "Talvi", hint: "Hoidettua reittiä, valaistua, ei soraa.",
    taste: { winter: 0, lit: 1, unpaved: 3 },
  },
];

export function applyPreset(preset: Preset): Taste {
  const taste = defaultTaste();
  for (const [key, stop] of Object.entries(preset.taste)) {
    taste[key as keyof Taste] = rowOf(key as keyof Taste).values[stop];
  }
  return taste;
}

/** Which preset a taste matches exactly, if any. */
export function presetOf(taste: Taste): Preset | null {
  return PRESETS.find((preset) => {
    const wanted = applyPreset(preset);
    return ROWS.every((row) => Math.abs(wanted[row.key] - taste[row.key]) < 1e-9);
  }) ?? null;
}

export const isDefault = (profile: Profile): boolean =>
  profile.speedKmh === DEFAULT_SPEED_KMH
  && Object.keys(profile.cost).length === 0
  && presetOf(profile.taste)?.id === "balanced";

// --- the link -----------------------------------------------------------------

/* One letter each, so a shared route stays a link somebody will paste rather than a
   paragraph. Lower case is taste, upper case is the cost model. */
const TASTE_CODE: Record<keyof Taste, string> = {
  turn: "t", signal: "g", unpaved: "u", shared: "j", traffic: "c",
  sidepath: "d", network: "n", hill: "h", barrier: "b", lit: "v", winter: "w",
};
const COST_CODE: Partial<Record<keyof CostModel, string>> = {
  signal_delay_s: "S", turn_penalty_s: "T", turn_left_factor: "L",
  crossing_delay_s: "C", slow_speed_factor: "F",
  climb_s_per_m: "H", descent_credit_s_per_m: "D",
};

const short = (value: number) => String(Number(value.toPrecision(3)));

/** The profile as a URL token, or "" when it is the shipped one. Only what differs
 *  is written, so the token stays short and a later change of default is inherited
 *  rather than frozen into every link ever shared. */
export function encodeProfile(profile: Profile): string {
  const standard = defaultTaste();
  let token = "";
  for (const row of ROWS) {
    const value = profile.taste[row.key];
    if (Math.abs(value - standard[row.key]) > 1e-9) token += TASTE_CODE[row.key] + short(value);
  }
  for (const [key, code] of Object.entries(COST_CODE)) {
    const value = profile.cost[key as keyof CostModel];
    if (typeof value === "number") token += code + short(value);
  }
  return token;
}

const finite = (value: number, min: number, max: number): number | null =>
  Number.isFinite(value) && value >= min && value <= max ? value : null;

/** Read a token back. Anything unrecognised or out of range is dropped rather than
 *  refused: a link from a later version should still route, just not exactly. */
export function decodeProfile(token: string, base = defaultProfile()): Profile {
  const profile: Profile = { speedKmh: base.speedKmh, cost: { ...base.cost }, taste: { ...base.taste } };
  for (const [, code, digits] of token.matchAll(/([a-zA-Z])(-?[0-9]*\.?[0-9]+)/g)) {
    const value = Number(digits);
    const tasteKey = (Object.keys(TASTE_CODE) as (keyof Taste)[]).find((key) => TASTE_CODE[key] === code);
    if (tasteKey) {
      const checked = finite(value, 0.05, 100);
      if (checked !== null) profile.taste[tasteKey] = checked;
      continue;
    }
    const costKey = (Object.keys(COST_CODE) as (keyof CostModel)[]).find((key) => COST_CODE[key] === code);
    const knob = costKey ? KNOB.get(costKey) : undefined;
    if (costKey && knob) {
      const checked = finite(value, knob.min, knob.max);
      if (checked !== null) profile.cost[costKey] = checked as never;
    }
  }
  return profile;
}

// --- the browser ---------------------------------------------------------------

/* Bumped whenever the meaning of a stored number changes. A stale profile is
   discarded rather than migrated: the settings are three clicks to rebuild, and
   silently routing someone by a rule they no longer hold is worse than forgetting. */
const STORE_KEY = "cycling-planner.profile.1";

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultProfile();
    const stored = JSON.parse(raw) as Partial<Profile>;
    const profile = defaultProfile();
    const speed = finite(Number(stored.speedKmh), 5, 45);
    if (speed !== null) profile.speedKmh = speed;
    for (const row of ROWS) {
      const value = finite(Number(stored.taste?.[row.key]), 0.05, 100);
      if (value !== null) profile.taste[row.key] = value;
    }
    for (const knob of KNOBS) {
      const value = finite(Number(stored.cost?.[knob.key]), knob.min, knob.max);
      if (value !== null) profile.cost[knob.key] = value as never;
    }
    return profile;
  } catch {
    // Private mode, blocked site data, corrupt JSON: all mean "no saved profile".
    return defaultProfile();
  }
}

export function saveProfile(profile: Profile): void {
  try {
    if (isDefault(profile)) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, JSON.stringify(profile));
  } catch { /* nothing worth telling the rider about */ }
}
