import {
  type Analysis,
  type Chain,
  type Ctx,
  type Hanger,
  type PinRef,
  PORT_PREFIX,
  type Stack,
} from "../context.js";
import { transformDirection, transformPoint } from "../geometry.js";
import type { Direction, LayoutPin } from "../types.js";
import type { Flow } from "./flow.js";

export type RowItem =
  /** Hangers sharing one column: at most one above the wire and one below. */
  | { t: "hang"; up?: Hanger; down?: Hanger; net: string }
  /** Parts in line with the row. `nets[i]` and `nets[i + 1]` are either side of `parts[i]`. */
  | { t: "series"; parts: string[]; nets: string[] }
  /** An upright part joining this row to the next. */
  | { t: "bridge"; chain: Chain; mate: Row }
  /** The port label this row ends in. */
  | { t: "port"; id: string };

/** A horizontal run leaving one pin, carrying everything attached to that signal. */
export interface Row {
  seq: number;
  /** Absent for a branch that continues a net from another row. */
  anchor?: string;
  pin?: string;
  /** 1 runs right, -1 runs left. */
  side: 1 | -1;
  /** Set when the pin faces up (-1) or down (1) and the row runs clear of the part. */
  lifted: -1 | 0 | 1;
  /** Position among rows lifted from the same side, innermost first. */
  liftIndex: number;
  net: string;
  items: RowItem[];
  target?: PinRef;
  /** The upper row of a bridge pair sets the lower one's height. */
  bridgeUpper?: Row;
  branchOf?: Row;
  desired: number;
  y: number;
}

export interface Direct {
  anchor: string;
  pin: string;
  hanger: Hanger;
}

/** Side pins on one rail, joined by a vertical wire that ends in a symbol past the part. */
export interface Riser {
  anchor: string;
  net: string;
  pins: string[];
  side: 1 | -1;
  dir: "up" | "down";
  /** Distance from the part's edge. */
  offset: number;
}

export interface RowPlan {
  rows: Row[];
  direct: Direct[];
  risers: Riser[];
  /** Loop chains by the anchor they wrap around. */
  loops: Map<string, Chain[]>;
  decoupling: Map<string, Stack[]>;
  freeHangers: Hanger[];
  freeChains: Chain[];
  freeStacks: Stack[];
  /** Adjacent pins on one rail tied to a neighbour, which holds the symbol. */
  ties: { net: string; a: PinRef; b: PinRef }[];
}

export const facing = (ctx: Ctx, part: string, pin: LayoutPin): Direction =>
  transformDirection(pin.outward, 0, ctx.mirror.get(part) ?? false);

export const localPin = (ctx: Ctx, part: string, pin: LayoutPin) =>
  transformPoint(pin, 0, ctx.mirror.get(part) ?? false);

export function zeroHanger(net: string, ctx: Ctx): Hanger {
  return {
    id: -1,
    parts: [],
    nets: [net],
    attach: net,
    rail: net,
    dir: ctx.railPointsDown(net) ? "down" : "up",
  };
}

/** Width to keep clear beside these anchors for their risers. */
export function riserRoom(plan: RowPlan, anchors: string[], side: 1 | -1): number {
  const offsets = plan.risers
    .filter((r) => r.side === side && anchors.includes(r.anchor))
    .map((r) => r.offset);
  // One more for half the symbol's width, which reaches past its wire.
  return offsets.length > 0 ? Math.max(...offsets) + 1 : 0;
}

/**
 * Picks each riser's distance from the part. The pin nearest the end the riser runs to takes the
 * closest track, so risers going the same way do not cross each other's stubs.
 */
function spaceRisers(ctx: Ctx, id: string, list: Riser[]) {
  const box = ctx.part(id).box;
  const ys = (r: Riser) => r.pins.map((p) => ctx.pin({ part: id, pin: p }).y);
  const span = (r: Riser): [number, number] =>
    r.dir === "up" ? [box.y, Math.max(...ys(r))] : [Math.min(...ys(r)), box.y + box.h];
  const ups = list.filter((r) => r.dir === "up");
  const downs = list.filter((r) => r.dir === "down");
  ups.sort((a, b) => Math.min(...ys(a)) - Math.min(...ys(b)));
  downs.sort((a, b) => Math.max(...ys(b)) - Math.max(...ys(a)));
  const done: Riser[] = [];
  for (const r of [...ups, ...downs]) {
    const [lo, hi] = span(r);
    const clash = (o: Riser, offset: number) => {
      // Same way: their symbols sit side by side. Opposite ways: only overlapping wires clash.
      if (o.dir === r.dir) return Math.abs(o.offset - offset) < 2;
      const [a, b] = span(o);
      return o.offset === offset && a <= hi && lo <= b;
    };
    let offset = 1;
    while (done.some((o) => clash(o, offset))) offset++;
    r.offset = offset;
    done.push(r);
  }
}

