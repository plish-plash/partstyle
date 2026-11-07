import type { Ctx } from "../context.js";
import { CHAR, manhattan, pointKey, stepOf } from "../geometry.js";
import type { Direction, NetLabel, PlacedPin, Pt, Rect, Wire } from "../types.js";

// Directions: 0 east, 1 north, 2 west, 3 south.
const DX = [1, 0, -1, 0] as const;
const DY = [0, -1, 0, 1] as const;
const dirOf = (d: Direction) => d / 90;
const MARGIN = 10;
const SEARCH_LIMIT = 400_000;

class Heap {
  private cost: number[] = [];
  private state: number[] = [];
  get size() {
    return this.cost.length;
  }
  clear() {
    this.cost.length = 0;
    this.state.length = 0;
  }
  private less(i: number, j: number) {
    const a = this.cost[i] as number;
    const b = this.cost[j] as number;
    return a < b || (a === b && (this.state[i] as number) < (this.state[j] as number));
  }
  private swap(i: number, j: number) {
    const c = this.cost[i] as number;
    this.cost[i] = this.cost[j] as number;
    this.cost[j] = c;
    const s = this.state[i] as number;
    this.state[i] = this.state[j] as number;
    this.state[j] = s;
  }
  push(cost: number, state: number) {
    this.cost.push(cost);
    this.state.push(state);
    let i = this.cost.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.cost[0] as number, this.state[0] as number];
    const c = this.cost.pop() as number;
    const s = this.state.pop() as number;
    const n = this.cost.length;
    if (n > 0) {
      this.cost[0] = c;
      this.state[0] = s;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < n && this.less(l, m)) m = l;
        if (r < n && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}

export interface RouteRequest {
  /** Part bodies; wires stay out of their interiors. */
  bodies: Rect[];
  /** Power symbols, port labels and other things wires may not touch at all. */
  solids: Rect[];
  /** Every pin on the sheet. */
  pins: PlacedPin[];
  /** Positions of pins on anchors rather than two-terminal parts. */
  anchorPins: Set<string>;
  /** Power symbols on wires; a net's wires must reach them. */
  anchors: { net: string; at: Pt }[];
  prewires: Wire[][];
  /** Nets to connect, each with its terminals. */
  nets: { net: string; terminals: Pt[] }[];
  /** Short joins within a net that is otherwise not wired, such as a pin and its symbol. */
  links: { net: string; terminals: Pt[] }[];
}

export interface RouteResult {
  wires: Wire[];
  labels: NetLabel[];
  unrouted: { net: string; at: Pt }[];
  notes: { net: string; note: string }[];
}

/** A maze router on the pin grid that keeps every net's wires distinct. */
class Router {
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;
  private blocked: Uint8Array;
  private soft: Uint8Array;
  /** Net owning the edge from each point to its right, and to the point below. Zero is none. */
  private hEdge: Int32Array;
  private vEdge: Int32Array;
  /** Net owning a pin, corner or wire end at each point; -1 is a pin of no net. */
  private node: Int32Array;
  private claimed: { at: Pt; net: string }[] = [];
  private pinDir = new Map<number, number>();
  private netIds = new Map<string, number>();
  private netNames: string[] = [""];
  /** Point state, generation stamped so each search needs no clearing. */
  private gen: Int32Array;
  private gen0 = 0;
  private g: Float64Array;
  private parent: Int32Array;
  private heap = new Heap();
  readonly wires = new Map<string, Wire[]>();
  readonly fixed = new Map<string, Wire[]>();

