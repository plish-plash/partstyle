import {
  type Direction,
  type Pt as GridPt,
  type LayoutInput,
  type LayoutNet,
  type LayoutPart,
  type LayoutPin,
  type LayoutResult,
  layoutBlock,
  type PartKind,
  type PinType,
  type Preferences,
  preferenceOverrides,
  type Rotation,
  type TextField,
} from "@partstyle/layout";
import type { CktFile, PortKind } from "../ckt/ast.js";
import { powerRotation, powerValueAt } from "../kicad/power.js";
import { type FlatPart, isOpenByDesign, type Netlist } from "../netlist/elaborate.js";
import { genericValue } from "../parts/generic.js";
import { partValue } from "../parts/schema.js";
import { type DrawingPlan, type NetPlan, shapeOf } from "./plan.js";
import type {
  PlacedLabel,
  PlacedPin,
  PlacedPower,
  PlacedSheet,
  PlacedText,
  PlacedUnit,
  Pt,
  Rect,
  SheetLayout,
} from "./types.js";

/** Millimetres per layout grid unit: KiCad's 100 mil pin grid. */
const GRID = 2.54;
/** Width of a character of 1.27 mm text. */
const CHAR = 1.27;
/** Blank grid units around a sheet's contents. */
const MARGIN = 6;

const textWidth = (s: string) => s.length * CHAR;
const round = (v: number) => Number(v.toFixed(4));

/** The Value text a part shows (as `buildBom` derives it). */
const valueText = (part: FlatPart) =>
  part.spec.kind === "lib"
    ? part.record
      ? partValue(part.record)
      : part.spec.id
    : genericValue(part.spec.fn, part.spec.args);

/** What layout should treat a part as, from its reference and its visible pin count. */
function kindOf(ref: string, pins: number): PartKind {
  const prefix = /^[A-Za-z]+/.exec(ref)?.[0].toUpperCase() ?? "";
  if (pins === 2) {
    const two: Record<string, PartKind> = {
      R: "resistor",
      C: "capacitor",
      L: "inductor",
      F: "ferrite",
      FB: "ferrite",
      D: "diode",
      LED: "led",
      Y: "crystal",
    };
    const kind = two[prefix];
    if (kind) return kind;
  }
  if (["J", "P", "CN", "X", "TP"].includes(prefix)) return "connector";
  if (prefix === "Q") return "transistor";
  return "ic";
}

const pinType = (t: string): PinType => {
  const known: PinType[] = [
    "input",
    "output",
    "bidir",
    "tristate",
    "passive",
    "power_in",
    "power_out",
    "open_collector",
    "open_emitter",
    "nc",
  ];
  return known.includes(t as PinType) ? (t as PinType) : "passive";
};

const portDirection = (k: PortKind): NonNullable<LayoutNet["port"]> =>
  k === "input" || k === "power_in"
    ? "input"
    : k === "output" || k === "power_out"
      ? "output"
      : "bidir";

/** Sheet ports on the right of the box: signal flows left to right. */
const onRight = (k: PortKind) => k === "output" || k === "power_out" || k === "bidir";

interface UnitInfo {
  ref: string;
  path: string;
  libId: string;
  unit: number;
  /** Where the layout's origin (the first pin) sits relative to the symbol's own. */
  origin: Pt;
  /** Pins relative to the symbol's origin, in sheet directions, by pin number. */
  pins: Map<string, Pt & { open: boolean | undefined }>;
  /** The symbol's true extent relative to its origin, in sheet directions. */
  box: Rect;
}

interface SheetInfo {
  instance: string;
  block: string;
  size: { w: number; h: number };
  kinds: Map<string, PortKind>;
}

interface Translation {
  input: LayoutInput;
  units: Map<string, UnitInfo>;
  sheets: Map<string, SheetInfo>;
  planOf: (net: string) => NetPlan;
}

/**
 * A symbol's extent rounded out to whole grid units, so layout always sees at least the whole
 * symbol: it aligns parts by this box, and wires stay out of it.
 */