export function buildRows(ctx: Ctx, an: Analysis, flow: Flow, columns: string[][]): RowPlan {
  const rows: Row[] = [];
  const claimed = new Set<string>(); // target pins
  const seenChain = new Set<number>();
  const seenHanger = new Set<Hanger>();
  const symboled = new Set<string>();
  const seenPort = new Set<string>();
  const key = (r: PinRef) => `${r.part}\u0000${r.pin}`;
  const useSymbols = ctx.rules.on("local-power-symbols");
  const hang = ctx.rules.on("shunt-hang");
  const pairStacks = ctx.rules.bool("shunt-hang", "pairStacks");
  const inlineChains =
    ctx.rules.on("chain-rows") && ctx.rules.str("chain-rows", "endStyle") === "inline";
  const anchorSet = new Set(an.anchors);

  const isRailEnd = (net: string) => ctx.role(net) !== "signal" && !an.railWires.has(net);

  const targetOn = (net: string, rank: number, origin: string | undefined) => {
    const pins = ctx.netPins.get(net) ?? [];
    return pins.find((r) => {
      if (!anchorSet.has(r.part) || r.part === origin || claimed.has(key(r))) return false;
      if ((flow.rank.get(r.part) ?? 0) !== rank + 1) return false;
      return facing(ctx, r.part, ctx.pin(r)) === 180;
    });
  };

  const leadsOn = (net: string, rank: number, origin: string | undefined, seen: Set<string>) => {
    if (seen.has(net)) return false;
    seen.add(net);
    if (targetOn(net, rank, origin)) return true;
    for (const c of an.chainsOn.get(net) ?? []) {
      if (seenChain.has(c.id)) continue;
      const far = c.nets[0] === net ? (c.nets.at(-1) as string) : (c.nets[0] as string);
      if (leadsOn(far, rank, origin, seen)) return true;
    }
    return false;
  };

  const addHangers = (row: Row, net: string) => {
    if (an.railWires.has(net) && !symboled.has(net) && useSymbols) {
      symboled.add(net);
      const h = zeroHanger(net, ctx);
      row.items.push({ t: "hang", ...(h.dir === "up" ? { up: h } : { down: h }), net });
    }
    const list = (an.hangersOn.get(net) ?? []).filter((h) => !seenHanger.has(h));
    if (!hang) return;
    const ups: Hanger[] = [];
    const downs: Hanger[] = [];
    const inline: Hanger[] = [];
    for (const h of list) {
      seenHanger.add(h);
      if (inlineChains && h.parts.length >= 2) inline.push(h);
      else (h.dir === "up" ? ups : downs).push(h);
    }
    if (pairStacks) {
      for (let i = 0; i < Math.max(ups.length, downs.length); i++) {
        const up = ups[i];
        const down = downs[i];
        row.items.push({
          t: "hang",
          ...(up ? { up } : {}),
          ...(down ? { down } : {}),
          net,
        });
      }
    } else {
      for (const up of ups) row.items.push({ t: "hang", up, net });
      for (const down of downs) row.items.push({ t: "hang", down, net });
    }
    for (const h of inline) {
      row.items.push({ t: "series", parts: h.parts, nets: h.nets });
      const end = zeroHanger(h.rail, ctx);
      row.items.push({
        t: "hang",
        ...(end.dir === "up" ? { up: end } : { down: end }),
        net: h.rail,
      });
    }
  };

  const walk = (row: Row, start: string, rank: number) => {
    const visited: string[] = [];
    let net = start;
    for (;;) {
      visited.push(net);
      addHangers(row, net);
      if (row.side === 1) {
        const t = targetOn(net, rank, row.anchor);
        if (t) {
          row.target = t;
          claimed.add(key(t));
          break;
        }
      }
      const options = (an.chainsOn.get(net) ?? []).filter((c) => !seenChain.has(c.id));
      if (options.length === 0) break;
      const pick =
        options.find((c) => {
          const far = c.nets[0] === net ? (c.nets.at(-1) as string) : (c.nets[0] as string);
          return leadsOn(far, rank, row.anchor, new Set([net]));
        }) ?? (options[0] as Chain);
      seenChain.add(pick.id);
      const forward = pick.nets[0] === net;
      const parts = forward ? pick.parts : [...pick.parts].reverse();
      const nets = forward ? pick.nets : [...pick.nets].reverse();
      row.items.push({ t: "series", parts, nets });
      net = nets.at(-1) as string;
    }
    // A port ends the row; on an earlier net it gets a short row of its own.
    const last = visited.at(-1) as string;
    for (const v of visited) {
      const port = `${PORT_PREFIX}${v}`;
      if (!an.terminalPorts.has(port) || seenPort.has(port)) continue;
      seenPort.add(port);
      const host =
        v === last && !row.target ? row : newRow({ side: row.side, net: v, branchOf: row });
      host.items.push({ t: "port", id: port });
      if (row.side === 1) ctx.mirror.set(port, true);
    }
    // Series parts left on the nets walked get rows of their own, joined back by the router.
    for (const v of visited) {
      for (const c of an.chainsOn.get(v) ?? []) {
        if (seenChain.has(c.id)) continue;
        const branch = newRow({ side: row.side, net: v, branchOf: row });
        walk(branch, v, rank);
      }
    }
  };

  const newRow = (o: Partial<Row> & Pick<Row, "side" | "net">): Row => {
    const row: Row = {
      seq: rows.length,
      lifted: 0,
      liftIndex: 0,
      items: [],
      desired: 0,
      y: 0,
      ...o,
    };
    rows.push(row);
    return row;
  };

  const direct: Direct[] = [];
  const risers: Riser[] = [];
  const ties: RowPlan["ties"] = [];
  const useRisers = useSymbols && ctx.rules.on("power-risers");

  const sidePins = (id: string, dir: Direction) =>
    ctx
      .part(id)
      .pins.filter((p) => facing(ctx, id, p) === dir)
      .sort((a, b) => a.y - b.y);

  /** Keeps a rail pin that has a bare symbol, unless the pin above can carry it. */
  const railRow = (id: string, pin: LayoutPin, prev: LayoutPin | undefined, side: 1 | -1) => {
    const net = pin.net as string;
    const share = useSymbols && ctx.rules.bool("local-power-symbols", "shareAdjacent");
    if (share && prev && prev.net === net && Math.abs(prev.y - pin.y) <= 2) {
      ties.push({ net, a: { part: id, pin: prev.id }, b: { part: id, pin: pin.id } });
      return;
    }
    const row = newRow({ anchor: id, pin: pin.id, side, net });
    const h = zeroHanger(net, ctx);
    row.items.push({ t: "hang", ...(h.dir === "up" ? { up: h } : { down: h }), net });
  };

  for (let c = 0; c < columns.length; c++) {
    for (const id of columns[c] as string[]) {
      const rank = flow.rank.get(id) ?? 0;
      const mine: Riser[] = [];
      const share = ctx.rules.bool("local-power-symbols", "shareAdjacent");
      for (const [dir, side] of [
        [0, 1],
        [180, -1],
      ] as const) {
        let prev: LayoutPin | undefined;
        for (const pin of sidePins(id, dir)) {
          const net = pin.net;
          if (net === undefined) {
            prev = pin;
            continue;
          }
          if (isRailEnd(net) && useRisers) {
            const same = share ? mine.find((r) => r.side === side && r.net === net) : undefined;
            if (same) same.pins.push(pin.id);
            else {
              const riserDir = zeroHanger(net, ctx).dir;
              mine.push({ anchor: id, net, pins: [pin.id], side, dir: riserDir, offset: 1 });
            }
          } else if (isRailEnd(net)) {
            if (useSymbols) railRow(id, pin, prev, side);
          } else if (!claimed.has(key({ part: id, pin: pin.id }))) {
            const row = newRow({ anchor: id, pin: pin.id, side, net });
            walk(row, net, rank);
          }
          prev = pin;
        }
      }
      for (const side of [1, -1] as const) {
        spaceRisers(
          ctx,
          id,
          mine.filter((r) => r.side === side),
        );
      }
      risers.push(...mine);

      // Pins on the top and bottom edges.
      const box = ctx.part(id).box;
      const middle = box.x + box.w / 2;
      for (const [dir, lift] of [
        [90, -1],
        [270, 1],
      ] as const) {
        const list = sidePins(id, dir).sort((a, b) => a.x - b.x);
        const counts = new Map<number, number>();
        // Outermost pins take the rows closest to the part, so the risers do not cross them.
        for (const pin of [...list].sort(
          (a, b) => Math.abs(b.x - middle) - Math.abs(a.x - middle) || a.x - b.x,
        )) {
          const net = pin.net;
          if (net === undefined || isRailEnd(net)) continue;
          const hangers = (an.hangersOn.get(net) ?? []).filter((h) => !seenHanger.has(h));
          const onlyHanger =
            hang &&
            hangers.length === 1 &&
            (ctx.netPins.get(net)?.length ?? 0) === 2 + (hangers[0]?.parts.length ?? 0) - 1 &&
            (an.chainsOn.get(net) ?? []).length === 0 &&
            hangers[0]?.dir === (dir === 90 ? "up" : "down");
          if (onlyHanger) {
            const h = hangers[0] as Hanger;
            seenHanger.add(h);
            direct.push({ anchor: id, pin: pin.id, hanger: h });
            continue;
          }
          const mirrored = ctx.mirror.get(id) ?? false;
          const px = mirrored ? -pin.x : pin.x;
          const mid = mirrored ? -middle : middle;
          const side: 1 | -1 = px >= mid ? 1 : -1;
          const index = counts.get(side) ?? 0;
          counts.set(side, index + 1);
          const row = newRow({
            anchor: id,
            pin: pin.id,
            side,
            net,
            lifted: lift,
            liftIndex: index,
          });
          walk(row, net, rank);
        }
      }
    }
  }

  // Bridges pair two rows of one anchor.
  for (const c of an.chains) {
    if (c.kind !== "bridge") continue;
    const netA = c.nets[0] as string;
    const netB = c.nets.at(-1) as string;
    const a = rows.find((r) => r.net === netA && r.pin !== undefined);
    const b = rows.find((r) => r.net === netB && r.pin !== undefined);
    if (!a || !b || a.anchor !== b.anchor || a.side !== b.side) {
      c.kind = "loop";
      continue;
    }
    const anchor = a.anchor as string;
    const ya = ctx.pin({ part: anchor, pin: a.pin as string }).y;
    const yb = ctx.pin({ part: anchor, pin: b.pin as string }).y;
    const upper = ya < yb ? a : b;
    const lower = upper === a ? b : a;
    upper.items.unshift({ t: "bridge", chain: c, mate: lower });
    lower.bridgeUpper = upper;
  }

  const kept = rows.filter(
    (r) => r.items.length > 0 || r.target !== undefined || r.bridgeUpper !== undefined,
  );

  const loops = new Map<string, Chain[]>();
  const anchorsOn = (net: string) =>
    (ctx.netPins.get(net) ?? []).filter((r) => anchorSet.has(r.part));
  for (const c of an.chains) {
    if (c.kind !== "loop") continue;
    const near = anchorsOn(c.nets[0] as string).map((r) => r.part);
    const far = anchorsOn(c.nets.at(-1) as string).map((r) => r.part);
    const shared = near.find((id) => far.includes(id)) as string;
    const list = loops.get(shared) ?? [];
    list.push(c);
    loops.set(shared, list);
  }

  // Decoupling goes to the anchor declared nearest that shares a rail with it.
  const decoupling = new Map<string, Stack[]>();
  const freeStacks: Stack[] = [];
  for (const s of an.stacks) {
    const order = ctx.part(s.parts[0] as string).order;
    const rails = new Set(s.nets);
    const supply = new Set(s.nets.filter((n) => ctx.role(n) !== "ground"));
    const sharing = (nets: Set<string>) =>
      an.anchors
        .filter((id) => ctx.part(id).kind !== "connector")
        .filter((id) => ctx.part(id).pins.some((p) => p.net !== undefined && nets.has(p.net)));
    // Sharing ground says nothing: nearly everything does. A shared supply is what counts.
    const onSupply = sharing(supply);
    const near = ctx.rules.on("decoupling-near-pin")
      ? (onSupply.length > 0 ? onSupply : sharing(rails)).sort(
          (a, b) =>
            Math.abs(ctx.part(a).order - order) - Math.abs(ctx.part(b).order - order) ||
            ctx.part(a).order - ctx.part(b).order,
        )[0]
      : undefined;
    if (near === undefined) {
      freeStacks.push(s);
      continue;
    }
    const list = decoupling.get(near) ?? [];
    list.push(s);
    decoupling.set(near, list);
  }

  const freeHangers = an.hangers.filter((h) => !seenHanger.has(h));
  const freeChains = an.chains.filter((c) => c.kind === "through" && !seenChain.has(c.id));
  return {
    rows: kept,
    direct,
    risers,
    loops,
    decoupling,
    freeHangers,
    freeChains,
    freeStacks,
    ties,
  };
}
