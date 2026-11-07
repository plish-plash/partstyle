import type { Ctx, Hanger, PinRef, Placement, Stack } from "../context.js";
import { rectsOverlap, transformPoint, transformRect, translate } from "../geometry.js";
import type { Direction, LayoutPart, Pt, Rect, Rotation, Wire } from "../types.js";
import { facing, localPin, type Row, type RowItem, type RowPlan, riserRoom } from "./rows.js";

/** Height of a power symbol with its name. */
export const SYMBOL_HEIGHT = 3;
/** Space kept clear above a horizontal part for its text. */
const TEXT_ABOVE = 3;
const PART_GAP = 1;
/** Stands for a wire spanning a whole gap. */
const ENDLESS = 100000;

export interface Sheet {
  placements: Map<string, Placement>;
  /** Wires known in advance, each group checked and committed whole by the router. */
  prewires: Wire[][];
  /** Power symbols that sit on a wire instead of a pin, with the pin they serve if any. */
  symbols: { net: string; at: Pt; pin?: PinRef }[];
  /** Pins given a wire or a symbol here, so power does not add another. */
  handled: Set<string>;
}

export const pinKey = (r: PinRef) => `${r.part}\u0000${r.pin}`;

export function newSheet(): Sheet {
  return { placements: new Map(), prewires: [], symbols: [], handled: new Set() };
}

export const spanOf = (p: LayoutPart) => {
  const [a, b] = p.pins;
  return Math.abs((a?.x ?? 0) - (b?.x ?? 0)) + Math.abs((a?.y ?? 0) - (b?.y ?? 0));
};

/** Places a two-terminal part so its pin on `nearNet` lands on `at` and it runs toward `dir`. */
function placeTwo(sheet: Sheet, p: LayoutPart, nearNet: string, at: Pt, dir: Direction) {
  const first = p.pins[0]?.net === nearNet;
  const near = (first ? p.pins[0] : p.pins[1]) as LayoutPart["pins"][number];
  const far = (first ? p.pins[1] : p.pins[0]) as LayoutPart["pins"][number];
  // The way the part runs as drawn, whichever way its symbol happens to be drawn.
  const drawn = far.x > near.x ? 0 : far.x < near.x ? 180 : far.y < near.y ? 90 : 270;
  const rotation = ((dir - drawn + 360) % 360) as Rotation;
  const o = transformPoint(near, rotation, false);
  sheet.placements.set(p.id, {
    at: { x: at.x - o.x, y: at.y - o.y },
    rotation,
    mirror: false,
  });
}

/** Lays parts out in a vertical run from `start`. */
export function placeRun(
  ctx: Ctx,
  sheet: Sheet,
  parts: string[],
  nets: string[],
  start: Pt,
  dir: 90 | 270,
) {
  const dy = dir === 270 ? 1 : -1;
  let y = start.y;
  parts.forEach((id, i) => {
    const p = ctx.part(id);
    placeTwo(sheet, p, nets[i] as string, { x: start.x, y }, dir);
    y += dy * (spanOf(p) + PART_GAP);
  });
}

/** Lays parts out in a horizontal run rightward from `at`. */
export function placeLine(ctx: Ctx, sheet: Sheet, parts: string[], nets: string[], at: Pt) {
  let x = at.x;
  parts.forEach((id, i) => {
    const p = ctx.part(id);
    placeTwo(sheet, p, nets[i] as string, { x, y: at.y }, 0);
    x += spanOf(p) + PART_GAP;
  });
}

const runLength = (ctx: Ctx, parts: string[]) =>
  parts.reduce((s, id) => s + spanOf(ctx.part(id)), 0) + Math.max(0, parts.length - 1) * PART_GAP;

export const hangerHeight = (ctx: Ctx, h: Hanger) =>
  (h.stem ?? 0) + runLength(ctx, h.parts) + SYMBOL_HEIGHT;
export const stackHeight = (ctx: Ctx, s: Stack) => runLength(ctx, s.parts) + SYMBOL_HEIGHT * 2;

const upOf = (ctx: Ctx, r: Row) =>
  Math.max(0, ...r.items.map((i) => (i.t === "hang" && i.up ? hangerHeight(ctx, i.up) : 0)));
const downOf = (ctx: Ctx, r: Row) =>
  Math.max(0, ...r.items.map((i) => (i.t === "hang" && i.down ? hangerHeight(ctx, i.down) : 0)));
const hasSeries = (r: Row) => r.items.some((i) => i.t === "series");
/**
 * A row that only carries a power symbol or a label. It stays short, right beside the part, and
 * the rows with real parts step past it.
 */
const isBare = (r: Row) =>
  !r.target &&
  r.items.length > 0 &&
  r.items.every(
    (i) => i.t === "port" || (i.t === "hang" && !i.up?.parts.length && !i.down?.parts.length),
  );

