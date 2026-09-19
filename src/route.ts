/** Turn-aware point-to-point routing over the contracted cycling graph.
 *
 * The pipeline routes over *nodes* and counts turns afterwards by walking the
 * predecessor tree, so the route it measures never tried to avoid a turn. Here the
 * state is a *directed edge*, which is what lets the cost of arriving somewhere
 * depend on the edge you arrived from -- and therefore lets the search price the
 * bend between them. A rider comparing two routes on a map notices the difference
 * immediately: the node-based route will happily zigzag to save ten metres.
 */
import {
  EDGE_DEDICATED, EDGE_NETWORK, EDGE_SIDEPATH,
  type CostModel, type Graph, edgeNameOf, edgeShape,
} from "./graph.ts";
import type { Climb } from "./climb.ts";
import { WINTER_SALTED, type Winter } from "./winter.ts";
import type { Taste } from "./profile.ts";

export interface RouteRequest {
  /** Free-flow riding speed in km/h, before any surface or junction penalty. */
  speedKmh: number;
  /** Set false to price a route the way the pipeline does, for comparison. */
  chargeTurns?: boolean;
  /** Set false to allow the carriageway where a cycleway runs beside it. */
  avoidSidepathRoads?: boolean;
  /** Overrides for the graph's own cost model. These are claims about the world, so
   *  they change what a route is reported to cost as well as which one is chosen. */
  cost?: Partial<CostModel>;
  /** Multipliers applied inside the search alone. A rider's dislike of gravel is not
   *  a duration, so it must never leak into the minutes on screen. */
  taste?: Partial<Taste>;
}

/** The shipped defaults for the two climb parameters, until a graph carries its own.
 *  `bench_climb.mjs` is what moves them. */
export const BARRIER_DELAY_S = 4;
/** Paved, firm, rough, loose. Firm gravel rolls nearly like asphalt; cobblestone is
 *  solid but shakes; mud is mud. */
export const GRADE_SPEED_FACTOR: [number, number, number, number] = [1, 0.8, 0.65, 0.55];
export const CLIMB_S_PER_M = 2;
export const DESCENT_CREDIT_S_PER_M = 0.4;

/** How much worse than the best an alternative may be before it is not an option
 *  at all. Google's own threshold is around a quarter; a cyclist chooses a longer
 *  way for quiet or shade, but not one that costs half the ride again. */
const ALTERNATIVE_MAX_RATIO = 1.3;
/** An alternative has to be a genuinely different way of going, not the same route
 *  with one block swapped. Measured as shared metres over the candidate's length. */
const ALTERNATIVE_MAX_OVERLAP = 0.7;
/** What an already-offered edge costs on the next search. Pushing the search off
 *  the roads it has already used is what makes it find a different way; too small a
 *  push returns the same route again, too large a one returns an absurd detour. */
const ALTERNATIVE_PENALTY = 1.6;
/** What a carriageway costs the search where a cycleway is mapped beside it, unless
 *  the rider has said otherwise.
 *
 * Not an exclusion: the cycleway is not always mapped through, and forbidding the
 * road outright made four of the ten benchmark routes fail to connect at all, which
 * sent them back to the road for their whole length. At eight times the cost the
 * search takes any legal way round that is not absurd, and still crosses the 20 m
 * of carriageway that a missing link leaves it no way past. The route is then
 * *reported* at its true cost, so the minutes on screen stay minutes.
 */
const SIDEPATH_PENALTY = 8;

/** What each traffic class costs, as a share of the aversion the rider set.
 *
 * A single multiplier over "not built for bicycles" could not tell a cul-de-sac from
 * a four-lane arterial, and this region has plenty of both. The scale is the road's
 * class, because in this region it stands in for how many cars there are and how
 * fast they go closely enough -- and unlike `maxspeed` it is tagged on nearly every
 * way. Index by `edgeTraffic`: none, calm, moderate, busy, arterial.
 */
const TRAFFIC_EXPOSURE = [0, 0.25, 0.6, 1, 1.4] as const;

/** How much of a winter preference each tier earns. A ploughed route is better than
 *  nothing and worse than bare pavement, so it takes most of the discount, not all. */
const WINTER_SHARE = [0, 0.6, 1] as const;

/** The graph's cost model with the rider's overrides laid on top. */
const effectiveCost = (graph: Graph, request: RouteRequest): CostModel =>
  ({ ...graph.manifest.cost, ...request.cost });

