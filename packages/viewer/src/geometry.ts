/** A symbol point (mm, y up) on the sheet (y down), for a symbol at `at` rotated `rot` degrees CCW. */
export function toSheet(
  at: { x: number; y: number },
  rot: number,
  lx: number,
  ly: number,
): [number, number] {
  const t = (rot * Math.PI) / 180;
  const x = lx * Math.cos(t) - ly * Math.sin(t);
  const y = lx * Math.sin(t) + ly * Math.cos(t);
  return [at.x + x, at.y - y];
}

/** SVG path for KiCad's three-point arc (start, a point on the arc, end), in symbol coords. */
export function arcPath(s: [number, number], m: [number, number], e: [number, number]): string {
  const [ax, ay] = s;
  const [bx, by] = m;
  const [cx, cy] = e;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return `M ${ax} ${ay} L ${cx} ${cy}`;
  const ux =
    ((ax * ax + ay * ay) * (by - cy) +
      (bx * bx + by * by) * (cy - ay) +
      (cx * cx + cy * cy) * (ay - by)) /
    d;
  const uy =
    ((ax * ax + ay * ay) * (cx - bx) +
      (bx * bx + by * by) * (ax - cx) +
      (cx * cx + cy * cy) * (bx - ax)) /
    d;
  const r = Math.hypot(ax - ux, ay - uy);
  const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  // A positive cross product turns from +x toward +y, which is SVG's sweep=1 in these coordinates.
  const sweep = cross > 0 ? 1 : 0;
  // Large arc when the middle point lies on the far side of the chord from the centre.
  const sideMid = (cx - ax) * (by - ay) - (cy - ay) * (bx - ax);
  const sideCentre = (cx - ax) * (uy - ay) - (cy - ay) * (ux - ax);
  const large = Math.sign(sideMid) === Math.sign(sideCentre) ? 1 : 0;
  return `M ${ax} ${ay} A ${r} ${r} 0 ${large} ${sweep} ${cx} ${cy}`;
}

/** SVG text placement for KiCad justification and angle (0 or 90). */
export function textProps(
  x: number,
  y: number,
  justify: string[],
  angle: number,
): {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  baseline: string;
  transform: string;
} {
  const h = justify.includes("left") ? "start" : justify.includes("right") ? "end" : "middle";
  const baseline = justify.includes("top")
    ? "hanging"
    : justify.includes("bottom")
      ? "auto"
      : "central";
  const vertical = Math.round(angle) % 180 !== 0;
  return {
    x,
    y,
    anchor: h,
    baseline,
    transform: vertical ? `rotate(-90 ${x} ${y})` : "",
  };
}

/** Direction (dx, dy) on the sheet for a KiCad angle in degrees (0 right, 90 up). */
export function direction(angle: number): [number, number] {
  const t = (angle * Math.PI) / 180;
  return [Math.round(Math.cos(t)), -Math.round(Math.sin(t))];
}
