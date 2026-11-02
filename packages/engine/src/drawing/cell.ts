import type { LibField } from "../kicad/libsym.js";
import { powerRotation, powerValueAt } from "../kicad/power.js";
import type { FlatPart } from "../netlist/elaborate.js";
import type { Attachment, Group } from "./groups.js";
import {
  CHAR,
  GRID,
  type Node,
  type NodePin,
  orientNode,
  type SheetInput,
  textWidth,
} from "./nodes.js";
import { type Rotation, turnable } from "./orient.js";
import type {
  PlacedPower,
  PlacedSheet,
  PlacedText,
  PlacedUnit,
  Pt,
  Rect,
  WireSegment,
} from "./types.js";
import { PITCH, snap } from "./wires.js";

/**
 * Pins of one net in a cell that are already joined (a pin and the parts hung off it, or a run
 * of adjacent pins): what the router connects to other pieces of the net, and where a label
 * goes if the net is labelled instead.
 */
export interface Piece {
  net: string;
  /** Pins and wire vertices, all connected. */
  points: Pt[];
  segments: WireSegment[];
  labelAt: Pt;
  /** Direction a label reads from `labelAt`. */
  labelDir: number;
  /** The rest of a shunt row, drawn only if the net goes on beyond it. */
  extension?: [Pt, Pt];
}

/** One group laid out in its own coordinates (y down), ready to be moved into place. */
export interface Cell {
  group: Group;
  stage: number;
  /** Everything the cell draws, text included. */
  box: Rect;
  units: PlacedUnit[];
  sheets: PlacedSheet[];
  /** Fixed wires that are not part of a piece: power stubs. */
  segments: WireSegment[];
  power: PlacedPower[];
  pieces: Piece[];
  noConnects: Pt[];
  /** Part bodies and power symbols: wires go around. */
  obstacles: Rect[];
  /** Text: wires avoid it where they can. */
  text: Rect[];
  /** Where a PWR_FLAG may go for each power net (see `layoutSheet`). */
  flagSpots: { net: string; at: Pt; outward: number; kind: "stub" | "lone" | "run" }[];
}

const ceilTo = (v: number) => snap(Math.ceil(v / PITCH - 1e-6) * PITCH);
const floorTo = (v: number) => snap(Math.floor(v / PITCH + 1e-6) * PITCH);
const add = (a: Pt, b: Pt): Pt => ({ x: snap(a.x + b.x), y: snap(a.y + b.y) });
/** An origin near `o` that puts pin `p` (and so every pin of a symbol drawn on the grid) on it. */
const toGrid = (o: Pt, p: Pt | undefined): Pt =>
  p ? { x: snap(ceilTo(o.x + p.x) - p.x), y: snap(ceilTo(o.y + p.y) - p.y) } : o;
const horizontal = (outward: number) => outward === 0 || outward === 180;

/** The Value text a part shows (as `resolveBom` derives it), for sizing its field. */
export const valueText = (part: FlatPart) =>
  part.spec.kind === "lib"
    ? (part.record?.mpn ?? part.spec.id)
    : (part.spec.args[0] ?? part.spec.fn);

/** Room for a two-terminal part's reference and value, drawn to its right. */
const textRoom = (n: Node) =>
  Math.max(textWidth(n.ref), textWidth(valueText(n.part as FlatPart))) + 2 * GRID;

/** A library field (symbol coords, y up) placed relative to a symbol origin. */
const libText = (origin: Pt, f: LibField): PlacedText => ({
  at: { x: origin.x + f.x, y: origin.y - f.y },
  angle: f.angle,
  justify: f.justify,
});

/** Distance between the centres of two stacked lines of text. */
const LINE = 2;

/**
 * Reference and value fields of a part whose library placement cannot be used (a generated
 * symbol, or one turned or mirrored): beside an upright part, the reference over the value,
 * starting just right of it; otherwise centred over the part, the value directly on it and the
 * reference above. Text is placed as the viewer draws it, on the sheet; the KiCad export
 * adapts it to how KiCad reads a mirrored or turned symbol's fields.
 */
