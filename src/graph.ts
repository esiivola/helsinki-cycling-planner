/** Decoding for the graph `pipeline/sources/cycling_routing_graph.py` writes. */

export interface CostModel {
  signal_delay_s: number;
  crossing_delay_s: number;
  turn_penalty_s: number;
  /** What a left turn costs relative to a right one; absent in graphs before 6. */
  turn_left_factor?: number;
  turn_degrees: number;
  turn_merge_m: number;
  slow_speed_factor: number;
  /** What a signposted cycle route costs the search, as a share of an ordinary way. */
  network_bonus?: number;
  /** What a barrier costs: a squeeze past at this, a stop at three times it. */
  barrier_delay_s?: number;
  /** Speed on the unpaved, as a share of the flat speed, by roughness. Index 0 is
   *  paved and unused; a graph before 9 has none of this and falls back to
   *  `slow_speed_factor` for everything. */
  grade_speed_factor?: [number, number, number, number];
  /** Seconds added per vertical metre climbed, on top of the riding time.
   *
   *  The familiar rule of thumb is that a metre of climb costs about ten metres of
   *  flat, which at 18 km/h is two seconds. Absent from every graph built so far, so
   *  it carries a default here rather than being required. */
  climb_s_per_m?: number;
  /** Seconds given back per vertical metre descended, against the climb charged on
   *  the same edge. A descent never makes an edge cheaper than the same edge flat:
   *  in city riding the junctions, the braking and the lights take the gift back. */
  descent_credit_s_per_m?: number;
}

export interface GraphManifest {
  version: number;
  coordinate_scale: number;
  shape_scale: number;
  bearing_steps: number;
  node_count: number;
  edge_count: number;
  shape_point_count: number;
  name_count: number;
  oneway_edge_count: number;
  dedicated_edge_count: number;
  sidepath_edge_count: number;
  traffic_edge_count?: Record<string, number>;
  network_edge_count: number;
  two_stage_signal_count: number;
  bounds: [number, number, number, number];
  bytes: number;
  layout: Record<string, { offset: number; count: number; type: string }>;
  cost: CostModel;
}

export interface Graph {
  readonly manifest: GraphManifest;
  readonly lon: Int32Array;
  readonly lat: Int32Array;
  /** 0 plain, 1 uncontrolled crossing, 2 traffic signal, 3 signal crossed in two
   *  stages -- a dual carriageway or a refuge island, where the rider waits twice. */
  readonly nodeKind: Uint8Array;
  readonly degree: Uint8Array;
  readonly edgeA: Uint32Array;
  readonly edgeB: Uint32Array;
  /** Metres. */
  readonly edgeLength: Float32Array;
  /** Metres of `edgeLength` ridden at the slow-surface factor: `edgeUnpaved` and
   *  `edgeShared` together, which is what the speed model charges for. */
  readonly edgeSlow: Float32Array;
  /** Metres on a rough surface. */
  readonly edgeUnpaved: Float32Array;
  /** Metres paved but shared with people on foot. Disjoint from `edgeUnpaved`: a
   *  gravel path full of walkers counts once, as unpaved. */
  readonly edgeShared: Float32Array;
  /** Motor traffic ridden among: 0 none, 1 calm, 2 moderate, 3 busy, 4 arterial. */
  readonly edgeTraffic: Uint8Array;
  /** How rough the unpaved part is: 0 paved, 1 firm, 2 rough, 3 loose. */
  readonly edgeGrade: Uint8Array;
  /** Metres explicitly tagged as lit. Silence is not darkness: only 27% of roads
   *  carry the tag at all, so the rest is unknown rather than unlit. */
  readonly edgeLit: Float32Array;
  /** Barriers met inside the edge, weighted 1 for a squeeze and 2 for a stop. */
  readonly edgeBarriers: Uint8Array;
  /** Barrier at each junction, on the same scale. */
  readonly nodeBarrier: Uint8Array;
  /** Signals and crossings passed inside the edge, between its two junctions. */
  readonly edgeSignals: Uint8Array;
  readonly edgeCrossings: Uint8Array;
  /** Degrees, heading leaving a towards b. */
  readonly bearingA: Float32Array;
  /** Degrees, heading arriving at b from a. */
  readonly bearingB: Float32Array;
  /** Index into `names` for each edge; 0 is the empty name of an unnamed way. */
  readonly edgeName: Uint32Array;
  /** Bit 0: rideable a to b. Bit 1: rideable b to a. One-way edges have one of them. */
  readonly edgeAccess: Uint8Array;
  /** `EDGE_DEDICATED` | `EDGE_SIDEPATH`. */
  readonly edgeClass: Uint8Array;
  /** Street names, as the builder interned them. */
  readonly names: readonly string[];
  readonly shapeCount: Uint16Array;
  readonly shapeDelta: Uint16Array;
  /** Kind of each shape point, as `nodeKind`: this is where an interior signal is. */
  readonly shapeKind: Uint8Array;
  /** Start of each edge's run in `shapeDelta`, in points. */
  readonly shapeStart: Uint32Array;
  /** Incident edge indices, grouped by node. */
  readonly adjacency: Uint32Array;
  readonly adjacencyStart: Uint32Array;
}

