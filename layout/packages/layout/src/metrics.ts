import { manhattan, pointKey, rectsOverlap, samePoint, segmentEntersRect } from "./geometry.js";
import type { LayoutInput, LayoutResult, PlacedPart, Pt, Wire } from "./types.js";

export interface Metrics {
  /** Pins of one net that are not joined. */
  opens: number;
  /** Different nets joined by the drawing. */
  shorts: number;
  overlaps: number;
  wiresThroughParts: number;
  unrouted: number;
  offGrid: number;
  /** Sum of the failures above. Anything but zero is a broken drawing. */
  hardFailures: number;

  /** Crossings between signal wires. */
  crossings: number;
  /** Power wires and label stubs crossing pin wires. These are expected and not penalized. */
  railCrossings: number;
  /** Total length of wire on rails. */
  powerWire: number;
  bends: number;
  wireLength: number;
  /** Share of two-pin nets drawn as one straight wire. */
  straightPercent: number;
  labels: number;
  signalBackwards: number;
  powerWrongWay: number;
  shuntMisplaced: number;
  width: number;
  height: number;
}

export interface MetricIssue {
  metric: keyof Metrics;
  message: string;
}

const wirePoints = (w: Wire): Pt[] => {
  const out: Pt[] = [];
  const dx = Math.sign(w.b.x - w.a.x);
  const dy = Math.sign(w.b.y - w.a.y);
  const n = Math.abs(w.a.x - w.b.x) + Math.abs(w.a.y - w.b.y);
  for (let i = 0; i <= n; i++) out.push({ x: w.a.x + dx * i, y: w.a.y + dy * i });
  return out;
};

class Dsu {
  private p = new Map<string, string>();
  find(a: string): string {
    const q = this.p.get(a);
    if (q === undefined) {
      this.p.set(a, a);
      return a;
    }
    if (q === a) return a;
    const r = this.find(q);
    this.p.set(a, r);
    return r;
  }
  union(a: string, b: string) {
    this.p.set(this.find(a), this.find(b));
  }
}

/** Re-derives connectivity from the drawing alone: wires, junctions, symbols, labels and pins. */
function checkConnectivity(input: LayoutInput, r: LayoutResult, issues: MetricIssue[]) {
  const dsu = new Dsu();
  const interior = new Map<string, string[]>();
  const ends = new Set<string>();
  r.wires.forEach((w, i) => {
    const id = `w${i}`;
    const a = pointKey(w.a);
    const b = pointKey(w.b);
    dsu.union(id, `p${a}`);
    dsu.union(id, `p${b}`);
    ends.add(a);
    ends.add(b);
    for (const p of wirePoints(w)) {
      const k = pointKey(p);
      if (k === a || k === b) continue;
      const list = interior.get(k) ?? [];
      list.push(id);
      interior.set(k, list);
    }
  });
  // A wire end on another wire joins it; two wires merely crossing do not.
  for (const k of ends) for (const id of interior.get(k) ?? []) dsu.union(id, `p${k}`);
  for (const j of r.junctions) {
    const k = pointKey(j.at);
    for (const id of interior.get(k) ?? []) dsu.union(id, `p${k}`);
  }
  for (const part of r.parts) {
    for (const pin of part.pins) {
      const k = pointKey(pin.at);
      for (const id of interior.get(k) ?? []) dsu.union(id, `p${k}`);
      if (pin.net !== undefined) dsu.union(`pin:${part.id}:${pin.id}`, `p${k}`);
    }
  }
  for (const s of r.power) {
    const k = pointKey(s.at);
    for (const id of interior.get(k) ?? []) dsu.union(id, `p${k}`);
    dsu.union(`name:${s.name}`, `p${k}`);
  }
  for (const l of r.labels) {
    const k = pointKey(l.at);
    for (const id of interior.get(k) ?? []) dsu.union(id, `p${k}`);
    dsu.union(`name:${l.text}`, `p${k}`);
  }

  let opens = 0;
  const netOfRoot = new Map<string, string>();
  const reported = new Set<string>();
  let shorts = 0;
  for (const net of input.nets) {
    const roots = new Map<string, string>();
    for (const part of r.parts) {
      for (const pin of part.pins) {
        if (pin.net !== net.name) continue;
        const root = dsu.find(`pin:${part.id}:${pin.id}`);
        if (!roots.has(root)) roots.set(root, `${part.ref}.${pin.name}`);
      }
    }
    if (roots.size > 1) {
      opens += roots.size - 1;
      issues.push({
        metric: "opens",
        message: `net ${net.name} is split: ${[...roots.values()].join(", ")}`,
      });
    }
    for (const root of roots.keys()) {
      const other = netOfRoot.get(root);
      if (other !== undefined && other !== net.name) {
        const key = [other, net.name].sort().join("|");
        if (!reported.has(key)) {
          reported.add(key);
          shorts++;
          issues.push({ metric: "shorts", message: `nets ${other} and ${net.name} touch` });
        }
      }
      netOfRoot.set(root, net.name);
    }
  }
  return { opens, shorts };
}