function gridBox(symbol: Rect, origin: Pt, pins: LayoutPin[]): Rect {
  const down = (v: number) => Math.floor(v / GRID + 1e-6);
  const up = (v: number) => Math.ceil(v / GRID - 1e-6);
  const x0 = Math.min(down(symbol.x - origin.x), ...pins.map((p) => p.x));
  const x1 = Math.max(up(symbol.x + symbol.w - origin.x), ...pins.map((p) => p.x));
  const y0 = Math.min(down(symbol.y - origin.y), ...pins.map((p) => p.y));
  const y1 = Math.max(up(symbol.y + symbol.h - origin.y), ...pins.map((p) => p.y));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Describes a block to the layout engine, in grid units from each part's first pin. */
function toLayoutInput(
  block: CktFile,
  plan: DrawingPlan,
  netlist: Netlist,
  blocks: Map<string, CktFile>,
): Translation {
  const name = block.block.name;
  const prefix = plan.instancesOf(name)[0]?.prefix ?? "";
  const partsByPath = new Map(netlist.parts.map((p) => [p.path, p]));
  const planOf = (net: string) => plan.net(name, net);

  const pinNet = new Map<string, string>(); // "R1#2" → net
  const portNet = new Map<string, string>(); // "PWR.+5V" → net
  for (const n of block.nets) {
    for (const ref of n.pins) {
      const part = partsByPath.get(prefix + ref.target);
      if (part) {
        const byNumber = part.pins.filter((p) => p.number === ref.pin);
        const matches =
          byNumber.length > 0 ? byNumber : part.pins.filter((p) => p.name === ref.pin);
        for (const p of matches) pinNet.set(`${ref.target}#${p.number}`, n.name);
      } else {
        portNet.set(`${ref.target}.${ref.pin}`, n.name);
      }
    }
  }

  const parts: LayoutPart[] = [];
  const units = new Map<string, UnitInfo>();
  const sheets = new Map<string, SheetInfo>();

  for (const decl of block.parts) {
    const part = partsByPath.get(prefix + decl.ref);
    const symbol = part && plan.symbolOf(part);
    if (!part || !symbol) continue;
    for (const [index, libUnit] of symbol.units.entries()) {
      const visible = [...libUnit.pins].filter(([, a]) => !a.hidden);
      const first = visible[0]?.[1] ?? { x: 0, y: 0 };
      const origin = { x: first.x, y: -first.y };
      const id = `${decl.ref}:${libUnit.unit}`;
      const pins: LayoutPin[] = [];
      const info: UnitInfo = {
        ref: decl.ref,
        path: part.path,
        libId: symbol.libId,
        unit: libUnit.unit,
        origin,
        pins: new Map(),
        box: { x: 0, y: 0, w: 0, h: 0 },
      };
      for (const [number, a] of visible) {
        const net = pinNet.get(`${decl.ref}#${number}`);
        const own = part.pins.find((p) => p.number === number);
        info.pins.set(number, {
          x: a.x,
          y: -a.y,
          open: own === undefined ? undefined : isOpenByDesign(own),
        });
        pins.push({
          id: number,
          name: own?.name ?? number,
          x: Math.round((a.x - origin.x) / GRID),
          y: Math.round((-a.y - origin.y) / GRID),
          outward: a.outward as Direction,
          type: pinType(own?.type ?? a.type),
          ...(net !== undefined && { net }),
        });
      }
      const { minX, maxX, minY, maxY } = libUnit.box;
      info.box = { x: minX, y: -maxY, w: maxX - minX, h: maxY - minY };
      const box = gridBox(info.box, origin, pins);
      parts.push({
        id,
        ref: decl.ref,
        value: valueText(part),
        kind: kindOf(decl.ref, visible.length),
        order: decl.location.line * 100 + index,
        box,
        pins,
      });
      units.set(id, info);
    }
  }

  for (const u of block.uses) {
    const child = blocks.get(u.block);
    if (!child) continue;
    // Power ports connect by name, so they get no sheet pin.
    const ports = child.ports.filter((p) => {
      const net = child.nets.find((n) => n.port === p.name);
      return !net || plan.net(child.block.name, net.name).kind !== "power";
    });
    const left = ports.filter((p) => !onRight(p.kind));
    const right = ports.filter((p) => onRight(p.kind));
    const longest = (ps: typeof ports) => Math.max(0, ...ps.map((p) => textWidth(p.name)));
    const widthMm = Math.max(
      12 * GRID,
      longest(left) + longest(right) + 4 * GRID,
      textWidth(u.instance) + GRID,
    );
    const w = Math.ceil(widthMm / GRID);
    const h = Math.max(left.length, right.length, 1) + 1;
    const pin = (p: (typeof ports)[number], i: number, x: number, outward: Direction) => {
      const net = portNet.get(`${u.instance}.${p.name}`);
      return {
        id: p.name,
        name: p.name,
        x,
        y: i + 1,
        outward,
        type: pinType(p.kind === "ground" ? "passive" : p.kind),
        ...(net !== undefined && { net }),
      };
    };
    const id = `sheet:${u.instance}`;
    parts.push({
      id,
      ref: u.instance,
      value: u.block,
      kind: "sheet",
      order: u.location.line * 100,
      box: { x: 0, y: 0, w, h },
      pins: [...left.map((p, i) => pin(p, i, 0, 180)), ...right.map((p, i) => pin(p, i, w, 0))],
    });
    sheets.set(id, {
      instance: u.instance,
      block: u.block,
      size: { w: w * GRID, h: h * GRID },
      kinds: new Map(ports.map((p) => [p.name, p.kind])),
    });
  }

  const flagged = plan.flags(name);
  const nets: LayoutNet[] = block.nets.map((n) => {
    const p = planOf(n.name);
    const common = flagged.has(n.name) ? { flagged: true } : {};
    if (p.kind === "power") {
      return {
        name: n.name,
        role: p.ground ? "ground" : "power",
        ...(!p.ground && p.symbol.bodyDir === 270 ? { pointsDown: true } : {}),
        ...common,
      };
    }
    return {
      name: n.name,
      role: "signal",
      ...(p.port ? { port: portDirection(p.port.kind) } : {}),
      ...common,
    };
  });

  return { input: { name, parts, nets }, units, sheets, planOf };
}

/** Where a symbol-relative point lands, turned and mirrored as the engine turned it. */
function turn(p: Pt, rotation: Rotation, mirror: boolean): Pt {
  const x = mirror ? -p.x : p.x;
  const { y } = p;
  if (rotation === 90) return { x: y, y: -x };
  if (rotation === 180) return { x: -x, y: -y };
  if (rotation === 270) return { x: -y, y: x };
  return { x, y };
}

const fieldOf = (t: TextField | undefined, fallback: Pt, toMm: (p: GridPt) => Pt): PlacedText => {
  if (!t) return { at: fallback, angle: 0, justify: ["left", "bottom"] };
  const side = t.anchor === "start" ? ["left"] : t.anchor === "end" ? ["right"] : [];
  return { at: toMm(t.at), angle: 0, justify: [...side, "bottom"] };
};

/** Turns the engine's drawing into the sheet that the viewer and the KiCad export read. */
function toSheetLayout(result: LayoutResult, t: Translation, plan: DrawingPlan): SheetLayout {
  const dx = MARGIN - Math.floor(result.bounds.x);
  const dy = MARGIN - Math.floor(result.bounds.y);
  const toMm = (p: GridPt): Pt => ({ x: round((p.x + dx) * GRID), y: round((p.y + dy) * GRID) });

  const units: PlacedUnit[] = [];
  const sheets: PlacedSheet[] = [];
  const noConnects: Pt[] = [];
  for (const part of result.parts) {
    const sheet = t.sheets.get(part.id);
    if (sheet) {
      sheets.push({
        instance: sheet.instance,
        block: sheet.block,
        at: toMm({ x: part.box.x, y: part.box.y }),
        size: sheet.size,
        pins: part.pins.map((p) => ({
          port: p.id,
          kind: sheet.kinds.get(p.id) ?? "passive",
          at: toMm(p.at),
          outward: p.outward,
          ...(p.net !== undefined && { net: p.net }),
        })),
      });
      continue;
    }
    const info = t.units.get(part.id) as UnitInfo;
    const first = toMm(part.at);
    const offset = turn(info.origin, part.rotation, part.mirror);
    const at = { x: round(first.x - offset.x), y: round(first.y - offset.y) };
    const pins: PlacedPin[] = part.pins.map((p) => {
      const local = info.pins.get(p.id) as Pt & { open: boolean | undefined };
      const o = turn(local, part.rotation, part.mirror);
      const placed = { x: round(at.x + o.x), y: round(at.y + o.y) };
      // A pin left open by mistake gets no flag, so that KiCad's ERC reports it.
      if (p.net === undefined && local.open !== false) noConnects.push(placed);
      return {
        number: p.id,
        at: placed,
        outward: p.outward,
        ...(p.net !== undefined && { net: p.net }),
      };
    });
    // The real symbol, not the grid box: this is what selection draws around.
    const corners = [
      turn({ x: info.box.x, y: info.box.y }, part.rotation, part.mirror),
      turn({ x: info.box.x + info.box.w, y: info.box.y + info.box.h }, part.rotation, part.mirror),
    ] as [Pt, Pt];
    const box = {
      x: round(at.x + Math.min(corners[0].x, corners[1].x)),
      y: round(at.y + Math.min(corners[0].y, corners[1].y)),
      w: round(Math.abs(corners[0].x - corners[1].x)),
      h: round(Math.abs(corners[0].y - corners[1].y)),
    };
    units.push({
      ref: info.ref,
      path: info.path,
      libId: info.libId,
      unit: info.unit,
      at,
      rotation: part.rotation,
      mirror: part.mirror,
      box,
      pins,
      refField: fieldOf(part.text[0], { x: box.x, y: box.y }, toMm),
      valueField: fieldOf(part.text[1], { x: box.x, y: box.y + box.h }, toMm),
    });
  }

  const labels: PlacedLabel[] = result.labels.map((l) => {
    const p = t.planOf(l.net);
    const port = p.kind === "signal" ? p.port : undefined;
    return l.kind === "port" && port
      ? {
          kind: "hier",
          text: port.name,
          net: l.net,
          at: toMm(l.at),
          angle: l.outward,
          shape: shapeOf[port.kind],
        }
      : { kind: "local", text: l.text, net: l.net, at: toMm(l.at), angle: l.outward };
  });

  const power: PlacedPower[] = [];
  for (const s of result.power) {
    const p = t.planOf(s.net);
    if (p.kind !== "power") continue;
    const at = toMm(s.at);
    power.push({
      libId: p.symbol.libId,
      name: p.name,
      net: s.net,
      at,
      outward: s.outward,
      rotation: powerRotation(p.symbol, s.outward),
      valueAt: powerValueAt(at, s.outward, p.name),
      hideValue: false,
      flag: false,
    });
  }
  for (const m of result.markers) {
    const at = toMm(m.at);
    power.push({
      libId: plan.flagSymbol.libId,
      name: "PWR_FLAG",
      net: m.net,
      at,
      outward: m.outward,
      rotation: powerRotation(plan.flagSymbol, m.outward),
      valueAt: powerValueAt(at, m.outward, "PWR_FLAG"),
      hideValue: false,
      flag: true,
    });
  }

  // Text can run past the drawing, and the paper has to hold it.
  const texts = result.parts.flatMap((p) => p.text);
  const widest = Math.max(
    result.bounds.x + result.bounds.w,
    ...texts.map((f) => f.at.x + f.text.length * (CHAR / GRID)),
  );
  const lowest = Math.max(result.bounds.y + result.bounds.h, ...texts.map((f) => f.at.y));
  return {
    block: result.name,
    width: round((widest + dx + MARGIN) * GRID),
    height: round((lowest + dy + MARGIN) * GRID),
    units,
    sheets,
    labels,
    power,
    wires: result.wires.map((w) => ({ net: w.net, a: toMm(w.a), b: toMm(w.b) })),
    junctions: result.junctions.map((j) => ({ net: j.net, at: toMm(j.at) })),
    noConnects,
  };
}

/** Lays out one block's sheet. */
export function layoutSheet(
  block: CktFile,
  plan: DrawingPlan,
  netlist: Netlist,
  blocks: Map<string, CktFile>,
  preferences: Preferences,
): SheetLayout {
  const translation = toLayoutInput(block, plan, netlist, blocks);
  const result = layoutBlock(translation.input, preferenceOverrides(preferences));
  return toSheetLayout(result, translation, plan);
}