/** The search-only multipliers. Absent a profile these reproduce what the graph
 *  shipped, so a rider who never opens the settings is routed exactly as before. */
function effectiveTaste(graph: Graph, request: RouteRequest): Taste {
  const base: Taste = {
    turn: 1,
    signal: 1,
    unpaved: 1,
    shared: 1,
    traffic: 1,
    sidepath: request.avoidSidepathRoads === false ? 1 : SIDEPATH_PENALTY,
    network: graph.manifest.cost.network_bonus ?? 1,
    hill: 1,
    barrier: 1,
    lit: 1,
    winter: 1,
  };
  return { ...base, ...request.taste };
}

/** What the rider does at the start of a step. `start` and `arrive` are the ends. */
export type Maneuver = "start" | "arrive" | "straight" | "left" | "right" | "sharp-left" | "sharp-right";

export interface Step {
  maneuver: Maneuver;
  /** The street ridden along this step, or "" where OSM names none of it. */
  name: string;
  /** Where the manoeuvre happens, [lon, lat] degrees. */
  at: [number, number];
  metres: number;
  seconds: number;
  signals: number;
  crossings: number;
}

/** Bends sharper than this are a hairpin rather than a turn, and read as one. */
const SHARP_DEGREES = 115;

export interface Route {
  /** Perceived seconds: riding time plus every delay the cost model charges. */
  seconds: number;
  /** Metres climbed and dropped over the ride. Zero until climb data is attached. */
  ascentMetres: number;
  descentMetres: number;
  /** Seconds of riding alone, with no delay or penalty. */
  ridingSeconds: number;
  metres: number;
  slowMetres: number;
  /** Barriers met, weighted 1 for a squeeze and 2 for a stop. */
  barriers: number;
  /** Metres known to be lit. */
  litMetres: number;
  /** Metres on the city's winter network, and on its brush-salted tier. */
  winterMetres: number;
  saltedMetres: number;
  /** Metres ridden at each traffic class, indexed 0 car-free to 4 arterial. The
   *  question the traffic preference exists to answer, and the one a table row of
   *  "65 % pyöräväylää" cannot: how much of this ride is actually among cars. */
  trafficMetres: number[];
  /** The two halves of `slowMetres`, which never overlap. */
  unpavedMetres: number;
  sharedMetres: number;
  signals: number;
  crossings: number;
  turns: number;
  /** The edges ridden, in order, each as [lon, lat] degrees. */
  path: [number, number][];
  /** Graph edge indices ridden, for comparing one route against another. */
  edges: number[];
  /** Metres ridden on a way built for bicycles. */
  dedicatedMetres: number;
  /** Metres on a signposted cycle route -- a baana or a regional route. */
  networkMetres: number;
  /** Metres on a carriageway that has a cycleway beside it, which only a route with
   *  no legal alternative should contain at all. */
  sidepathMetres: number;
  /** Every traffic light on the route, [lon, lat] degrees, in the order met. */
  signalPoints: [number, number][];
  /** Height against distance along the ride: [metres travelled, metres above the
   *  terrain model's datum], one point per junction. Empty without climb data. */
  profile: [number, number][];
  /** The ride broken at each manoeuvre, for a turn-by-turn list. */
  steps: Step[];
}

const FLAT = { up: 0, down: 0 };

const EARTH_NORTH_M = 110_540;
const EARTH_EAST_M = 111_320;

function metresBetween(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const east = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180)) * EARTH_EAST_M;
  const north = (lat2 - lat1) * EARTH_NORTH_M;
  return Math.hypot(east, north);
}

/** A min-heap over (priority, state) kept in typed arrays; ~840k states fit easily. */
class Heap {
  private priority: Float64Array;
  private item: Int32Array;
  private size = 0;

  constructor(capacity: number) {
    this.priority = new Float64Array(capacity);
    this.item = new Int32Array(capacity);
  }

  get length(): number { return this.size; }

  push(priority: number, item: number): void {
    if (this.size === this.priority.length) this.grow();
    let child = this.size++;
    this.priority[child] = priority;
    this.item[child] = item;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (this.priority[parent] <= this.priority[child]) break;
      this.swap(parent, child);
      child = parent;
    }
  }

  pop(): number {
    const top = this.item[0];
    this.size -= 1;
    if (this.size > 0) {
      this.priority[0] = this.priority[this.size];
      this.item[0] = this.item[this.size];
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        if (left >= this.size) break;
        const right = left + 1;
        const child = right < this.size && this.priority[right] < this.priority[left] ? right : left;
        if (this.priority[parent] <= this.priority[child]) break;
        this.swap(parent, child);
        parent = child;
      }
    }
    return top;
  }

  private swap(left: number, right: number): void {
    const priority = this.priority[left];
    this.priority[left] = this.priority[right];
    this.priority[right] = priority;
    const item = this.item[left];
    this.item[left] = this.item[right];
    this.item[right] = item;
  }

  private grow(): void {
    const priority = new Float64Array(this.priority.length * 2);
    priority.set(this.priority);
    this.priority = priority;
    const item = new Int32Array(this.item.length * 2);
    item.set(this.item);
    this.item = item;
  }
}

