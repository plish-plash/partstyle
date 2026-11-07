import { CHAR, LINE, pointKey, rectsOverlap } from "../geometry.js";
import type { Junction, PlacedPart, PowerSymbol, Pt, Rect, TextField, Wire } from "../types.js";

interface Edge {
  a: Pt;
  b: Pt;
}

/**
 * Rebuilds a net's wires as maximal straight runs broken at junctions, pins and corners, and adds
 * a junction wherever three or more connections meet.
 */
export function normalizeWires(
  wires: Wire[],
  pinPoints: Map<string, Pt[]>,
  symbolPoints: Map<string, Pt[]>,
): { wires: Wire[]; junctions: Junction[] } {
  const byNet = new Map<string, Wire[]>();
  for (const w of wires) {
    const list = byNet.get(w.net) ?? [];
    list.push(w);
    byNet.set(w.net, list);
  }
  const out: Wire[] = [];
  const junctions: Junction[] = [];
  for (const [net, list] of byNet) {
    // Unit edges, so overlapping and touching wires merge.
    const edges = new Map<string, Edge>();
    const adj = new Map<string, Set<string>>();
    const points = new Map<string, Pt>();
    const link = (a: Pt, b: Pt) => {
      const ka = pointKey(a);
      const kb = pointKey(b);
      points.set(ka, a);
      points.set(kb, b);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      edges.set(key, { a, b });
      if (!adj.has(ka)) adj.set(ka, new Set());
      if (!adj.has(kb)) adj.set(kb, new Set());
      adj.get(ka)?.add(kb);
      adj.get(kb)?.add(ka);
    };
    for (const w of list) {
      const dx = Math.sign(w.b.x - w.a.x);
      const dy = Math.sign(w.b.y - w.a.y);
      const n = Math.abs(w.b.x - w.a.x) + Math.abs(w.b.y - w.a.y);
      let p = w.a;
      for (let i = 0; i < n; i++) {
        const q = { x: p.x + dx, y: p.y + dy };
        link(p, q);
        p = q;
      }
    }

    const pins = new Set((pinPoints.get(net) ?? []).map(pointKey));
    const symbols = new Set((symbolPoints.get(net) ?? []).map(pointKey));
    const stops = new Set<string>();
    for (const [key, ns] of adj) {
      const extra = (pins.has(key) ? 1 : 0) + (symbols.has(key) ? 1 : 0);
      const degree = ns.size + extra;
      if (degree >= 3) {
        junctions.push({ net, at: points.get(key) as Pt });
        stops.add(key);
      }
      if (extra > 0 || ns.size !== 2) stops.add(key);
      if (ns.size === 2) {
        const [a, b] = [...ns].map((k) => points.get(k) as Pt);
        const p = points.get(key) as Pt;
        if (a && b && (a.x - p.x) * (b.y - p.y) !== (a.y - p.y) * (b.x - p.x)) stops.add(key);
      }
    }

    // Walk straight runs from every stop.
    const seen = new Set<string>();
    const edgeKey = (ka: string, kb: string) => (ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
    const sorted = [...stops].sort();
    for (const start of sorted) {
      for (const first of [...(adj.get(start) ?? [])].sort()) {
        if (seen.has(edgeKey(start, first))) continue;
        let prev = start;
        let cur = first;
        seen.add(edgeKey(prev, cur));
        while (!stops.has(cur)) {
          const nexts = [...(adj.get(cur) ?? [])].filter((k) => k !== prev);
          const nxt = nexts[0] as string;
          seen.add(edgeKey(cur, nxt));
          prev = cur;
          cur = nxt;
        }
        out.push({ net, a: points.get(start) as Pt, b: points.get(cur) as Pt });
      }
    }
  }
  return { wires: out, junctions };
}

const fieldBox = (lines: string[], at: Pt, anchor: TextField["anchor"]): Rect => {
  const w = Math.max(...lines.map((s) => s.length * CHAR));
  const h = lines.length * LINE;
  const x = anchor === "start" ? at.x : anchor === "end" ? at.x - w : at.x - w / 2;
  return { x, y: at.y - LINE, w, h };
};

/** Puts each part's reference and value in the first spot clear of wires and other text. */
export function placeText(
  parts: PlacedPart[],
  wires: Wire[],
  power: PowerSymbol[],
  labelBoxes: Rect[],
) {
  const taken: Rect[] = [...parts.map((p) => p.box), ...power.map((s) => s.box), ...labelBoxes];
  const wireHit = (r: Rect) =>
    wires.some((w) => {
      const x0 = Math.min(w.a.x, w.b.x);
      const x1 = Math.max(w.a.x, w.b.x);
      const y0 = Math.min(w.a.y, w.b.y);
      const y1 = Math.max(w.a.y, w.b.y);
      return x0 < r.x + r.w && x1 > r.x && y0 < r.y + r.h && y1 > r.y;
    });
  for (const part of parts) {
    const lines = [part.ref, ...(part.value ? [part.value] : [])];
    const b = part.box;
    const mid = b.x + b.w / 2;
    const wide = b.w >= b.h;
    const options: { at: Pt; anchor: TextField["anchor"] }[] =
      part.kind === "ic" && b.w >= 10 && b.h >= 8
        ? [{ at: { x: mid, y: b.y + b.h / 2 }, anchor: "middle" }]
        : part.kind === "connector" ||
            part.kind === "ic" ||
            part.kind === "opamp" ||
            part.kind === "sheet"
          ? [
              { at: { x: b.x, y: b.y - lines.length * LINE + LINE - 0.3 }, anchor: "start" },
              { at: { x: b.x, y: b.y + b.h + LINE + 0.3 }, anchor: "start" },
            ]
          : wide
            ? [
                { at: { x: mid, y: b.y - lines.length * LINE + LINE }, anchor: "middle" },
                { at: { x: mid, y: b.y + b.h + LINE }, anchor: "middle" },
              ]
            : [
                {
                  at: { x: b.x + b.w + 0.3, y: b.y + b.h / 2 - lines.length * 0.5 + 1 },
                  anchor: "start",
                },
                {
                  at: { x: b.x - 0.3, y: b.y + b.h / 2 - lines.length * 0.5 + 1 },
                  anchor: "end",
                },
              ];
    const others = taken.filter((r) => r !== b);
    const fits = (o: (typeof options)[number]) => {
      const box = fieldBox(lines, o.at, o.anchor);
      if (part.kind === "ic" && b.w >= 10 && b.h >= 8) return true;
      return !wireHit(box) && !others.some((r) => rectsOverlap(box, r));
    };
    const chosen = options.find(fits) ?? (options[0] as (typeof options)[number]);
    const box = fieldBox(lines, chosen.at, chosen.anchor);
    taken.push(box);
    part.text = lines.map((text, i) => ({
      text,
      at: { x: chosen.at.x, y: chosen.at.y + i * LINE },
      anchor: chosen.anchor,
    }));
  }
}
