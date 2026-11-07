import { Ctx, isPort, type Placement } from "./context.js";
import { placedPins, pointKey, transformRect, translate, unionRects } from "./geometry.js";
import { classify } from "./passes/classify.js";
import { normalizeWires, placeText } from "./passes/cleanup.js";
import { placeDecoupling } from "./passes/decoupling.js";
import { deriveFlow } from "./passes/flow.js";
import { orderColumns } from "./passes/order.js";
import {
  newSheet,
  pinKey,
  placeComponent,
  placeLine,
  placeRun,
  type Sheet,
} from "./passes/place.js";
import { placePower } from "./passes/power.js";
import { type RouteRequest, route } from "./passes/route.js";
import { buildRows, type RowPlan } from "./passes/rows.js";
import { type RuleOverrides, Rules, resolveRules } from "./rules.js";
import type {
  LayoutInput,
  LayoutResult,
  NetLabel,
  PlacedPart,
  PlacedPin,
  PowerSymbol,
  Pt,
  Rect,
  TraceEntry,
  Wire,
} from "./types.js";

function sheetBounds(ctx: Ctx, sheet: Sheet): Rect {
  const rects: Rect[] = [];
  for (const [id, pl] of sheet.placements) {
    const box = transformRect(ctx.part(id).box, pl.rotation, pl.mirror);
    rects.push(translate(box, pl.at.x, pl.at.y));
    // Room for the power symbols that will land on its pins.
    if (ctx.isTwoTerminal(ctx.part(id))) rects.push(translate(box, pl.at.x, pl.at.y - 3));
  }
  for (const group of sheet.prewires) {
    for (const w of group) {
      rects.push({ x: Math.min(w.a.x, w.b.x), y: Math.min(w.a.y, w.b.y), w: 0, h: 0 });
      rects.push({ x: Math.max(w.a.x, w.b.x), y: Math.max(w.a.y, w.b.y), w: 0, h: 0 });
    }
  }
  return unionRects(rects);
}

function shiftSheet(sheet: Sheet, dx: number, dy: number) {
  const move = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy });
  for (const pl of sheet.placements.values()) pl.at = move(pl.at);
  sheet.prewires = sheet.prewires.map((g) =>
    g.map((w) => ({ net: w.net, a: move(w.a), b: move(w.b) })),
  );
  sheet.symbols = sheet.symbols.map((s) => ({ ...s, at: move(s.at) }));
}

interface Group {
  sheet: Sheet;
  /** Breaks ties when sorting, independently of declaration order. */
  key: string;
}

/** Lays out whatever has no wire or anchor to sit on, in one row. */
function placeLoose(ctx: Ctx, plan: RowPlan): Sheet {
  const tray = newSheet();
  const rules = ctx.rules;
  const byId = <T>(list: T[], id: (item: T) => string) =>
    [...list].sort((a, b) => (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0));
  let x = 0;
  for (const s of byId(plan.freeStacks, (t) => t.parts[0] as string)) {
    placeRun(ctx, tray, s.parts, s.nets, { x, y: 3 }, 270);
    x += rules.num("decoupling-near-pin", "spacing");
    for (const p of s.parts) ctx.roles.set(p, "free");
  }
  for (const h of byId(plan.freeHangers, (t) => t.parts[0] as string)) {
    const start = { x, y: 3 };
    if (h.dir === "down") {
      placeRun(ctx, tray, h.parts, h.nets, start, 270);
    } else {
      placeRun(ctx, tray, [...h.parts].reverse(), [...h.nets].reverse(), start, 270);
    }
    x += rules.num("shunt-hang", "spacing");
    for (const p of h.parts) {
      ctx.roles.set(p, "free");
      ctx.note(p, "shunt-hang", "set aside: this rule is off");
    }
  }
  for (const c of byId(plan.freeChains, (t) => t.parts[0] as string)) {
    placeLine(ctx, tray, c.parts, c.nets, { x, y: 3 });
    x += c.parts.reduce((s, id) => s + Math.max(ctx.part(id).box.w, ctx.part(id).box.h) + 2, 0);
    for (const p of c.parts) ctx.roles.set(p, "free");
  }
  return tray;
}

/** The room a group needs: its extent, plus the symbols its rail pins will get. */
function groupRoom(ctx: Ctx, sheet: Sheet): Rect {
  const rects: Rect[] = [sheetBounds(ctx, sheet)];
  for (const [id, pl] of sheet.placements) {
    const part = ctx.part(id);
    if (!part.pins.some((p) => p.net !== undefined && ctx.role(p.net) !== "signal")) continue;
    const box = translate(transformRect(part.box, pl.rotation, pl.mirror), pl.at.x, pl.at.y);
    rects.push({ x: box.x - 2, y: box.y - 4, w: box.w + 4, h: box.h + 8 });
  }
  return unionRects(rects);
}

