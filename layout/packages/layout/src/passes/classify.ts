import {
  type Analysis,
  type Chain,
  type Ctx,
  type Hanger,
  isPort,
  type Stack,
} from "../context.js";
import type { LayoutPart } from "../types.js";

/**
 * Sorts parts into what stays fixed (anchors) and what hangs off or runs between them.
 *
 * Reduction order matters: rails first, then hangers (which absorb the parts in front of them, so
 * resistor + LED + ground becomes one hanger), then what is left forms series chains.
 */
export function classify(ctx: Ctx): Analysis {
  const anchors: string[] = [];
  const twos: LayoutPart[] = [];
  for (const p of ctx.parts.values()) {
    if (ctx.isTwoTerminal(p)) twos.push(p);
    else anchors.push(p.id);
  }
  anchors.sort((a, b) => ctx.part(a).order - ctx.part(b).order);
  twos.sort((a, b) => a.order - b.order);

  const railWires = findRailWires(ctx);
  const isRail = (net: string | undefined) =>
    net !== undefined && ctx.role(net) !== "signal" && !railWires.has(net);

  const netsOf = (p: LayoutPart) => [p.pins[0]?.net, p.pins[1]?.net] as const;
  const other = (p: LayoutPart, net: string) => {
    const [a, b] = netsOf(p);
    return a === net ? b : a;
  };

  // One end on a rail makes a one-part hanger; both ends make a stack.
  const hangers: Hanger[] = [];
  const stacks: Stack[] = [];
  const claimed = new Set<string>();
  const topDown = ctx.rules.on("power-top-bottom");
  for (const p of twos) {
    const [a, b] = netsOf(p);
    if (a === undefined || b === undefined) continue;
    if (isRail(a) && isRail(b)) {
      // Ground always goes to the bottom; between two rails, the higher one goes on top.
      const rank = (n: string) => (ctx.role(n) === "ground" ? 2 : ctx.railPointsDown(n) ? 1 : 0);
      const aOnTop = rank(a) < rank(b) || (rank(a) === rank(b) && a <= b);
      stacks.push({ parts: [p.id], nets: aOnTop ? [a, b] : [b, a] });
      claimed.add(p.id);
      ctx.roles.set(p.id, "decoupling");
    } else if (isRail(a) || isRail(b)) {
      const rail = isRail(a) ? a : b;
      const attach = isRail(a) ? b : a;
      const dir = topDown && !ctx.railPointsDown(rail) ? "up" : "down";
      hangers.push({ id: hangers.length, parts: [p.id], nets: [attach, rail], attach, rail, dir });
      claimed.add(p.id);
      ctx.roles.set(p.id, "shunt");
    }
  }

  // A net that only joins a hanger to one more two-terminal part extends the hanger.
  const pinCount = (net: string) => ctx.netPins.get(net)?.length ?? 0;
  const isPortNet = (net: string) => ctx.nets.get(net)?.port !== undefined;
  let merged = true;
  while (merged) {
    merged = false;
    for (const h of hangers) {
      if (h.parts.length === 0) continue;
      const net = h.attach;
      if (pinCount(net) !== 2 || isPortNet(net) || ctx.role(net) !== "signal") continue;
      const pins = ctx.netPins.get(net) ?? [];
      const nextId = pins.map((r) => r.part).find((id) => !h.parts.includes(id));
      if (nextId === undefined) continue;
      const next = ctx.part(nextId);
      if (!ctx.isTwoTerminal(next)) continue;

      const opposite = hangers.find((o) => o !== h && o.parts.includes(nextId));
      if (opposite) {
        if (opposite.attach !== net) continue;
        // Rail, part, this net, part, rail: drawn as one upright stack.
        const up = h.dir === "up" ? h : opposite;
        const down = up === h ? opposite : h;
        if (up.dir === down.dir) continue;
        stacks.push({
          parts: [...[...up.parts].reverse(), ...down.parts],
          nets: [...[...up.nets].reverse(), ...down.nets.slice(1)],
        });
        for (const id of [...up.parts, ...down.parts]) ctx.roles.set(id, "decoupling");
        hangers.splice(hangers.indexOf(up), 1);
        hangers.splice(hangers.indexOf(down), 1);
        merged = true;
        break;
      }

      if (claimed.has(nextId) || !ctx.rules.on("chain-rows")) continue;
      const far = other(next, net);
      if (far === undefined) continue;
      h.parts.unshift(nextId);
      h.nets.unshift(far);
      h.attach = far;
      claimed.add(nextId);
      for (const id of h.parts) ctx.roles.set(id, "chain");
      merged = true;
    }
  }
  // Ids index nothing, but keep them dense and in a stable order.
  hangers.forEach((h, i) => {
    h.id = i;
  });

  // The rest joins two wires. Parts in a row through plain two-pin nets form one chain.
  const series = twos.filter((p) => !claimed.has(p.id) && p.pins.every((x) => x.net !== undefined));
  const onHanger = new Set(hangers.map((h) => h.attach));
  const joinable = (net: string) =>
    pinCount(net) === 2 &&
    !isPortNet(net) &&
    !onHanger.has(net) &&
    !railWires.has(net) &&
    (ctx.netPins.get(net) ?? []).every((r) => series.some((p) => p.id === r.part));

  const used = new Set<string>();
  const chains: Chain[] = [];
  for (const p of series) {
    if (used.has(p.id)) continue;
    used.add(p.id);
    const [a, b] = netsOf(p) as [string, string];
    const parts = [p.id];
    const nets = [a, b];
    const extend = (atEnd: boolean) => {
      for (;;) {
        const net = (atEnd ? nets.at(-1) : nets[0]) as string;
        if (!joinable(net)) return;
        const pins = ctx.netPins.get(net) ?? [];
        const nextId = pins.map((r) => r.part).find((id) => !used.has(id));
        if (nextId === undefined) return;
        used.add(nextId);
        const far = other(ctx.part(nextId), net) as string;
        if (atEnd) {
          parts.push(nextId);
          nets.push(far);
        } else {
          parts.unshift(nextId);
          nets.unshift(far);
        }
      }
    };
    extend(true);
    extend(false);
    chains.push({ id: chains.length, parts, nets, kind: "through" });
    for (const id of parts) ctx.roles.set(id, "series");
  }

  // A chain with both ends on one anchor loops back around it instead of carrying signal onward.
  const anchorSet = new Set(anchors);
  const anchorsOn = (net: string) =>
    new Set((ctx.netPins.get(net) ?? []).filter((r) => anchorSet.has(r.part)).map((r) => r.part));
  for (const c of chains) {
    const ends = anchorsOn(c.nets[0] as string);
    const far = anchorsOn(c.nets.at(-1) as string);
    const shared = [...ends].find((id) => far.has(id));
    if (shared === undefined) continue;
    c.kind = "loop";
    if (c.parts.length === 1 && adjacentPins(ctx, shared, c)) c.kind = "bridge";
    for (const id of c.parts) {
      ctx.roles.set(id, c.kind === "bridge" ? "bridge" : "feedback");
    }
  }

  for (const p of ctx.parts.values()) if (anchorSet.has(p.id)) ctx.roles.set(p.id, "anchor");

  const hangersOn = new Map<string, Hanger[]>();
  for (const h of hangers) {
    const list = hangersOn.get(h.attach) ?? [];
    list.push(h);
    hangersOn.set(h.attach, list);
  }
  const chainsOn = new Map<string, Chain[]>();
  for (const c of chains) {
    if (c.kind !== "through") continue;
    for (const net of [c.nets[0] as string, c.nets.at(-1) as string]) {
      const list = chainsOn.get(net) ?? [];
      list.push(c);
      chainsOn.set(net, list);
    }
  }
  // Group nets joined by through-chains to see how many anchors each port can reach.
  const group = new Map<string, string>();
  const root = (n: string): string => {
    const p = group.get(n);
    if (p === undefined || p === n) return n;
    const r = root(p);
    group.set(n, r);
    return r;
  };
  for (const c of chains) {
    if (c.kind === "through") group.set(root(c.nets[0] as string), root(c.nets.at(-1) as string));
  }
  const reach = new Map<string, Set<string>>();
  for (const [net, pins] of ctx.netPins) {
    const set = reach.get(root(net)) ?? new Set<string>();
    for (const r of pins)
      if (anchorSet.has(r.part) && !isPort(r.part)) set.add(`${r.part}.${r.pin}`);
    reach.set(root(net), set);
  }
  const terminalPorts = new Set<string>();
  for (const id of anchors) {
    if (!isPort(id)) continue;
    const net = ctx.part(id).pins[0]?.net as string;
    if (reach.get(root(net))?.size === 1) terminalPorts.add(id);
  }
  const kept = anchors.filter((id) => !terminalPorts.has(id));
  // Hangers, stacks and chains all need both ends on nets; a part not wired in yet has neither.
  const loose = twos.filter((p) => !claimed.has(p.id) && !used.has(p.id)).map((p) => p.id);
  for (const id of loose) ctx.roles.set(id, "free");
  return {
    loose,
    hangers,
    stacks,
    chains,
    railWires,
    anchors: kept,
    terminalPorts,
    hangersOn,
    chainsOn,
  };
}