/** Spaces rows vertically in order, as close to their pins as the hanging parts allow. */
function solveRowHeights(ctx: Ctx, rows: Row[]) {
  const pitch = ctx.rules.num("chain-rows", "rowPitch");
  // A bare row off the bottom of a part stays by its pin, out of the way of the rows in the gap.
  const settled = rows.filter((r) => r.lifted === 1 && isBare(r));
  for (const r of settled) r.y = r.desired;
  const order = rows
    .filter((r) => !settled.includes(r))
    .sort((a, b) => a.desired - b.desired || b.side - a.side || a.seq - b.seq);
  /** The highest a row may sit given the rows before it in the order. */
  const floorOf = (r: Row, count: number) => {
    let y = Number.NEGATIVE_INFINITY;
    const prev = order[count - 1];
    if (prev) {
      let gap = 1;
      if (hasSeries(prev) && hasSeries(r)) gap = pitch;
      else if (hasSeries(r)) gap = 1 + TEXT_ABOVE;
      else if (hasSeries(prev)) gap = 2;
      y = prev.y + gap;
    }
    for (let k = 0; k < count; k++) {
      const o = order[k] as Row;
      if (r.target || o.target) {
        // A long row's hanging parts step past a bare row, so it need not move for them.
        if (!isBare(r)) y = Math.max(y, o.y + downOf(ctx, o) + 1);
        y = Math.max(y, o.y + upOf(ctx, r) + 1);
      }
      if (o.side === r.side && downOf(ctx, o) > 0 && upOf(ctx, r) > 0 && !isBare(r)) {
        y = Math.max(y, o.y + downOf(ctx, o) + upOf(ctx, r) + 1);
      }
    }
    return y;
  };
  order.forEach((r, i) => {
    if (r.lifted === -1) {
      r.y = r.desired;
      return;
    }
    let y = Math.max(r.desired, floorOf(r, i));
    const upper = r.bridgeUpper;
    const bridge = upper?.items.find((x) => x.t === "bridge");
    if (upper && bridge?.t === "bridge") {
      y = Math.max(y, upper.y + spanOf(ctx.part(bridge.chain.parts[0] as string)));
    }
    r.y = y;
  });
  // Pushing only ever moves rows down. Each run of rows pushed together recentres by itself, so
  // that most of the run sits level with its pins and rows that never moved stay where they are.
  if (ctx.rules.on("straighten-wires") && order.every((r) => r.lifted === 0)) {
    let i = 0;
    while (i < order.length) {
      let j = i + 1;
      while (j < order.length) {
        const r = order[j] as Row;
        // Rows joined by a bridge move as one.
        if (r.y === r.desired && !r.bridgeUpper) break;
        j++;
      }
      const run = order.slice(i, j);
      // Rows that run through the gap matter most; bare rows matter least.
      const through = run.filter((r) => r.target);
      const counted = through.length > 0 ? through : run.filter((r) => !isBare(r));
      const moves = counted.map((r) => r.y - r.desired).sort((a, b) => a - b);
      let shift = moves[Math.floor((moves.length - 1) / 2)] ?? 0;
      for (const r of run) shift = Math.min(shift, r.y - floorOf(r, i));
      if (shift > 0) for (const r of run) r.y -= shift;
      i = j;
    }
    // A shift suits the run as a whole, so a row it carried past its pin settles back down.
    const allowed = () => order.every((r, k) => r.lifted === -1 || k === 0 || r.y >= floorOf(r, k));
    for (let k = order.length - 1; k >= 0; k--) {
      const r = order[k] as Row;
      const bridged = r.bridgeUpper || r.items.some((x) => x.t === "bridge");
      if (r.y >= r.desired || bridged) continue;
      const start = r.y;
      for (let y = r.desired; y > start; y--) {
        r.y = y;
        if (allowed()) break;
        r.y = start;
      }
    }
  }
}

/**
 * Lines up matching hangers from neighbouring rows: each gets a stem down to the level of the
 * furthest row, so their parts sit in a line instead of a staircase.
 */
function alignHangers(ctx: Ctx, rows: Row[]) {
  const groups = new Map<string, { h: Hanger; y: number }[]>();
  for (const r of rows) {
    if (r.target || r.items.length !== 1) continue;
    const item = r.items[0];
    if (item?.t !== "hang" || (item.up && item.down)) continue;
    const h = item.up ?? item.down;
    if (!h || h.parts.length === 0) continue;
    const key = [r.side, h.dir, ...h.parts.map((p) => ctx.part(p).kind)].join(":");
    const list = groups.get(key) ?? [];
    list.push({ h, y: r.y });
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const ys = list.map((e) => e.y);
    const level = list[0]?.h.dir === "up" ? Math.min(...ys) : Math.max(...ys);
    for (const e of list) {
      const stem = Math.abs(e.y - level);
      if (stem > 0) e.h.stem = stem;
    }
  }
}