  constructor(
    private req: RouteRequest,
    private bendCost: number,
    private crossCost: number,
    private nearCost: number,
    /** Extra cost of branching off a wire anywhere but straight on from a corner or end. */
    private forkCost: number,
  ) {
    let x0 = 0;
    let y0 = 0;
    let x1 = 0;
    let y1 = 0;
    const grow = (x: number, y: number) => {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    };
    for (const r of [...req.bodies, ...req.solids]) {
      grow(r.x, r.y);
      grow(r.x + r.w, r.y + r.h);
    }
    for (const p of req.pins) grow(p.at.x, p.at.y);
    for (const g of req.prewires) {
      for (const w of g) {
        grow(w.a.x, w.a.y);
        grow(w.b.x, w.b.y);
      }
    }
    this.x0 = Math.floor(x0) - MARGIN;
    this.y0 = Math.floor(y0) - MARGIN;
    this.w = Math.ceil(x1) + MARGIN - this.x0 + 1;
    this.h = Math.ceil(y1) + MARGIN - this.y0 + 1;
    const n = this.w * this.h;
    this.blocked = new Uint8Array(n);
    this.soft = new Uint8Array(n);
    this.hEdge = new Int32Array(n);
    this.vEdge = new Int32Array(n);
    this.node = new Int32Array(n);
    this.gen = new Int32Array(n * 4);
    this.g = new Float64Array(n * 4);
    this.parent = new Int32Array(n * 4);

    for (const r of req.bodies) this.stampBody(r);
    for (const r of req.solids) this.stampSolid(r);
    for (const p of req.pins) {
      const i = this.index(p.at);
      this.blocked[i] = 0;
      this.node[i] = p.net === undefined ? -1 : this.id(p.net);
      if (p.net !== undefined) this.pinDir.set(i, dirOf(p.outward));
    }
    for (const a of req.anchors) this.claim(a.at, a.net);
  }

  /** Reserves a point for a net: a symbol or label connects here, so no other wire may pass. */
  claim(at: Pt, net: string) {
    this.claimed.push({ at, net });
    const i = this.index(at);
    this.blocked[i] = 0;
    this.node[i] = this.id(net);
  }

  id(net: string): number {
    let id = this.netIds.get(net);
    if (id === undefined) {
      id = this.netNames.length;
      this.netNames.push(net);
      this.netIds.set(net, id);
    }
    return id;
  }

  index(p: Pt): number {
    return (p.y - this.y0) * this.w + (p.x - this.x0);
  }

  private point(i: number): Pt {
    return { x: (i % this.w) + this.x0, y: Math.floor(i / this.w) + this.y0 };
  }

  private inGrid(x: number, y: number) {
    return x >= this.x0 && y >= this.y0 && x < this.x0 + this.w && y < this.y0 + this.h;
  }

