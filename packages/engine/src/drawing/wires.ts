import type { Pt } from "./types.js";

export const key = (p: Pt) => `${p.x},${p.y}`;

const between = (v: number, a: number, b: number) => v > Math.min(a, b) && v < Math.max(a, b);

/** Whether `p` lies strictly inside the axis-aligned segment a–b. */
export function onSegmentInterior(p: Pt, a: Pt, b: Pt): boolean {
  if (a.x === b.x) return p.x === a.x && between(p.y, a.y, b.y);
  if (a.y === b.y) return p.y === a.y && between(p.x, a.x, b.x);
  return false;
}
