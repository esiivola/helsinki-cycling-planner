import * as maplibregl from "maplibre-gl";
// Vite will not find MapLibre's worker on its own; without this the style never
// finishes loading and the map stays blank with no error anywhere.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { type ClimbBytes, decodeClimb, fetchClimb } from "./climb.ts";
import { type Winter, loadWinter } from "./winter.ts";
import { type Graph, loadGraph } from "./graph.ts";
import { Router, type Maneuver, type Route, type Step } from "./route.ts";
import { AddressIndex, type Place, loadSearchIndex } from "./search.ts";
import { type Endpoint, type Which, coordinateLabel, currentPosition, withinBounds } from "./endpoints.ts";
import {
  DEFAULT_SPEED_KMH, type Profile,
  decodeProfile, defaultProfile, encodeProfile, loadProfile, saveProfile,
} from "./profile.ts";
import { mountSettings } from "./settings.ts";

maplibregl.setWorkerUrl(workerUrl);

const CENTRE: [number, number] = [24.9414, 60.1710];
const ROUTE_SOURCE = "route";
const SIGNAL_SOURCE = "signals";
const ACCESS_SOURCE = "access";
/** Below this the pin is on the network for all practical purposes, and a stub of a
 *  dash is just noise. */
const ACCESS_MIN_M = 8;
const ALTERNATIVE_LAYER = "route-alternative";
/** The best route first, then genuinely different ways of riding the same trip. */
const ALTERNATIVES = 3;

/* Two basemaps rather than a CSS filter over one: inverting Positron turns the sea
   pale and the land black, which reads as a photographic negative of a map. CARTO
   draws a dark style properly, so use it. */
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const basemap = () => dark.matches
  ? "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
  : "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const routeColour = () => (dark.matches ? "#7ea7ff" : "#155eef");
const casingColour = () => (dark.matches ? "#0d1114" : "#ffffff");

const map = new maplibregl.Map({
  container: "map",
  style: basemap(),
  center: CENTRE,
  zoom: 11.5,
  // One control, not two: adding a second AttributionControl by hand printed the
  // basemap's credits twice along the bottom of the map.
  // Left to decide for itself: pinned open, the credits ran as a two-line grey band
  // right across a phone screen. Narrow viewports get the (i) button instead.
  attributionControl: {
    customAttribution:
      "Reititys ja osoitteet: OpenStreetMap · Liikennevalot myös Helsinki, Espoo ja Vantaa (CC BY 4.0)",
  },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true, showAccuracyCircle: true }), "bottom-right");

let router: Router | null = null;
let addresses: AddressIndex | null = null;
let bounds: readonly number[] = [-180, -90, 180, 90];
/** Climb can land before the graph it belongs to, and cannot even be decoded without
 *  it, so the raw bytes wait here. */
let climbData: ClimbBytes | null = null;
/** Kept because decoding the heights needs the graph's own shape index. */
let graphData: Graph | null = null;
/** The city's winter network, which can also land before the router exists. */
let winterData: Winter | null = null;

/** Everything the rider has told the router about themselves. */
let profile = loadProfile();
/** A link may carry a profile that is not the one saved in this browser. Adopting it
 *  silently would rewrite their settings from a link someone else sent; ignoring it
 *  would show them a different route from the one that was shared. So: use it for
 *  this visit, and offer to keep it. */
let borrowedProfile = false;
let status = "";
let failure = "";
/** Which field the next map click fills. Reittiopas picks the empty one; so do we. */
let picking: Which = "from";

const ends: Record<Which, Endpoint | null> = { from: null, to: null };
const markers: Partial<Record<Which, maplibregl.Marker>> = {};
const draft: Record<Which, string> = { from: "", to: "" };
let focused: Which | null = null;
let suggestions: Place[] = [];
let highlighted = -1;
let routes: Route[] = [];
let selected = 0;
/** The step the rider last asked to see, highlighted in the list and centred. */
let openStep = -1;
/** Whether the turn-by-turn list is unfolded; it survives a re-render. */
let directionsOpen = false;
/** Endpoints restored from the link still carry coordinates for labels; once the
 *  address index lands they get their real names. */
let namesPending = false;

const panel = document.getElementById("panel") as HTMLElement;
const form = document.getElementById("form")!;
const readout = document.getElementById("readout")!;
const live = document.getElementById("live")!;
const resetButton = document.getElementById("reset") as HTMLButtonElement;
const grip = document.getElementById("grip") as HTMLButtonElement;

const PLACEHOLDER: Record<Which, string> = { from: "Mistä?", to: "Minne?" };
const LABEL: Record<Which, string> = { from: "Lähtöpaikka", to: "Määränpää" };

// --- icons -------------------------------------------------------------------