/** Lays groups out in rows, largest first, aiming for the shape the rule asks for. */
function packGroups(ctx: Ctx, groups: Group[]): Sheet {
  const out = newSheet();
  const merge = (g: Group, dx: number, dy: number) => {
    shiftSheet(g.sheet, dx, dy);
    for (const [id, pl] of g.sheet.placements) out.placements.set(id, pl);
    out.prewires.push(...g.sheet.prewires);
    out.symbols.push(...g.sheet.symbols);
    for (const k of g.sheet.handled) out.handled.add(k);
  };
  const only = groups.length === 1 ? groups[0] : undefined;
  if (only) {
    const b = sheetBounds(ctx, only.sheet);
    merge(only, -Math.floor(b.x), -Math.floor(b.y));
    return out;
  }

  const gap = ctx.rules.num("pack-groups", "gap");
  const items = groups.map((g) => ({ g, room: groupRoom(ctx, g.sheet) }));
  if (!ctx.rules.on("pack-groups")) {
    let top = 0;
    for (const { g, room } of items) {
      merge(g, -Math.floor(room.x), top - Math.floor(room.y));
      top += Math.ceil(room.h) + gap;
    }
    return out;
  }

  // First fit: tallest first, each group joining the first row with room for it.
  items.sort((a, b) => b.room.h - a.room.h || (a.g.key < b.g.key ? -1 : a.g.key > b.g.key ? 1 : 0));
  const area = items.reduce((s, i) => s + (i.room.w + gap) * (i.room.h + gap), 0);
  const widest = Math.max(...items.map((i) => i.room.w));
  const target = Math.max(widest, Math.sqrt(area * ctx.rules.num("pack-groups", "aspect")));
  const shelves: { y: number; x: number; h: number }[] = [];
  for (const { g, room } of items) {
    let shelf = shelves.find((r) => r.x + room.w <= target);
    if (!shelf) {
      const last = shelves.at(-1);
      shelf = { y: last ? last.y + last.h + gap : 0, x: 0, h: Math.ceil(room.h) };
      shelves.push(shelf);
    }
    merge(g, shelf.x - Math.floor(room.x), shelf.y - Math.floor(room.y));
    shelf.x += Math.ceil(room.w) + gap;
  }
  return out;
}

