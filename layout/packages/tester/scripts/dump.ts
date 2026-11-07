/** Prints a case as a character grid, for debugging the engine from a terminal. */

import { layoutBlock } from "@partstyle/layout";
import { CASES } from "@partstyle/layout-cases";

const id = process.argv[2] as string;
const c = CASES.find((x) => x.id === id);
if (!c) throw new Error(`no case ${id}`);
const r = layoutBlock(c.input, process.argv[3] ? JSON.parse(process.argv[3]) : {});
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
    put(
      l.at.x + (l.outward === 180 ? -l.text.length + i : i) * (l.kind === "port" ? 1 : 1),
      l.at.y,
      ch,
    );
  });
}
for (const p of r.parts) {
  [...p.ref].forEach((ch, i) => {
    put(p.box.x + i, p.box.y, ch);
  });
}
console.log(g.map((row) => row.join("").trimEnd()).join("\n"));
console.log(r.unrouted);