const TYPES = {
  int32: Int32Array, uint32: Uint32Array, uint16: Uint16Array, uint8: Uint8Array,
} as const;

function section<T extends keyof typeof TYPES>(
  buffer: ArrayBuffer, manifest: GraphManifest, name: string, type: T,
): InstanceType<(typeof TYPES)[T]> {
  const entry = manifest.layout[name];
  if (!entry) throw new Error(`graph is missing the ${name} section`);
  if (entry.type !== type) throw new Error(`graph section ${name} is ${entry.type}, expected ${type}`);
  return new TYPES[type](buffer, entry.offset, entry.count) as InstanceType<(typeof TYPES)[T]>;
}

/** Edges reachable from each node, as a flat CSR-style array built once at load. */
function buildAdjacency(nodeCount: number, edgeA: Uint32Array, edgeB: Uint32Array) {
  const start = new Uint32Array(nodeCount + 1);
  for (let edge = 0; edge < edgeA.length; edge += 1) {
    start[edgeA[edge] + 1] += 1;
    start[edgeB[edge] + 1] += 1;
  }
  for (let node = 0; node < nodeCount; node += 1) start[node + 1] += start[node];
  const cursor = start.slice(0, nodeCount);
  const adjacency = new Uint32Array(edgeA.length * 2);
  for (let edge = 0; edge < edgeA.length; edge += 1) {
    adjacency[cursor[edgeA[edge]]++] = edge;
    adjacency[cursor[edgeB[edge]]++] = edge;
  }
  return { adjacency, adjacencyStart: start };
}

export function decodeGraph(manifest: GraphManifest, bytes: ArrayBuffer): Graph {
  // 2 added street names and the kind of each shape point, 3 which way round each
  // edge may be ridden, 4 what kind of way it is, 5 which crossings take two waits,
  // 7 how much traffic each edge carries and whether its slow metres are rough or
  // merely crowded. An older graph would be drawn without its lights, routed the
  // wrong way up a one-way street, sent riders down a carriageway with a cycleway
  // beside it, charge one wait where the rider makes two, ignore the signposted
  // network, be unable to tell a quiet street from an arterial, or ride through
  // every bollard and gate in the region without noticing, or charge a compacted
  // park path what it charges a mud track.
  if (manifest.version !== 9) {
    throw new Error(`graph version ${manifest.version} is too old; rebuild it with tools/build_graph.py`);
  }
  const edgeCount = manifest.edge_count;
  const rawLength = section(bytes, manifest, "edge_length", "uint16");
  const rawUnpaved = section(bytes, manifest, "edge_unpaved", "uint16");
  const rawLit = section(bytes, manifest, "edge_lit", "uint16");
  const rawShared = section(bytes, manifest, "edge_shared", "uint16");
  const rawBearingA = section(bytes, manifest, "bearing_a", "uint8");
  const rawBearingB = section(bytes, manifest, "bearing_b", "uint8");
  const degrees = 360 / manifest.bearing_steps;

  const edgeLength = new Float32Array(edgeCount);
  const edgeSlow = new Float32Array(edgeCount);
  const edgeUnpaved = new Float32Array(edgeCount);
  const edgeLit = new Float32Array(edgeCount);
  const edgeShared = new Float32Array(edgeCount);
  const bearingA = new Float32Array(edgeCount);
  const bearingB = new Float32Array(edgeCount);
  for (let edge = 0; edge < edgeCount; edge += 1) {
    edgeLength[edge] = rawLength[edge] / 10;
    edgeUnpaved[edge] = rawUnpaved[edge] / 10;
    edgeLit[edge] = Math.min(rawLit[edge] / 10, edgeLength[edge]);
    edgeShared[edge] = rawShared[edge] / 10;
    // Clamped, because all three are rounded to the decimetre independently and the
    // two parts can round up while the whole rounds down. One decimetre of slack
    // would leave the fast remainder negative, which is both untrue and enough to
    // break the promise A* relies on: that no edge costs less than riding it.
    edgeSlow[edge] = Math.min(edgeUnpaved[edge] + edgeShared[edge], edgeLength[edge]);
    bearingA[edge] = rawBearingA[edge] * degrees;
    bearingB[edge] = rawBearingB[edge] * degrees;
  }

  const shapeCount = section(bytes, manifest, "shape_count", "uint16");
  const shapeStart = new Uint32Array(edgeCount + 1);
  for (let edge = 0; edge < edgeCount; edge += 1) shapeStart[edge + 1] = shapeStart[edge] + shapeCount[edge];

  const edgeA = section(bytes, manifest, "edge_a", "uint32");
  const edgeB = section(bytes, manifest, "edge_b", "uint32");
  return {
    manifest,
    lon: section(bytes, manifest, "lon", "int32"),
    lat: section(bytes, manifest, "lat", "int32"),
    nodeKind: section(bytes, manifest, "node_kind", "uint8"),
    degree: section(bytes, manifest, "degree", "uint8"),
    edgeA, edgeB, edgeLength, edgeSlow, edgeUnpaved, edgeShared, bearingA, bearingB,
    edgeTraffic: section(bytes, manifest, "edge_traffic", "uint8"),
    edgeGrade: section(bytes, manifest, "edge_grade", "uint8"),
    edgeLit,
    edgeBarriers: section(bytes, manifest, "edge_barriers", "uint8"),
    nodeBarrier: section(bytes, manifest, "node_barrier", "uint8"),
    edgeSignals: section(bytes, manifest, "edge_signals", "uint8"),
    edgeCrossings: section(bytes, manifest, "edge_crossings", "uint8"),
    edgeName: section(bytes, manifest, "edge_name", "uint32"),
    edgeAccess: section(bytes, manifest, "edge_access", "uint8"),
    edgeClass: section(bytes, manifest, "edge_class", "uint8"),
    names: new TextDecoder().decode(section(bytes, manifest, "name_blob", "uint8")).split("\n"),
    shapeCount, shapeDelta: section(bytes, manifest, "shape_delta", "uint16"), shapeStart,
    shapeKind: section(bytes, manifest, "shape_kind", "uint8"),
    ...buildAdjacency(manifest.node_count, edgeA, edgeB),
  };
}