const svg = (path: string, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${path}</svg>`;

const ICON = {
  locate: svg(`<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7.6"/>
    <path d="M12 1.8v2.6M12 19.6v2.6M22.2 12h-2.6M4.4 12H1.8"/>`),
  clear: svg(`<path d="M6 6l12 12M18 6L6 18"/>`),
  swap: svg(`<path d="M7.5 3.5v17M7.5 20.5 4 17M7.5 20.5 11 17M16.5 20.5v-17M16.5 3.5 13 7M16.5 3.5 20 7"/>`),
  share: svg(`<path d="M9.5 13.5 14.5 11M9.5 10.5l5 2.5"/>
    <circle cx="17.5" cy="7" r="2.8"/><circle cx="6.5" cy="12" r="2.8"/><circle cx="17.5" cy="17" r="2.8"/>`),
  address: svg(`<path d="M12 21.5s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z"/><circle cx="12" cy="10.5" r="2.4"/>`),
  place: svg(`<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/>`),
  warn: svg(`<path d="M12 3.5 21 19.5H3L12 3.5Z"/><path d="M12 9.5v4.5M12 17h.01"/>`, 'style="flex:0 0 auto;width:17px;height:17px"'),
};

// --- map -------------------------------------------------------------------

function setMarker(which: Which): void {
  const end = ends[which];
  if (!end) { markers[which]?.remove(); delete markers[which]; return; }
  const existing = markers[which];
  if (existing) { existing.setLngLat([end.lon, end.lat]); return; }
  const element = document.createElement("div");
  element.className = which === "from" ? "pin" : "pin to";
  element.textContent = which === "from" ? "A" : "B";
  element.title = `${LABEL[which]} — vedä siirtääksesi`;
  const marker = new maplibregl.Marker({ element, draggable: true }).setLngLat([end.lon, end.lat]).addTo(map);
  marker.on("dragend", () => {
    // Through setEnd, not by assigning: dropping a pin somewhere else is the same
    // act as picking it from the map, and it has to rename the field with it. It
    // used to leave the old address sitting under a pin that had moved away.
    const at = marker.getLngLat();
    setEnd(which, describe(at.lng, at.lat));
  });
  markers[which] = marker;
}

/** Name a raw point by its nearest known address, falling back to coordinates. */
function describe(lon: number, lat: number): Endpoint {
  const nearest = addresses?.nearest(lon, lat);
  return { lon, lat, label: nearest ? nearest.label : coordinateLabel(lon, lat) };
}

function drawRoutes(): void {
  const source = map.getSource(ROUTE_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (!source) return; // the basemap may still be loading; update() runs again when it is
  source.setData({
    type: "FeatureCollection",
    features: routes.map((route, index) => ({
      type: "Feature" as const,
      properties: { index, chosen: index === selected },
      geometry: { type: "LineString" as const, coordinates: route.path },
    })),
  });
  drawSignals();
  drawAccess();
}

/** The lights on the chosen route only: drawing the alternatives' as well turned the
 *  inner city into a field of dots that said nothing about the ride being planned. */
function drawSignals(): void {
  const source = map.getSource(SIGNAL_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (!source) return;
  source.setData({
    type: "FeatureCollection",
    features: (routes[selected]?.signalPoints ?? []).map((point) => ({
      type: "Feature" as const, properties: {},
      geometry: { type: "Point" as const, coordinates: point },
    })),
  });
}

/** The bit between the pin and where the riding starts.
 *
 * A route runs between junctions, so it begins at the nearest one -- the median
 * building in the region is 24 m from it, some are hundreds. Drawn as nothing at
 * all, the line simply stops short of the pin and the map looks broken, which is
 * what dragging a pin makes obvious. Drawn as a dash, it says what it is: the metres
 * you cover before the route can price anything.
 */
function drawAccess(): void {
  const source = map.getSource(ACCESS_SOURCE) as maplibregl.GeoJSONSource | undefined;
  if (!source) return;
  const route = routes[selected];
  const legs: [number, number][][] = [];
  if (route?.path.length) {
    for (const [which, point] of [["from", route.path[0]], ["to", route.path[route.path.length - 1]]] as const) {
      const end = ends[which];
      if (end && metresApart(end.lon, end.lat, point[0], point[1]) > ACCESS_MIN_M) {
        legs.push([[end.lon, end.lat], point]);
      }
    }
  }
  source.setData({
    type: "FeatureCollection",
    features: legs.map((line) => ({
      type: "Feature" as const, properties: {},
      geometry: { type: "LineString" as const, coordinates: line },
    })),
  });
}

function metresApart(fromLon: number, fromLat: number, toLon: number, toLat: number): number {
  const east = (toLon - fromLon) * Math.cos(((fromLat + toLat) / 2) * (Math.PI / 180)) * 111_320;
  return Math.hypot(east, (toLat - fromLat) * 110_540);
}

/** Keep clear of whatever the panel is covering: the left third on a desktop, the
 *  bottom sheet on a phone. Fitting to the viewport alone hid the route behind it. */
function padding(): maplibregl.PaddingOptions {
  if (isSheet()) {
    const covered = panel.getBoundingClientRect().height - sheetOffset();
    return { top: 70, bottom: Math.round(covered) + 24, left: 24, right: 24 };
  }
  return { top: 60, bottom: 60, left: Math.round(panel.getBoundingClientRect().right) + 24, right: 60 };
}

/** Frame the ride. The whole drawn route, not just its two ends -- a route that
 *  detours around a bay runs well outside the box its endpoints make, and half of
 *  it used to sit off-screen. */
function frame(): void {
  const points: [number, number][] = routes[selected]?.path.length
    ? routes[selected].path
    : (["from", "to"] as const).flatMap((which) => {
        const end = ends[which];
        return end ? [[end.lon, end.lat] as [number, number]] : [];
      });
  if (points.length < 2) return;
  const box = points.reduce(
    (acc, point) => acc.extend(point),
    new maplibregl.LngLatBounds(points[0], points[0]),
  );
  map.fitBounds(box, { padding: padding(), maxZoom: 15, duration: 600 });
}

// --- endpoints ---------------------------------------------------------------

function setEnd(which: Which, end: Endpoint | null, options: { frame?: boolean } = {}): void {
  ends[which] = end;
  selected = 0;
  draft[which] = end?.label ?? "";
  setMarker(which);
  picking = ends.from ? (ends.to ? "from" : "to") : "from";
  update({ frame: options.frame });
}

async function useCurrentPosition(which: Which): Promise<void> {
  status = "Haetaan sijaintia…";
  failure = "";
  render();
  try {
    const fix = await currentPosition();
    if (!withinBounds(bounds, fix.lon, fix.lat)) {
      status = "";
      failure = "Sijaintisi on palvelun kattaman alueen ulkopuolella.";
      render();
      return;
    }
    status = "";
    setEnd(which, { ...describe(fix.lon, fix.lat), label: "Oma sijainti" }, { frame: true });
  } catch (error) {
    status = "";
    failure = error instanceof Error ? error.message : "Sijaintia ei saatu selville.";
    render();
  }
}

function swap(): void {
  const [previousFrom, previousTo] = [ends.from, ends.to];
  ends.from = previousTo;
  ends.to = previousFrom;
  draft.from = previousTo?.label ?? "";
  draft.to = previousFrom?.label ?? "";
  setMarker("from");
  setMarker("to");
  picking = ends.from ? (ends.to ? "from" : "to") : "from";
  update();
}

function clearEnd(which: Which): void {
  draft[which] = "";
  suggestions = [];
  highlighted = -1;
  setEnd(which, null);
  inputs[which].focus();
}

function resetAll(): void {
  focused = null;
  suggestions = [];
  highlighted = -1;
  failure = "";
  for (const which of ["from", "to"] as const) { draft[which] = ""; ends[which] = null; setMarker(which); }
  picking = "from";
  update();
  inputs.from.focus();
}

// --- the link ----------------------------------------------------------------

const coordinateParam = (end: Endpoint) => `${end.lon.toFixed(5)},${end.lat.toFixed(5)}`;

/** The trip lives in the address bar, so it can be bookmarked, reloaded and sent to
 *  someone else -- which is the first thing anyone tries after finding a good route. */
function writeUrl(): void {
  const query = new URLSearchParams();
  if (ends.from) query.set("a", coordinateParam(ends.from));
  if (ends.to) query.set("b", coordinateParam(ends.to));
  if (profile.speedKmh !== DEFAULT_SPEED_KMH) query.set("v", String(profile.speedKmh));
  // Only what differs from the shipped model, so an ordinary trip stays an ordinary
  // link and a later change of default is inherited rather than frozen in.
  const token = encodeProfile(profile);
  if (token) query.set("p", token);
  const text = query.toString();
  history.replaceState(null, "", text ? `?${text}` : location.pathname);
}

function readUrl(): void {
  const query = new URLSearchParams(location.search);
  const point = (name: string): Endpoint | null => {
    const [lon, lat] = (query.get(name) ?? "").split(",").map(Number);
    return Number.isFinite(lon) && Number.isFinite(lat)
      ? { lon, lat, label: coordinateLabel(lon, lat) }
      : null;
  };
  const token = query.get("p");
  if (token) {
    const linked = decodeProfile(token, defaultProfile());
    linked.speedKmh = profile.speedKmh;
    borrowedProfile = !sameProfile(linked, profile);
    if (borrowedProfile) profile = linked;
  }
  const speed = Number(query.get("v"));
  if (Number.isFinite(speed) && speed >= 10 && speed <= 28) profile.speedKmh = Math.round(speed);
  for (const which of ["from", "to"] as const) {
    const end = point(which === "from" ? "a" : "b");
    if (!end) continue;
    ends[which] = end;
    draft[which] = end.label;
    setMarker(which);
    namesPending = true;
  }
  picking = ends.from ? (ends.to ? "from" : "to") : "from";
}

/** Copying a URL has three implementations and no single one of them is reliable:
 *  the async clipboard needs the document focused and a permission that Safari and
 *  embedded views withhold, `execCommand` is deprecated but still works where that
 *  fails, and a phone would rather open its own share sheet than copy anything. */
function copyToClipboard(text: string): Promise<boolean> {
  const byCommand = (): boolean => {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(scratch);
    scratch.select();
    let copied = false;
    try { copied = document.execCommand("copy"); } catch { copied = false; }
    scratch.remove();
    return copied;
  };
  if (!navigator.clipboard?.writeText) return Promise.resolve(byCommand());
  return navigator.clipboard.writeText(text).then(() => true, () => byCommand());
}

async function share(button: HTMLButtonElement): Promise<void> {
  const url = location.href;
  if (navigator.share) {
    try {
      await navigator.share({ title: document.title, url });
      return;
    } catch (error) {
      // Backing out of the share sheet is not a failure and gets no message.
      if (error instanceof Error && error.name === "AbortError") return;
    }
  }
  if (await copyToClipboard(url)) {
    const previous = button.getAttribute("aria-label")!;
    button.setAttribute("aria-label", "Linkki kopioitu");
    button.classList.add("copied");
    announce("Linkki kopioitu leikepöydälle.");
    setTimeout(() => { button.setAttribute("aria-label", previous); button.classList.remove("copied"); }, 2000);
  } else {
    announce("Linkin kopiointi ei onnistunut. Kopioi osoite selaimen osoiterivistä.");
  }
}

// --- the profile -------------------------------------------------------------

/** Give the router its hills, if both halves have arrived. A file that does not fit
 *  the graph is dropped rather than thrown: flat routing is a far better outcome
 *  than a dead page. */
function useClimb(raw: ClimbBytes | null): void {
  climbData = raw;
  if (!router || !raw || !graphData) return;
  try {
    router.attachClimb(decodeClimb(raw.manifest, raw.bytes, graphData));
  } catch (error) {
    console.error("climb data does not match the graph", error);
    climbData = null;
    return;
  }
  update({ frame: false });
}

/** Hand the router the city's winter network, once both have arrived. */
function useWinter(winter: Winter | null): void {
  winterData = winter;
  if (!router || !winter) return;
  try {
    router.attachWinter(winter);
  } catch (error) {
    console.error("winter data does not match the graph", error);
    winterData = null;
    return;
  }
  update({ frame: false });
}

const sameProfile = (a: Profile, b: Profile): boolean =>
  encodeProfile(a) === encodeProfile(b) && a.speedKmh === b.speedKmh;

/** Re-routing on every frame of a slider drag is affordable -- the whole search is
 *  local and takes milliseconds -- but only once per frame, not once per event. */
let pendingUpdate = 0;
function setProfile(next: Profile): void {
  profile = next;
  // Touching a control is how a rider adopts a profile arrived at by link: from here
  // on it is theirs, and it is saved.
  borrowedProfile = false;
  saveProfile(profile);
  if (pendingUpdate) return;
  pendingUpdate = requestAnimationFrame(() => {
    pendingUpdate = 0;
    update({ frame: false });
  });
}

function keepBorrowed(keep: boolean): void {
  borrowedProfile = false;
  if (keep) saveProfile(profile);
  else profile = loadProfile();
  update({ frame: false });
}

// --- the mobile sheet --------------------------------------------------------

const sheetQuery = window.matchMedia("(max-width: 720px), (max-height: 520px)");
const isSheet = () => sheetQuery.matches;
let sheetOpen = false;

/** How much of the sheet is hidden below the fold. Collapsed it shows the fields and
 *  the headline answer and nothing else, so the route stays on screen. */
function sheetOffset(): number {
  if (!isSheet()) return 0;
  if (sheetOpen) return 0;
  const first = readout.querySelector<HTMLElement>(".headline, .notice, .lede");
  // Measured against the panel rather than summed from part heights: both move with
  // the sheet, so the difference holds however far down it is pushed, and margins
  // between the parts are counted instead of guessed.
  const top = panel.getBoundingClientRect().top;
  const peek = first
    ? first.getBoundingClientRect().bottom - top + 18
    : form.getBoundingClientRect().bottom - top + 14;
  return Math.max(0, panel.offsetHeight - peek);
}

function layoutSheet(): void {
  if (!isSheet()) {
    panel.style.removeProperty("--sheet");
    document.documentElement.style.removeProperty("--controls");
    grip.setAttribute("aria-expanded", "true");
    return;
  }
  const offset = sheetOffset();
  panel.style.setProperty("--sheet", `${offset}px`);
  document.documentElement.style.setProperty("--controls", `${panel.offsetHeight - offset + 12}px`);
  grip.setAttribute("aria-expanded", String(sheetOpen));
}

function setSheet(open: boolean): void {
  sheetOpen = open;
  layoutSheet();
}

(() => {
  let startY = 0;
  let startOffset = 0;
  let moved = 0;
  grip.addEventListener("pointerdown", (event) => {
    if (!isSheet()) return;
    grip.setPointerCapture(event.pointerId);
    panel.classList.add("dragging");
    startY = event.clientY;
    startOffset = sheetOffset();
    moved = 0;
  });
  grip.addEventListener("pointermove", (event) => {
    if (!panel.classList.contains("dragging")) return;
    moved = event.clientY - startY;
    const max = panel.offsetHeight - grip.offsetHeight;
    panel.style.setProperty("--sheet", `${Math.min(Math.max(startOffset + moved, 0), max)}px`);
  });
  const finish = () => {
    if (!panel.classList.contains("dragging")) return;
    panel.classList.remove("dragging");
    // A tap is a drag that went nowhere, and it toggles; a real drag snaps to
    // whichever end it is nearer.
    setSheet(Math.abs(moved) < 6 ? !sheetOpen : moved < 0);
  };
  grip.addEventListener("pointerup", finish);
  grip.addEventListener("pointercancel", finish);
})();

// A phone keyboard opening, a rotation, a resize: all change what "collapsed" means.
window.addEventListener("resize", layoutSheet);
sheetQuery.addEventListener("change", () => setSheet(false));

// --- rendering ---------------------------------------------------------------

const minutes = (seconds: number) => `${Math.round(seconds / 60)}`;
const km = (metres: number) => (metres / 1000).toFixed(1).replace(".", ",");
const percent = (part: number, whole: number) => Math.round((part / Math.max(whole, 1)) * 100);
const escape = (text: string) =>
  text.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character]!));

let announced = "";
let announceTimer = 0;
/** Said once things have settled. A screen reader queues every change to a live
 *  region, so announcing each frame of a slider drag buries the answer under the
 *  journey to it. */
function announce(text: string): void {
  if (text === announced) return;
  announced = text;
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { live.textContent = text; }, 350);
}

/** The fields are built once and kept. Rebuilding the panel's markup on every
 *  keystroke -- which is what re-rendering it wholesale does -- destroys the very
 *  element the caret sits in, and the replacement starts at position 0: typing a
 *  second letter put it in front of the first. Only the parts that actually change
 *  are written on each render. */
function buildForm(): Record<Which, HTMLInputElement> {
  const field = (which: Which) => `
    <div class="field" data-field="${which}">
      <label class="sr-only" for="${which}">${LABEL[which]}</label>
      <input id="${which}" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"
             enterkeyhint="search" placeholder="${PLACEHOLDER[which]}"
             role="combobox" aria-expanded="false" aria-controls="suggestions"
             aria-autocomplete="list" aria-describedby="picking-hint" />
      <button class="inline" type="button" data-locate="${which}"
              aria-label="Käytä omaa sijaintia: ${LABEL[which].toLowerCase()}">${ICON.locate}</button>
    </div>`;

  form.innerHTML = `
    <div class="trip">
      <span class="rail" aria-hidden="true"><i></i><span></span><i class="stop"></i></span>
      ${field("from")}
      ${field("to")}
      <button class="icon-button swap" type="button" id="swap"
              aria-label="Vaihda lähtöpaikka ja määränpää keskenään">${ICON.swap}</button>
    </div>
    <p id="picking-hint" class="sr-only"></p>
    <ul class="suggestions" id="suggestions" role="listbox" aria-label="Hakuehdotukset" hidden></ul>`;

  const fields = {} as Record<Which, HTMLInputElement>;
  for (const which of ["from", "to"] as const) {
    const input = document.getElementById(which) as HTMLInputElement;
    fields[which] = input;
    input.addEventListener("input", () => { draft[which] = input.value; offerSuggestions(which); });
    input.addEventListener("focus", () => { picking = which; offerSuggestions(which); });
    input.addEventListener("blur", () => {
      // Late enough that a click on a suggestion still lands, early enough that the
      // list does not hang around over the map.
      setTimeout(() => { if (focused === which) { focused = null; suggestions = []; renderForm(); } }, 120);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!suggestions.length) return;
        highlighted = (highlighted + (event.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length;
        renderForm();
        form.querySelector(`#suggestion-${highlighted}`)?.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (suggestions.length) choose(which, suggestions[Math.max(highlighted, 0)]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        focused = null;
        suggestions = [];
        renderForm();
      }
    });
  }
  // mousedown, not click: blurring the input first would close the list.
  form.querySelector(".suggestions")!.addEventListener("mousedown", (event) => {
    const option = (event.target as HTMLElement).closest<HTMLElement>("[data-pick]");
    if (!option || !focused) return;
    event.preventDefault();
    choose(focused, suggestions[Number(option.dataset.pick)]);
  });
  form.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const locate = target.closest<HTMLElement>("[data-locate]");
    if (locate) { void useCurrentPosition(locate.dataset.locate as Which); return; }
    const clear = target.closest<HTMLElement>("[data-clear]");
    if (clear) clearEnd(clear.dataset.clear as Which);
  });
  document.getElementById("swap")!.addEventListener("click", swap);
  return fields;
}

