/** Per-edge ascent and descent, loaded beside the graph rather than inside it.
 *
 * The graph already carries the full shape of every edge, so climb can be sampled
 * from a terrain model against the *shipped* graph -- no OSM extract, no rebuild, no
 * version bump. It therefore travels as its own file, on the same terms as the
 * address index: routing works the moment the graph lands, and gets hill-aware when
 * this arrives. A page that never receives it prices every route flat, which is
 * exactly what it did before.
 */

export interface ClimbManifest {
  version: number;
  edge_count: number;
  node_count: number;
  shape_point_count: number;
  /** Decimetres per stored unit, so a uint16 spans 6.5 km of climb. */
  scale: number;
  /** What produced it, for the attribution line. */
  source: string;
  /** Spacing of the samples along each edge, in metres. */
  sampled_m: number;
  /** A rise is only counted once it has been given back by this much.
   *
   *  Summing every positive difference straight off a terrain model accumulates its
   *  vertical noise into phantom climb -- on the probe routes that inflated the
   *  total by 15-20%. The threshold is the standard fix and belongs in the manifest
   *  because it is the single number the figures are most sensitive to. */
  threshold_m: number;
  layout: Record<string, { offset: number; count: number; type: string }>;
}

export interface Climb {
  readonly manifest: ClimbManifest;
  /** Metres gained riding the edge from a to b. Riding b to a swaps the two. */
  readonly ascent: Float32Array;
  readonly descent: Float32Array;
  /** Height above the model's datum at each junction, in metres. Ascent gives a
   *  ride its shape; this gives it a datum, which is what a profile needs. */
  readonly height: Float32Array;
  /** Height at each shape point, in metres, in the graph's own shape order. A
   *  junction-only profile misses whatever the road does between junctions, which on
   *  the benchmark routes was a third of the climb. */
  readonly shapeHeight: Float32Array;
}

function section(buffer: ArrayBuffer, manifest: ClimbManifest, name: string, type = "uint16") {
  const entry = manifest.layout[name];
  if (!entry) throw new Error(`climb data is missing the ${name} section`);
  if (entry.type !== type) throw new Error(`climb section ${name} is ${entry.type}, expected ${type}`);
  return type === "uint8"
    ? new Uint8Array(buffer, entry.offset, entry.count)
    : new Uint16Array(buffer, entry.offset, entry.count);
}

const unzigzag = (value: number) => (value >>> 1) ^ -(value & 1);

export function decodeClimb(manifest: ClimbManifest, bytes: ArrayBuffer, graph?: {
  shapeStart: Uint32Array; shapeCount: Uint16Array; edgeA: Uint32Array;
}): Climb {
  // 2 added the height at each junction, 3 the height at each shape point; without
  // them a route can say how much it climbs but not draw where.
  if (manifest.version !== 3) {
    throw new Error(`climb data version ${manifest.version} is not supported`);
  }
  const scale = manifest.scale;
  const metres = (raw: Uint16Array | Uint8Array) => {
    const out = new Float32Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) out[index] = raw[index] / scale;
    return out;
  };
  const height = metres(section(bytes, manifest, "node_height") as Uint16Array);
  return {
    manifest,
    ascent: metres(section(bytes, manifest, "edge_ascent") as Uint16Array),
    descent: metres(section(bytes, manifest, "edge_descent") as Uint16Array),
    height,
    shapeHeight: shapeHeights(section(bytes, manifest, "shape_height", "uint8") as Uint8Array, height, graph),
  };
}

/** Undo the delta chain. Each edge's first shape point is relative to that edge's
 *  own start node, the rest to the point before, so an unreadable step in the
 *  terrain model cannot drift past the end of the edge it is on. */
function shapeHeights(
  raw: Uint8Array, nodeHeight: Float32Array,
  graph?: { shapeStart: Uint32Array; shapeCount: Uint16Array; edgeA: Uint32Array },
): Float32Array {
  const out = new Float32Array(raw.length);
  if (!graph) return out; // no graph to anchor against; the profile stays flat
  for (let edge = 0; edge < graph.shapeCount.length; edge += 1) {
    let height = nodeHeight[graph.edgeA[edge]];
    const start = graph.shapeStart[edge];
    for (let point = 0; point < graph.shapeCount[edge]; point += 1) {
      height += unzigzag(raw[start + point]) / 10;
      out[start + point] = height;
    }
  }
  return out;
}

/** The bytes, before they can be made sense of.
 *
 * Decoding needs the graph -- the height deltas are anchored to its nodes -- but the
 * download should not wait for it, so the two halves are separate and the fetch can
 * run alongside the graph's own.
 */
export interface ClimbBytes {
  manifest: ClimbManifest;
  bytes: ArrayBuffer;
}

export async function fetchClimb(baseUrl: string): Promise<ClimbBytes> {
  const manifest = (await (await fetch(`${baseUrl}/climb.json`)).json()) as ClimbManifest;
  const response = await fetch(`${baseUrl}/climb.bin.gz`);
  if (!response.ok) throw new Error("climb request failed");
  const bytes = await response.arrayBuffer();
  // Whether the body arrives compressed depends on the host, exactly as for the
  // graph; sniffing the gzip magic settles it without trusting a header.
  const header = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  if (header[0] !== 0x1f || header[1] !== 0x8b) return { manifest, bytes };
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return { manifest, bytes: await new Response(stream).arrayBuffer() };
}
