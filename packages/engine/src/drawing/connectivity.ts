import type { Pt, SheetLayout } from "./types.js";
import { key, onSegmentInterior } from "./wires.js";

/**
 * Re-derives connectivity from a sheet's geometry, as KiCad would, and reports where it differs
 * from the nets the sheet was drawn for: a net split into pieces (open), two nets touching
 * (short), or a connection point sitting on another net's wire. Empty means the drawing is
 * faithful. Labels with the same text and power symbols with the same name connect, as in KiCad.
 */
export function checkConnectivity(sheet: SheetLayout): string[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const pointNode = (p: Pt) => `pt:${key(p)}`;

  const items: { net: string; node: string; what: string; at?: Pt }[] = [];
  for (const u of sheet.units) {
    for (const p of u.pins) {
      if (p.net === undefined) continue;
      items.push({ net: p.net, node: pointNode(p.at), what: `${u.ref}.${p.number}`, at: p.at });
    }
  }
  for (const s of sheet.sheets) {
    for (const p of s.pins) {
      if (p.net === undefined) continue;
      items.push({ net: p.net, node: pointNode(p.at), what: `${s.instance}.${p.port}`, at: p.at });
    }
  }
  for (const l of sheet.labels) {
    items.push({ net: l.net, node: pointNode(l.at), what: `label ${l.text}`, at: l.at });
    union(pointNode(l.at), `${l.kind}:${l.text}`);
  }
  for (const p of sheet.power) {
    if (p.flag) continue;
    items.push({ net: p.net, node: pointNode(p.at), what: `power ${p.name}`, at: p.at });
    union(pointNode(p.at), `power:${p.name}`);
  }
  for (const w of sheet.wires) {
    union(pointNode(w.a), pointNode(w.b));
    items.push({ net: w.net, node: pointNode(w.a), what: `wire ${key(w.a)}-${key(w.b)}` });
  }

  const problems: string[] = [];
  for (const it of items) {
    if (!it.at) continue;
    const at = it.at;
    const crossed = sheet.wires.find((w) => w.net !== it.net && onSegmentInterior(at, w.a, w.b));
    if (crossed) problems.push(`${it.what} (net ${it.net}) lies on a wire of net ${crossed.net}`);
  }

  const netsOfGroup = new Map<string, Set<string>>();
  const groupsOfNet = new Map<string, Set<string>>();
  for (const it of items) {
    const g = find(it.node);
    netsOfGroup.set(g, (netsOfGroup.get(g) ?? new Set()).add(it.net));
    groupsOfNet.set(it.net, (groupsOfNet.get(it.net) ?? new Set()).add(g));
  }
  for (const nets of netsOfGroup.values()) {
    if (nets.size > 1) problems.push(`nets ${[...nets].sort().join(", ")} are shorted together`);
  }
  for (const [net, groups] of groupsOfNet) {
    if (groups.size > 1) problems.push(`net ${net} is drawn in ${groups.size} unconnected pieces`);
  }
  return problems;
}