/** A bridge needs its two pins next to each other on one side of the anchor. */
function adjacentPins(ctx: Ctx, anchor: string, c: Chain): boolean {
  const near = (net: string) =>
    (ctx.netPins.get(net) ?? []).find((r) => r.part === anchor && ctx.pin(r));
  const a = near(c.nets[0] as string);
  const b = near(c.nets.at(-1) as string);
  if (!a || !b) return false;
  const pa = ctx.pin(a);
  const pb = ctx.pin(b);
  if (pa.outward !== pb.outward || (pa.outward !== 0 && pa.outward !== 180)) return false;
  // No other connected pin may sit between them.
  const lo = Math.min(pa.y, pb.y);
  const hi = Math.max(pa.y, pb.y);
  return !ctx
    .part(anchor)
    .pins.some((p) => p.outward === pa.outward && p.y > lo && p.y < hi && p.net !== undefined);
}

/**
 * Rails drawn as a wire. Current runs along these from left to right, so their caps hang off the
 * wire: a side power pin of an IC, or the far side of an inductor or ferrite.
 */
function findRailWires(ctx: Ctx): Set<string> {
  const out = new Set<string>();
  for (const p of ctx.parts.values()) {
    for (const pin of p.pins) {
      if (pin.net === undefined || ctx.role(pin.net) !== "power") continue;
      const side = pin.outward === 0 || pin.outward === 180;
      if (!side) continue;
      const icLike = p.kind !== "connector";
      if (pin.type === "power_out" || (icLike && pin.type === "power_in")) out.add(pin.net);
    }
    if ((p.kind === "inductor" || p.kind === "ferrite") && p.pins.length === 2) {
      const [a, b] = [p.pins[0]?.net, p.pins[1]?.net];
      if (a === undefined || b === undefined) continue;
      const roleA = ctx.role(a);
      const roleB = ctx.role(b);
      if (roleA === "power" && roleB !== "ground") out.add(a);
      if (roleB === "power" && roleA !== "ground") out.add(b);
    }
  }
  return out;
}
