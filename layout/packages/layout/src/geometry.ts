import type { Direction, LayoutPart, PlacedPin, Pt, Rect, Rotation } from "./types.js";

/** Grid units per text character and per text line. */
export const CHAR = 0.5;
export const LINE = 1;
export const textWidth = (s: string) => s.length * CHAR;

export const rectsOverlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export const inflate = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + by * 2,
  h: r.h + by * 2,
});

export const translate = (r: Rect, dx: number, dy: number): Rect => ({
  x: r.x + dx,
  y: r.y + dy,
  w: r.w,
  h: r.h,
});

export function unionRects(rects: Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Maps a part-local point to its offset from the origin: mirror about y, then rotate. */
export function transformPoint(p: Pt, rotation: Rotation, mirror: boolean): Pt {
  const x = mirror ? -p.x : p.x;
  const y = p.y;
  // `+ 0` turns -0 into 0 so results compare and serialize cleanly.
  switch (rotation) {
    case 0:
      return { x: x + 0, y: y + 0 };
    case 90:
      return { x: y + 0, y: -x + 0 };
    case 180:
      return { x: -x + 0, y: -y + 0 };
    case 270:
      return { x: -y + 0, y: x + 0 };
  }
}

export function transformDirection(d: Direction, rotation: Rotation, mirror: boolean): Direction {
  const m = mirror ? (((180 - d + 360) % 360) as Direction) : d;
  return ((m + rotation) % 360) as Direction;
}

export function transformRect(r: Rect, rotation: Rotation, mirror: boolean): Rect {
  const a = transformPoint({ x: r.x, y: r.y }, rotation, mirror);
  const b = transformPoint({ x: r.x + r.w, y: r.y + r.h }, rotation, mirror);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export function placedPins(
  part: LayoutPart,
  at: Pt,
  rotation: Rotation,
  mirror: boolean,
): PlacedPin[] {
  return part.pins.map((p) => {
    const o = transformPoint(p, rotation, mirror);
    return {
      id: p.id,
      name: p.name,
      at: { x: at.x + o.x, y: at.y + o.y },
      outward: transformDirection(p.outward, rotation, mirror),
      type: p.type,
      ...(p.net !== undefined ? { net: p.net } : {}),
    };
  });
}

export const samePoint = (a: Pt, b: Pt) => a.x === b.x && a.y === b.y;
export const pointKey = (p: Pt) => `${p.x},${p.y}`;
export const manhattan = (a: Pt, b: Pt) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export const stepOf = (d: Direction): Pt =>
  d === 0
    ? { x: 1, y: 0 }
    : d === 90
      ? { x: 0, y: -1 }
      : d === 180
        ? { x: -1, y: 0 }
        : { x: 0, y: 1 };

/** Whether a point lies strictly inside a rectangle. */
export const strictlyInside = (p: Pt, r: Rect) =>
  p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;

/** Whether the axis-aligned segment a–b passes through the open interior of `r`. */
export function segmentEntersRect(a: Pt, b: Pt, r: Rect): boolean {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  if (y0 === y1) return y0 > r.y && y0 < r.y + r.h && x0 < r.x + r.w && x1 > r.x;
  return x0 > r.x && x0 < r.x + r.w && y0 < r.y + r.h && y1 > r.y;
}