/** Built for bicycles: a cycleway, or a path they are designated on. */
export const EDGE_DEDICATED = 1;
/** A carriageway whose cycle traffic belongs on the path mapped beside it. */
export const EDGE_SIDEPATH = 2;
/** Part of a signposted cycle route: the baanas and the regional routes. */
export const EDGE_NETWORK = 4;

const unzigzag = (value: number) => (value >>> 1) ^ -(value & 1);

/** What an edge is called, or "" where OSM names no way along it. */
export function edgeNameOf(graph: Graph, edge: number): string {
  return graph.names[graph.edgeName[edge]] ?? "";
}

/** The polyline for one edge, from node a to node b, as [lon, lat] degrees. */
export function edgeShape(graph: Graph, edge: number): [number, number][] {
  const scale = graph.manifest.coordinate_scale;
  const shapeScale = graph.manifest.shape_scale;
  const points: [number, number][] = [[graph.lon[graph.edgeA[edge]] / scale, graph.lat[graph.edgeA[edge]] / scale]];
  let lon = Math.round(graph.lon[graph.edgeA[edge]] / scale * shapeScale);
  let lat = Math.round(graph.lat[graph.edgeA[edge]] / scale * shapeScale);
  for (let point = graph.shapeStart[edge]; point < graph.shapeStart[edge + 1]; point += 1) {
    lon += unzigzag(graph.shapeDelta[point * 2]);
    lat += unzigzag(graph.shapeDelta[point * 2 + 1]);
    points.push([lon / shapeScale, lat / shapeScale]);
  }
  points.push([graph.lon[graph.edgeB[edge]] / scale, graph.lat[graph.edgeB[edge]] / scale]);
  return points;
}

export async function loadGraph(baseUrl: string): Promise<Graph> {
  const manifest = (await (await fetch(`${baseUrl}/graph.json`)).json()) as GraphManifest;
  const response = await fetch(`${baseUrl}/graph.bin.gz`);
  if (!response.ok) throw new Error("graph request failed");
  const bytes = await response.arrayBuffer();
  // Whether the body arrives compressed depends on the host: some serve the .gz as
  // an opaque file, others set Content-Encoding and the browser has already inflated
  // it. Sniffing the gzip magic settles it without trusting a header that fetch is
  // allowed to hide.
  const header = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  if (header[0] !== 0x1f || header[1] !== 0x8b) return decodeGraph(manifest, bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return decodeGraph(manifest, await new Response(stream).arrayBuffer());
}