/**
 * Gives each step between a row and a pin its own vertical track. Steps going the same way nest:
 * the row furthest along turns closest to the column.
 */
function assignTracks(steps: { y: number; pinY: number; set: (track: number) => void }[]) {
  const above = steps.filter((s) => s.y < s.pinY).sort((a, b) => a.y - b.y);
  const below = steps.filter((s) => s.y > s.pinY).sort((a, b) => b.y - a.y);
  above.forEach((s, i) => {
    s.set(i);
  });
  below.forEach((s, i) => {
    s.set(i);
  });
  return Math.max(above.length, below.length);
}

interface PlacedItem {
  item: RowItem;
  /** Signed offset from the column edge the row leaves. */
  x: number;
}

interface GapRow {
  row: Row;
  items: PlacedItem[];
  /** Vertical track for the step from the pin to the row. */
  track: number;
  /** Vertical track for the step from the row to its target pin. */
  endTrack: number;
  /** Signed reach of the row's last item. */
  reach: number;
  /** Width kept clear beside the column the row leaves, and the one it reaches. */
  room: number;
  endRoom: number;
}

const collides = (r: Rect, occ: Rect[]) => occ.some((o) => rectsOverlap(r, o));
const isSolid = (r: Rect) => r.h > 0 && r.w < ENDLESS;

function hangRect(ctx: Ctx, x: number, y: number, item: Extract<RowItem, { t: "hang" }>): Rect {
  const up = item.up ? hangerHeight(ctx, item.up) : 0;
  const down = item.down ? hangerHeight(ctx, item.down) : 0;
  const bare = !item.up?.parts.length && !item.down?.parts.length;
  const w = bare ? 3 : ctx.rules.num("shunt-hang", "spacing") - 1;
  return { x: x - 1, y: y - up, w, h: up + down };
}

function portRect(ctx: Ctx, id: string, side: 1 | -1, v: number, y: number): Rect {
  const w = ctx.part(id).box.w;
  return { x: side === 1 ? v : -v - w, y: y - 0.4, w, h: 0.8 };
}

/** Finds the first column at or past `u` where `probe` fits. */
function firstFree(u: number, probe: (v: number) => Rect, occ: Rect[]): number {
  let v = u;
  for (let n = 0; n < 400 && collides(probe(v), occ); n++) v++;
  return v;
}

/**
 * Orders rows so each is placed before any row whose hanging parts reach across it. A part can
 * then always step past the rows it spans.
 */
function nestingOrder(ctx: Ctx, rows: Row[]): Row[] {
  const spans = (over: Row, under: Row) =>
    (under.y > over.y && under.y < over.y + downOf(ctx, over)) ||
    (under.y < over.y && under.y > over.y - upOf(ctx, over));
  const left = [...rows].sort((a, b) => b.y - a.y);
  const out: Row[] = [];
  while (left.length > 0) {
    // Mutual spans cannot be satisfied; rows were spaced to avoid them, so take the first.
    const i = Math.max(
      0,
      left.findIndex((r) => !left.some((o) => o !== r && spans(r, o))),
    );
    out.push(...left.splice(i, 1));
  }
  return out;
}

/**
 * Assigns a column to every item on one side of a gap. Through rows go first and fill the gap;
 * the rest step around each other, which is what keeps wires from crossing: a part hanging across
 * lower rows must sit past where they end, so the lowest row takes the nearest column.
 */