/** Lays out one block. The same input and rules always give the same drawing. */
export function layoutBlock(input: LayoutInput, overrides: RuleOverrides = {}): LayoutResult {
  const rules = new Rules(resolveRules(overrides));
  const ctx = new Ctx(input, rules);
  const an = classify(ctx);
  const flow = deriveFlow(ctx, an);

  const columnsOf = flow.components.map((comp) => orderColumns(ctx, flow, comp));
  const plan = buildRows(ctx, an, flow, columnsOf.flat());

  // Each group of connected anchors is drawn alone, then the groups are packed.
  const groups: Group[] = columnsOf.map((columns) => {
    const part = newSheet();
    placeComponent(ctx, plan, columns, part);
    return { sheet: part, key: [...columns.flat()].sort()[0] as string };
  });
  const tray = placeLoose(ctx, plan);
  if (tray.placements.size > 0) groups.push({ sheet: tray, key: "\uffff" });

  const sheet = packGroups(ctx, groups);
  if (rules.on("decoupling-near-pin")) placeDecoupling(ctx, plan, columnsOf.flat(2), sheet);

  const placed: PlacedPart[] = [];
  const portBoxes: Rect[] = [];
  const pins = new Map<string, PlacedPin>();
  const labels: NetLabel[] = [];
  for (const [id, pl] of sheet.placements) {
    const part = ctx.part(id);
    const list = placedPins(part, pl.at, pl.rotation, pl.mirror);
    const box = translate(transformRect(part.box, pl.rotation, pl.mirror), pl.at.x, pl.at.y);
    for (const pin of list) pins.set(pinKey({ part: id, pin: pin.id }), pin);
    if (isPort(id)) {
      const pin = list[0] as PlacedPin;
      portBoxes.push(box);
      labels.push({
        net: pin.net as string,
        text: pin.net as string,
        kind: "port",
        at: pin.at,
        outward: pin.outward === 0 ? 180 : 0,
        box,
      });
      continue;
    }
    placed.push({
      id,
      ref: part.ref,
      ...(part.value !== undefined ? { value: part.value } : {}),
      kind: part.kind,
      at: pl.at,
      rotation: pl.rotation,
      mirror: pl.mirror,
      box,
      pins: list,
      text: [],
      role: ctx.roles.get(id) ?? "anchor",
      column: ctx.columns.get(id) ?? -1,
    });
  }
  placed.sort((a, b) => ctx.part(a.id).order - ctx.part(b.id).order);

  // Adjacent side pins on one rail share the symbol on the first of them.
  for (const t of plan.ties) {
    sheet.handled.add(pinKey(t.b));
    const a = pins.get(pinKey(t.a)) as PlacedPin;
    const b = pins.get(pinKey(t.b)) as PlacedPin;
    sheet.prewires.push([{ net: t.net, a: a.at, b: b.at }]);
  }

  // Parts first, since symbols need to see them, then the symbols and their stubs.
  const bodies = placed.map((p) => p.box);
  const { symbols: power, markers } = placePower(ctx, sheet, plan.risers, pins, [
    ...bodies,
    ...portBoxes,
  ]);

  const useSymbols = rules.on("local-power-symbols");
  const nets: RouteRequest["nets"] = [];
  for (const net of input.nets) {
    const refs = ctx.netPins.get(net.name) ?? [];
    const onWire = (k: string) => sheet.handled.has(k);
    const isRailWire = an.railWires.has(net.name);
    let terminals: Pt[] = [];
    if (net.role === "signal" || !useSymbols) {
      terminals = refs.map((r) => (pins.get(pinKey(r)) as PlacedPin).at);
    } else if (isRailWire) {
      terminals = refs
        .filter((r) => onWire(pinKey(r)))
        .map((r) => (pins.get(pinKey(r)) as PlacedPin).at);
      for (const s of sheet.symbols) if (s.net === net.name) terminals.push(s.at);
    }
    if (terminals.length >= 2) nets.push({ net: net.name, terminals });
  }

  // A symbol on a stub still has to reach its pin if the planned stub did not fit.
  const links: RouteRequest["links"] = [];
  for (const s of sheet.symbols) {
    const pin = s.pin ? pins.get(pinKey(s.pin)) : undefined;
    if (pin && !an.railWires.has(s.net)) links.push({ net: s.net, terminals: [pin.at, s.at] });
  }

  const req: RouteRequest = {
    bodies,
    solids: [...power.map(symbolBody), ...portBoxes, ...markers.map((m) => m.box)],
    pins: [...pins.values()],
    anchorPins: new Set(
      [...ctx.parts.values()]
        .filter((p) => !ctx.isTwoTerminal(p))
        .flatMap((p) => p.pins.map((q) => pins.get(pinKey({ part: p.id, pin: q.id }))))
        .map((p) => pointKey((p as PlacedPin).at)),
    ),
    anchors: power.map((s) => ({ net: s.net, at: s.at })),
    prewires: sheet.prewires,
    nets,
    links,
  };
  const routed = route(ctx, req, (n) => an.railWires.has(n));
  for (const l of routed.labels) labels.push(l);

  // A port is drawn only as its label, so its internal pin is left out.
  const connections = new Map<string, Pt[]>();
  for (const { net, at } of [...placed.flatMap((p) => p.pins), ...power, ...markers, ...labels]) {
    if (net === undefined) continue;
    const list = connections.get(net) ?? [];
    list.push(at);
    connections.set(net, list);
  }
  const clean = normalizeWires(routed.wires, connections);
  placeText(
    placed,
    clean.wires,
    power,
    labels.map((l) => l.box),
  );

  const noConnects = [...pins.values()].filter((p) => p.net === undefined).map((p) => p.at);
  const bounds = unionRects([
    ...placed.flatMap((p) => [p.box]),
    ...power.map((s) => s.box),
    ...labels.map((l) => l.box),
    ...markers.map((m) => m.box),
    ...clean.wires.map(wireRect),
  ]);

  const trace: Record<string, TraceEntry[]> = {};
  for (const p of placed) trace[p.id] = ctx.trace.get(p.id) ?? [];
  for (const n of routed.notes) {
    for (const r of ctx.netPins.get(n.net) ?? []) {
      if (isPort(r.part)) continue;
      trace[r.part]?.push({ rule: "label-fallback", note: `net ${n.net}: ${n.note}` });
    }
  }

  return {
    name: input.name,
    parts: placed,
    wires: clean.wires,
    junctions: clean.junctions,
    power,
    labels,
    noConnects,
    markers,
    bounds,
    trace,
    unrouted: routed.unrouted,
  };
}

/** A symbol"s body, less the line it connects on, so wires can reach it from the side. */
const symbolBody = (s: PowerSymbol): Rect =>
  s.outward === 270
    ? { x: s.box.x, y: s.at.y + 1, w: s.box.w, h: s.box.h - 1 }
    : { x: s.box.x, y: s.box.y, w: s.box.w, h: s.box.h - 1 };

const wireRect = (w: Wire): Rect => ({
  x: Math.min(w.a.x, w.b.x),
  y: Math.min(w.a.y, w.b.y),
  w: Math.abs(w.a.x - w.b.x),
  h: Math.abs(w.a.y - w.b.y),
});

export type { Placement };
