import type { Group } from "./groups.js";
import type { Node, SheetInput } from "./nodes.js";
import { turnable } from "./orient.js";

type Dir = "out" | "in" | "any";

const dirOf = (type: string): Dir =>
  type === "output" || type === "power_out"
    ? "out"
    : type === "input" || type === "power_in"
      ? "in"
      : "any";

export interface Flow {
  /** Stage per group id: stored, else derived. */
  stages: Map<string, number>;
  /** Whether each anchor node (by id) is mirrored: stored, else derived. */
  flips: Map<string, boolean>;
}

/**
 * Orders the groups of a sheet along its signal flow. Between two groups sharing signal nets,
 * each shared pin votes: an output for its group coming first, an input for it coming later
 * (two votes each), and a pin on the right or left side of a part with pins on both sides
 * (one vote: the symbol was drawn to read that way). Where the votes are even the groups are
 * only tied. Supply nets carry power from a supply's output, or failing that from passive pins,
 * to the parts it powers. A group's stage is one more than the latest group feeding it (or tied
 * to it, if nothing feeds it); cycles are broken in declaration order; stored stages are kept
 * as given. Groups connected to nothing come last, one stage each.
 *
 * A part whose signal pins all face one way is then mirrored to face the rest of the circuit:
 * a source whose pins face left, or a sink whose pins face right. A stored flip wins.
 */
export function deriveFlow(input: SheetInput, groups: Group[]): Flow {
  const { hints, roleOf, block } = input;
  const portNets = new Set(block.nets.flatMap((n) => (n.port !== undefined ? [n.name] : [])));

  const members = new Map<string, { g: Group; dir: Dir; side: number }[]>();
  const add = (net: string | undefined, g: Group, dir: Dir, side: number) => {
    if (net === undefined) return;
    members.set(net, [...(members.get(net) ?? []), { g, dir, side }]);
  };
  for (const g of groups) {
    for (const a of g.anchors) {
      // The sides of a part with pins on both (an IC) say which way it reads; a connector's
      // single row says nothing until it is mirrored to face its circuit.
      const twoSided = a.pins.some((p) => p.outward === 0) && a.pins.some((p) => p.outward === 180);
      const mirrored = hints.get(a.ref)?.flip === true;
      for (const p of a.pins) {
        const east = p.outward === (mirrored ? 180 : 0);
        const west = p.outward === (mirrored ? 0 : 180);
        add(p.net, g, dirOf(p.type), twoSided ? (east ? 1 : west ? -1 : 0) : 0);
      }
    }
    for (const t of g.attached) for (const p of t.node.pins) add(p.net, g, "any", 0);
  }

  const preds = new Map<string, Set<string>>(groups.map((g) => [g.id, new Set()]));
  const ties = new Map<string, Set<string>>(groups.map((g) => [g.id, new Set()]));
  const neighbours = new Map<string, Set<string>>(groups.map((g) => [g.id, new Set()]));
  const edge = (from: Group, to: Group) => {
    if (from === to) return;
    preds.get(to.id)?.add(from.id);
    neighbours.get(to.id)?.add(from.id);
    neighbours.get(from.id)?.add(to.id);
  };
  /** Signal votes between pairs of groups, "a|b" → how strongly a comes before b. */
  const votes = new Map<string, { a: Group; b: Group; v: number }>();
  const weight = (m: { dir: Dir; side: number }) =>
    m.dir === "out" ? 2 : m.dir === "in" ? -2 : m.side;
  for (const [net, list] of members) {
    const role = roleOf(net);
    if (role === "ground") continue;
    if (role === "signal") {
      const score = new Map<Group, number>();
      for (const m of list) score.set(m.g, (score.get(m.g) ?? 0) + weight(m));
      const gs = [...score.keys()];
      for (const a of gs) {
        for (const b of gs) {
          if (a.line >= b.line) continue;
          neighbours.get(a.id)?.add(b.id);
          neighbours.get(b.id)?.add(a.id);
          const k = `${a.id}|${b.id}`;
          const cur = votes.get(k) ?? { a, b, v: 0 };
          cur.v += (score.get(a) as number) - (score.get(b) as number);
          votes.set(k, cur);
        }
      }
      continue;
    }
    // Supply nets carry power from what makes it to what takes it.
    const outs = list.filter((m) => m.dir === "out");
    const ins = list.filter((m) => m.dir === "in");
    const anys = list.filter((m) => m.dir === "any");
    if (outs.length > 0) {
      for (const o of outs) for (const t of [...ins, ...anys]) edge(o.g, t.g);
    } else if (ins.length > 0 && !portNets.has(net)) {
      for (const a of anys) for (const i of ins) edge(a.g, i.g);
    }
  }
  for (const { a, b, v } of votes.values()) {
    if (v > 0) edge(a, b);
    else if (v < 0) edge(b, a);
    else {
      ties.get(a.id)?.add(b.id);
      ties.get(b.id)?.add(a.id);
    }
  }

  const stages = new Map<string, number>();
  const stored = (g: Group) => hints.get(g.id)?.stage;
  const remaining = [...groups];
  const succs = (id: string) => groups.filter((g) => preds.get(g.id)?.has(id));
  const deferred: Group[] = [];
  while (remaining.length > 0) {
    const pending = new Set(remaining.map((g) => g.id));
    const ready =
      remaining.find((g) => ![...(preds.get(g.id) ?? [])].some((p) => pending.has(p))) ??
      (remaining[0] as Group); // a cycle: break it at the first declared
    remaining.splice(remaining.indexOf(ready), 1);
    const fed = [...(preds.get(ready.id) ?? [])].flatMap((p) => stages.get(p) ?? []);
    const tied = [...(ties.get(ready.id) ?? [])].flatMap((p) => stages.get(p) ?? []);
    const s =
      stored(ready) ??
      (fed.length > 0
        ? Math.max(...fed) + 1
        : tied.length > 0
          ? Math.max(...tied) + 1
          : succs(ready.id).length > 0 || (ties.get(ready.id)?.size ?? 0) > 0
            ? 1
            : undefined);
    if (s === undefined) deferred.push(ready);
    else stages.set(ready.id, s);
  }
  let last = Math.max(0, ...stages.values());
  for (const g of deferred) stages.set(g.id, ++last);

  const flips = new Map<string, boolean>();
  for (const g of groups) {
    const own = stages.get(g.id) as number;
    const near = [...(neighbours.get(g.id) ?? [])].map((id) => stages.get(id) as number);
    for (const a of g.anchors) {
      const hint = hints.get(a.ref)?.flip;
      if (hint !== undefined) {
        flips.set(a.id, hint && canFlip(a));
        continue;
      }
      if (!canFlip(a) || near.length === 0) {
        flips.set(a.id, false);
        continue;
      }
      const sides = a.pins.filter((p) => p.net !== undefined && roleOf(p.net) === "signal");
      const east = sides.filter((p) => p.outward === 0).length;
      const west = sides.filter((p) => p.outward === 180).length;
      const source = near.every((s) => s > own);
      const sink = near.every((s) => s < own);
      flips.set(a.id, (source && west > 0 && east === 0) || (sink && east > 0 && west === 0));
    }
  }
  return { stages, flips };
}

/** Two-terminal parts turn instead; everything else may be mirrored. */
export const canFlip = (n: Node) => n.kind === "sheet" || !turnable.test(n.ref);