function offerSuggestions(which: Which): void {
  focused = which;
  suggestions = addresses?.search(draft[which]) ?? [];
  highlighted = suggestions.length ? 0 : -1;
  renderForm();
}

const placeIcon = (place: Place) => (place.detail.startsWith("Osoite") ? ICON.address : ICON.place);

function renderForm(): void {
  for (const which of ["from", "to"] as const) {
    // Assigning to `value` moves the caret to the end, so only when it really differs.
    if (inputs[which].value !== draft[which]) inputs[which].value = draft[which];
  }
  const open = Boolean(focused && suggestions.length);

  for (const which of ["from", "to"] as const) {
    const wrapper = form.querySelector<HTMLElement>(`[data-field="${which}"]`)!;
    // The slot on the right is "find me" while the field is empty and "clear it"
    // once it is not -- the swap every map app makes, and the only way to unset an
    // end without selecting the text by hand.
    const filled = Boolean(draft[which]);
    const button = wrapper.querySelector("button")!;
    const wanted = filled ? "clear" : "locate";
    if (button.dataset.role !== wanted) {
      button.dataset.role = wanted;
      button.innerHTML = filled ? ICON.clear : ICON.locate;
      button.setAttribute(
        "aria-label",
        filled ? `Tyhjennä ${LABEL[which].toLowerCase()}` : `Käytä omaa sijaintia: ${LABEL[which].toLowerCase()}`,
      );
      if (filled) { button.dataset.clear = which; delete button.dataset.locate; }
      else { button.dataset.locate = which; delete button.dataset.clear; }
    }
    // Neither end set yet, or one of them missing: say where the next map click goes.
    wrapper.classList.toggle("target", !ends[which] && picking === which && !focused);
    const input = inputs[which];
    const expanded = open && focused === which;
    input.setAttribute("aria-expanded", String(expanded));
    if (expanded && highlighted >= 0) input.setAttribute("aria-activedescendant", `suggestion-${highlighted}`);
    else input.removeAttribute("aria-activedescendant");
  }

  document.getElementById("picking-hint")!.textContent = ends.from && ends.to
    ? ""
    : `Kartan klikkaus asettaa: ${LABEL[picking].toLowerCase()}.`;
  (document.getElementById("swap") as HTMLButtonElement).disabled = !(ends.from || ends.to);
  // Both live and die with the trip: nothing to clear and nothing to link to until
  // an end is set.
  resetButton.hidden = !(ends.from || ends.to);
  shareButton.hidden = resetButton.hidden;

  const list = form.querySelector<HTMLUListElement>(".suggestions")!;
  list.hidden = !open;
  list.innerHTML = !open ? "" : suggestions.map((place, index) => `
    <li id="suggestion-${index}" role="option" aria-selected="${index === highlighted}" data-pick="${index}">
      ${placeIcon(place)}
      <span><b>${escape(place.label)}</b><em>${escape(place.detail)}</em></span>
    </li>`).join("");
}

