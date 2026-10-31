import type { Pt, WireSegment } from "./types.js";

/** KiCad's connection grid; every connection point and wire vertex lands on it. */
export const SNAP = 1.27;

/** Snaps to the connection grid, rounded so equal points compare equal. */
export const snap = (v: number) => Number((Math.round(v / SNAP) * SNAP).toFixed(4));
export const snapPt = (p: Pt): Pt => ({ x: snap(p.x), y: snap(p.y) });

export const key = (p: Pt) => `${p.x},${p.y}`;

const between = (v: number, a: number, b: number) => v > Math.min(a, b) && v < Math.max(a, b);

/** Whether `p` lies strictly inside the axis-aligned segment a–b. */
export function onSegmentInterior(p: Pt, a: Pt, b: Pt): boolean {
  if (a.x === b.x) return p.x === a.x && between(p.y, a.y, b.y);
  if (a.y === b.y) return p.y === a.y && between(p.x, a.x, b.x);
  return false;
}

/**
 * Cleans up routed wires so every connection is explicit: segments are split wherever another
 * segment's end or a connection point (pin, label, power symbol) of the same net lands on them,
 * duplicates are removed, straight runs are re-merged where nothing else connects, and a
 * junction is placed wherever three or more segments meet.
 */
export function normalizeWires(
  segments: WireSegment[],
  connectionPoints: { net: string; at: Pt }[],
): { wires: WireSegment[]; junctions: { net: string; at: Pt }[] } {
  const byNet = new Map<string, WireSegment[]>();
  for (const s of segments) {
    if (s.a.x === s.b.x && s.a.y === s.b.y) continue;
    byNet.set(s.net, [...(byNet.get(s.net) ?? []), s]);
  }
  const wires: WireSegment[] = [];
  const junctions: { net: string; at: Pt }[] = [];

  for (const [net, segs] of byNet) {
    const anchors = connectionPoints.filter((c) => c.net === net).map((c) => c.at);
    const breaks = [...segs.flatMap((s) => [s.a, s.b]), ...anchors];

    // Split at every breakpoint inside a segment, then dedupe.
    const pieces = new Map<string, [Pt, Pt]>();
    for (const s of segs) {
      const inside = breaks
        .filter((p) => onSegmentInterior(p, s.a, s.b))
        .sort((p, q) => (s.a.x === s.b.x ? p.y - q.y : p.x - q.x));
      const ordered =
        s.a.x === s.b.x
          ? s.a.y < s.b.y
            ? [s.a, s.b]
            : [s.b, s.a]
          : s.a.x < s.b.x
            ? [s.a, s.b]
            : [s.b, s.a];
      const pts = [ordered[0] as Pt, ...inside, ordered[1] as Pt];
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i] as Pt;
        const b = pts[i + 1] as Pt;
        if (key(a) !== key(b)) pieces.set(`${key(a)}|${key(b)}`, [a, b]);
      }
    }

    // Re-merge straight runs through points nothing else connects to.
    const keep = new Set(anchors.map(key));
    const list = [...pieces.values()];
    let merged = true;
    while (merged) {
      merged = false;
      const degree = new Map<string, number>();
      for (const [a, b] of list) {
        degree.set(key(a), (degree.get(key(a)) ?? 0) + 1);
        degree.set(key(b), (degree.get(key(b)) ?? 0) + 1);
      }
      for (let i = 0; i < list.length && !merged; i++) {
        for (let j = i + 1; j < list.length && !merged; j++) {
          const [a1, b1] = list[i] as [Pt, Pt];
          const [a2, b2] = list[j] as [Pt, Pt];
          const vertical = a1.x === b1.x && a2.x === b2.x && a1.x === a2.x;
          const horizontal = a1.y === b1.y && a2.y === b2.y && a1.y === a2.y;
          if (!vertical && !horizontal) continue;
          const shared = key(b1) === key(a2) ? b1 : key(b2) === key(a1) ? a1 : undefined;
          if (!shared || keep.has(key(shared)) || degree.get(key(shared)) !== 2) continue;
          const ends = key(b1) === key(a2) ? [a1, b2] : [a2, b1];
          list.splice(j, 1);
          list.splice(i, 1, ends as [Pt, Pt]);
          merged = true;
        }
      }
    }

    const degree = new Map<string, { at: Pt; n: number }>();
    for (const [a, b] of list) {
      for (const p of [a, b]) {
        const d = degree.get(key(p)) ?? { at: p, n: 0 };
        d.n++;
        degree.set(key(p), d);
      }
      wires.push({ net, a, b });
    }
    for (const d of degree.values()) if (d.n >= 3) junctions.push({ net, at: d.at });
  }
  return { wires, junctions };
}