function ownFields(box: Rect, upright: boolean): [ref: PlacedText, value: PlacedText] {
  const at = (x: number, y: number, justify: string[]): PlacedText => ({
    at: { x, y },
    angle: 0,
    justify,
  });
  if (upright) {
    const left = box.x + box.w + CHAR;
    const mid = box.y + box.h / 2;
    return [at(left, mid - LINE / 2, ["left"]), at(left, mid + LINE / 2, ["left"])];
  }
  const centre = box.x + box.w / 2;
  const top = box.y - CHAR;
  return [at(centre, top - LINE, []), at(centre, top, [])];
}

/** The area a text field covers, roughly. */
export function textRect(t: PlacedText, text: string): Rect {
  const w = textWidth(text);
  const h = CHAR * 1.2;
  const x = t.justify.includes("left") ? 0 : t.justify.includes("right") ? -w : -w / 2;
  const y = t.justify.includes("bottom") ? -h : t.justify.includes("top") ? 0 : -h / 2;
  return t.angle === 90
    ? { x: t.at.x + y, y: t.at.y - w - x, w: h, h: w }
    : { x: t.at.x + x, y: t.at.y + y, w, h };
}

/** Lays out a group: its anchor units stacked, each with its attached parts around it. */
export function buildCell(
  group: Group,
  stage: number,
  flips: Map<string, boolean>,
  input: SheetInput,
): Cell {
  const { roleOf, planOf } = input;
  const cell: Cell = {
    group,
    stage,
    box: { x: 0, y: 0, w: 0, h: 0 },
    units: [],
    sheets: [],
    segments: [],
    power: [],
    pieces: [],
    noConnects: [],
    obstacles: [],
    text: [],
    flagSpots: [],
  };
  const bySpec = new Map<string, Attachment[]>();
  for (const a of group.attached) {
    if (a.kind === "satellite") continue;
    const k = `${a.host}#${a.hostPin}`;
    bySpec.set(k, [...(bySpec.get(k) ?? []), a]);
  }
  const satellitesOf = (id: string) =>
    group.attached.filter((a) => a.kind === "satellite" && a.host === id);
  /** Power names already shown per unit side, so a repeat is drawn without its name. */
  const shown = new Set<string>();

  let top = 0;
  for (const raw of group.anchors) {
    const anchor = orientNode(raw, raw.rotation, flips.get(raw.id) ?? false);
    const block = unitBlock(anchor);
    // Stack the units of a part one under another.
    const extent = bounds(block);
    const dy = ceilTo(top - extent.y);
    moveCell(block, 0, dy);
    top = extent.y + dy + extent.h + 2 * GRID;
    merge(cell, block);
  }
  // On the grid, so that moving the cell by its box keeps every pin on it.
  const b = bounds(cell);
  const x = floorTo(b.x);
  const y = floorTo(b.y);
  cell.box = { x, y, w: ceilTo(b.x + b.w - x), h: ceilTo(b.y + b.h - y) };
  return cell;

  function unitBlock(anchor: Node): Cell {
    const b: Cell = {
      ...cell,
      units: [],
      sheets: [],
      segments: [],
      power: [],
      pieces: [],
      noConnects: [],
      obstacles: [],
      text: [],
      flagSpots: [],
    };
    // Pins on the 2.54 mm grid: a symbol's pins are, but its origin need not be (Device:R).
    const origin = toGrid({ x: 0, y: 0 }, anchor.pins[0]);
    place(b, anchor, origin);

    // Runs of adjacent pins on one side and one net are joined by a wire along the pins.
    const runOf = new Map<NodePin, NodePin[]>();
    for (const outward of [0, 90, 180, 270]) {
      const along = (p: NodePin) => (horizontal(outward) ? p.y : p.x);
      const side = anchor.pins
        .filter((p) => p.outward === outward)
        .sort((p, q) => along(p) - along(q));
      let run: NodePin[] = [];
      for (const p of side) {
        if (run.length > 0 && p.net !== undefined && p.net === run[0]?.net) run.push(p);
        else {
          run = [p];
        }
        runOf.set(p, run);
      }
    }
    const at = (p: NodePin) => add(origin, p);
    for (const run of new Set(runOf.values())) {
      const first = run[0] as NodePin;
      if (first.net === undefined) {
        for (const p of run) b.noConnects.push(at(p));
        continue;
      }
      const net = first.net;
      const spine: WireSegment[] = [];
      for (let i = 1; i < run.length; i++) {
        spine.push({ net, a: at(run[i - 1] as NodePin), b: at(run[i] as NodePin) });
      }
      if (roleOf(net) !== "signal") {
        b.segments.push(...spine);
        powerRun(b, anchor, origin, run);
        continue;
      }
      // A piece of the net, with whatever hangs off its pins.
      const piece: Piece = {
        net,
        points: run.map(at),
        segments: spine,
        labelAt: at(first),
        labelDir: first.outward,
      };
      for (const p of run) host(b, anchor, origin, p, piece);
      b.pieces.push(piece);
    }
    satellites(b, anchor, origin);
    return b;
  }

  /**
   * Lays out the parts hung off pin `p` of `n` (at `origin`), growing `piece`. `clear` is where
   * the text of the row before ends: shunts here start beyond it.
   */
  function host(b: Cell, n: Node, origin: Pt, p: NodePin, piece: Piece, clear?: number): void {
    const atts = bySpec.get(`${n.id}#${p.id}`) ?? [];
    if (atts.length === 0) return;
    const P = add(origin, p);
    const shunts = atts.filter((a) => a.kind === "shunt");
    const series = atts.find((a) => a.kind === "series");

    if (!horizontal(p.outward)) {
      // In line under a pin pointing down (or over one pointing up), side by side.
      const dy = p.outward === 270 ? 1 : -1;
      const jy = snap(P.y + dy * GRID);
      let cursor: number | undefined;
      let last = P.x;
      piece.segments.push({ net: piece.net, a: P, b: { x: P.x, y: jy } });
      for (const s of shunts) {
        const node = s.node;
        const N = node.pins.find((q) => q.id === s.pin) as NodePin;
        const pinX = cursor === undefined ? P.x : ceilTo(cursor + N.x - node.box.x);
        const pin = { x: pinX, y: snap(P.y + dy * 2 * GRID) };
        const o = { x: snap(pin.x - N.x), y: snap(pin.y - N.y) };
        place(b, node, o);
        piece.segments.push({ net: piece.net, a: { x: pin.x, y: jy }, b: pin });
        piece.points.push(pin);
        last = pin.x;
        cursor = o.x + node.box.x + node.box.w + textRoom(node) + GRID;
        supplyTags(b, node, o, s.pin as string);
      }
      if (last !== P.x)
        piece.segments.push({ net: piece.net, a: { x: P.x, y: jy }, b: { x: last, y: jy } });
      const end = { x: ceilTo(last + 2 * GRID), y: jy };
      piece.extension = [{ x: last, y: jy }, end];
      piece.labelAt = end;
      piece.labelDir = 0;
      return;
    }

    const d = p.outward === 0 ? 1 : -1;
    // Clear of power symbols on the host's neighbouring pins.
    const crowded = n.pins.some(
      (o) =>
        o !== p &&
        o.outward === p.outward &&
        o.net !== undefined &&
        Math.abs(o.y - p.y) <= 3 * GRID,
    );
    const near = P.x + d * (crowded ? 3 : 2) * GRID;
    const start =
      clear === undefined ? near : d > 0 ? Math.max(near, clear) : Math.min(near, clear);
    const cursor = { below: start, above: start };
    let last: number | undefined;
    /** Where the row's parts end, and where their text does. */
    let bodyFar = P.x;
    let farthest = P.x;
    for (const s of shunts) {
      const node = s.node;
      const N = node.pins.find((q) => q.id === s.pin) as NodePin;
      const below = N.outward === 90;
      const key = below ? "below" : "above";
      const left = N.x - node.box.x;
      const right = node.box.x + node.box.w - N.x + textRoom(node);
      const pinX = d > 0 ? ceilTo(cursor[key] + left) : floorTo(cursor[key] - right);
      cursor[key] = d > 0 ? pinX + right + GRID : pinX - left - GRID;
      const pin = { x: pinX, y: snap(P.y + (below ? 2 : -2) * GRID) };
      const o = { x: snap(pin.x - N.x), y: snap(pin.y - N.y) };
      place(b, node, o);
      piece.segments.push({ net: piece.net, a: { x: pinX, y: P.y }, b: pin });
      piece.points.push(pin, { x: pinX, y: P.y });
      supplyTags(b, node, o, s.pin as string);
      last = last === undefined ? pinX : d > 0 ? Math.max(last, pinX) : Math.min(last, pinX);
      bodyFar =
        d > 0
          ? Math.max(bodyFar, o.x + node.box.x + node.box.w)
          : Math.min(bodyFar, o.x + node.box.x);
      farthest =
        d > 0
          ? Math.max(farthest, o.x + node.box.x + node.box.w + textRoom(node))
          : Math.min(farthest, o.x + node.box.x);
    }
    if (last !== undefined) piece.segments.push({ net: piece.net, a: P, b: { x: last, y: P.y } });
    const rowEnd = last === undefined ? P.x : d > 0 ? ceilTo(farthest) : floorTo(farthest);

    if (series) {
      let node = series.node;
      let N = node.pins.find((q) => q.id === series.pin) as NodePin;
      // Facing its host, unless the human turned it.
      if (input.hints.get(node.ref)?.rotation === undefined && N.outward === p.outward) {
        node = orientNode(node, ((node.rotation + 180) % 360) as Rotation, false);
        N = node.pins.find((q) => q.id === series.pin) as NodePin;
      }
      // In line beyond the shunts' bodies: their text hangs below (or above) the wire.
      const from = last === undefined ? P.x : bodyFar;
      const edge = d > 0 ? node.box.x : node.box.x + node.box.w;
      const pinX =
        d > 0 ? ceilTo(from + 2 * GRID + N.x - edge) : floorTo(from - 2 * GRID + N.x - edge);
      const o = { x: snap(pinX - N.x), y: snap(P.y - N.y) };
      place(b, node, o);
      const pin = add(o, N);
      piece.segments.push({ net: piece.net, a: { x: last ?? P.x, y: P.y }, b: pin });
      piece.points.push(pin);
      const far = node.pins.find((q) => q !== N) as NodePin;
      if (far.net !== undefined && roleOf(far.net) === "signal") {
        const next: Piece = {
          net: far.net,
          points: [add(o, far)],
          segments: [],
          labelAt: add(o, far),
          labelDir: far.outward,
        };
        host(b, node, o, far, next, last === undefined ? clear : farthest);
        b.pieces.push(next);
      } else if (far.net !== undefined) {
        tag(b, far.net, add(o, far), far.outward, undefined, horizontal(far.outward));
      } else {
        b.noConnects.push(add(o, far));
      }
      return;
    }
    if (last !== undefined) {
      const end = { x: rowEnd, y: P.y };
      if (end.x !== last) piece.extension = [{ x: last, y: P.y }, end];
      piece.labelAt = end;
      piece.labelDir = p.outward;
    }
  }

  /**
   * Decoupling parts in a row beside the part they serve when its left side has no pins (an
   * op-amp's supply unit), else under it (over it if its bottom carries signal).
   */
  function satellites(b: Cell, anchor: Node, origin: Pt): void {
    const row = satellitesOf(anchor.id);
    if (row.length === 0) return;
    if (!anchor.pins.some((p) => p.outward === 180)) {
      // Right to left from the part, each with its text between it and the next.
      let right = anchor.box.x - GRID;
      for (const s of row) {
        const want = {
          x: origin.x + right - textRoom(s.node) - s.node.box.x - s.node.box.w,
          y: origin.y + anchor.box.y + (anchor.box.h - s.node.box.h) / 2 - s.node.box.y,
        };
        const o = toGrid({ x: want.x - PITCH, y: want.y }, s.node.pins[0]);
        place(b, s.node, o);
        for (const p of s.node.pins) {
          if (p.net === undefined) b.noConnects.push(add(o, p));
          else tag(b, p.net, add(o, p), p.outward);
        }
        right = o.x - origin.x + s.node.box.x - GRID;
      }
      return;
    }
    const edgeFree = (outward: number) =>
      anchor.pins.every(
        (p) => p.outward !== outward || p.net === undefined || roleOf(p.net) !== "signal",
      );
    const below = edgeFree(270);
    const pins = anchor.pins.some((p) => p.outward === (below ? 270 : 90));
    const gap = (pins ? 3 * GRID : GRID) + (below ? 0 : 2 * GRID);
    const rowH = Math.max(...row.map((s) => s.node.box.h));
    const box = anchor.box;
    const rowTop = below ? box.y + box.h + gap + 2 * GRID : box.y - gap - 2 * GRID - rowH;
    let x = box.x;
    for (const s of row) {
      const o = toGrid(
        { x: origin.x + x - s.node.box.x, y: origin.y + rowTop - s.node.box.y },
        s.node.pins[0],
      );
      place(b, s.node, o);
      for (const p of s.node.pins) {
        if (p.net === undefined) b.noConnects.push(add(o, p));
        else tag(b, p.net, add(o, p), p.outward);
      }
      x = o.x - origin.x + s.node.box.x + s.node.box.w + textRoom(s.node) + GRID;
    }
  }

  /** Power symbols on the supply pin of a part hung off a signal net. */
  function supplyTags(b: Cell, node: Node, o: Pt, signalPin: string): void {
    for (const p of node.pins) {
      if (p.id === signalPin) continue;
      if (p.net === undefined) b.noConnects.push(add(o, p));
      else tag(b, p.net, add(o, p), p.outward, undefined, horizontal(p.outward));
    }
  }

  /**
   * One power symbol per run of joined pins: on its first pin, but a side run's rail symbol goes
   * on its top pin and its ground on its bottom one. There it stands on a stub when no other
   * connected pin on that side is in its way; otherwise it points straight out of the pin.
   */
  function powerRun(b: Cell, anchor: Node, origin: Pt, run: NodePin[]): void {
    const first = run[0] as NodePin;
    const net = first.net as string;
    const role = roleOf(net);
    const s = !horizontal(first.outward)
      ? first
      : run.reduce((a, q) => ((role === "ground" ? q.y > a.y : q.y < a.y) ? q : a));
    const clear = anchor.pins.every((o) => {
      if (o.outward !== s.outward || o.net === undefined || run.includes(o)) return true;
      const dy = (o.y - s.y) * (role === "ground" ? 1 : -1);
      return dy <= 0 || dy > 3 * GRID;
    });
    tag(
      b,
      net,
      add(origin, s),
      s.outward,
      `${anchor.id}:${s.outward}`,
      horizontal(s.outward) && clear,
    );
    if (run.length === 1)
      b.flagSpots.push({
        net,
        at: add(origin, s),
        outward: horizontal(s.outward) ? 90 : 0,
        kind: "lone",
      });
    else {
      const a = add(origin, run[0] as NodePin);
      const z = add(origin, run[run.length - 1] as NodePin);
      const outward = z.x !== a.x ? (z.x > a.x ? 0 : 180) : z.y > a.y ? 270 : 90;
      b.flagSpots.push({ net, at: z, outward, kind: "run" });
    }
  }

  /** A power symbol (or label) for a non-wired net at a connection point. */
  function tag(
    b: Cell,
    net: string,
    at: Pt,
    outward: number,
    sideKey?: string,
    stub = false,
  ): void {
    const p = planOf(net);
    if (p.kind !== "power") return;
    const k = sideKey && `${sideKey}|${p.name}`;
    const repeat = k !== undefined && shown.has(k);
    if (k) shown.add(k);
    if (stub) {
      // At a side pin, a short stub carries the symbol clear of the part so that it can point
      // the conventional way: rails up, ground down.
      const end = { x: snap(at.x + (outward === 0 ? GRID : -GRID)), y: at.y };
      b.segments.push({ net, a: at, b: end });
      b.flagSpots.push({ net, at: end, outward, kind: "stub" });
      at = end;
      outward = p.symbol.bodyDir === 270 ? 270 : 90;
    }
    const valueAt = powerValueAt(at, outward, p.name);
    b.power.push({
      libId: p.symbol.libId,
      name: p.name,
      net,
      at,
      outward,
      rotation: powerRotation(p.symbol, outward),
      valueAt,
      hideValue: repeat,
      flag: false,
    });
    b.obstacles.push(powerRect(at, outward));
    if (!repeat) {
      b.text.push({
        x: valueAt.x - textWidth(p.name) / 2,
        y: valueAt.y - CHAR / 2,
        w: textWidth(p.name),
        h: CHAR,
      });
    }
  }

  /** Places a unit or sheet with its origin at `o`. */
  function place(b: Cell, n: Node, o: Pt): void {
    const box = { x: o.x + n.box.x, y: o.y + n.box.y, w: n.box.w, h: n.box.h };
    b.obstacles.push(box);
    if (n.kind === "sheet") {
      b.sheets.push({
        instance: n.ref,
        block: n.block as string,
        at: o,
        size: { w: n.box.w, h: n.box.h },
        pins: n.pins.map((p, i) => ({
          port: p.id,
          kind: n.ports?.[i]?.kind ?? "passive",
          at: add(o, p),
          outward: p.outward,
          ...(p.net !== undefined && { net: p.net }),
        })),
        stage,
      });
      b.text.push({ x: o.x, y: o.y - 2 * CHAR, w: textWidth(n.ref), h: CHAR * 1.5 });
      b.text.push({
        x: o.x,
        y: o.y + n.box.h,
        w: textWidth(`${n.block} (double-click to open)`) * 0.7,
        h: CHAR * 1.5,
      });
      return;
    }
    const part = n.part as FlatPart;
    const upright = !n.pins.some((p) => horizontal(p.outward));
    const value = valueText(part);
    const fields = n.symbol?.fields;
    // A KiCad symbol drawn as its library has it keeps its author's text placement; two-terminal
    // parts all read alike, whatever their library symbol does with its text.
    const asLibrary = n.rotation === 0 && !n.mirror && !turnable.test(n.ref);
    const [refField, valueField] =
      asLibrary && fields?.reference && fields.value
        ? [libText(o, fields.reference), libText(o, fields.value)]
        : ownFields(box, upright);
    b.text.push(textRect(refField, n.ref), textRect(valueField, value));
    b.units.push({
      ref: n.ref,
      path: part.path,
      libId: n.symbol?.libId ?? "",
      unit: n.unit?.unit ?? 1,
      at: o,
      rotation: n.rotation,
      mirror: n.mirror,
      box,
      pins: n.pins.map((p) => ({
        number: p.id,
        at: add(o, p),
        outward: p.outward,
        ...(p.net !== undefined && { net: p.net }),
      })),
      refField,
      valueField,
      group: group.id,
      stage,
    });
  }
}