function layoutSide(
  ctx: Ctx,
  rows: Row[],
  side: 1 | -1,
  occ: Rect[],
  gap: Map<Row, GapRow>,
  channel: number,
  room: number,
  pinOffset: (r: Row) => number,
) {
  const spacing = ctx.rules.num("shunt-hang", "spacing");
  const mine = rows.filter((r) => r.side === side);
  const start = Math.max(2, channel + 2) + room;

  const place = (r: Row): PlacedItem[] => {
    const placed: PlacedItem[] = [];
    let u = start;
    // A row off a top or bottom pin may stop right above that pin, on a straight wire, when what
    // it carries fits in the space over the part.
    const first = r.items[0];
    const overPin =
      r.lifted !== 0 &&
      r.anchor !== undefined &&
      ((first?.t === "port" && r.items.length === 1) ||
        (first?.t === "hang" &&
          (r.lifted === -1 ? first.up && !first.down : first.down && !first.up)));
    if (overPin && first) {
      const v = pinOffset(r);
      const fits = (x: number) =>
        first.t === "port" ? x + ctx.part(first.id).box.w <= 0 : x === v;
      const probe = (x: number): Rect =>
        first.t === "port"
          ? portRect(ctx, first.id, side, x, r.y)
          : hangRect(ctx, side * x, r.y, first as Extract<RowItem, { t: "hang" }>);
      const spot = firstFree(v, probe, occ);
      if (fits(spot)) u = spot;
    }
    // A hanger going the way its row stepped can start on the step itself, so the wire runs
    // straight into it. Later rows follow it in: the steps they would hit all end above them.
    const below = r.y > r.desired;
    const steppedInto =
      r.lifted === 0 &&
      r.anchor !== undefined &&
      r.y !== r.desired &&
      !r.bridgeUpper &&
      first?.t === "hang" &&
      (below ? first.down && !first.up : first.up && !first.down);
    if (steppedInto && first?.t === "hang") {
      const track = 1 + room + (gap.get(r) as GapRow).track;
      u = firstFree(track, (v) => hangRect(ctx, side * v, r.y, first), occ);
    }
    for (const item of r.items) {
      if (item.t === "bridge") {
        const probe = (v: number): Rect => ({
          x: side * v - 1,
          y: r.y,
          w: spacing - 1,
          h: item.mate.y - r.y,
        });
        u = firstFree(u, probe, occ);
        placed.push({ item, x: side * u });
        occ.push(probe(u));
        u += spacing;
      } else if (item.t === "hang") {
        const probe = (v: number) => hangRect(ctx, side * v, r.y, item);
        u = firstFree(u, probe, occ);
        placed.push({ item, x: side * u });
        occ.push(probe(u));
        u += !item.up?.parts.length && !item.down?.parts.length ? 2 : spacing;
      } else if (item.t === "port") {
        const probe = (v: number) => portRect(ctx, item.id, side, v, r.y);
        u = firstFree(u, probe, occ);
        placed.push({ item, x: side * u });
        occ.push(probe(u));
        u += ctx.part(item.id).box.w + 1;
      } else {
        const len = runLength(ctx, item.parts);
        const probe = (v: number): Rect => ({
          x: side === 1 ? v - 1 : -v - len - 1,
          y: r.y - TEXT_ABOVE,
          w: len + 2,
          h: TEXT_ABOVE + 1,
        });
        u = firstFree(u, probe, occ);
        placed.push({ item, x: side * u });
        occ.push(probe(u));
        u += len + 2;
      }
    }
    return placed;
  };

  // Bare symbols take the first columns, so hanging parts step past them.
  const bare = mine.filter(isBare);
  const through = mine.filter((r) => r.target);
  const rest = mine.filter((r) => !r.target && !isBare(r));
  for (const r of [...bare, ...through, ...nestingOrder(ctx, rest)]) {
    const g = gap.get(r) as GapRow;
    g.items = place(r);
    const last = g.items.at(-1);
    g.reach = last ? last.x : 0;
    if (last?.item.t === "series") g.reach += side * runLength(ctx, last.item.parts);
    if (last?.item.t === "port") g.reach += side * ctx.part(last.item.id).box.w;
    if (r.bridgeUpper) {
      const b = gap.get(r.bridgeUpper)?.items.find((x) => x.item.t === "bridge");
      if (b) g.reach = side * Math.max(side * g.reach, side * b.x);
    }
    const x0 = Math.min(0, g.reach);
    occ.push(
      r.target
        ? { x: -ENDLESS, y: r.y, w: ENDLESS * 2, h: 0 }
        : { x: x0, y: r.y, w: Math.abs(g.reach), h: 0 },
    );
  }
}