/** What a manoeuvre costs, in multiples of `turn_penalty_s`.
 *
 * A right turn is the cheap one: the rider crosses nothing to make it, and the Dutch
 * GPS study found right-turning cyclists largely do not stop at all. A left turn
 * crosses the opposing traffic, which in Finland usually means taking it in two
 * goes -- ride to the far corner, stop, then cross -- so it costs more than the
 * geometry alone suggests.
 */
function turnCost(change: number, cost: Pick<CostModel, "turn_penalty_s" | "turn_left_factor">): number {
  const left = change < 0;
  return cost.turn_penalty_s * (left ? cost.turn_left_factor ?? 1 : 1);
}

const EMPTY_ROUTE = (): Route => ({
  seconds: 0, ascentMetres: 0, descentMetres: 0,
  ridingSeconds: 0, metres: 0, slowMetres: 0, barriers: 0, litMetres: 0,
  winterMetres: 0, saltedMetres: 0, trafficMetres: [0, 0, 0, 0, 0],
  unpavedMetres: 0, sharedMetres: 0,
  signals: 0, crossings: 0, turns: 0,
  dedicatedMetres: 0, networkMetres: 0, sidepathMetres: 0,
  path: [], edges: [], signalPoints: [], profile: [], steps: [],
});

/** Signed heading change: negative is to the left, positive to the right. */
function swing(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

function maneuverOf(change: number, turnDegrees: number): Maneuver {
  if (Math.abs(change) < turnDegrees) return "straight";
  if (Math.abs(change) >= SHARP_DEGREES) return change < 0 ? "sharp-left" : "sharp-right";
  return change < 0 ? "left" : "right";
}

export class Router {
  private readonly graph: Graph;
  /** Attached after construction, because it is a separate download that may never
   *  arrive. Absent, every edge is flat and the router behaves exactly as before. */
  private climb: Climb | null = null;
  /** Also attached after construction, and also optional: without it every route is
   *  priced as if the city gritted nothing, which is what it did before. */
  private winter: Winter | null = null;
  private readonly cells = new Map<number, number[]>();
  private readonly cellSize = 0.01; // ~1.1 km of latitude
  private readonly distance: Float64Array;
  private readonly cameFrom: Int32Array;
  private readonly visitStamp: Int32Array;
  private visit = 0;

  constructor(graph: Graph) {
    this.graph = graph;
    const states = graph.manifest.edge_count * 2;
    this.distance = new Float64Array(states);
    this.cameFrom = new Int32Array(states);
    // Re-zeroing 840k entries per query would dwarf the search itself, so staleness
    // is tracked with a stamp instead of by clearing.
    this.visitStamp = new Int32Array(states);
    const scale = graph.manifest.coordinate_scale;
    for (let node = 0; node < graph.manifest.node_count; node += 1) {
      const key = this.cellKey(graph.lon[node] / scale, graph.lat[node] / scale);
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(node); else this.cells.set(key, [node]);
    }
  }

  /** The graph's own cost model, so the settings panel can show what each knob
   *  was shipped at rather than what the rider has moved it to. */
  get costModel(): CostModel { return this.graph.manifest.cost; }

  /** Whether routes can say anything about hills yet. */
  get hasClimb(): boolean { return this.climb !== null; }

  get hasWinter(): boolean { return this.winter !== null; }

  attachWinter(winter: Winter | null): void {
    if (winter && winter.tier.length !== this.graph.manifest.edge_count) {
      throw new Error("winter data does not match this graph");
    }
    this.winter = winter;
  }

  attachClimb(climb: Climb | null): void {
    if (climb && climb.ascent.length !== this.graph.manifest.edge_count) {
      throw new Error("climb data does not match this graph");
    }
    if (climb && climb.height.length !== this.graph.manifest.node_count) {
      throw new Error("climb heights do not match this graph");
    }
    this.climb = climb;
  }

  /** Metres up and down riding `edge` the way `reversed` says. */
  private relief(edge: number, reversed: boolean): { up: number; down: number } {
    if (!this.climb) return FLAT;
    const ascent = this.climb.ascent[edge];
    const descent = this.climb.descent[edge];
    return reversed ? { up: descent, down: ascent } : { up: ascent, down: descent };
  }

  /** What the hill costs, in seconds, over and above riding the same metres flat.
   *
   * Clamped at zero: a descent pays back the climb charged on the same edge and no
   * further. Rolling downhill through a city does not beat flat -- the junctions,
   * the braking and the lights take the gift back -- and a negative cost would make
   * A*'s heuristic optimistic, which is not a trade worth making for a fiction.
   */
  private climbSeconds(edge: number, reversed: boolean, cost: CostModel): number {
    if (!this.climb) return 0;
    const { up, down } = this.relief(edge, reversed);
    const charge = up * (cost.climb_s_per_m ?? CLIMB_S_PER_M);
    const credit = down * (cost.descent_credit_s_per_m ?? DESCENT_CREDIT_S_PER_M);
    return Math.max(0, charge - credit);
  }

  private cellKey(lon: number, lat: number): number {
    return Math.floor(lon / this.cellSize) * 100_000 + Math.floor(lat / this.cellSize);
  }

  /** Nearest junction to a point. Every node in the graph is on the main component,
   *  so this cannot strand a query on an island the way snapping to raw OSM can. */
  nearestNode(lon: number, lat: number): number {
    const scale = this.graph.manifest.coordinate_scale;
    let best = -1;
    let bestMetres = Infinity;
    let lastRing = 64;
    for (let ring = 0; ring <= lastRing; ring += 1) {
      for (let x = -ring; x <= ring; x += 1) {
        for (let y = -ring; y <= ring; y += 1) {
          if (ring > 0 && Math.abs(x) !== ring && Math.abs(y) !== ring) continue;
          const bucket = this.cells.get(this.cellKey(lon + x * this.cellSize, lat + y * this.cellSize));
          if (!bucket) continue;
          for (const node of bucket) {
            const metres = metresBetween(lon, lat, this.graph.lon[node] / scale, this.graph.lat[node] / scale);
            if (metres < bestMetres) { bestMetres = metres; best = node; }
          }
        }
      }
      // Search one ring past the first hit: a node just over a cell boundary can be
      // nearer than anything in the cell the point happens to land in.
      if (best >= 0 && lastRing === 64) lastRing = ring + 1;
    }
    return best;
  }

  /** Whether this directed edge may be ridden the way the state faces.
   *
   * The state's parity is its direction: even rides a to b, odd rides b to a, which
   * is exactly the two bits the graph carries. Checking it here rather than when the
   * edge is built keeps one-way streets out of the search entirely, so a route never
   * even considers riding against one.
   */
  private rideable(state: number): boolean {
    return (this.graph.edgeAccess[state >> 1] & ((state & 1) === 0 ? 1 : 2)) !== 0;
  }

  private headOf(state: number): number {
    const edge = state >> 1;
    return (state & 1) === 0 ? this.graph.edgeB[edge] : this.graph.edgeA[edge];
  }

  private arrivalBearing(state: number): number {
    const edge = state >> 1;
    return (state & 1) === 0 ? this.graph.bearingB[edge] : (this.graph.bearingA[edge] + 180) % 360;
  }

  private departureBearing(state: number): number {
    const edge = state >> 1;
    return (state & 1) === 0 ? this.graph.bearingA[edge] : (this.graph.bearingB[edge] + 180) % 360;
  }

  /** Seconds of riding: the metres, at whatever speed the surface and the gradient
   *  leave. The hill is part of the ride, not a delay bolted onto it. */
  /** What the unpaved metres of an edge roll at, as a share of the flat speed. */
  private gradeFactor(edge: number, cost: CostModel): number {
    const grade = this.graph.edgeGrade[edge];
    if (!grade) return cost.slow_speed_factor;
    return (cost.grade_speed_factor ?? GRADE_SPEED_FACTOR)[grade] ?? cost.slow_speed_factor;
  }

  private rideSeconds(edge: number, reversed: boolean, metresPerSecond: number, cost: CostModel): number {
    const graph = this.graph;
    const fast = graph.edgeLength[edge] - graph.edgeSlow[edge];
    return fast / metresPerSecond
      // Sharing with people on foot is a crowd, not a surface, so it keeps the one
      // factor; the rough metres are charged at whatever their roughness rolls at.
      + graph.edgeUnpaved[edge] / (metresPerSecond * this.gradeFactor(edge, cost))
      + graph.edgeShared[edge] / (metresPerSecond * cost.slow_speed_factor)
      + this.climbSeconds(edge, reversed, cost);
  }

  /** Seconds to traverse `edge`, including the signals, crossings and barriers
   *  inside it. A bollard mid-block is dissolved by contraction exactly as a light
   *  is, so both are counted per edge rather than only at junctions. */
  private edgeSeconds(edge: number, reversed: boolean, metresPerSecond: number, cost: CostModel): number {
    return this.rideSeconds(edge, reversed, metresPerSecond, cost)
      + this.graph.edgeSignals[edge] * cost.signal_delay_s
      + this.graph.edgeCrossings[edge] * cost.crossing_delay_s
      + this.graph.edgeBarriers[edge] * (cost.barrier_delay_s ?? BARRIER_DELAY_S);
  }

  /** The delay a junction costs. A crossing split by an island, or one that takes
   *  the rider over two carriageways, is two waits at one set of lights. */
  private nodeSeconds(node: number, cost: CostModel): number {
    return this.kindSeconds(this.graph.nodeKind[node], cost) + this.barrierSeconds(node, cost);
  }

  private kindSeconds(kind: number, cost: CostModel): number {
    if (kind === 3) return cost.signal_delay_s * 2;
    return kind === 2 ? cost.signal_delay_s : kind === 1 ? cost.crossing_delay_s : 0;
  }

  /** What the barrier standing at a node costs, in seconds. */
  private barrierSeconds(node: number, cost: CostModel): number {
    return this.graph.nodeBarrier[node] * (cost.barrier_delay_s ?? BARRIER_DELAY_S);
  }

  /** A junction as the *search* prices it. Most lights stand mid-block, but the
   *  other 40% are junctions, so an aversion to waiting has to reach both or it
   *  hardly reaches anything. */
  private searchNodeSeconds(node: number, cost: CostModel, taste: Taste): number {
    const barrier = this.barrierSeconds(node, cost) * taste.barrier;
    const kind = this.graph.nodeKind[node];
    if (kind === 3) return cost.signal_delay_s * 2 * taste.signal + barrier;
    if (kind === 2) return cost.signal_delay_s * taste.signal + barrier;
    return (kind === 1 ? cost.crossing_delay_s : 0) + barrier;
  }

  /** Seconds to traverse `edge` as the *search* prices it.
   *
   * The true cost with each aversion applied to the part of it that the aversion is
   * about -- gravel to the slow metres, waiting to the light delay -- and then the
   * whole edge scaled by what kind of way it is. `route.seconds` is summed from the
   * true costs alone, so none of this reaches the minutes on screen.
   */
  private searchSeconds(
    edge: number, reversed: boolean, metresPerSecond: number,
    cost: CostModel, taste: Taste, penalty: Float64Array | null,
  ): number {
    const graph = this.graph;
    const fast = graph.edgeLength[edge] - graph.edgeSlow[edge];
    let seconds = fast / metresPerSecond
      + (graph.edgeUnpaved[edge] / (metresPerSecond * this.gradeFactor(edge, cost))) * taste.unpaved
      + (graph.edgeShared[edge] / (metresPerSecond * cost.slow_speed_factor)) * taste.shared
      + this.climbSeconds(edge, reversed, cost) * taste.hill
      + graph.edgeSignals[edge] * cost.signal_delay_s * taste.signal
      + graph.edgeCrossings[edge] * cost.crossing_delay_s
      + graph.edgeBarriers[edge] * (cost.barrier_delay_s ?? BARRIER_DELAY_S) * taste.barrier;
    // Lit metres are discounted rather than dark ones surcharged: only a quarter of
    // roads carry the tag, so a penalty would fall on whatever nobody has surveyed.
    if (taste.lit !== 1) seconds -= (graph.edgeLit[edge] / metresPerSecond) * (1 - taste.lit);
    const kind = graph.edgeClass[edge];
    // Graded by how busy the road is, so avoiding traffic sends a rider down a
    // residential street long before it sends them the long way round one.
    const exposure = TRAFFIC_EXPOSURE[graph.edgeTraffic[edge]] ?? 1;
    if (exposure > 0 && taste.traffic !== 1) seconds *= 1 + (taste.traffic - 1) * exposure;
    if (kind & EDGE_SIDEPATH) seconds *= taste.sidepath;
    const tier = this.winter ? this.winter.tier[edge] : 0;
    if (tier && taste.winter !== 1) seconds *= 1 - (1 - taste.winter) * WINTER_SHARE[tier];
    // A signposted route is the one a rider can follow, so it wins a tie.
    if (kind & EDGE_NETWORK) seconds *= taste.network;
    if (penalty) seconds *= penalty[edge];
    return seconds;
  }

  /** The most a metre of riding can be discounted by, over every way class.
   *
   * A* is only correct while the heuristic never overestimates, and a *preference*
   * is a multiplier below 1 -- so straight-line-distance over free-flow speed stops
   * being a lower bound the moment one is set. Scaling it by the deepest discount
   * available restores that. The shipped `network_bonus` of 0.9 already needed this.
   */
  private heuristicFloor(cost: CostModel, taste: Taste): number {
    // The deepest the traffic row can discount a metre is at the busiest class.
    const traffic = Math.min(1, 1 + (taste.traffic - 1) * Math.max(...TRAFFIC_EXPOSURE));
    return traffic * Math.min(1, taste.sidepath) * Math.min(1, taste.network)
      // The cheapest a rough metre can be: the firmest grade at the keenest taste.
      * Math.min(1, taste.unpaved / Math.max(...(cost.grade_speed_factor ?? GRADE_SPEED_FACTOR).slice(1)))
      * Math.min(1, taste.shared / cost.slow_speed_factor)
      // A lit metre is discounted straight off the riding time, so the cheapest a
      // metre can be is that discount.
      * Math.min(1, taste.lit)
      * Math.min(1, 1 - (1 - taste.winter) * Math.max(...WINTER_SHARE));
  }

  route(fromLon: number, fromLat: number, toLon: number, toLat: number, request: RouteRequest): Route | null {
    const start = this.nearestNode(fromLon, fromLat);
    const target = this.nearestNode(toLon, toLat);
    if (start < 0 || target < 0) return null;
    if (start === target) return EMPTY_ROUTE();
    return this.search(start, target, request, null);
  }

  /** The best route and up to `limit - 1` genuinely different ways of riding it.
   *
   * Each pass raises the cost of the roads already offered and searches again, which
   * is how a single-pair search can be made to yield alternatives at all; a candidate
   * is kept only if it is neither much slower than the best nor mostly the same ride.
   * The returned routes are measured at their true cost, not the penalised one.
   */
  routes(
    fromLon: number, fromLat: number, toLon: number, toLat: number,
    request: RouteRequest & { limit?: number },
  ): Route[] {
    const limit = Math.max(1, request.limit ?? 3);
    const best = this.route(fromLon, fromLat, toLon, toLat, request);
    if (!best || limit === 1 || best.edges.length === 0) return best ? [best] : [];

    const start = this.nearestNode(fromLon, fromLat);
    const target = this.nearestNode(toLon, toLat);
    const penalty = new Float64Array(this.graph.manifest.edge_count).fill(1);
    const kept = [best];
    const penalise = (route: Route) => {
      for (const edge of route.edges) penalty[edge] *= ALTERNATIVE_PENALTY;
    };
    penalise(best);

    // Two tries past the last one wanted: a candidate can be rejected for looking too
    // much like a route already offered, and the next push often clears it.
    for (let attempt = 0; attempt < limit + 2 && kept.length < limit; attempt += 1) {
      const candidate = this.search(start, target, request, penalty);
      if (!candidate) break;
      penalise(candidate);
      if (candidate.seconds > best.seconds * ALTERNATIVE_MAX_RATIO) continue;
      if (kept.some((route) => this.overlap(route, candidate) > ALTERNATIVE_MAX_OVERLAP)) continue;
      kept.push(candidate);
    }
    return kept;
  }

  /** Share of `candidate`'s length that is also ridden by `route`, 0 to 1. */
  private overlap(route: Route, candidate: Route): number {
    const shared = new Set(route.edges);
    let metres = 0;
    let common = 0;
    for (const edge of candidate.edges) {
      metres += this.graph.edgeLength[edge];
      if (shared.has(edge)) common += this.graph.edgeLength[edge];
    }
    return metres > 0 ? common / metres : 1;
  }

  private search(start: number, target: number, request: RouteRequest, penalty: Float64Array | null): Route | null {
    const graph = this.graph;
    const scale = graph.manifest.coordinate_scale;
    const metresPerSecond = (request.speedKmh * 1000) / 3600;
    const chargeTurns = request.chargeTurns !== false;
    const cost = effectiveCost(graph, request);
    const taste = effectiveTaste(graph, request);
    const turnDegrees = cost.turn_degrees;
    const targetLon = graph.lon[target] / scale;
    const targetLat = graph.lat[target] / scale;
    // Admissible: no edge is ever cheaper than riding it at the free-flow speed,
    // less whatever the deepest preference discounts a metre by.
    const floor = this.heuristicFloor(cost, taste);
    const heuristic = (node: number) =>
      (metresBetween(graph.lon[node] / scale, graph.lat[node] / scale, targetLon, targetLat) / metresPerSecond)
      * floor;

    this.visit += 1;
    const heap = new Heap(1 << 16);
    for (let slot = graph.adjacencyStart[start]; slot < graph.adjacencyStart[start + 1]; slot += 1) {
      const edge = graph.adjacency[slot];
      const state = edge * 2 + (graph.edgeA[edge] === start ? 0 : 1);
      if (!this.rideable(state)) continue;
      const seconds = this.searchSeconds(edge, (state & 1) === 1, metresPerSecond, cost, taste, penalty);
      this.distance[state] = seconds;
      this.cameFrom[state] = -1;
      this.visitStamp[state] = this.visit;
      heap.push(seconds + heuristic(this.headOf(state)), state);
    }

    let found = -1;
    while (heap.length > 0) {
      const state = heap.pop();
      const head = this.headOf(state);
      if (head === target) { found = state; break; }
      const seconds = this.distance[state];
      const arrival = this.arrivalBearing(state);
      const throughNode = this.searchNodeSeconds(head, cost, taste);
      const isJunction = graph.degree[head] >= 3;
      for (let slot = graph.adjacencyStart[head]; slot < graph.adjacencyStart[head + 1]; slot += 1) {
        const edge = graph.adjacency[slot];
        const next = edge * 2 + (graph.edgeA[edge] === head ? 0 : 1);
        if (!this.rideable(next)) continue;
        let step = throughNode + this.searchSeconds(edge, (next & 1) === 1, metresPerSecond, cost, taste, penalty);
        const change = swing(arrival, this.departureBearing(next));
        if (chargeTurns && isJunction && Math.abs(change) >= turnDegrees) {
          step += turnCost(change, cost) * taste.turn;
        }
        const total = seconds + step;
        if (this.visitStamp[next] === this.visit && this.distance[next] <= total) continue;
        this.visitStamp[next] = this.visit;
        this.distance[next] = total;
        this.cameFrom[next] = state;
        heap.push(total + heuristic(this.headOf(next)), next);
      }
    }
    if (found < 0) return null;

    const states: number[] = [];
    for (let state = found; state >= 0; state = this.cameFrom[state]) states.push(state);
    states.reverse();

    const route = EMPTY_ROUTE();
    const turnMerge = cost.turn_merge_m;
    // A step is named after the street carrying most of it: a stretch can run over a
    // named road and an unnamed connector, and the rider knows it by the road.
    const stepNames: Map<string, number>[] = [];
    let step: Step | null = null;
    for (let index = 0; index < states.length; index += 1) {
      const state = states[index];
      const edge = state >> 1;
      const reversed = (state & 1) === 1;
      const shape = edgeShape(graph, edge);
      if (reversed) shape.reverse();

      // Reported, not searched: every aversion is left behind here on purpose.
      let seconds = this.edgeSeconds(edge, reversed, metresPerSecond, cost);
      let maneuver: Maneuver = "start";
      let junctionSignals = 0;
      let junctionCrossings = 0;
      if (index > 0) {
        const junction = this.headOf(states[index - 1]);
        const kind = graph.nodeKind[junction];
        if (kind === 2) junctionSignals = 1;
        if (kind === 3) junctionSignals = 2; // one junction, two waits
        if (kind === 1) junctionCrossings = 1;
        seconds += this.nodeSeconds(junction, cost);
        route.barriers += graph.nodeBarrier[junction];
        const change = swing(this.arrivalBearing(states[index - 1]), this.departureBearing(state));
        maneuver = graph.degree[junction] >= 3 ? maneuverOf(change, turnDegrees) : "straight";
        if (maneuver !== "straight") {
          route.turns += 1;
          if (chargeTurns) seconds += turnCost(change, cost);
        }
        if (junctionSignals) route.signalPoints.push(shape[0]);
      }

      // Interior signals are the whole reason shape points carry a kind: most lights
      // stand mid-block, where contraction dissolved the node they were tagged on.
      const shapeStart = graph.shapeStart[edge];
      const shapeCount = graph.shapeCount[edge];
      for (let point = 0; point < shapeCount; point += 1) {
        const kind = graph.shapeKind[shapeStart + (reversed ? shapeCount - 1 - point : point)];
        // One mark on the map either way: a two-stage crossing is one place you
        // stop, even where it is two waits.
        if (kind === 2 || kind === 3) route.signalPoints.push(shape[point + 1]);
      }

      // Turns closer together than turn_merge_m are one manoeuvre -- a staggered
      // crossing is a single "cross here", not a left immediately followed by a right.
      if (!step || (maneuver !== "straight" && maneuver !== "start" && step.metres >= turnMerge)) {
        step = { maneuver: index === 0 ? "start" : maneuver, name: "", at: shape[0], metres: 0, seconds: 0, signals: 0, crossings: 0 };
        route.steps.push(step);
        stepNames.push(new Map());
      }
      const name = edgeNameOf(graph, edge);
      const names = stepNames[stepNames.length - 1];
      if (name) names.set(name, (names.get(name) ?? 0) + graph.edgeLength[edge]);
      step.metres += graph.edgeLength[edge];
      step.seconds += seconds;
      step.signals += graph.edgeSignals[edge] + junctionSignals;
      step.crossings += graph.edgeCrossings[edge] + junctionCrossings;

      route.edges.push(edge);
      route.ridingSeconds += this.rideSeconds(edge, reversed, metresPerSecond, cost);
      // One point per junction: where this edge starts, then where it ends. Taken
      // before `route.metres` grows, so the distance is the running total.
      if (this.climb) {
        const tail = reversed ? graph.edgeA[edge] : graph.edgeB[edge];
        if (route.profile.length === 0) {
          const head = reversed ? graph.edgeB[edge] : graph.edgeA[edge];
          route.profile.push([0, this.climb.height[head]]);
        }
        // Through the edge's shape points, not straight from junction to junction:
        // the road between two junctions is where most of the relief actually is.
        const count = graph.shapeCount[edge];
        const start = graph.shapeStart[edge];
        const run = graph.edgeLength[edge];
        for (let point = 0; point < count; point += 1) {
          const index = start + (reversed ? count - 1 - point : point);
          const along = (run * (point + 1)) / (count + 1);
          route.profile.push([route.metres + along, this.climb.shapeHeight[index]]);
        }
        route.profile.push([route.metres + run, this.climb.height[tail]]);
      }
      const relief = this.relief(edge, reversed);
      route.ascentMetres += relief.up;
      route.descentMetres += relief.down;
      route.metres += graph.edgeLength[edge];
      route.slowMetres += graph.edgeSlow[edge];
      route.trafficMetres[graph.edgeTraffic[edge]] += graph.edgeLength[edge];
      route.barriers += graph.edgeBarriers[edge];
      route.litMetres += graph.edgeLit[edge];
      if (this.winter?.tier[edge]) {
        route.winterMetres += graph.edgeLength[edge];
        if (this.winter.tier[edge] === WINTER_SALTED) route.saltedMetres += graph.edgeLength[edge];
      }
      route.unpavedMetres += graph.edgeUnpaved[edge];
      route.sharedMetres += graph.edgeShared[edge];
      if (graph.edgeClass[edge] & EDGE_DEDICATED) route.dedicatedMetres += graph.edgeLength[edge];
      if (graph.edgeClass[edge] & EDGE_NETWORK) route.networkMetres += graph.edgeLength[edge];
      if (graph.edgeClass[edge] & EDGE_SIDEPATH) route.sidepathMetres += graph.edgeLength[edge];
      route.signals += graph.edgeSignals[edge] + junctionSignals;
      route.crossings += graph.edgeCrossings[edge] + junctionCrossings;
      // Priced afresh rather than read off the search, which may have been riding
      // penalised costs to find this route at all.
      route.seconds += seconds;
      route.path.push(...(index === 0 ? shape : shape.slice(1)));
    }
    route.steps.forEach((entry, index) => {
      const names = [...stepNames[index]];
      entry.name = names.length ? names.reduce((best, pair) => (pair[1] > best[1] ? pair : best))[0] : "";
    });
    if (route.path.length) {
      const last = route.path[route.path.length - 1];
      route.steps.push({ maneuver: "arrive", name: "", at: last, metres: 0, seconds: 0, signals: 0, crossings: 0 });
    }
    return route;
  }
}
