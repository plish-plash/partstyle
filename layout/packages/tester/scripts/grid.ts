/** Draws a layout as a character grid, for reading it from a terminal. */

import type { LayoutResult, Pt } from "@partstyle/layout";

/**
 * One character per grid unit: `.` part boxes, `-` and `|` wires, `+` wire ends, `o` connected
 * pins, `^` and `v` power and ground symbols, then label text and refs. With `rulers`, row and
 * column numbers are printed with that offset added (for Partstyle's sheet grid coordinates).
 */
export function textGrid(r: LayoutResult, opts: { rulers?: Pt } = {}): string {
  const b = r.bounds;
  const x0 = Math.floor(b.x) - 1;
  const y0 = Math.floor(b.y) - 1;
  const W = Math.ceil(b.w) + 3;
  const H = Math.ceil(b.h) + 3;
  const g = Array.from({ length: H }, () => Array<string>(W).fill(" "));
  const put = (x: number, y: number, ch: string) => {
    const row = g[Math.round(y) - y0];
    if (row && Math.round(x) - x0 >= 0 && Math.round(x) - x0 < W) row[Math.round(x) - x0] = ch;
  };
  for (const p of r.parts) {
    for (let y = p.box.y; y <= p.box.y + p.box.h; y++)
      for (let x = p.box.x; x <= p.box.x + p.box.w; x++) put(x, y, ".");
  }
  for (const w of r.wires) {
    const dx = Math.sign(w.b.x - w.a.x);
    const dy = Math.sign(w.b.y - w.a.y);
    const n = Math.abs(w.a.x - w.b.x) + Math.abs(w.a.y - w.b.y);
    for (let i = 0; i <= n; i++) put(w.a.x + dx * i, w.a.y + dy * i, dx ? "-" : "|");
  }
  for (const w of r.wires) {
    put(w.a.x, w.a.y, "+");
    put(w.b.x, w.b.y, "+");
  }
  for (const p of r.parts) for (const pin of p.pins) if (pin.net) put(pin.at.x, pin.at.y, "o");
  for (const s of r.power) put(s.at.x, s.at.y, s.role === "ground" ? "v" : "^");
  for (const l of r.labels) {
    [...l.text].forEach((ch, i) => {
      put(l.at.x + (l.outward === 180 ? -l.text.length + i : i), l.at.y, ch);
    });
  }
  for (const p of r.parts) {
    [...p.ref].forEach((ch, i) => {
      put(p.box.x + i, p.box.y, ch);
    });
  }
  const rows = g.map((row) => row.join("").trimEnd());
  const off = opts.rulers;
  if (!off) return rows.join("\n");

  // Column numbers written downwards every 5 columns, row numbers on the left.
  const cols = Array.from({ length: W }, (_, i) => x0 + i + off.x);
  const digits = Math.max(...cols.map((c) => String(c).length));
  const margin = Math.max(...rows.map((_, i) => String(y0 + i + off.y).length)) + 1;
  const header = Array.from(
    { length: digits },
    (_, d) =>
      " ".repeat(margin) +
      cols
        .map((c) => (c % 5 === 0 ? (String(c).padStart(digits, " ")[d] ?? " ") : " "))
        .join("")
        .trimEnd(),
  );
  const body = rows.map((row, i) => `${String(y0 + i + off.y).padStart(margin - 1)} ${row}`);
  return [...header, ...body].join("\n");
}
