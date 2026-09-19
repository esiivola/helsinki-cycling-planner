/** The two ends of a journey, and the ways a person can set one.
 *
 * Reittiopas and Google Maps agree on the shape: two always-visible fields, a swap
 * between them, "my location", and picking straight off the map. Digitransit's own
 * autosuggest calls those last two `CurrentPosition` and `MapPosition` and treats
 * them as search results like any other, which is the trick that keeps one control
 * handling every way of naming a place -- so this does the same.
 */
export type Which = "from" | "to";

export interface Endpoint {
  lon: number;
  lat: number;
  /** What the field shows. May be an address, a place, or a coordinate pair. */
  label: string;
}

export const coordinateLabel = (lon: number, lat: number): string =>
  `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

export class GeolocationUnavailable extends Error {}

/** A single GPS fix, phrased for a user rather than for a log.
 *
 * The browser only grants this over HTTPS, which GitHub Pages is; on plain HTTP it
 * fails with the same permission error as a refusal, so the message has to cover
 * both without guessing which happened.
 */
export function currentPosition(timeoutMs = 10_000): Promise<{ lon: number; lat: number; accuracyM: number }> {
  if (!navigator.geolocation) {
    return Promise.reject(new GeolocationUnavailable("Selain ei tue paikannusta."));
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        lon: position.coords.longitude,
        lat: position.coords.latitude,
        accuracyM: position.coords.accuracy,
      }),
      (error) => reject(new GeolocationUnavailable(
        error.code === error.PERMISSION_DENIED
          ? "Paikannus ei ole sallittu. Salli sijainti selaimen asetuksista."
          : error.code === error.TIMEOUT
            ? "Paikannus kesti liian kauan. Yritä uudelleen."
            : "Sijaintia ei saatu selville.",
      )),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

/** True when a point is inside the area the graph covers. */
export function withinBounds(bounds: readonly number[], lon: number, lat: number): boolean {
  const [west, south, east, north] = bounds;
  return lon >= west && lon <= east && lat >= south && lat <= north;
}