function isOnGrid(r: LayoutResult): number {
  const off = (p: Pt) => (Number.isInteger(p.x) && Number.isInteger(p.y) ? 0 : 1);
  let n = 0;
  for (const part of r.parts) for (const pin of part.pins) n += off(pin.at);
  for (const w of r.wires) n += off(w.a) + off(w.b);
  for (const s of r.power) n += off(s.at);
  return n;
}

const isTwoTerminal = (p: PlacedPart) => p.pins.length === 2;

export function measure(
  input: LayoutInput,
  r: LayoutResult,
): { metrics: Metrics; issues: MetricIssue[] } {
  const issues: MetricIssue[] = [];
  const { opens, shorts } = checkConnectivity(input, r, issues);

  let overlaps = 0;
  for (let i = 0; i < r.parts.length; i++) {
    for (let j = i + 1; j < r.parts.length; j++) {
      const a = r.parts[i] as PlacedPart;
      const b = r.parts[j] as PlacedPart;
      if (rectsOverlap(a.box, b.box)) {
        overlaps++;
        issues.push({ metric: "overlaps", message: `${a.ref} overlaps ${b.ref}` });
      }
    }
    for (const s of r.power) {
      const part = r.parts[i] as PlacedPart;
      if (rectsOverlap(part.box, s.box)) {
        overlaps++;
        issues.push({ metric: "overlaps", message: `${s.name} symbol overlaps ${part.ref}` });
      }
    }
  }

  let wiresThroughParts = 0;
  for (const w of r.wires) {
    for (const part of r.parts) {
      if (segmentEntersRect(w.a, w.b, part.box)) {
        wiresThroughParts++;
        issues.push({
          metric: "wiresThroughParts",
          message: `a wire of ${w.net} runs through ${part.ref}`,
        });
      }
    }
  }

  // Crossings: a horizontal and vertical wire of different nets meeting away from their ends.
  const hs = r.wires.filter((w) => w.a.y === w.b.y);
  const vs = r.wires.filter((w) => w.a.x === w.b.x);
  const isRail = (net: string) => input.nets.find((n) => n.name === net)?.role !== "signal";
  const stubEnds = new Set(r.labels.filter((l) => l.kind === "local").map((l) => pointKey(l.at)));
  const isStub = (w: Wire) => stubEnds.has(pointKey(w.a)) || stubEnds.has(pointKey(w.b));
  let crossings = 0;
  let railCrossings = 0;
  for (const h of hs) {
    const x0 = Math.min(h.a.x, h.b.x);
    const x1 = Math.max(h.a.x, h.b.x);
    for (const v of vs) {
      if (v.net === h.net) continue;
      const y0 = Math.min(v.a.y, v.b.y);
      const y1 = Math.max(v.a.y, v.b.y);
      if (v.a.x > x0 && v.a.x < x1 && h.a.y > y0 && h.a.y < y1) {
        if (isRail(v.net) || isRail(h.net) || isStub(v) || isStub(h)) railCrossings++;
        else crossings++;
      }
    }
  }

  let bends = 0;
  const endpoints = new Map<string, { net: string; h: number; v: number }>();
  for (const w of r.wires) {
    const horizontal = w.a.y === w.b.y;
    for (const p of [w.a, w.b]) {
      const key = `${w.net}\u0000${pointKey(p)}`;
      const e = endpoints.get(key) ?? { net: w.net, h: 0, v: 0 };
      if (horizontal) e.h++;
      else e.v++;
      endpoints.set(key, e);
    }
  }
  for (const e of endpoints.values()) if (e.h === 1 && e.v === 1) bends++;

  const wireLength = r.wires.reduce((s, w) => s + manhattan(w.a, w.b), 0);
  const powerWire = r.wires
    .filter((w) => isRail(w.net))
    .reduce((s, w) => s + manhattan(w.a, w.b), 0);

  // Straightness of simple connections.
  const pinsByNet = new Map<string, Pt[]>();
  for (const part of r.parts) {
    for (const pin of part.pins) {
      if (pin.net === undefined) continue;
      const list = pinsByNet.get(pin.net) ?? [];
      list.push(pin.at);
      pinsByNet.set(pin.net, list);
    }
  }
  let simple = 0;
  let straight = 0;
  for (const [net, pins] of pinsByNet) {
    const role = input.nets.find((n) => n.name === net)?.role;
    if (pins.length !== 2 || role !== "signal") continue;
    if (r.labels.some((l) => l.net === net)) continue;
    simple++;
    const [a, b] = pins as [Pt, Pt];
    if (a.x === b.x || a.y === b.y) straight++;
  }

  // Signal flow: a driving pin should sit left of a pin it drives.
  let signalBackwards = 0;
  const drivers = new Set(["output", "power_out", "open_collector", "open_emitter"]);
  for (const net of input.nets) {
    if (net.role !== "signal") continue;
    const pins = r.parts.flatMap((p) =>
      p.pins.filter((x) => x.net === net.name).map((x) => ({ ...x, part: p })),
    );
    const outs = pins.filter((p) => drivers.has(p.type));
    const ins = pins.filter((p) => p.type === "input");
    for (const o of outs) {
      for (const i of ins) {
        if (o.part === i.part) continue;
        if (o.at.x > i.at.x) {
          signalBackwards++;
          issues.push({
            metric: "signalBackwards",
            message: `${o.part.ref}.${o.name} drives ${i.part.ref}.${i.name} from the right`,
          });
        }
      }
    }
  }

  const pointsDown = (net: string | undefined) =>
    input.nets.find((n) => n.name === net)?.pointsDown === true;
  let powerWrongWay = 0;
  for (const s of r.power) {
    const wrong = s.role === "ground" ? s.outward !== 270 : s.outward !== 90 && !pointsDown(s.net);
    if (wrong) {
      powerWrongWay++;
      issues.push({ metric: "powerWrongWay", message: `${s.name} symbol points the wrong way` });
    }
  }

  // A two-terminal part from a wire to a rail should stand upright with the rail outward.
  let shuntMisplaced = 0;
  const roleOf = (net: string | undefined) => input.nets.find((n) => n.name === net)?.role;
  for (const part of r.parts) {
    if (!isTwoTerminal(part)) continue;
    const [a, b] = part.pins as [(typeof part.pins)[0], (typeof part.pins)[0]];
    const ra = roleOf(a.net);
    const rb = roleOf(b.net);
    if ((ra === "signal") === (rb === "signal")) continue;
    const signal = ra === "signal" ? a : b;
    const rail = ra === "signal" ? b : a;
    const railRole = ra === "signal" ? rb : ra;
    // In line with a wired rail is fine: that part carries the rail, it does not hang off it.
    if (
      r.wires.some(
        (w) => w.net === rail.net && (samePoint(w.a, rail.at) || samePoint(w.b, rail.at)),
      )
    ) {
      continue;
    }
    const upright = signal.at.x === rail.at.x;
    const negative = railRole === "power" && pointsDown(rail.net);
    const right =
      negative || (railRole === "ground" ? rail.at.y > signal.at.y : rail.at.y < signal.at.y);
    if (!upright || !right) {
      shuntMisplaced++;
      issues.push({ metric: "shuntMisplaced", message: `${part.ref} does not hang off its wire` });
    }
  }

  for (const u of r.unrouted) {
    issues.push({
      metric: "unrouted",
      message: `net ${u.net} has no route to (${u.at.x}, ${u.at.y})`,
    });
  }

  const offGrid = isOnGrid(r);
  const unrouted = r.unrouted.length;
  const metrics: Metrics = {
    opens,
    shorts,
    overlaps,
    wiresThroughParts,
    unrouted,
    offGrid,
    hardFailures: opens + shorts + overlaps + wiresThroughParts + unrouted + offGrid,
    crossings,
    railCrossings,
    powerWire,
    bends,
    wireLength,
    straightPercent: simple === 0 ? 100 : Math.round((straight / simple) * 100),
    labels: r.labels.filter((l) => l.kind === "local").length,
    signalBackwards,
    powerWrongWay,
    shuntMisplaced,
    width: r.bounds.w,
    height: r.bounds.h,
  };
  return { metrics, issues };
}

/** A string that is equal for two drawings exactly when they look the same. */
export function fingerprint(r: LayoutResult): string {
  const point = (p: Pt) => `${p.x},${p.y}`;
  const lines = [
    ...r.parts.map((p) => `part ${p.id} ${point(p.at)} ${p.rotation} ${p.mirror}`),
    ...r.wires.map((w) => {
      const [a, b] = [point(w.a), point(w.b)].sort();
      return `wire ${w.net} ${a} ${b}`;
    }),
    ...r.power.map((s) => `power ${s.net} ${point(s.at)} ${s.outward}`),
    ...r.labels.map((l) => `label ${l.text} ${point(l.at)} ${l.outward}`),
    ...r.markers.map((m) => `marker ${m.net} ${point(m.at)} ${m.outward}`),
  ];
  return lines.sort().join("\n");
}