function choose(which: Which, place: Place): void {
  focused = null;
  suggestions = [];
  highlighted = -1;
  inputs[which].blur();
  setEnd(which, { lon: place.lon, lat: place.lat, label: place.label }, { frame: true });
}

/** The switcher between the routes on offer. Each row carries what a rider actually
 *  decides on -- the time, the length, and how much of the ride is stop-and-go.
 *
 *  A radio group rather than a listbox: this is a choice among three, which is what
 *  radios narrate, and it needs no keyboard model of its own. */
function renderOptions(): string {
  if (routes.length < 2) return "";
  const first = routes[0].seconds;
  // The list is ordered by what the *search* preferred, which once a preference is
  // set is no longer the same as what takes least time. Calling the first one
  // "nopein" then states something the row under it visibly contradicts, so it only
  // keeps that name while it really is the quickest.
  const quickest = Math.min(...routes.map((route) => route.seconds));
  return `<span class="eyebrow" id="options-label">Vaihtoehdot</span>
    <div class="options" role="radiogroup" aria-labelledby="options-label">${routes.map((route, index) => {
    const delta = Math.round((route.seconds - first) / 60);
    const rank = index === 0
      ? (routes[0].seconds === quickest ? "nopein" : "paras asetuksillasi")
      : delta > 0 ? `+${delta} min` : delta < 0 ? `\u2212${-delta} min` : "sama aika";
    return `<button type="button" role="radio" aria-checked="${index === selected}"
      tabindex="${index === selected ? 0 : -1}" data-route="${index}">
      <strong>${minutes(route.seconds)} min</strong>
      <span>${km(route.metres)} km · ${rank}</span>
      <small>${route.signals} valo-odotusta · ${route.turns} käännöstä${
        router?.hasClimb ? ` · ${ascent(route)}` : ""}</small>
    </button>`;
  }).join("")}</div>`;
}

