import type { Graph, GraphManifest } from "../src/graph.ts";

export const COST = {
  signal_delay_s: 30, crossing_delay_s: 2, turn_penalty_s: 10, turn_left_factor: 1.5,
  turn_degrees: 40, turn_merge_m: 25, slow_speed_factor: 0.65, network_bonus: 0.9,
};

export interface EdgeSpec {
  a: number;
  b: number;
  /** Share of the edge ridden at the slow-surface factor. Counted as unpaved unless
   *  `shared` says otherwise, so `slow` alone keeps meaning what it always did. */
  slow?: number;
  /** Treat the slow share as paved-but-crowded rather than rough. */
  shared?: boolean;
  /** 0 none .. 4 arterial. */
  traffic?: number;
  /** 0 paved, 1 firm, 2 rough, 3 loose. */
  grade?: number;
  /** Share of the edge known to be lit. */
  lit?: number;
  /** Barriers inside the edge, weighted 1 squeeze and 2 stop. */
  barriers?: number;
  signals?: number;
  crossings?: number;
  name?: string;
  /** 1 rideable a->b only, -1 b->a only; omitted means both ways. */
  oneway?: 1 | -1;
  /** `EDGE_DEDICATED` | `EDGE_SIDEPATH`. */
  kind?: number;
}

export function metresBetween(from: [number, number], to: [number, number]): number {
  const east = (to[0] - from[0]) * Math.cos(((from[1] + to[1]) / 2) * (Math.PI / 180)) * 111_320;
  return Math.hypot(east, (to[1] - from[1]) * 110_540);
}

/** Build a Graph directly, so a test can state a topology instead of an OSM file.
 *
 * Lengths and bearings are derived from the node positions rather than declared.
 * That is not just convenience: A* is only admissible while an edge is at least as
 * long as the straight line between its ends, which a real polyline always is. A
 * fixture free to claim a 5 m edge between nodes 200 m apart would make the search
 * look broken when it is the fixture that is impossible.
 */
export function graphOf(
  nodes: [number, number][], edges: EdgeSpec[], kinds: number[] = [], barriers: number[] = [],
): Graph {
  const scale = 10_000_000;
  const names = ["", ...new Set(edges.map((edge) => edge.name).filter((name): name is string => !!name))];
  const manifest: GraphManifest = {
    version: 9, coordinate_scale: scale, shape_scale: 1_000_000, bearing_steps: 256,
    node_count: nodes.length, edge_count: edges.length, shape_point_count: 0, name_count: names.length,
    oneway_edge_count: edges.filter((edge) => edge.oneway).length,
    two_stage_signal_count: kinds.filter((kind) => kind === 3).length,
    dedicated_edge_count: edges.filter((edge) => (edge.kind ?? 0) & 1).length,
    network_edge_count: edges.filter((edge) => (edge.kind ?? 0) & 4).length,
    sidepath_edge_count: edges.filter((edge) => (edge.kind ?? 0) & 2).length,
    bounds: [0, 0, 0, 0], bytes: 0, layout: {}, cost: COST,
  };
  const bearing = (from: number, to: number) => {
    const east = (nodes[to][0] - nodes[from][0]) * Math.cos(((nodes[from][1] + nodes[to][1]) / 2) * (Math.PI / 180));
    return ((Math.atan2(east, nodes[to][1] - nodes[from][1]) * 180) / Math.PI + 360) % 360;
  };
  const length = (edge: EdgeSpec) => metresBetween(nodes[edge.a], nodes[edge.b]);
  const degree = new Uint8Array(nodes.length);
  for (const edge of edges) { degree[edge.a] += 1; degree[edge.b] += 1; }
  const adjacencyStart = new Uint32Array(nodes.length + 1);
  for (const edge of edges) { adjacencyStart[edge.a + 1] += 1; adjacencyStart[edge.b + 1] += 1; }
  for (let node = 0; node < nodes.length; node += 1) adjacencyStart[node + 1] += adjacencyStart[node];
  const cursor = adjacencyStart.slice(0, nodes.length);
  const adjacency = new Uint32Array(edges.length * 2);
  edges.forEach((edge, index) => {
    adjacency[cursor[edge.a]++] = index;
    adjacency[cursor[edge.b]++] = index;
  });
  return {
    manifest,
    lon: Int32Array.from(nodes, (node) => Math.round(node[0] * scale)),
    lat: Int32Array.from(nodes, (node) => Math.round(node[1] * scale)),
    nodeKind: Uint8Array.from(nodes, (_, index) => kinds[index] ?? 0),
    degree,
    edgeA: Uint32Array.from(edges, (edge) => edge.a),
    edgeB: Uint32Array.from(edges, (edge) => edge.b),
    edgeLength: Float32Array.from(edges, length),
    edgeSlow: Float32Array.from(edges, (edge) => length(edge) * (edge.slow ?? 0)),
    edgeUnpaved: Float32Array.from(edges, (edge) => (edge.shared ? 0 : length(edge) * (edge.slow ?? 0))),
    edgeShared: Float32Array.from(edges, (edge) => (edge.shared ? length(edge) * (edge.slow ?? 0) : 0)),
    edgeTraffic: Uint8Array.from(edges, (edge) => edge.traffic ?? 0),
    edgeGrade: Uint8Array.from(edges, (edge) => edge.grade ?? 0),
    edgeLit: Float32Array.from(edges, (edge) => length(edge) * (edge.lit ?? 0)),
    edgeBarriers: Uint8Array.from(edges, (edge) => edge.barriers ?? 0),
    nodeBarrier: Uint8Array.from(nodes, (_, index) => barriers[index] ?? 0),
    edgeSignals: Uint8Array.from(edges, (edge) => edge.signals ?? 0),
    edgeCrossings: Uint8Array.from(edges, (edge) => edge.crossings ?? 0),
    bearingA: Float32Array.from(edges, (edge) => bearing(edge.a, edge.b)),
    bearingB: Float32Array.from(edges, (edge) => bearing(edge.a, edge.b)),
    edgeName: Uint32Array.from(edges, (edge) => names.indexOf(edge.name ?? "")),
    edgeAccess: Uint8Array.from(edges, (edge) => (edge.oneway === 1 ? 1 : edge.oneway === -1 ? 2 : 3)),
    edgeClass: Uint8Array.from(edges, (edge) => edge.kind ?? 0),
    names,
    shapeCount: new Uint16Array(edges.length),
    shapeDelta: new Uint16Array(0),
    shapeKind: new Uint8Array(0),
    shapeStart: new Uint32Array(edges.length + 1),
    adjacency, adjacencyStart,
  };
}