  private stampBody(r: Rect) {
    const x0 = Math.floor(r.x);
    const y0 = Math.floor(r.y);
    const x1 = Math.ceil(r.x + r.w);
    const y1 = Math.ceil(r.y + r.h);
    for (let y = y0 - 1; y <= y1 + 1; y++) {
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        if (!this.inGrid(x, y)) continue;
        const i = this.index({ x, y });
        if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) this.blocked[i] = 1;
        else this.soft[i] = 1;
      }
    }
  }

  private stampSolid(r: Rect) {
    for (let y = Math.ceil(r.y); y <= Math.floor(r.y + r.h); y++) {
      for (let x = Math.ceil(r.x); x <= Math.floor(r.x + r.w); x++) {
        if (this.inGrid(x, y)) this.blocked[this.index({ x, y })] = 1;
      }
    }
  }

  block(r: Rect) {
    this.stampSolid(r);
  }

  /** Other net's wire running straight through `i` perpendicular to direction `d`. */
  private crossed(i: number, d: number, net: number): boolean {
    const vertical = d === 0 || d === 2;
    if (vertical) {
      const up = i - this.w >= 0 ? (this.vEdge[i - this.w] as number) : 0;
      const dn = this.vEdge[i] as number;
      return (up !== 0 && up !== net) || (dn !== 0 && dn !== net);
    }
    const lf = this.hEdge[i - 1] as number;
    const rt = this.hEdge[i] as number;
    return (lf !== 0 && lf !== net) || (rt !== 0 && rt !== net);
  }

  private edgeOwner(i: number, d: number): number {
    if (d === 0) return this.hEdge[i] as number;
    if (d === 2) return this.hEdge[i - 1] as number;
    if (d === 3) return this.vEdge[i] as number;
    return this.vEdge[i - this.w] as number;
  }

  private setEdge(i: number, d: number, net: number) {
    if (d === 0) this.hEdge[i] = net;
    else if (d === 2) this.hEdge[i - 1] = net;
    else if (d === 3) this.vEdge[i] = net;
    else this.vEdge[i - this.w] = net;
  }

  /** Cheapest path from any start to `goal`, or undefined if there is none. */
  private search(net: number, starts: number[], goal: number): number[] | undefined {
    this.gen0++;
    const gen = this.gen0;
    const heap = this.heap;
    heap.clear();
    const goalPt = this.point(goal);
    const h = (i: number) => manhattan(this.point(i), goalPt);
    const stepW = this.w;
    const offset = [1, -stepW, -1, stepW] as const;
    const goalDir = this.pinDir.get(goal);

    for (const s of starts) {
      // Branching where another net crosses would read as a connection to it.
      if (this.crossed(s, 0, net) || this.crossed(s, 1, net)) continue;
      const pd = this.pinDir.get(s);
      const wired = this.isWired(s);
      for (let d = 0; d < 4; d++) {
        // A pin not yet wired leaves straight out; turning off it counts as a bend.
        const extra = wired
          ? this.branchCost(s, d)
          : pd !== undefined && d !== pd
            ? this.bendCost
            : 0;
        const state = s * 4 + d;
        this.gen[state] = gen;
        this.g[state] = extra;
        this.parent[state] = -1;
        heap.push(extra + h(s), state);
      }
    }

    let pops = 0;
    let best = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    while (heap.size > 0 && pops++ < SEARCH_LIMIT) {
      const [f, state] = heap.pop();
      if (f >= bestCost) break;
      const i = Math.floor(state / 4);
      const d = state % 4;
      const cost = this.g[state] as number;
      if (i === goal) {
        // Arriving along a pin's axis costs nothing extra.
        const extra = goalDir !== undefined && (d + 2) % 4 !== goalDir ? this.bendCost : 0;
        if (cost + extra < bestCost) {
          bestCost = cost + extra;
          best = state;
        }
        continue;
      }
      const pt = this.point(i);
      for (let nd = 0; nd < 4; nd++) {
        if (this.parent[state] === -1 ? nd !== d : (nd + 2) % 4 === d) continue;
        const nx = pt.x + (DX[nd] as number);
        const ny = pt.y + (DY[nd] as number);
        if (!this.inGrid(nx, ny)) continue;
        const q = i + (offset[nd] as number);
        if (this.blocked[q]) continue;
        const owner = this.edgeOwner(i, nd);
        if (owner !== 0 && owner !== net) continue;
        const nodeQ = this.node[q] as number;
        if (nodeQ !== 0 && nodeQ !== net) continue;
        let step = 1 + (this.soft[q] as number) * this.nearCost;
        if (nd !== d) {
          // Never turn on another net's wire: that would join or touch it.
          if (this.parent[state] !== -1 && this.crossed(i, nd, net)) continue;
          if (this.parent[state] !== -1 || this.pinDir.has(i)) step += this.bendCost;
          if (this.crossed(i, d, net)) continue;
        }
        if (this.crossed(q, nd, net)) {
          if (q === goal) continue;
          step += this.crossCost;
        }
        const ns = q * 4 + nd;
        const c = cost + step;
        if (this.gen[ns] === gen && (this.g[ns] as number) <= c) continue;
        this.gen[ns] = gen;
        this.g[ns] = c;
        this.parent[ns] = state;
        heap.push(c + h(q), ns);
      }
    }
    if (best < 0) return undefined;
    const path: number[] = [];
    for (let s = best; s !== -1; s = this.parent[s] as number) path.push(Math.floor(s / 4));
    return path.reverse();
  }

  /** Carrying on straight from a corner or a wire's end keeps a line going; anything else forks. */
  private branchCost(i: number, d: number): number {
    const incoming = [0, 1, 2, 3].filter((e) => this.edgeOwner(i, e) !== 0);
    const corner =
      incoming.length === 2 && (incoming[0] as number) % 2 !== (incoming[1] as number) % 2;
    const end = incoming.length === 1;
    return (corner || end) && incoming.includes((d + 2) % 4) ? 0 : this.forkCost;
  }

  private isWired(i: number): boolean {
    return (
      (this.hEdge[i] as number) !== 0 ||
      (this.hEdge[i - 1] as number) !== 0 ||
      (this.vEdge[i] as number) !== 0 ||
      (i >= this.w && (this.vEdge[i - this.w] as number) !== 0)
    );
  }

  private commit(net: number, path: number[]): Wire[] {
    const out: Wire[] = [];
    const name = this.netNames[net] as string;
    let start = path[0] as number;
    let dir = -1;
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1] as number;
      const b = path[k] as number;
      const d = b - a === 1 ? 0 : b - a === -1 ? 2 : b > a ? 3 : 1;
      this.setEdge(a, d, net);
      if (d !== dir && dir !== -1) {
        out.push({ net: name, a: this.point(start), b: this.point(a) });
        start = a;
        this.node[a] = net;
      }
      dir = d;
    }
    const end = path.at(-1) as number;
    if (end !== start) out.push({ net: name, a: this.point(start), b: this.point(end) });
    this.node[path[0] as number] = net;
    this.node[end] = net;
    return out;
  }

  /** Checks a group of known wires and commits them, or leaves them for the search. */
  commitFixed(group: Wire[]): boolean {
    const name = group[0]?.net as string;
    const net = this.id(name);
    for (const w of group) {
      const [dx, dy] = [Math.sign(w.b.x - w.a.x), Math.sign(w.b.y - w.a.y)];
      const d = dx === 1 ? 0 : dx === -1 ? 2 : dy === 1 ? 3 : 1;
      const n = Math.abs(w.a.x - w.b.x) + Math.abs(w.a.y - w.b.y);
      let i = this.index(w.a);
      const step = dx + dy * this.w;
      for (let k = 0; k <= n; k++) {
        if (this.blocked[i]) return false;
        const nodeHere = this.node[i] as number;
        if (nodeHere !== 0 && nodeHere !== net) return false;
        if (k < n) {
          const owner = this.edgeOwner(i, d);
          if (owner !== 0 && owner !== net) return false;
        }
        // A wire may cross another only partway along, never begin or end on it.
        if ((k === 0 || k === n) && this.crossed(i, d, net)) return false;
        i += step;
      }
    }
    for (const w of group) {
      const [dx, dy] = [Math.sign(w.b.x - w.a.x), Math.sign(w.b.y - w.a.y)];
      const d = dx === 1 ? 0 : dx === -1 ? 2 : dy === 1 ? 3 : 1;
      const n = Math.abs(w.a.x - w.b.x) + Math.abs(w.a.y - w.b.y);
      let i = this.index(w.a);
      const step = dx + dy * this.w;
      this.node[i] = net;
      for (let k = 0; k < n; k++) {
        this.setEdge(i, d, net);
        i += step;
      }
      this.node[i] = net;
    }
    const list = this.fixed.get(name) ?? [];
    list.push(...group);
    this.fixed.set(name, list);
    return true;
  }

  private restamp() {
    for (const p of this.req.pins) {
      this.node[this.index(p.at)] = p.net === undefined ? -1 : this.id(p.net);
    }
    for (const c of this.claimed) this.node[this.index(c.at)] = this.id(c.net);
  }

  private clearWires(list: Wire[]) {
    for (const w of list) {
      const [dx, dy] = [Math.sign(w.b.x - w.a.x), Math.sign(w.b.y - w.a.y)];
      const d = dx === 1 ? 0 : dx === -1 ? 2 : dy === 1 ? 3 : 1;
      const n = Math.abs(w.a.x - w.b.x) + Math.abs(w.a.y - w.b.y);
      let i = this.index(w.a);
      const step = dx + dy * this.w;
      this.node[i] = 0;
      for (let k = 0; k < n; k++) {
        this.setEdge(i, d, 0);
        i += step;
        this.node[i] = 0;
      }
    }
  }

  ripUp(net: string) {
    this.clearWires(this.wires.get(net) ?? []);
    this.wires.delete(net);
    this.restamp();
    for (const [name, list] of this.fixed) {
      const id = this.id(name);
      for (const w of list) {
        this.node[this.index(w.a)] = id;
        this.node[this.index(w.b)] = id;
      }
    }
  }

  /** Drops a net entirely, known wires included. */
  clearNet(net: string) {
    this.clearWires(this.fixed.get(net) ?? []);
    this.fixed.delete(net);
    this.ripUp(net);
  }

  /** Puts back wires saved from an earlier attempt. */
  restore(net: string, list: Wire[]) {
    const id = this.id(net);
    for (const w of list) {
      const [dx, dy] = [Math.sign(w.b.x - w.a.x), Math.sign(w.b.y - w.a.y)];
      const d = dx === 1 ? 0 : dx === -1 ? 2 : dy === 1 ? 3 : 1;
      const n = Math.abs(w.a.x - w.b.x) + Math.abs(w.a.y - w.b.y);
      let i = this.index(w.a);
      const step = dx + dy * this.w;
      this.node[i] = id;
      for (let k = 0; k < n; k++) {
        this.setEdge(i, d, id);
        i += step;
      }
      this.node[i] = id;
    }
    this.wires.set(net, list);
  }

  /** Connects a set of terminals. Returns the terminals that stayed unconnected. */
  connect(net: string, terminals: Pt[]): Pt[] {
    const id = this.id(net);
    const lists = [...(this.fixed.get(net) ?? []), ...(this.wires.get(net) ?? [])];
    // Pieces already joined, as sets of grid points.
    const parent = new Map<number, number>();
    const find = (a: number): number => {
      const p = parent.get(a);
      if (p === undefined || p === a) return a;
      const r = find(p);
      parent.set(a, r);
      return r;
    };
    const union = (a: number, b: number) => {
      parent.set(find(a), find(b));
    };
    const walk = (w: Wire) => {
      const [dx, dy] = [Math.sign(w.b.x - w.a.x), Math.sign(w.b.y - w.a.y)];
      const n = Math.abs(w.a.x - w.b.x) + Math.abs(w.a.y - w.b.y);
      let i = this.index(w.a);
      const step = dx + dy * this.w;
      const first = i;
      for (let k = 0; k <= n; k++) {
        union(i, first);
        i += step;
      }
    };
    for (const w of lists) walk(w);
    const seen = new Set<string>();
    const terms: number[] = [];
    for (const t of terminals) {
      const key = pointKey(t);
      if (seen.has(key)) continue;
      seen.add(key);
      const i = this.index(t);
      terms.push(i);
      if (!parent.has(i)) parent.set(i, i);
    }
    const failed: Pt[] = [];
    const out = this.wires.get(net) ?? [];
    for (;;) {
      const groups = new Map<number, number[]>();
      for (const i of parent.keys()) {
        const r = find(i);
        const g = groups.get(r) ?? [];
        g.push(i);
        groups.set(r, g);
      }
      const liveRoots = new Set(terms.map(find));
      const failedRoots = new Set(failed.map((p) => find(this.index(p))));
      const open = [...liveRoots].filter((r) => !failedRoots.has(r));
      if (open.length <= 1) break;
      const rootA = find(terms[0] as number);
      const tree = groups.get(rootA) as number[];
      let bestDist = Number.POSITIVE_INFINITY;
      let goal = -1;
      for (const r of open) {
        if (r === rootA) continue;
        for (const q of groups.get(r) as number[]) {
          if (!terms.includes(q)) continue;
          const pq = this.point(q);
          for (const s of tree) {
            const dist = manhattan(this.point(s), pq);
            if (dist < bestDist) {
              bestDist = dist;
              goal = q;
            }
          }
        }
      }
      if (goal < 0) break;
      const path = this.search(id, tree, goal);
      if (!path) {
        failed.push(this.point(goal));
        continue;
      }
      out.push(...this.commit(id, path));
      for (const p of path) {
        if (!parent.has(p)) parent.set(p, p);
        union(p, goal);
      }
      union(goal, rootA);
    }
    this.wires.set(net, out);
    return failed;
  }

  /** All wires of a net, known and routed. */
  of(net: string): Wire[] {
    return [...(this.fixed.get(net) ?? []), ...(this.wires.get(net) ?? [])];
  }

  all(): Wire[] {
    const out: Wire[] = [];
    for (const list of this.fixed.values()) out.push(...list);
    for (const list of this.wires.values()) out.push(...list);
    return out;
  }
}