const MANEUVER: Record<Maneuver, { icon: string; text: string }> = {
  start: { icon: "◉", text: "Lähde liikkeelle" },
  straight: { icon: "↑", text: "Jatka suoraan" },
  left: { icon: "↰", text: "Käänny vasemmalle" },
  right: { icon: "↱", text: "Käänny oikealle" },
  "sharp-left": { icon: "↰", text: "Jyrkkä käännös vasemmalle" },
  "sharp-right": { icon: "↱", text: "Jyrkkä käännös oikealle" },
  arrive: { icon: "◎", text: "Perillä" },
};

/** How much of the ride is among cars, drawn rather than tabulated.
 *
 * Five classes do not fit a table row, and "65 % pyöräväylää" answers a different
 * question from the one the traffic preference is about. A stacked bar reads at a
 * glance and is the shape Komoot and Strava both settled on.
 */
const TRAFFIC_BANDS = [
  { label: "Autoton", hint: "pyörätie, puisto, polku" },
  { label: "Rauhallinen", hint: "asuinkatu, huoltoajo" },
  { label: "Keskivilkas", hint: "kokoojakatu" },
  { label: "Vilkas", hint: "pääkatu" },
  { label: "Pääväylä", hint: "läpiajoväylä" },
] as const;

function renderTraffic(route: Route): string {
  const total = route.trafficMetres.reduce((sum, metres) => sum + metres, 0);
  if (total <= 0) return "";
  const bands = route.trafficMetres
    .map((metres, index) => ({ index, metres, share: (metres / total) * 100 }))
    .filter((band) => band.share >= 0.5);
  return `<span class="eyebrow">Missä ajetaan</span>
    <div class="bands">
      <div class="band-bar" role="img"
           aria-label="${bands.map((band) =>
             `${TRAFFIC_BANDS[band.index].label} ${band.share.toFixed(0)} prosenttia`).join(", ")}">
        ${bands.map((band) =>
          `<i class="band-${band.index}" style="width:${band.share.toFixed(2)}%"></i>`).join("")}
      </div>
      <ul class="band-key">
        ${bands.map((band) => `<li><i class="band-${band.index}"></i>
          ${escape(TRAFFIC_BANDS[band.index].label)}
          <b>${band.share < 1 ? "<1" : band.share.toFixed(0)} %</b></li>`).join("")}
      </ul>
    </div>`;
}

/** Smooth the profile before drawing it.
 *
 * The terrain model has a few metres of vertical noise, and the shape points are
 * 20 m apart, so drawn raw the profile is a sawtooth that climbs six times what the
 * route actually climbs -- a chart that contradicts the number printed beside it. A
 * moving average over `PROFILE_SMOOTH_M` removes the noise and leaves the hills,
 * which is the same problem `gain_and_loss` solves at build time, and the same
 * reason.
 */
const PROFILE_SMOOTH_M = 100;

function smoothProfile(points: readonly [number, number][]): [number, number][] {
  if (points.length < 3) return points as [number, number][];
  const out: [number, number][] = [];
  let first = 0;
  let last = 0;
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const at = points[index][0];
    while (last < points.length && points[last][0] <= at + PROFILE_SMOOTH_M / 2) {
      sum += points[last][1];
      last += 1;
    }
    while (points[first][0] < at - PROFILE_SMOOTH_M / 2) {
      sum -= points[first][1];
      first += 1;
    }
    out.push([at, sum / Math.max(last - first, 1)]);
  }
  return out;
}

