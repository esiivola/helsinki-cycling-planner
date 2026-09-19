/** The settings panel behind the gear.
 *
 * Two tabs, because the two halves of a profile answer different questions and
 * mixing them would make the readout dishonest:
 *
 *   Mieltymykset  what the rider would rather ride. Steers the search, never the
 *                 minutes -- so "avoid gravel" cannot quietly inflate an estimate.
 *   Malli         what the ride actually costs. Moving these *does* change the
 *                 minutes, because they are claims about the world.
 *
 * Every preference is a five-stop slider rather than a row of buttons: a range input
 * arrows with the keyboard, announces itself, and takes a thumb on a phone, all of
 * which five small buttons would have had to be taught. The stops themselves come
 * from `scripts/bench_profiles.mjs`, not from taste.
 */
import type { CostModel } from "./graph.ts";
import { CLIMB_S_PER_M, DESCENT_CREDIT_S_PER_M } from "./route.ts";

/** A graph built before hills existed carries no value for these, so the router's
 *  own defaults stand in as "shipped". */
const SHIPPED_CLIMB: Partial<Record<keyof CostModel, number>> = {
  climb_s_per_m: CLIMB_S_PER_M,
  descent_credit_s_per_m: DESCENT_CREDIT_S_PER_M,
};
import {
  KNOBS, PRESETS, ROWS, type Preset, type Profile, type Taste,
  applyPreset, defaultProfile, presetOf, rowOf, stopOf,
} from "./profile.ts";

const shown = (row: { needsClimb?: boolean; needsWinter?: boolean }) =>
  (!row.needsClimb || hasClimbRef()) && (!row.needsWinter || hasWinterRef());
let hasClimbRef: () => boolean = () => false;
let hasWinterRef: () => boolean = () => false;

const decimal = (value: number) => String(Number(value.toFixed(2))).replace(".", ",");
const parse = (text: string) => Number(text.replace(",", "."));
const escape = (text: string) =>
  text.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character]!));

export interface Settings {
  toggle(): void;
  close(): void;
  readonly open: boolean;
}

