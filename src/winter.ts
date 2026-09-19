/** Helsinki's prioritised winter-maintenance network, loaded beside the graph.
 *
 * Two tiers, 149 km of them: brush-salted routes swept to bare pavement, and routes
 * ploughed early and often. Against 21 641 km of network that is a rounding error
 * for most of the year and the only thing that matters in February.
 *
 * A sidecar rather than a graph section, because the city revises its gritting plan
 * on its own schedule and none of it has anything to do with OSM: binding it in
 * would mean a full graph rebuild to pick up a change of contractor.
 */

export interface WinterManifest {
  version: number;
  edge_count: number;
  source: string;
  layout: Record<string, { offset: number; count: number; type: string }>;
}

export const WINTER_NONE = 0;
export const WINTER_PLOUGHED = 1;
export const WINTER_SALTED = 2;

export interface Winter {
  readonly manifest: WinterManifest;
  /** 0 not maintained, 1 ploughed, 2 brush-salted. */
  readonly tier: Uint8Array;
}

export function decodeWinter(manifest: WinterManifest, bytes: ArrayBuffer): Winter {
  if (manifest.version !== 1) {
    throw new Error(`winter data version ${manifest.version} is not supported`);
  }
  const entry = manifest.layout.edge_winter;
  if (!entry) throw new Error("winter data is missing the edge_winter section");
  return { manifest, tier: new Uint8Array(bytes, entry.offset, entry.count) };
}

export async function loadWinter(baseUrl: string): Promise<Winter> {
  const manifest = (await (await fetch(`${baseUrl}/winter.json`)).json()) as WinterManifest;
  const response = await fetch(`${baseUrl}/winter.bin.gz`);
  if (!response.ok) throw new Error("winter request failed");
  const bytes = await response.arrayBuffer();
  const header = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  if (header[0] !== 0x1f || header[1] !== 0x8b) return decodeWinter(manifest, bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return decodeWinter(manifest, await new Response(stream).arrayBuffer());
}