/** At most one point per pixel of chart, keeping the highest and lowest in each
 *  column so a summit is never averaged away. A 38 km ride has 2,200 shape points
 *  and the chart is 300 px wide; drawing them all is seven points a pixel of ink
 *  that reads as fur. */
function thin(points: [number, number][], columns: number, total: number): [number, number][] {
  if (points.length <= columns || total <= 0) return points;
  const out: [number, number][] = [];
  let column = -1;
  let low: [number, number] | null = null;
  let high: [number, number] | null = null;
  const flush = () => {
    if (!low || !high) return;
    // In the order they occur, so the line does not zigzag backwards.
    out.push(...(low[0] <= high[0] ? [low, high] : [high, low]));
  };
  for (const point of points) {
    const at = Math.floor((point[0] / total) * columns);
    if (at !== column) { flush(); column = at; low = high = point; continue; }
    if (!low || point[1] < low[1]) low = point;
    if (!high || point[1] > high[1]) high = point;
  }
  flush();
  return out;
}

/** The ride's height against its distance.
 *
 * Every cycling app draws this, and for good reason: a total of 92 m says nothing
 * about whether it is one wall or spread over ten kilometres, which is the thing a
 * rider actually wants to know. Drawn as a filled path in the panel's own width; the
 * y range is padded so a flat ride reads as flat rather than as noise magnified to
 * fill the box.
 */
function renderProfile(route: Route): string {
  const width = 300;
  const points = thin(smoothProfile(route.profile), width, route.metres);
  if (points.length < 2 || route.metres <= 0) return "";
  const height = 64;
  const heights = points.map((point) => point[1]);
  const low = Math.min(...heights);
  const high = Math.max(...heights);
  // At least a 20 m window, so a 3 m undulation does not draw as an alp.
  const span = Math.max(high - low, 20);
  const middle = (high + low) / 2;
  const top = middle + span / 2;
  const x = (metres: number) => (metres / route.metres) * width;
  const y = (metre: number) => ((top - metre) / span) * height;
  const line = points.map((point, index) =>
    `${index ? "L" : "M"}${x(point[0]).toFixed(1)} ${y(point[1]).toFixed(1)}`).join("");
  const area = `${line}L${width} ${height}L0 ${height}Z`;
  return `<span class="eyebrow">Korkeusprofiili</span>
    <figure class="profile">
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
           aria-label="Korkeusprofiili: nousua ${Math.round(route.ascentMetres)} metriä,
             matalin ${Math.round(low)} ja korkein ${Math.round(high)} metriä merenpinnasta.">
        <path class="profile-fill" d="${area}" />
        <path class="profile-line" d="${line}" />
      </svg>
      <figcaption>
        <span>${Math.round(low)}–${Math.round(high)} m mpy</span>
        <span>${ascent(route)} · ↓${Math.round(route.descentMetres)} m</span>
      </figcaption>
    </figure>`;
}

/** Climb, with the arrow that says which way. */
const ascent = (route: Route) => `\u2191${Math.round(route.ascentMetres)} m`;

const distance = (metres: number) =>
  metres < 1000 ? `${Math.round(metres / 10) * 10} m` : `${km(metres)} km`;

/** What the step costs beyond the riding: the two things the rider stops for. */
function stepDelays(step: Step): string {
  const parts = [];
  if (step.signals) parts.push(`${step.signals} ${step.signals === 1 ? "liikennevalo" : "liikennevaloa"}`);
  if (step.crossings) parts.push(`${step.crossings} suojatie${step.crossings === 1 ? "" : "tä"}`);
  return parts.join(" · ");
}

/** The turn-by-turn list. Steps break at the manoeuvres the search itself priced,
 *  so what the rider reads is exactly what the route was costed on. */
function renderSteps(route: Route): string {
  const rows = route.steps.map((step, index) => {
    const { icon, text } = MANEUVER[step.maneuver];
    const detail = [step.name, stepDelays(step)].filter(Boolean).join(" · ");
    const size = step.maneuver === "arrive"
      ? `${minutes(route.seconds)} min · ${km(route.metres)} km`
      : distance(step.metres);
    return `<li data-step="${index}" tabindex="0" aria-current="${index === openStep}">
      <span class="turn" aria-hidden="true">${icon}</span>
      <span class="what">${escape(text)}</span>
      <span class="far">${escape(size)}</span>
      ${detail ? `<span class="where">${escape(detail)}</span>` : ""}
    </li>`;
  });
  return `<details class="directions" ${directionsOpen || openStep >= 0 ? "open" : ""}>
    <summary>Reittiohje · ${route.steps.length - 1} osuutta</summary>
    <ol>${rows.join("")}</ol>
  </details>`;
}

const METHOD = `<details class="method">
  <summary>Miten kesto lasketaan?</summary>
  <p>Koettu kesto = ajoaika + 30 s / valo-odotus + 10 s / käännös + 2 s / valo-ohjaamaton
  suojatie. Hidas pinnoite ja jalankulkijoiden kanssa jaettu väylä ajetaan
  0,65-kertaisella vauhdilla. Kahdessa vaiheessa ylitettävä leveä väylä on kaksi
  odotusta yhdellä valolla. Reitti valitaan tätä kestoa minimoiden.</p>
  <p>Reititys ja osoitteet: OpenStreetMap. Liikennevalot myös Helsinki, Espoo ja
  Vantaa (CC BY 4.0).</p>
</details>`;

function speedControl(): string {
  return `<div class="speed">
    <label class="row" for="speed">Vauhti tasaisella <b>${profile.speedKmh} km/h</b></label>
    <input type="range" min="10" max="28" step="1" value="${profile.speedKmh}" id="speed"
           aria-valuetext="${profile.speedKmh} kilometriä tunnissa" />
    <span class="scale" aria-hidden="true"><span>10</span><span>rauhallinen · reipas</span><span>28</span></span>
  </div>`;
}