/** The area a power symbol's drawing covers. */
export function powerRect(at: Pt, outward: number): Rect {
  const len = 2 * GRID;
  const half = CHAR;
  switch (outward) {
    case 90:
      return { x: at.x - half, y: at.y - len, w: 2 * half, h: len };
    case 270:
      return { x: at.x - half, y: at.y, w: 2 * half, h: len };
    case 0:
      return { x: at.x, y: at.y - half, w: len, h: 2 * half };
    default:
      return { x: at.x - len, y: at.y - half, w: len, h: 2 * half };
  }
}

/** The extent of everything a cell draws. */
export function bounds(c: Cell): Rect {
  const rects: Rect[] = [...c.obstacles, ...c.text];
  const pts = [
    ...c.segments.flatMap((s) => [s.a, s.b]),
    ...c.pieces.flatMap((p) => [
      ...p.points,
      ...p.segments.flatMap((s) => [s.a, s.b]),
      ...(p.extension ?? []),
    ]),
  ];
  for (const p of pts) rects.push({ x: p.x, y: p.y, w: 0, h: 0 });
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y,
  };
}

const movePt = (p: Pt, dx: number, dy: number): Pt => ({ x: snap(p.x + dx), y: snap(p.y + dy) });
const moveRect = (r: Rect, dx: number, dy: number): Rect => ({ ...r, x: r.x + dx, y: r.y + dy });
const moveText = (t: PlacedText, dx: number, dy: number): PlacedText => ({
  ...t,
  at: { x: t.at.x + dx, y: t.at.y + dy },
});
const moveSeg = (s: WireSegment, dx: number, dy: number): WireSegment => ({
  ...s,
  a: movePt(s.a, dx, dy),
  b: movePt(s.b, dx, dy),
});

