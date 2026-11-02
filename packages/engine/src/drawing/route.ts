import type { Pt, Rect, WireSegment } from "./types.js";
import { PITCH, snap } from "./wires.js";

/** Pieces of one net to join with wires; each is a set of points already connected. */
export interface NetToRoute {
  net: string;
  /** `group`: the part group the piece belongs to. */
  pieces: { points: Pt[]; segments: WireSegment[]; group?: string }[];
}

export interface RouteInput {
  /** Extent of the sheet; the router may use a margin around it. */
  width: number;
  height: number;
  /** Part bodies and symbols: wires never pass through. */
  obstacles: Rect[];
  /** Text: wires avoid it where they can. */
  text: Rect[];
  /** Wires already drawn, of any net. */
  fixed: WireSegment[];
  /** Connection points (pins, labels, power symbols); a net of undefined belongs to nothing. */
  points: { net?: string; at: Pt }[];
  nets: NetToRoute[];
}

const BEND = 4;
const CROSS = 12;
const SOFT = 1;
const WINDOW = 16;
const MARGIN = 6;
/** A connection whose best route crosses this many other wires is labelled instead. */
const MAX_CROSSINGS = 3;
/**
 * Nor may a connection between two groups run this many grid steps further than the distance
 * between its ends: it would wrap around a part. Within a group (a feedback loop round an
 * op-amp) a loop is the convention.
 */
const MAX_DETOUR = 8;

// Directions: 0 east, 1 north (y−), 2 west, 3 south (y+).
const DX = [1, 0, -1, 0];
const DY = [0, -1, 0, 1];
const isH = (d: number) => d === 0 || d === 2;

/** A binary min-heap of (cost, state), ties broken by state for determinism. */
class Heap {
  private c: number[] = [];
  private s: number[] = [];
  get size() {
    return this.c.length;
  }
  push(cost: number, state: number) {
    this.c.push(cost);
    this.s.push(state);
    let i = this.c.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.c[0] as number, this.s[0] as number];
    const lc = this.c.pop() as number;
    const ls = this.s.pop() as number;
    if (this.c.length > 0) {
      this.c[0] = lc;
      this.s[0] = ls;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.c.length && this.less(l, m)) m = l;
        if (r < this.c.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private less(a: number, b: number) {
    const ca = this.c[a] as number;
    const cb = this.c[b] as number;
    return ca < cb || (ca === cb && (this.s[a] as number) < (this.s[b] as number));
  }
  private swap(a: number, b: number) {
    [this.c[a], this.c[b]] = [this.c[b] as number, this.c[a] as number];
    [this.s[a], this.s[b]] = [this.s[b] as number, this.s[a] as number];
  }
}

/**
 * Routes each net's pieces together with orthogonal wires on the 2.54 mm pin grid, one net at
 * a time (smallest first) and one piece at a time (nearest first). Wires never overlap another
 * net's, cross one only straight through, and never end or bend on one; they keep out of part
 * bodies and away from text where they can. A net that cannot be completed, or only by crossing
 * three or more other wires on one connection, is left unrouted and reported, for the caller to
 * label instead.
 */
export function route(input: RouteInput): { segments: WireSegment[]; failed: string[] } {
  const W = Math.ceil(input.width / PITCH) + MARGIN;
  const H = Math.ceil(input.height / PITCH) + MARGIN;
  const N = W * H;
  const block = new Uint8Array(N);
  const soft = new Uint8Array(N);
  let hNet = new Int32Array(N).fill(-1);
  let vNet = new Int32Array(N).fill(-1);
  let node = new Int32Array(N).fill(-1);
  const FORBIDDEN = -2;

  const ids = new Map<string, number>();
  const idOf = (net: string) => {
    let id = ids.get(net);
    if (id === undefined) {
      id = ids.size;
      ids.set(net, id);
    }
    return id;
  };
  const gx = (v: number) => Math.round(v / PITCH);
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
  const cell = (p: Pt) => {
    const x = gx(p.x);
    const y = gx(p.y);
    return inside(x, y) ? y * W + x : -1;
  };
  const fillRect = (r: Rect, arr: Uint8Array, v: number) => {
    const x0 = Math.max(0, Math.ceil(r.x / PITCH - 1e-6));
    const x1 = Math.min(W - 1, Math.floor((r.x + r.w) / PITCH + 1e-6));
    const y0 = Math.max(0, Math.ceil(r.y / PITCH - 1e-6));
    const y1 = Math.min(H - 1, Math.floor((r.y + r.h) / PITCH + 1e-6));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) arr[y * W + x] = v;
  };
  for (const r of input.obstacles) fillRect(r, block, 1);
  for (const r of input.text) fillRect(r, soft, 1);