function renderReadout(): void {
  const route = routes[selected] ?? null;
  const problem = failure ? `<p class="notice">${ICON.warn}<span>${escape(failure)}</span></p>` : "";
  const borrowed = borrowedProfile ? `<div class="borrowed">
    <span>Tämä linkki käyttää eri asetuksia kuin sinun.</span>
    <span class="borrowed-actions">
      <button type="button" class="ghost" data-keep="1">Käytä näitä</button>
      <button type="button" class="ghost" data-keep="">Omat asetukset</button>
    </span>
  </div>` : "";

  if (!route) {
    const hint = status || (router
      ? `Hae osoitteella, käytä omaa sijaintia tai klikkaa kartalta ${ends.from ? "määränpää" : "lähtöpaikka"}.`
      : "Ladataan tieverkkoa…");
    readout.innerHTML = `${borrowed}${problem}<p class="lede">${escape(hint)}</p>
      ${ends.from || ends.to ? speedControl() : ""}${METHOD}`;
  } else {
    // Subtracted after rounding, not before: at 44,5 min total and 38,4 min riding,
    // rounding each separately printed "38 min plus 6 min" under a headline of 45.
    const ridden = Math.round(route.ridingSeconds / 60);
    const friction = Math.round(route.seconds / 60) - ridden;
    readout.innerHTML = `${borrowed}${problem}
      <div class="headline">
        <strong>${minutes(route.seconds)}</strong>
        <span>min · ${km(route.metres)} km${router?.hasClimb ? ` · ${ascent(route)}` : ""}</span>
      </div>
      <p class="free-flow">Pelkkä ajoaika ${ridden} min;
        pysähtely ja käännökset lisäävät <b>${friction} min</b>.</p>
      <dl class="facts">
        <div><dt>Pyörätietä</dt><dd>${percent(route.dedicatedMetres, route.metres)} <small>%</small></dd></div>
        <div><dt>Odotuksia</dt><dd>${route.signals}</dd></div>
        <div><dt>Käännöksiä</dt><dd>${route.turns}</dd></div>
      </dl>
      ${renderOptions()}
      ${renderTraffic(route)}
      ${router?.hasClimb ? renderProfile(route) : ""}
      <span class="eyebrow">Reitin erittely</span>
      <table>
        <tr><th>Pyöräväylää</th><td>${km(route.dedicatedMetres)} km <small>${percent(route.dedicatedMetres, route.metres)} %</small></td></tr>
        ${route.sidepathMetres > 50 ? `<tr><th>Ajorataa pyörätien vierellä</th><td>${km(route.sidepathMetres)} km</td></tr>` : ""}
        ${router?.hasClimb ? `<tr><th>Nousua</th><td>${Math.round(route.ascentMetres)} m</td></tr>
        <tr><th>Laskua</th><td>${Math.round(route.descentMetres)} m</td></tr>` : ""}
        <tr><th>Suojatiet ilman valoja</th><td>${route.crossings}</td></tr>
        ${route.barriers ? `<tr><th>Puomeja ja pollareita</th><td>${route.barriers}</td></tr>` : ""}
        ${route.winterMetres > 50 ? `<tr><th>Talvihoidettua</th><td>${km(route.winterMetres)} km <small>${percent(route.winterMetres, route.metres)} %</small></td></tr>` : ""}
        ${route.litMetres > 50 ? `<tr><th>Valaistua</th><td>${km(route.litMetres)} km <small>${percent(route.litMetres, route.metres)} %</small></td></tr>` : ""}
        ${route.unpavedMetres > 50 ? `<tr><th>Päällystämätöntä</th><td>${km(route.unpavedMetres)} km <small>${percent(route.unpavedMetres, route.metres)} %</small></td></tr>` : ""}
        ${route.sharedMetres > 50 ? `<tr><th>Jalankulkijoiden kanssa</th><td>${km(route.sharedMetres)} km <small>${percent(route.sharedMetres, route.metres)} %</small></td></tr>` : ""}
      </table>
      ${renderSteps(route)}
      ${speedControl()}${METHOD}`;
  }

  document.getElementById("speed")?.addEventListener("input", (event) => {
    setProfile({ ...profile, speedKmh: Number((event.target as HTMLInputElement).value) });
  });
  readout.querySelector<HTMLDetailsElement>(".directions")?.addEventListener("toggle", (event) => {
    directionsOpen = (event.target as HTMLDetailsElement).open;
    layoutSheet();
  });
  readout.querySelectorAll<HTMLElement>("[data-keep]").forEach((element) => {
    element.addEventListener("click", () => keepBorrowed(Boolean(element.dataset.keep)));
  });
  readout.querySelectorAll<HTMLElement>("[data-step]").forEach((element) => {
    const show = () => showStep(Number(element.dataset.step));
    element.addEventListener("click", show);
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); show(); }
    });
  });
  const options = readout.querySelectorAll<HTMLElement>("[data-route]");
  options.forEach((element, index) => {
    element.addEventListener("click", () => select(Number(element.dataset.route)));
    // Arrow keys move between radios and pick as they go, which is the pattern
    // browsers use for native radio groups.
    element.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft" ? options.length - 1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = (index + step) % options.length;
      select(next);
      readout.querySelector<HTMLElement>(`[data-route="${next}"]`)?.focus();
    });
  });
}