/** Lays out one group of connected anchors, column by column. */
export function placeComponent(ctx: Ctx, plan: RowPlan, columns: string[][], sheet: Sheet) {
  const boxOf = (id: string): Rect =>
    transformRect(ctx.part(id).box, 0, ctx.mirror.get(id) ?? false);
  const rowsOf = (id: string) => plan.rows.filter((r) => r.anchor === id);
  const hasPinsFacing = (id: string, dir: Direction) =>
    ctx.part(id).pins.some((p) => p.net !== undefined && facing(ctx, id, p) === dir);
  const liftedCount = (id: string, lift: -1 | 1) =>
    rowsOf(id).filter((r) => r.lifted === lift).length;
  /** Distance from the box to the first free line above (-1) or below (1) it. */
  const clearance = (id: string, lift: -1 | 1) => {
    const pins = hasPinsFacing(id, lift === -1 ? 90 : 270);
    return (
      (pins ? SYMBOL_HEIGHT + 1 : 1) + (liftedCount(id, lift) > 0 ? liftedCount(id, lift) + 1 : 0)
    );
  };

  /** Vertical room an anchor needs beyond its box. */
  const extents = (id: string) => {
    const box = boxOf(id);
    let top = clearance(id, -1);
    let bottom = clearance(id, 1);
    for (const d of plan.direct.filter((x) => x.anchor === id)) {
      const h = hangerHeight(ctx, d.hanger) + 2;
      if (d.hanger.dir === "up") top = Math.max(top, h);
      else bottom = Math.max(bottom, h);
    }
    const risers = plan.risers.filter((r) => r.anchor === id);
    const riserReach = ctx.rules.num("power-risers", "gap") + SYMBOL_HEIGHT + 1;
    if (risers.some((r) => r.dir === "up")) top = Math.max(top, riserReach);
    if (risers.some((r) => r.dir === "down")) bottom = Math.max(bottom, riserReach);
    top += (plan.loops.get(id)?.length ?? 0) * (TEXT_ABOVE + 2);
    // A dry run of the side rows, for how far they spread past the part.
    const side = rowsOf(id).filter((r) => r.lifted === 0);
    for (const r of side) r.desired = localPin(ctx, id, ctx.pin(pinRef(r))).y;
    solveRowHeights(ctx, side);
    for (const r of side) {
      top = Math.max(top, box.y - (r.y - upOf(ctx, r)));
      bottom = Math.max(bottom, r.y + downOf(ctx, r) - (box.y + box.h));
    }
    return { top, bottom };
  };

  const pinRef = (r: Row): PinRef => ({ part: r.anchor as string, pin: r.pin as string });
  const pinAt = (ref: PinRef): Pt => {
    const pl = sheet.placements.get(ref.part) as Placement;
    const o = transformPoint(ctx.pin(ref), pl.rotation, pl.mirror);
    return { x: pl.at.x + o.x, y: pl.at.y + o.y };
  };

  const colLeft: number[] = [];
  const colRight: number[] = [];
  const room = new Map<string, { top: number; bottom: number }>();
  const straighten = ctx.rules.on("straighten-wires");
  const maxShift = ctx.rules.num("straighten-wires", "maxShift");

  const placeColumn = (c: number, x: number) => {
    const col = columns[c] as string[];
    const width = Math.max(0, ...col.map((id) => boxOf(id).w));
    colLeft[c] = x;
    colRight[c] = x + width;
    let cursor: number | undefined;
    for (const id of col) {
      const box = boxOf(id);
      const ext = extents(id);
      room.set(id, ext);
      const wants = plan.rows
        .filter((r) => r.target?.part === id && r.anchor !== undefined)
        .map((r) => pinAt(pinRef(r)).y - localPin(ctx, id, ctx.pin(r.target as PinRef)).y)
        .sort((a, b) => a - b);
      const base = cursor === undefined ? 0 : cursor + ext.top - box.y;
      let y = base;
      if (straighten && wants.length > 0) {
        const want = wants[Math.floor((wants.length - 1) / 2)] as number;
        if (cursor === undefined || (want >= base && want - base <= maxShift)) {
          y = want;
          ctx.note(id, "straighten-wires", `lined up with ${wants.length} incoming wire(s)`);
        }
      }
      const faceRight = ctx.part(id).pins.every((p) => facing(ctx, id, p) === 0);
      sheet.placements.set(id, {
        at: { x: (faceRight ? x + width - box.w : x) - box.x, y },
        rotation: 0,
        mirror: ctx.mirror.get(id) ?? false,
      });
      cursor = y + box.y + box.h + ext.bottom + 1;
      placeSatellites(id);
    }
  };

  const placeSatellites = (id: string) => {
    const pl = sheet.placements.get(id) as Placement;
    const box = translate(boxOf(id), pl.at.x, pl.at.y);

    for (const d of plan.direct.filter((x) => x.anchor === id)) {
      const pin = pinAt({ part: id, pin: d.pin });
      const up = d.hanger.dir === "up";
      const start = { x: pin.x, y: pin.y + (up ? -1 : 1) };
      placeRun(ctx, sheet, d.hanger.parts, d.hanger.nets, start, up ? 90 : 270);
      for (const p of d.hanger.parts) ctx.note(p, "shunt-hang", `hangs straight from ${id}`);
    }

    // Feedback parts stack above the anchor.
    let top = box.y - clearance(id, -1);
    for (const chain of plan.loops.get(id) ?? []) {
      const len = runLength(ctx, chain.parts);
      placeLine(ctx, sheet, chain.parts, chain.nets, {
        x: Math.round(box.x + (box.w - len) / 2),
        y: top - 1,
      });
      for (const p of chain.parts) {
        ctx.note(p, "follow-pin-side", `feedback around ${id}, kept out of the signal path`);
      }
      top -= TEXT_ABOVE + 2;
    }
  };

  /** Moves anchors and everything that travels with them. */
  const moveAnchors = (ids: string[], dx: number, dy: number) => {
    const moved = new Set<string>();
    for (const id of ids) {
      moved.add(id);
      for (const d of plan.direct) {
        if (d.anchor === id) for (const p of d.hanger.parts) moved.add(p);
      }
      for (const chain of plan.loops.get(id) ?? []) for (const p of chain.parts) moved.add(p);
    }
    for (const id of moved) {
      const pl = sheet.placements.get(id);
      if (pl) pl.at = { x: pl.at.x + dx, y: pl.at.y + dy };
    }
  };

  const shiftColumn = (c: number, x: number) => {
    const dx = x - (colLeft[c] as number);
    colLeft[c] = x;
    colRight[c] = (colRight[c] as number) + dx;
    moveAnchors(columns[c] as string[], dx, 0);
  };

  /**
   * Slides the anchors of a column by the amount `step` asks of each, top to bottom, without
   * letting one touch the anchor above it.
   */
  const slideColumn = (c: number, step: (id: string) => number[]) => {
    let floor: number | undefined;
    for (const id of columns[c] ?? []) {
      const box = boxOf(id);
      const ext = room.get(id) as { top: number; bottom: number };
      const pl = sheet.placements.get(id) as Placement;
      const steps = step(id).sort((a, b) => a - b);
      let dy = steps[Math.floor((steps.length - 1) / 2)] ?? 0;
      if (Math.abs(dy) > maxShift) dy = 0;
      if (floor !== undefined) dy = Math.max(dy, floor + ext.top - box.y - pl.at.y);
      if (dy !== 0) {
        moveAnchors([id], 0, dy);
        ctx.note(id, "straighten-wires", "moved to meet the rows reaching it");
      }
      floor = pl.at.y + box.y + box.h + ext.bottom + 1;
    }
  };

  /** The y a row wants: level with its pin, or clear of the part for one lifted off an edge. */
  const desiredY = (r: Row): number => {
    const pin = pinAt(pinRef(r));
    if (r.lifted === 0) return pin.y;
    const id = r.anchor as string;
    const y = (sheet.placements.get(id) as Placement).at.y;
    const b = translate(boxOf(id), 0, y);
    const dir = r.lifted === -1 ? 90 : 270;
    const inWay = ctx
      .part(id)
      .pins.some(
        (p) =>
          p.net !== undefined &&
          p.net !== r.net &&
          facing(ctx, id, p) === dir &&
          ctx.role(p.net) !== "signal" &&
          r.side * (localPin(ctx, id, p).x - pin.x + (sheet.placements.get(id) as Placement).at.x) >
            0,
      );
    const clear = (inWay ? SYMBOL_HEIGHT + 1 : 2) + r.liftIndex;
    return r.lifted === -1 ? b.y - clear : b.y + b.h + clear;
  };

  /** Solves the gap to the right of column `c`. Returns its width and a step to draw it. */
  const layoutGap = (c: number) => {
    const left = columns[c] ?? [];
    const right = columns[c + 1] ?? [];
    const rows = plan.rows.filter(
      (r) =>
        r.anchor !== undefined &&
        ((r.side === 1 && left.includes(r.anchor)) || (r.side === -1 && right.includes(r.anchor))),
    );
    for (const r of plan.rows) {
      if (r.branchOf && rows.includes(rootOf(r))) rows.push(r);
    }
    const solve = () => {
      for (const r of rows) if (r.anchor !== undefined) r.desired = desiredY(r);
      for (const r of rows) if (r.anchor === undefined) r.desired = rootOf(r).desired + 1;
      solveRowHeights(ctx, rows);
    };
    // An anchor with rows of its own here stays put; what feeds it comes to it instead.
    const ownRows = rows.some(
      (r) => r.side === -1 && r.anchor !== undefined && right.includes(r.anchor),
    );
    const fromRows = (id: string) => rows.filter((r) => r.anchor === id && r.target);
    const movable = straighten && c === 0 && ownRows;
    if (movable) {
      slideColumn(c, (id) =>
        fromRows(id).map((r) => pinAt(r.target as PinRef).y - pinAt(pinRef(r)).y),
      );
    }
    solve();
    if (movable) {
      slideColumn(c, (id) => fromRows(id).map((r) => r.y - pinAt(pinRef(r)).y));
      solve();
    } else if (straighten && c >= 0 && right.length > 0) {
      slideColumn(c + 1, (id) =>
        rows.filter((r) => r.target?.part === id).map((r) => r.y - pinAt(r.target as PinRef).y),
      );
      solve();
    }
    if (ctx.rules.on("align-hangers")) alignHangers(ctx, rows);

    const roomLeft = riserRoom(plan, left, 1);
    const roomRight = riserRoom(plan, right, -1);
    const gap = new Map<Row, GapRow>();
    for (const r of rows) {
      gap.set(r, {
        row: r,
        items: [],
        track: 0,
        endTrack: 0,
        reach: 0,
        room: r.side === 1 ? roomLeft : roomRight,
        endRoom: roomRight,
      });
    }

    const edge = colRight[c] ?? 0;
    const occR: Rect[] = [];
    const occL: Rect[] = [];
    // Every step off a pin needs a track, whichever row it belongs to.
    const jogged = (r: Row) => r.lifted === 0 && r.anchor !== undefined && r.y !== r.desired;
    const trackSetter = (r: Row) => (t: number) => {
      (gap.get(r) as GapRow).track = t;
    };
    const channelLeft = assignTracks(
      rows
        .filter((r) => r.side === 1 && jogged(r))
        .map((r) => ({ y: r.y, pinY: r.desired, set: trackSetter(r) })),
    );
    const endChannel = assignTracks([
      ...rows
        .filter((r) => r.side === -1 && jogged(r))
        .map((r) => ({ y: r.y, pinY: r.desired, set: trackSetter(r) })),
      ...rows
        .filter((r) => r.target && pinAt(r.target).y !== r.y)
        .map((r) => ({
          y: r.y,
          pinY: pinAt(r.target as PinRef).y,
          set: (t: number) => {
            (gap.get(r) as GapRow).endTrack = t;
          },
        })),
    ]);
    const pinOffset = (side: 1 | -1) => (r: Row) =>
      side * (pinAt(pinRef(r)).x - (side === 1 ? edge : (colLeft[c + 1] as number)));
    layoutSide(ctx, rows, 1, occR, gap, channelLeft, roomLeft, pinOffset(1));
    layoutSide(ctx, rows, -1, occL, gap, endChannel, roomRight, pinOffset(-1));

    let width = 3;
    for (const g of gap.values()) {
      if (g.row.side === 1) width = Math.max(width, g.reach + 2 + endChannel + roomRight);
    }
    for (const r of occR) if (isSolid(r)) width = Math.max(width, r.x + r.w + 1);
    if (right.length > 0 && left.length > 0) {
      // Left-running rows stay clear of the column they run toward.
      for (const r of occL) if (isSolid(r)) width = Math.max(width, 1 - r.x);
      for (const g of gap.values()) {
        if (g.row.side === -1) width = Math.max(width, 2 - g.reach);
      }
      // Slide the left-running rows in until they would touch the right-running ones.
      const a = occR.filter(isSolid);
      const b = occL.filter(isSolid);
      while (b.some((r) => collides(translate(r, width, 0), a))) width += 1;
    }

    /**
     * How far the column on the left can slide into the gap, as one, without touching what the
     * column on the right has hung there. Only worth doing where it shortens every wire.
     */
    const slide = () => {
      if (!movable) return 0;
      const reserve = endChannel + roomRight + 2 + roomLeft + channelLeft + 1;
      const block = occL.filter((r) => r.w < ENDLESS).map((r) => translate(r, width, 0));
      const moving = [
        ...occR.filter(isSolid),
        ...left.map((id) => {
          const pl = sheet.placements.get(id) as Placement;
          const b = translate(boxOf(id), pl.at.x - edge, pl.at.y);
          const margin = roomLeft + channelLeft + 2;
          return { x: b.x, y: b.y - 1, w: b.w + margin, h: b.h + 2 };
        }),
      ];
      for (let dx = width - reserve; dx > 0; dx--) {
        if (!moving.some((r) => collides(translate(r, dx, 0), block))) return dx;
      }
      return 0;
    };

    const draw = (xRight: number, xLeft = edge) => {
      for (const g of gap.values()) {
        emitRow(g, g.row.side === 1 ? xLeft : xRight, gap);
      }
    };
    return { width, draw, slide };
  };

  const rootOf = (r: Row): Row => (r.branchOf ? rootOf(r.branchOf) : r);

  const handle = (part: string, net: string) => {
    for (const p of ctx.part(part).pins) {
      if (p.net === net) sheet.handled.add(pinKey({ part, pin: p.id }));
    }
  };

  /** The pin a symbol on a row serves: the row's own, or the end of the chain before it. */
  const symbolPin = (g: GapRow, rail: string): PinRef | undefined => {
    if (g.row.anchor !== undefined && rail === g.row.net) return pinRef(g.row);
    for (const { item } of [...g.items].reverse()) {
      if (item.t !== "series") continue;
      const part = ctx.part(item.parts.at(-1) as string);
      const pin = part.pins.find((p) => p.net === rail);
      if (pin) return { part: part.id, pin: pin.id };
    }
    return undefined;
  };

  /** Places a row's parts now that its gap is final, and draws its wires. */
  const emitRow = (g: GapRow, base: number, gap: Map<Row, GapRow>) => {
    const r = g.row;
    const side = r.side;
    const y = r.y;
    const pieces: Wire[][] = [];
    let piece: Wire[] = [];
    let net = r.net;
    const add = (a: Pt, b: Pt) => {
      if (a.x !== b.x || a.y !== b.y) piece.push({ net, a, b });
    };
    const endPiece = () => {
      if (piece.length > 0) pieces.push(piece);
      piece = [];
    };

    let cur: Pt | undefined;
    if (r.anchor !== undefined) {
      const origin = pinAt(pinRef(r));
      sheet.handled.add(pinKey(pinRef(r)));
      if (r.lifted !== 0) {
        cur = { x: origin.x, y };
        add(origin, cur);
      } else if (y === origin.y) {
        cur = origin;
      } else {
        const tx = base + side * (1 + g.room + g.track);
        add(origin, { x: tx, y: origin.y });
        cur = { x: tx, y };
        add({ x: tx, y: origin.y }, cur);
      }
    }

    for (const { item, x: offset } of g.items) {
      const x = base + offset;
      if (item.t === "hang") {
        const at = { x, y };
        if (cur) add(cur, at);
        cur = at;
        for (const h of [item.up, item.down]) {
          if (!h) continue;
          if (h.parts.length === 0) {
            const pin = symbolPin(g, h.rail);
            sheet.symbols.push({ net: h.rail, at, ...(pin ? { pin } : {}) });
            continue;
          }
          const stem = (h.dir === "up" ? -1 : 1) * (h.stem ?? 0);
          const first = { x, y: y + stem };
          placeRun(ctx, sheet, h.parts, h.nets, first, h.dir === "up" ? 90 : 270);
          if (stem !== 0) {
            sheet.prewires.push([{ net: h.attach, a: at, b: first }]);
            ctx.note(h.parts[0] as string, "align-hangers", "lined up with its neighbours");
          }
          handle(h.parts[0] as string, h.attach);
          const where = `${h.dir === "up" ? "stands above" : "hangs below"} net ${h.attach}`;
          for (const p of h.parts) {
            ctx.note(p, h.parts.length > 1 ? "chain-rows" : "shunt-hang", where);
          }
        }
      } else if (item.t === "port") {
        const at = { x, y };
        if (cur) add(cur, at);
        cur = at;
        const part = ctx.part(item.id);
        const mirror = ctx.mirror.get(item.id) ?? false;
        const o = transformPoint(part.pins[0] as LayoutPart["pins"][number], 0, mirror);
        sheet.placements.set(item.id, {
          at: { x: x - o.x, y: y - o.y },
          rotation: 0,
          mirror,
        });
      } else if (item.t === "bridge") {
        const at = { x, y };
        if (cur) add(cur, at);
        cur = at;
        const part = item.chain.parts[0] as string;
        placeTwo(sheet, ctx.part(part), r.net, at, 270);
        handle(part, r.net);
        handle(part, item.mate.net);
        ctx.note(part, "follow-pin-side", `bridges nets ${r.net} and ${item.mate.net}`);
      } else {
        let px = x;
        item.parts.forEach((id, i) => {
          const p = ctx.part(id);
          const at = { x: px, y };
          if (cur) add(cur, at);
          endPiece();
          net = item.nets[i + 1] as string;
          placeTwo(sheet, p, item.nets[i] as string, at, side === 1 ? 0 : 180);
          handle(id, item.nets[i] as string);
          handle(id, net);
          ctx.note(id, "signal-left-right", `in line with the signal on ${r.net}`);
          px += side * spanOf(p);
          cur = { x: px, y };
          if (i < item.parts.length - 1) px += side * PART_GAP;
        });
      }
    }

    if (r.target && cur) {
      const end = pinAt(r.target);
      if (end.y === y) {
        add(cur, end);
      } else {
        const tx = end.x - 1 - g.endRoom - g.endTrack;
        add(cur, { x: tx, y });
        add({ x: tx, y }, { x: tx, y: end.y });
        add({ x: tx, y: end.y }, end);
      }
      sheet.handled.add(pinKey(r.target));
    }
    if (r.bridgeUpper && cur && g.items.length === 0) {
      const b = gap.get(r.bridgeUpper)?.items.find((x) => x.item.t === "bridge");
      if (b) add(cur, { x: base + b.x, y });
    }
    endPiece();
    sheet.prewires.push(...pieces);
  };

  placeColumn(0, 0);
  for (let c = 0; c < columns.length; c++) {
    const last = c + 1 === columns.length;
    const edge = colRight[c] as number;
    if (!last) placeColumn(c + 1, edge + 4);
    const { width, draw, slide } = layoutGap(c);
    if (!last) shiftColumn(c + 1, edge + width);
    const inward = c === 0 && !last ? slide() : 0;
    if (inward > 0) {
      shiftColumn(0, (colLeft[0] as number) + inward);
      for (const id of columns[0] as string[]) {
        ctx.note(id, "straighten-wires", "slid in with its column to shorten its wires");
      }
    }
    draw(last ? edge : (colLeft[c + 1] as number), colRight[c] as number);
  }
  // Last, since the first column may have moved to meet the column after it.
  layoutGap(-1).draw(colLeft[0] as number);
}