  const markNode = (c: number, id: number) => {
    if (c < 0) return;
    const was = node[c] as number;
    node[c] = was === -1 || was === id ? id : FORBIDDEN;
  };
  /** Records a wire: its run as occupied, its ends as connection points. */
  const markSeg = (s: WireSegment) => {
    const id = idOf(s.net);
    const ax = gx(s.a.x);
    const ay = gx(s.a.y);
    const bx = gx(s.b.x);
    const by = gx(s.b.y);
    markNode(cell(s.a), id);
    markNode(cell(s.b), id);
    if (ay === by) {
      for (let x = Math.min(ax, bx) + 1; x < Math.max(ax, bx); x++) {
        if (inside(x, ay)) hNet[ay * W + x] = id;
      }
    } else {
      for (let y = Math.min(ay, by) + 1; y < Math.max(ay, by); y++) {
        if (inside(ax, y)) vNet[y * W + ax] = id;
      }
    }
  };
  for (const p of input.points) markNode(cell(p.at), p.net === undefined ? FORBIDDEN : idOf(p.net));
  for (const s of input.fixed) markSeg(s);
  for (const n of input.nets) for (const p of n.pieces) for (const s of p.segments) markSeg(s);

  const cellsOf = (p: { points: Pt[]; segments: WireSegment[] }) => {
    const out = new Set<number>();
    for (const q of p.points) {
      const c = cell(q);
      if (c >= 0) out.add(c);
    }
    for (const s of p.segments) {
      const ax = gx(s.a.x);
      const ay = gx(s.a.y);
      const bx = gx(s.b.x);
      const by = gx(s.b.y);
      for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) {
        for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++)
          if (inside(x, y)) out.add(y * W + x);
      }
    }
    return out;
  };

  // Search state, reused across searches.
  const dist = new Float64Array(N * 4);
  const prev = new Int32Array(N * 4);
  const stamp = new Int32Array(N * 4);
  let gen = 0;

  /** A cell another net runs through: nothing of ours may end or turn there. */
  const occupiedByOther = (c: number, id: number) => {
    const h = hNet[c] as number;
    const v = vNet[c] as number;
    return (h !== -1 && h !== id) || (v !== -1 && v !== id);
  };

  const search = (
    id: number,
    from: Set<number>,
    to: Set<number>,
    window: number,
  ): number[] | undefined => {
    gen++;
    let x0 = W;
    let y0 = H;
    let x1 = 0;
    let y1 = 0;
    for (const c of [...from, ...to]) {
      const x = c % W;
      const y = (c - x) / W;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    x0 = Math.max(0, x0 - window);
    y0 = Math.max(0, y0 - window);
    x1 = Math.min(W - 1, x1 + window);
    y1 = Math.min(H - 1, y1 + window);
    const tx = [...to].map((c) => c % W);
    const ty = [...to].map((c) => Math.floor(c / W));
    const h = (c: number) => {
      const x = c % W;
      const y = (c - x) / W;
      let m = Number.POSITIVE_INFINITY;
      for (let i = 0; i < tx.length; i++) {
        m = Math.min(m, Math.abs(x - (tx[i] as number)) + Math.abs(y - (ty[i] as number)));
      }
      return m;
    };
    const heap = new Heap();
    for (const c of [...from].sort((a, b) => a - b)) {
      if (occupiedByOther(c, id)) continue;
      for (let d = 0; d < 4; d++) {
        const s = c * 4 + d;
        stamp[s] = gen;
        dist[s] = 0;
        prev[s] = -1;
        heap.push(h(c), s);
      }
    }
    while (heap.size > 0) {
      const [, s] = heap.pop();
      const c = s >> 2;
      const d = s & 3;
      const g = dist[s] as number;
      const across = isH(d) ? (vNet[c] as number) : (hNet[c] as number);
      const crossing = across !== -1 && across !== id;
      if (to.has(c) && !from.has(c) && !crossing && !occupiedByOther(c, id)) {
        const path: number[] = [];
        for (let t = s; t !== -1; t = prev[t] as number) path.push(t >> 2);
        return path.reverse();
      }
      if (to.has(c) && !from.has(c)) continue;
      const cx = c % W;
      const cy = (c - cx) / W;
      for (let e = 0; e < 4; e++) {
        if (e === (d + 2) % 4) continue;
        if (crossing && e !== d) continue;
        const nx = cx + (DX[e] as number);
        const ny = cy + (DY[e] as number);
        if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
        const n = ny * W + nx;
        const nd = node[n] as number;
        if (nd !== -1 && nd !== id) continue;
        if (block[n] && nd !== id) continue;
        const along = isH(e) ? (hNet[n] as number) : (vNet[n] as number);
        if (along !== -1 && along !== id) continue;
        const other = isH(e) ? (vNet[n] as number) : (hNet[n] as number);
        const cost =
          g +
          1 +
          (e !== d && from.has(c) && g === 0 ? 0 : e !== d ? BEND : 0) +
          (soft[n] ? SOFT : 0) +
          (other !== -1 && other !== id ? CROSS : 0);
        const t = n * 4 + e;
        if (stamp[t] === gen && (dist[t] as number) <= cost) continue;
        stamp[t] = gen;
        dist[t] = cost;
        prev[t] = s;
        heap.push(cost + h(n), t);
      }
    }
    return undefined;
  };

  /** How many other nets' wires a path runs across. */
  const crossings = (id: number, path: number[]) => {
    let n = 0;
    for (let i = 1; i + 1 < path.length; i++) {
      const c = path[i] as number;
      const across = Math.abs(c - (path[i - 1] as number)) === 1 ? vNet[c] : hNet[c];
      if (across !== -1 && across !== id) n++;
    }
    return n;
  };

  const segments: WireSegment[] = [];
  const failed: string[] = [];
  const toPt = (c: number): Pt => {
    const x = c % W;
    return { x: snap(x * PITCH), y: snap(((c - x) / W) * PITCH) };
  };
  const span = (n: NetToRoute) => {
    const pts = n.pieces.flatMap((p) => p.points);
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
  };
  const order = [...input.nets]
    .filter((n) => n.pieces.length > 1)
    .sort((a, b) => span(a) - span(b) || (a.net < b.net ? -1 : a.net > b.net ? 1 : 0));

  for (const n of order) {
    const id = idOf(n.net);
    const saved = { h: hNet.slice(), v: vNet.slice(), node: node.slice() };
    const mine: WireSegment[] = [];
    const first = n.pieces[0] as NetToRoute["pieces"][number];
    const tree = cellsOf(first);
    /** The group each cell of the tree came from. */
    const owner = new Map([...tree].map((c) => [c, first.group]));
    const rest = n.pieces.slice(1).map(cellsOf);
    const restGroups = n.pieces.slice(1).map((p) => p.group);
    let ok = true;
    while (rest.length > 0) {
      const targets = new Set(rest.flatMap((r) => [...r]));
      const path = search(id, tree, targets, WINDOW) ?? search(id, tree, targets, Math.max(W, H));
      if (!path || crossings(id, path) >= MAX_CROSSINGS) {
        ok = false;
        break;
      }
      const start = path[0] as number;
      const end = path[path.length - 1] as number;
      const hit = rest.findIndex((r) => r.has(end));
      const from = owner.get(start);
      const detour =
        path.length -
        1 -
        Math.abs((start % W) - (end % W)) -
        Math.abs(Math.floor(start / W) - Math.floor(end / W));
      if ((from === undefined || from !== restGroups[hit]) && detour > MAX_DETOUR) {
        ok = false;
        break;
      }
      // The polyline's corners: where the direction changes.
      const corners: number[] = [path[0] as number];
      for (let i = 1; i + 1 < path.length; i++) {
        const a = path[i - 1] as number;
        const b = path[i] as number;
        const c = path[i + 1] as number;
        if (b - a !== c - b) corners.push(b);
      }
      corners.push(path[path.length - 1] as number);
      for (let i = 0; i + 1 < corners.length; i++) {
        const seg = {
          net: n.net,
          a: toPt(corners[i] as number),
          b: toPt(corners[i + 1] as number),
        };
        mine.push(seg);
        markSeg(seg);
      }
      for (const c of path) {
        tree.add(c);
        if (!owner.has(c)) owner.set(c, from);
      }
      for (const c of rest[hit] as Set<number>) {
        tree.add(c);
        owner.set(c, restGroups[hit]);
      }
      rest.splice(hit, 1);
      restGroups.splice(hit, 1);
    }
    if (ok) segments.push(...mine);
    else {
      hNet = saved.h;
      vNet = saved.v;
      node = saved.node;
      failed.push(n.net);
    }
  }
  return { segments, failed };
}