/** Fly to the manoeuvre a step describes, close enough to see which way to go. */
function showStep(index: number): void {
  const step = routes[selected]?.steps[index];
  if (!step) return;
  openStep = index;
  map.easeTo({ center: step.at, zoom: Math.max(map.getZoom(), 16), padding: padding(), duration: 600 });
  renderReadout();
  // The panel scrolls, and the list is long enough that the step just picked can sit
  // off-screen -- which reads as nothing having happened.
  readout.querySelector('.directions li[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
}

/** Show one of the routes already computed. Nothing is re-routed: the alternatives
 *  came out of the same query, so switching is only a redraw. */
function select(index: number): void {
  if (index === selected || index < 0 || index >= routes.length) return;
  selected = index;
  openStep = -1;
  drawRoutes();
  renderReadout();
  layoutSheet();
  const route = routes[selected];
  announce(`Vaihtoehto ${index + 1}: ${minutes(route.seconds)} minuuttia, ${km(route.metres)} kilometriä.`);
}

function render(): void {
  renderForm();
  renderReadout();
  layoutSheet();
}

function update(options: { frame?: boolean } = {}): void {
  if (!router || !ends.from || !ends.to) {
    routes = [];
    drawRoutes();
    render();
    writeUrl();
    if (options.frame) frame();
    return;
  }
  routes = router.routes(ends.from.lon, ends.from.lat, ends.to.lon, ends.to.lat, {
    speedKmh: profile.speedKmh, limit: ALTERNATIVES, cost: profile.cost, taste: profile.taste,
  });
  if (selected >= routes.length) selected = 0;
  openStep = -1;
  failure = routes.length ? "" : "Reittiä ei löytynyt. Siirrä pisteitä lähemmäs tieverkkoa.";
  drawRoutes();
  render();
  writeUrl();
  if (options.frame !== false) frame();
  const route = routes[selected];
  announce(route
    ? `Reitti: ${minutes(route.seconds)} minuuttia, ${km(route.metres)} kilometriä, ` +
      `${route.signals} valo-odotusta` +
      `${router?.hasClimb ? `, nousua ${Math.round(route.ascentMetres)} metriä` : ""}.` +
      `${routes.length > 1 ? ` ${routes.length} vaihtoehtoa.` : ""}`
    : failure);
}

// --- wiring -------------------------------------------------------------------

/** Whether the sources and layers have been built at least once. */
let styled = false;

// The basemap and the data are independent: gating the router on the map's `load`
// left the page dead whenever a sprite or glyph request hung, which it does.
map.on("style.load", () => {
  map.addSource(ROUTE_SOURCE, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  // Added before the chosen route's layers so it always draws on top of them.
  map.addLayer({
    id: ALTERNATIVE_LAYER, type: "line", source: ROUTE_SOURCE,
    filter: ["!", ["get", "chosen"]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": dark.matches ? "#7b8a95" : "#8c9aa5",
      "line-width": 4, "line-dasharray": [2, 1.5],
    },
  });
  map.addLayer({
    id: "route-casing", type: "line", source: ROUTE_SOURCE,
    filter: ["get", "chosen"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": casingColour(), "line-width": 9, "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "route-line", type: "line", source: ROUTE_SOURCE,
    filter: ["get", "chosen"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": routeColour(), "line-width": 4.5 },
  });
  map.addSource(ACCESS_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "access-line", type: "line", source: ACCESS_SOURCE,
    layout: { "line-cap": "round" },
    paint: { "line-color": routeColour(), "line-width": 3, "line-opacity": 0.55, "line-dasharray": [1, 1.6] },
  });
  map.addSource(SIGNAL_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  // Hidden while the whole region is in view: at that zoom the dots crowd into a
  // smear that says only "there are lights", which the readout already says better.
  map.addLayer({
    id: "signal-dot", type: "circle", source: SIGNAL_SOURCE, minzoom: 12,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 3, 16, 6],
      "circle-color": "#d92d20",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
    },
  });
  // The style reloads when the system theme flips; re-framing the map then would
  // throw away wherever the rider had panned to.
  update({ frame: !styled });
  styled = true;
});

dark.addEventListener("change", () => map.setStyle(basemap()));

// MapLibre opens the compact attribution the first time and leaves it open, which
// on a phone is a three-line grey band across the map. Collapse it to the (i) once
// the map is up; the rider can still open it.
// `idle`, not `load`: the control only decides it is compact once it has been laid
// out, which on a slow first paint happens after `load` has already fired. `once`
// so that a rider who opens the credits keeps them open.
let attributionCollapsed = false;
function collapseAttribution(): void {
  if (attributionCollapsed) return;
  const control = document.querySelector(".maplibregl-ctrl-attrib.maplibregl-compact");
  if (!control) return; // not narrow enough to be compact; the credits stay out
  attributionCollapsed = true;
  control.classList.remove("maplibregl-compact-show");
}
// Whichever comes first: the control only calls itself compact once it has been
// laid out, and `idle` never arrives at all if the tiles fail.
map.once("idle", collapseAttribution);
setTimeout(collapseAttribution, 1500);

map.on("error", (event) => console.error("map", event.error));

map.on("click", (event: maplibregl.MapMouseEvent) => {
  if (!router) return;
  const hit = alternativeAt(event.point);
  if (hit >= 0) { select(hit); return; }
  // Picking off the map should not yank the view out from under the finger that
  // just pointed at it.
  setEnd(picking, describe(event.lngLat.lng, event.lngLat.lat), { frame: false });
});

// A 4 px line is hard to hit exactly, so the pick is a small box around the cursor.
function alternativeAt(point: maplibregl.Point): number {
  if (!map.getLayer(ALTERNATIVE_LAYER)) return -1;
  const box: [maplibregl.PointLike, maplibregl.PointLike] = [
    [point.x - 8, point.y - 8], [point.x + 8, point.y + 8],
  ];
  const feature = map.queryRenderedFeatures(box, { layers: [ALTERNATIVE_LAYER] })[0];
  return feature ? Number(feature.properties.index) : -1;
}

map.on("mousemove", (event: maplibregl.MapMouseEvent) => {
  map.getCanvas().style.cursor = alternativeAt(event.point) >= 0 ? "pointer" : "";
});

resetButton.addEventListener("click", resetAll);

const shareButton = document.createElement("button");
shareButton.type = "button";
shareButton.className = "ghost";
shareButton.innerHTML = ICON.share;
shareButton.setAttribute("aria-label", "Kopioi linkki tähän reittiin");
shareButton.addEventListener("click", () => void share(shareButton));
resetButton.after(shareButton);
const inputs = buildForm();
mountSettings(
  document.getElementById("gear") as HTMLButtonElement,
  document.getElementById("settings")!,
  () => profile,
  setProfile,
  () => router?.costModel ?? null,
  () => router?.hasClimb ?? false,
  () => router?.hasWinter ?? false,
);
readUrl();
status = "Ladataan tieverkkoa…";
render();

loadGraph(`${import.meta.env.BASE_URL}graph`).then(
  (graph) => {
    router = new Router(graph);
    graphData = graph;
    bounds = graph.manifest.bounds;
    status = "";
    if (climbData) useClimb(climbData);
    if (winterData) useWinter(winterData);
    update({ frame: true });
  },
  (error: unknown) => {
    status = "";
    failure = `Tieverkon lataus epäonnistui: ${error instanceof Error ? error.message : "tuntematon virhe"}`;
    render();
  },
);
// Hills arrive on their own too. Absent, every edge is flat -- which is exactly how
// the router behaved before there was any such thing as climb.
fetchClimb(`${import.meta.env.BASE_URL}graph`).then(
  useClimb,
  (error: unknown) => console.info("climb data unavailable", error),
);
// The city's winter network is small and entirely optional; without it the hoidetut
// row simply never appears.
loadWinter(`${import.meta.env.BASE_URL}graph`).then(
  useWinter,
  (error: unknown) => console.info("winter data unavailable", error),
);
// Search is a separate, smaller download so routing is usable the moment the graph
// lands; until it does, the fields simply offer nothing.
loadSearchIndex(`${import.meta.env.BASE_URL}graph`).then(
  (index) => {
    addresses = index;
    // A trip restored from a link named its ends by coordinates because nothing
    // could name them better yet. Now something can.
    if (namesPending) {
      namesPending = false;
      for (const which of ["from", "to"] as const) {
        const end = ends[which];
        if (end) { ends[which] = describe(end.lon, end.lat); draft[which] = ends[which]!.label; }
      }
    }
    render();
  },
  (error: unknown) => console.error("search index", error),
);