/** Crossings of different nets, counted per net. */
export function crossingsByNet(wires: Wire[], exempt: (net: string) => boolean) {
  const counts = new Map<string, number>();
  const hs = wires.filter((w) => w.a.y === w.b.y && w.a.x !== w.b.x);
  const vs = wires.filter((w) => w.a.x === w.b.x && w.a.y !== w.b.y);
  for (const h of hs) {
    const x0 = Math.min(h.a.x, h.b.x);
    const x1 = Math.max(h.a.x, h.b.x);
    for (const v of vs) {
      if (v.net === h.net || exempt(v.net) || exempt(h.net)) continue;
      const y0 = Math.min(v.a.y, v.b.y);
      const y1 = Math.max(v.a.y, v.b.y);
      if (v.a.x > x0 && v.a.x < x1 && h.a.y > y0 && h.a.y < y1) {
        counts.set(h.net, (counts.get(h.net) ?? 0) + 1);
        counts.set(v.net, (counts.get(v.net) ?? 0) + 1);
      }
    }
  }
  return counts;
}

export function route(ctx: Ctx, req: RouteRequest, isRailWire: (net: string) => boolean) {
  const costs = ctx.rules.on("route-costs");
  const bend = costs ? ctx.rules.num("route-costs", "bend") : 1;
  const cross = costs ? ctx.rules.num("route-costs", "crossing") : 0;
  const near = costs ? ctx.rules.num("route-costs", "clearance") : 0;
  const passes = costs ? ctx.rules.num("route-costs", "ripupPasses") : 0;
  const fork = costs ? ctx.rules.num("route-costs", "fork") : 0;
  const r = new Router(req, bend, cross, near, fork);
  // A power wire crossing pin wires to reach its symbol is expected, so it never counts.
  const isRail = (net: string) => ctx.role(net) !== "signal";

  for (const group of req.prewires) if (group.length > 0) r.commitFixed(group);

  const span = (t: Pt[]) => {
    const xs = t.map((p) => p.x);
    const ys = t.map((p) => p.y);
    return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
  };
  const order = [...req.nets].sort((a, b) => span(a.terminals) - span(b.terminals));
  const failed = new Map<string, Pt[]>();
  for (const n of order) {
    const f = r.connect(n.net, n.terminals);
    if (f.length > 0) failed.set(n.net, f);
  }

  const strandedPins: Pt[] = [];
  for (const n of req.links) {
    if (r.connect(n.net, n.terminals).length > 0) strandedPins.push(n.terminals[0] as Pt);
  }

  // Rip up the most-crossed nets and try them again with everything else in place.
  for (let pass = 0; pass < passes; pass++) {
    const counts = crossingsByNet(r.all(), isRail);
    const worst = order
      .filter((n) => (counts.get(n.net) ?? 0) > 0 && (r.wires.get(n.net)?.length ?? 0) > 0)
      .sort((a, b) => (counts.get(b.net) ?? 0) - (counts.get(a.net) ?? 0));
    if (worst.length === 0) break;
    for (const n of worst) {
      const before = crossingsByNet(r.all(), isRail).get(n.net) ?? 0;
      const saved = r.wires.get(n.net) ?? [];
      r.ripUp(n.net);
      const f = r.connect(n.net, n.terminals);
      const after = crossingsByNet(r.all(), isRail).get(n.net) ?? 0;
      if (f.length > 0 || after >= before) {
        r.ripUp(n.net);
        r.restore(n.net, saved);
      }
    }
  }

  const labels: NetLabel[] = [];
  const notes: RouteResult["notes"] = [];

  if (ctx.rules.on("label-fallback")) {
    const limit = ctx.rules.num("label-fallback", "crossingLimit");
    const detourLimit = ctx.rules.num("label-fallback", "detourLimit");
    /** How much further a net's wires run than the box around its pins calls for. */
    const detour = (n: RouteRequest["nets"][number]) => {
      const length = r.of(n.net).reduce((s, w) => s + manhattan(w.a, w.b), 0);
      return length - span(n.terminals) * Math.max(1, n.terminals.length / 2);
    };
    const done = new Set<string>();
    const convert = (net: string, why: string) => {
      const n = req.nets.find((x) => x.net === net);
      if (!n) return;
      done.add(net);
      failed.delete(net);
      r.clearNet(net);
      const pins = req.pins.filter(
        (p) => p.net === net && n.terminals.some((t) => t.x === p.at.x && t.y === p.at.y),
      );
      const queue = splitPieces(pins, req.anchorPins);
      while (queue.length > 0) {
        const piece = queue.shift() as PlacedPin[];
        // A piece with wires of its own routes first, so the label cannot bend them.
        if (piece.length > 1) {
          const missed = r.connect(
            net,
            piece.map((p) => p.at),
          );
          const own = r.wires.get(net) ?? [];
          const tee = teeLabel(r, net, own, piece[0] as PlacedPin, req, labels);
          r.fixed.set(net, r.of(net));
          r.wires.delete(net);
          if (tee) {
            labels.push(tee);
            for (const p of piece.filter((x) =>
              missed.some((m) => m.x === x.at.x && m.y === x.at.y),
            )) {
              queue.push([p]);
            }
            continue;
          }
        }
        const label = placeLabel(net, piece, req, labels, r.all());
        if (!label) continue;
        labels.push(label.label);
        if (label.stub) {
          r.block(label.label.box);
          r.claim(label.label.at, net);
          r.commitFixed(label.stub);
        }
        const missed = r.connect(net, [...piece.map((p) => p.at), label.label.at]);
        r.fixed.set(net, r.of(net));
        r.wires.delete(net);
        // A stub that found no way out leaves the label on the pin.
        const stranded = missed.some((m) => m.x === label.label.at.x && m.y === label.label.at.y);
        if (stranded) label.label.at = (piece[0] as PlacedPin).at;
        // A pin the piece cannot reach gets a label of its own.
        const alone = piece.filter((p) => missed.some((m) => m.x === p.at.x && m.y === p.at.y));
        for (const p of alone) queue.push([p]);
      }
      notes.push({ net, note: why });
    };
    for (let guard = 0; guard < req.nets.length + 2; guard++) {
      const counts = crossingsByNet(r.all(), isRail);
      const candidates = [...counts.entries()]
        .filter(([net, c]) => {
          return c >= limit && !done.has(net) && ctx.role(net) === "signal" && !isRailWire(net);
        })
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      const wandering = req.nets.find(
        (n) =>
          !done.has(n.net) &&
          ctx.role(n.net) === "signal" &&
          !isRailWire(n.net) &&
          detour(n) > detourLimit,
      );
      const next =
        [...failed.keys()].find((net) => !done.has(net)) ?? candidates[0]?.[0] ?? wandering?.net;
      if (next === undefined) break;
      const c = counts.get(next) ?? 0;
      const why = failed.has(next)
        ? "no route found"
        : c >= limit
          ? `would cross ${c} wires`
          : "would take a long way round";
      convert(next, why);
    }
  }

  // A rail pin that cannot reach its symbol still connects by name.
  for (const at of strandedPins) {
    const pin = req.pins.find((p) => p.at.x === at.x && p.at.y === at.y && p.net !== undefined);
    if (!pin) continue;
    const net = pin.net as string;
    const label = placeLabel(net, [pin], req, labels, r.all());
    if (!label) continue;
    labels.push(label.label);
    if (label.stub) {
      r.block(label.label.box);
      r.claim(label.label.at, net);
      if (!r.commitFixed(label.stub)) label.label.at = pin.at;
    }
  }

  const unrouted: RouteResult["unrouted"] = [];
  for (const [net, pts] of failed) for (const at of pts) unrouted.push({ net, at });
  return { wires: r.all(), labels, unrouted, notes } satisfies RouteResult;
}