export function mountSettings(
  gear: HTMLButtonElement,
  panel: HTMLElement,
  read: () => Profile,
  write: (profile: Profile) => void,
  /** The graph's own cost model, or null until it has landed. Every knob is shown
   *  against the shipped value, and there is no honest shipped value to show yet. */
  baseCost: () => CostModel | null,
  /** Whether the climb data has arrived. Offering a hills slider that cannot move a
   *  route would be a control that lies about what it does. */
  hasClimb: () => boolean,
  /** Whether the city's winter network has arrived. */
  hasWinter: () => boolean,
): Settings {
  hasClimbRef = hasClimb;
  hasWinterRef = hasWinter;
  let open = false;
  let tab: "taste" | "model" = "taste";

  const change = (mutate: (profile: Profile) => void) => {
    const profile = structuredClone(read());
    mutate(profile);
    write(profile);
    render();
  };

  function rowMarkup(profile: Profile): string {
    return ROWS.filter(shown).map((row) => {
      const value = profile.taste[row.key];
      const stop = stopOf(row.key, value);
      const name = stop < 0 ? `Mukautettu · ${decimal(value)}×` : row.labels[stop];
      return `<div class="pref">
        <div class="pref-head">
          <label for="pref-${row.key}">${escape(row.label)}</label>
          <b${stop === row.standard ? "" : ' class="moved"'}>${escape(name)}</b>
        </div>
        <input type="range" id="pref-${row.key}" data-pref="${row.key}"
               min="0" max="${row.values.length - 1}" step="1"
               value="${stop < 0 ? row.standard : stop}"
               aria-valuetext="${escape(name)}" aria-describedby="hint-${row.key}" />
        <small id="hint-${row.key}">${escape(row.hint)}</small>
      </div>`;
    }).join("");
  }

  function weightsMarkup(profile: Profile): string {
    return `<details class="raw">
      <summary>Omat painot</summary>
      <p class="raw-note">Kerroin, jolla haku hinnoittelee tämän. 1 = ei mielipidettä,
        suurempi välttää, pienempi suosii. Ei vaikuta näytettyyn kestoon.</p>
      ${ROWS.filter(shown).map((row) => `<div class="raw-row">
        <label for="raw-${row.key}">${escape(row.label)}</label>
        <input id="raw-${row.key}" data-raw="${row.key}" type="text" inputmode="decimal"
               value="${decimal(profile.taste[row.key])}" size="4" />
      </div>`).join("")}
      <p class="raw-note">${ROWS.map((row) =>
        `<span>${escape(row.label)}: ${escape(row.effect)}</span>`).join("")}</p>
    </details>`;
  }

  function knobMarkup(profile: Profile): string {
    const base = baseCost();
    if (!base) return `<p class="settings-note">Ladataan tieverkkoa…</p>`;
    return KNOBS.filter((knob) => !knob.needsClimb || hasClimb()).map((knob) => {
      const shipped = (base[knob.key] as number | undefined) ?? SHIPPED_CLIMB[knob.key] ?? 0;
      const value = (profile.cost[knob.key] as number | undefined) ?? shipped;
      const moved = Math.abs(value - shipped) > 1e-9;
      return `<div class="pref">
        <div class="pref-head">
          <label for="knob-${knob.key}">${escape(knob.label)}</label>
          <b${moved ? ' class="moved"' : ""}>${decimal(value)} ${escape(knob.unit)}</b>
        </div>
        <input type="range" id="knob-${knob.key}" data-knob="${knob.key}"
               min="${knob.min}" max="${knob.max}" step="${knob.step}" value="${value}"
               aria-valuetext="${decimal(value)} ${escape(knob.unit)}" />
        ${moved ? `<small>Oletus ${decimal(shipped)} ${escape(knob.unit)}</small>` : ""}
      </div>`;
    }).join("");
  }

  function render(): void {
    const profile = read();
    const active = presetOf(profile.taste);
    gear.setAttribute("aria-expanded", String(open));
    gear.classList.toggle("moved", !isShipped(profile));
    panel.hidden = !open;
    if (!open) { panel.innerHTML = ""; return; }

    panel.innerHTML = `
      <header class="settings-head">
        <h2 id="settings-title">Asetukset</h2>
        <button class="inline" type="button" data-close aria-label="Sulje asetukset">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </header>
      <div class="tabs" role="tablist" aria-label="Asetusryhmät">
        <button role="tab" type="button" data-tab="taste" id="tab-taste"
                aria-selected="${tab === "taste"}" aria-controls="panel-taste"
                tabindex="${tab === "taste" ? 0 : -1}">Mieltymykset</button>
        <button role="tab" type="button" data-tab="model" id="tab-model"
                aria-selected="${tab === "model"}" aria-controls="panel-model"
                tabindex="${tab === "model" ? 0 : -1}">Malli</button>
      </div>

      <div class="settings-body">
        <div role="tabpanel" id="panel-taste" aria-labelledby="tab-taste" ${tab === "taste" ? "" : "hidden"}>
          <p class="settings-note">Ohjaavat reitinvalintaa. Näytetty kesto ei muutu.</p>
          <div class="presets" role="group" aria-label="Valmiit asetukset">
            ${PRESETS.map((preset) => `<button type="button" data-preset="${preset.id}"
              aria-pressed="${active?.id === preset.id}" title="${escape(preset.hint)}"
              >${escape(preset.label)}</button>`).join("")}
          </div>
          ${rowMarkup(profile)}
          ${weightsMarkup(profile)}
        </div>
        <div role="tabpanel" id="panel-model" aria-labelledby="tab-model" ${tab === "model" ? "" : "hidden"}>
          <p class="settings-note">Mitä ajaminen oikeasti maksaa. <b>Muuttaa näytettyä kestoa.</b></p>
          ${knobMarkup(profile)}
        </div>
      </div>

      <footer class="settings-foot">
        <button type="button" class="ghost" data-reset ${isShipped(profile) ? "disabled" : ""}>
          Palauta oletukset
        </button>
      </footer>`;
  }

  const isShipped = (profile: Profile): boolean =>
    Object.keys(profile.cost).length === 0 && presetOf(profile.taste)?.id === "balanced";

  // One delegated listener per kind, so re-rendering the panel never leaks handlers.
  panel.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.dataset.pref) {
      const key = target.dataset.pref as keyof Taste;
      change((profile) => { profile.taste[key] = rowOf(key).values[Number(target.value)]; });
    } else if (target.dataset.knob) {
      const key = target.dataset.knob as keyof Profile["cost"];
      change((profile) => { (profile.cost as Record<string, number>)[key] = Number(target.value); });
    }
  });

  // `change`, not `input`: a free weight is committed when the rider has finished
  // typing it, or "2" on the way to "2.5" would route twice and land somewhere odd.
  panel.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    const key = target.dataset.raw as keyof Taste | undefined;
    if (!key) return;
    const value = parse(target.value);
    if (!Number.isFinite(value) || value < 0.05 || value > 100) { render(); return; }
    change((profile) => { profile.taste[key] = value; });
  });

  panel.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-close]")) { setOpen(false); gear.focus(); return; }
    if (target.closest("[data-reset]")) {
      change((profile) => {
        const fresh = defaultProfile();
        profile.cost = {};
        profile.taste = fresh.taste;
      });
      return;
    }
    const preset = target.closest<HTMLElement>("[data-preset]");
    if (preset) {
      const chosen = PRESETS.find((candidate) => candidate.id === preset.dataset.preset) as Preset;
      change((profile) => { profile.taste = applyPreset(chosen); });
      return;
    }
    const chosen = target.closest<HTMLElement>("[data-tab]");
    if (chosen) {
      tab = chosen.dataset.tab as typeof tab;
      render();
      panel.querySelector<HTMLElement>(`#tab-${tab}`)?.focus();
    }
  });

  panel.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (!target.matches('[role="tab"]')) return;
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    tab = tab === "taste" ? "model" : "taste";
    render();
    panel.querySelector<HTMLElement>(`#tab-${tab}`)?.focus();
  });

  function setOpen(next: boolean): void {
    open = next;
    render();
    if (open) panel.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }

  // A popover, not a modal: the map stays live underneath so a weight can be dragged
  // and the line watched moving. Escape closes it and Tab is allowed to walk out,
  // which is the behaviour a non-modal disclosure is supposed to have.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) { setOpen(false); gear.focus(); }
  });
  document.addEventListener("pointerdown", (event) => {
    const target = event.target as Node;
    if (open && !panel.contains(target) && !gear.contains(target)) setOpen(false);
  });
  gear.addEventListener("click", () => setOpen(!open));

  render();
  return {
    toggle: () => setOpen(!open),
    close: () => setOpen(false),
    get open() { return open; },
  };
}
