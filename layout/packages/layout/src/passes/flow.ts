import type { Analysis, Ctx } from "../context.js";
import { isPort } from "../context.js";
import type { LayoutPin } from "../types.js";

export interface Flow {
  /** Anchors connected to each other, each laid out on its own. */
  components: string[][];
  /** Anchor to column, counted within its component. */
  rank: Map<string, number>;
  /** Weighted links between anchors, used by ordering. */
  links: { a: string; b: string; pa: string; pb: string }[];
}

/** Nets joined by through-chains: a signal keeps its identity across a series part. */
function linkNets(an: Analysis): (net: string) => string {
  const parent = new Map<string, string>();
  const find = (n: string): string => {
    const p = parent.get(n);
    if (p === undefined || p === n) return n;
    const root = find(p);
    parent.set(n, root);
    return root;
  };
  for (const c of an.chains) {
    if (c.kind !== "through") continue;
    parent.set(find(c.nets[0] as string), find(c.nets.at(-1) as string));
  }
  return find;
}

/** Positive if this pin wants its net to run away to the right. */
function score(ctx: Ctx, part: string, pin: LayoutPin): number {
  const p = ctx.part(part);
  const follow = ctx.rules.on("follow-pin-side");
  const signal = ctx.rules.on("signal-left-right");
  const sidedPart = p.kind !== "connector";
  let s = 0;
  if (isPort(part)) {
    if (signal && pin.type === "output") s += 100;
    if (signal && pin.type === "input") s -= 100;
    return s;
  }
  if (follow && sidedPart) {
    if (pin.outward === 0) s += 3;
    if (pin.outward === 180) s -= 3;
  }
  if (signal) {
    if (pin.type === "output" || pin.type === "power_out") s += 2;
    if (pin.type === "input" || pin.type === "power_in") s -= 2;
  }
  return s;
}

/**
 * Assigns anchors to columns. Each pair of linked anchors votes for which sits further left; the
 * strongest votes form a DAG and a longest-path pass turns it into columns.
 */
export function deriveFlow(ctx: Ctx, an: Analysis): Flow {
  const find = linkNets(an);
  const byLink = new Map<string, { part: string; pin: LayoutPin }[]>();
  for (const id of an.anchors) {
    for (const pin of ctx.part(id).pins) {
      if (pin.net === undefined) continue;
      const net = pin.net;
      if (ctx.role(net) !== "signal" && !an.railWires.has(net)) continue;
      const key = find(net);
      const list = byLink.get(key) ?? [];
      list.push({ part: id, pin });
      byLink.set(key, list);
    }
  }

  const votes = new Map<string, number>();
  const links: Flow["links"] = [];
  const pairKey = (a: string, b: string) => `${a}\u0000${b}`;
  for (const list of byLink.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i] as (typeof list)[number];
        const b = list[j] as (typeof list)[number];
        if (a.part === b.part) continue;
        const v = score(ctx, a.part, a.pin) - score(ctx, b.part, b.pin);
        const key = pairKey(a.part, b.part);
        const rev = pairKey(b.part, a.part);
        if (votes.has(rev)) votes.set(rev, (votes.get(rev) ?? 0) - v);
        else votes.set(key, (votes.get(key) ?? 0) + v);
        links.push({ a: a.part, b: b.part, pa: a.pin.id, pb: b.pin.id });
      }
    }
  }

  const edges = [...votes.entries()].map(([key, v]) => {
    const [a, b] = key.split("\u0000") as [string, string];
    // With nothing to choose between them, a connector goes after what it connects to.
    const pa = ctx.part(a);
    const pb = ctx.part(b);
    const connectors = Number(pa.kind === "connector") - Number(pb.kind === "connector");
    const earlier = connectors !== 0 ? connectors < 0 : pa.order < pb.order;
    const forward = v > 0 || (v === 0 && earlier);
    return { from: forward ? a : b, to: forward ? b : a, weight: Math.abs(v) };
  });
  edges.sort(
    (x, y) =>
      y.weight - x.weight ||
      ctx.part(x.from).order - ctx.part(y.from).order ||
      ctx.part(x.to).order - ctx.part(y.to).order,
  );

  // Strongest votes first; any vote that would close a cycle loses.
  const next = new Map<string, Set<string>>();
  const prev = new Map<string, Set<string>>();
  for (const id of an.anchors) {
    next.set(id, new Set());
    prev.set(id, new Set());
  }
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const todo = [from];
    while (todo.length > 0) {
      const n = todo.pop() as string;
      if (n === to) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      todo.push(...(next.get(n) ?? []));
    }
    return false;
  };
  for (const e of edges) {
    if (reaches(e.to, e.from)) continue;
    next.get(e.from)?.add(e.to);
    prev.get(e.to)?.add(e.from);
  }

  // Connected components, keeping declaration order.
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const id of an.anchors) {
    if (seen.has(id)) continue;
    const comp: string[] = [];
    const todo = [id];
    while (todo.length > 0) {
      const n = todo.pop() as string;
      if (seen.has(n)) continue;
      seen.add(n);
      comp.push(n);
      todo.push(...(next.get(n) ?? []), ...(prev.get(n) ?? []));
    }
    comp.sort((a, b) => ctx.part(a).order - ctx.part(b).order);
    components.push(comp);
  }

  const rank = new Map<string, number>();
  for (const comp of components) {
    const rankOf = (n: string): number => {
      const known = rank.get(n);
      if (known !== undefined) return known;
      let r = 0;
      for (const p of prev.get(n) ?? []) r = Math.max(r, rankOf(p) + 1);
      rank.set(n, r);
      return r;
    };
    for (const id of comp) rankOf(id);
    // Sources slide right to sit next to what they feed.
    const byRank = [...comp].sort((a, b) => (rank.get(b) as number) - (rank.get(a) as number));
    for (const id of byRank) {
      if ((prev.get(id)?.size ?? 0) > 0) continue;
      const after = [...(next.get(id) ?? [])].map((n) => rank.get(n) as number);
      if (after.length > 0) rank.set(id, Math.min(...after) - 1);
    }
  }

  // One-sided parts face what they connect to.
  for (const id of an.anchors) {
    const p = ctx.part(id);
    ctx.columns.set(id, rank.get(id) ?? 0);
    const sides = new Set(p.pins.map((x) => x.outward));
    if (p.kind !== "connector" || sides.size !== 1) continue;
    const r = rank.get(id) ?? 0;
    const others = [...(next.get(id) ?? []), ...(prev.get(id) ?? [])];
    let left = 0;
    let right = 0;
    for (const o of others) {
      const ro = rank.get(o) ?? 0;
      if (ro < r) left++;
      if (ro > r) right++;
    }
    const facesRight = p.pins[0]?.outward === 0;
    const wantLeft = left > right;
    if (wantLeft === facesRight && left + right > 0) {
      ctx.mirror.set(id, true);
      if (!isPort(id)) {
        ctx.note(id, "follow-pin-side", "mirrored to face the parts it connects to");
      }
    }
    if (isPort(id) && left + right === 0) {
      // A port on hangers alone: an output sits right of them, an input left.
      if (p.pins[0]?.type === "input") ctx.mirror.set(id, true);
    }
  }
  return { components, rank, links };
}