/**
 * Splits a net for labelling. Each anchor pin keeps a piece of its own; two-terminal parts stay
 * with the nearest anchor pin.
 */
function splitPieces(pins: PlacedPin[], anchored: Set<string>): PlacedPin[][] {
  const isAnchorPin = (p: PlacedPin) => anchored.has(pointKey(p.at));
  const leaders = pins.filter(isAnchorPin);
  if (leaders.length <= 1) return [pins];
  const pieces = leaders.map((p) => [p]);
  for (const p of pins) {
    if (isAnchorPin(p)) continue;
    let best = 0;
    let dist = Number.POSITIVE_INFINITY;
    leaders.forEach((l, i) => {
      const d = manhattan(l.at, p.at);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    pieces[best]?.push(p);
  }
  return pieces;
}

/**
 * Hangs a label off a piece's wires on a short vertical stub, as close to `near` as it fits, so
 * the wire keeps its straight run and the text stays clear of it.
 */
function teeLabel(
  r: Router,
  net: string,
  wires: Wire[],
  near: PlacedPin,
  req: RouteRequest,
  labels: NetLabel[],
): NetLabel | undefined {
  const points: Pt[] = [];
  for (const w of wires) {
    if (w.a.y !== w.b.y) continue;
    const x0 = Math.min(w.a.x, w.b.x);
    const x1 = Math.max(w.a.x, w.b.x);
    for (let x = x0; x <= x1; x++) points.push({ x, y: w.a.y });
  }
  points.sort((a, b) => manhattan(a, near.at) - manhattan(b, near.at) || a.x - b.x || a.y - b.y);
  const all = r.all();
  for (const p of points) {
    for (const dy of [-1, 1]) {
      for (const length of [1, 2]) {
        const at = { x: p.x, y: p.y + dy * length };
        for (const way of [180, 0] as const) {
          const box = labelBox(net, at, way);
          if (labelHits(box, req, labels, all)) continue;
          if (!r.commitFixed([{ net, a: p, b: at }])) continue;
          r.block(box);
          r.claim(at, net);
          return { net, text: net, kind: "local", at, outward: way, box };
        }
      }
    }
  }
  return undefined;
}

function labelBox(net: string, at: Pt, d: Direction): Rect {
  const length = Math.ceil(net.length * CHAR) + 1;
  if (d === 0) return { x: at.x, y: at.y - 0.5, w: length, h: 1 };
  if (d === 180) return { x: at.x - length, y: at.y - 0.5, w: length, h: 1 };
  if (d === 90) return { x: at.x - 0.5, y: at.y - length, w: 1, h: length };
  return { x: at.x - 0.5, y: at.y, w: 1, h: length };
}

function labelHits(r: Rect, req: RouteRequest, labels: NetLabel[], wires: Wire[]): boolean {
  const overlaps = (o: Rect) =>
    r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h;
  if (req.bodies.some(overlaps) || req.solids.some(overlaps)) return true;
  if (labels.some((l) => overlaps(l.box))) return true;
  return wires.some((w) => {
    const x0 = Math.min(w.a.x, w.b.x);
    const x1 = Math.max(w.a.x, w.b.x);
    const y0 = Math.min(w.a.y, w.b.y);
    const y1 = Math.max(w.a.y, w.b.y);
    return x0 <= r.x + r.w && x1 >= r.x && y0 <= r.y + r.h && y1 >= r.y;
  });
}

function placeLabel(
  net: string,
  piece: PlacedPin[],
  req: RouteRequest,
  labels: NetLabel[],
  wires: Wire[],
): { label: NetLabel; stub?: Wire[] } | undefined {
  const leader = piece[0];
  if (!leader) return undefined;
  const boxFor = (at: Pt, d: Direction) => labelBox(net, at, d);
  const hit = (r: Rect) => labelHits(r, req, labels, wires);
  // A pin on a part's top or bottom takes a short step out, then runs sideways past the part.
  if (leader.outward === 90 || leader.outward === 270) {
    const body = req.bodies.find(
      (b) =>
        leader.at.x >= b.x &&
        leader.at.x <= b.x + b.w &&
        leader.at.y >= b.y &&
        leader.at.y <= b.y + b.h,
    );
    if (body) {
      const dy = leader.outward === 90 ? -1 : 1;
      const rightNearer = body.x + body.w - leader.at.x <= leader.at.x - body.x;
      const sides = rightNearer ? [1, -1] : [-1, 1];
      for (let out = 1; out <= 8; out++) {
        for (const side of sides) {
          const y = leader.at.y + dy * out;
          const at = { x: side === 1 ? body.x + body.w + 1 : body.x - 1, y };
          const way: Direction = side === 1 ? 0 : 180;
          const box = boxFor(at, way);
          if (hit(box)) continue;
          return {
            label: { net, text: net, kind: "local", at, outward: way, box },
            stub: [
              { net, a: leader.at, b: { x: leader.at.x, y } },
              { net, a: { x: leader.at.x, y }, b: at },
            ],
          };
        }
      }
    }
  }
  const step = stepOf(leader.outward);
  for (let k = 1; k <= 12; k++) {
    const at = { x: leader.at.x + step.x * k, y: leader.at.y + step.y * k };
    const box = boxFor(at, leader.outward);
    if (!hit(box)) {
      return {
        label: { net, text: net, kind: "local", at, outward: leader.outward, box },
        stub: [{ net, a: leader.at, b: at }],
      };
    }
  }
  // Nowhere clear: sit on the pin itself. The text may crowd its neighbours, but it connects.
  return {
    label: {
      net,
      text: net,
      kind: "local",
      at: leader.at,
      outward: leader.outward,
      box: boxFor(leader.at, leader.outward),
    },
  };
}