/** Moves everything in a cell by whole grid steps. */
export function moveCell(c: Cell, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  c.units = c.units.map((u) => ({
    ...u,
    at: movePt(u.at, dx, dy),
    box: moveRect(u.box, dx, dy),
    pins: u.pins.map((p) => ({ ...p, at: movePt(p.at, dx, dy) })),
    refField: moveText(u.refField, dx, dy),
    valueField: moveText(u.valueField, dx, dy),
  }));
  c.sheets = c.sheets.map((s) => ({
    ...s,
    at: movePt(s.at, dx, dy),
    pins: s.pins.map((p) => ({ ...p, at: movePt(p.at, dx, dy) })),
  }));
  c.segments = c.segments.map((s) => moveSeg(s, dx, dy));
  c.power = c.power.map((p) => ({
    ...p,
    at: movePt(p.at, dx, dy),
    valueAt: { x: p.valueAt.x + dx, y: p.valueAt.y + dy },
  }));
  c.pieces = c.pieces.map((p) => ({
    ...p,
    points: p.points.map((q) => movePt(q, dx, dy)),
    segments: p.segments.map((s) => moveSeg(s, dx, dy)),
    labelAt: movePt(p.labelAt, dx, dy),
    ...(p.extension && {
      extension: [movePt(p.extension[0], dx, dy), movePt(p.extension[1], dx, dy)] as [Pt, Pt],
    }),
  }));
  c.noConnects = c.noConnects.map((p) => movePt(p, dx, dy));
  c.obstacles = c.obstacles.map((r) => moveRect(r, dx, dy));
  c.text = c.text.map((r) => moveRect(r, dx, dy));
  c.flagSpots = c.flagSpots.map((f) => ({ ...f, at: movePt(f.at, dx, dy) }));
  c.box = moveRect(c.box, dx, dy);
}

function merge(into: Cell, from: Cell): void {
  into.units.push(...from.units);
  into.sheets.push(...from.sheets);
  into.segments.push(...from.segments);
  into.power.push(...from.power);
  into.pieces.push(...from.pieces);
  into.noConnects.push(...from.noConnects);
  into.obstacles.push(...from.obstacles);
  into.text.push(...from.text);
  into.flagSpots.push(...from.flagSpots);
}
