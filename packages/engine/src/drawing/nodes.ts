import type { CktFile, LayoutHint, PortKind } from "../ckt/ast.js";
import type { SchSymbol, SymbolUnit } from "../kicad/libsym.js";
import type { FlatPart, Netlist } from "../netlist/elaborate.js";
import { mirrorUnit, type NetRole, orient, type Rotation, rotateUnit, turnable } from "./orient.js";
import type { DrawingPlan, NetPlan } from "./plan.js";
import type { Rect } from "./types.js";

export const GRID = 2.54;
export const CHAR = 1.27;
export const textWidth = (s: string) => s.length * CHAR;

/** A connection point of a node, relative to its origin in sheet directions (y down). */
export interface NodePin {
  /** Pin number, or port name for a sheet. */
  id: string;
  name: string;
  x: number;
  y: number;
  /** 0 right, 90 up, 180 left, 270 down. */
  outward: number;
  /** Electrical type (`input`, `power_out`, ...), or the port kind of a sheet pin. */
  type: string;
  net?: string;
}

/** Something placed on a sheet: one unit of a part, or a child sheet. */
export interface Node {
  /** `u:R1:1` or `s:AFE`. */
  id: string;
  kind: "unit" | "sheet";
  /** Part refdes or instance name. */
  ref: string;
  /** Declaration line, which orders everything. */
  line: number;
  pins: NodePin[];
  /** Extent relative to the origin, pins included. */
  box: Rect;
  rotation: Rotation;
  mirror: boolean;
  part?: FlatPart;
  symbol?: SchSymbol;
  /** The library unit, unturned. */
  base?: SymbolUnit;
  /** The unit as placed (symbol coordinates, y up). */
  unit?: SymbolUnit;
  /** Child block, for a sheet. */
  block?: string;
  ports?: { name: string; kind: PortKind; right: boolean }[];
}

/** Hierarchical labels and sheet pins for these port kinds sit on the right: signal flows left to right. */
export const outputKinds = new Set<PortKind>(["output", "power_out"]);

/** Everything about one block's sheet that layout needs before anything is placed. */
export interface SheetInput {
  block: CktFile;
  plan: DrawingPlan;
  nodes: Node[];
  /** Layout hint per part ref or instance. */
  hints: Map<string, LayoutHint>;
  planOf(net: string): NetPlan;
  roleOf(net: string | undefined): NetRole;
  /** Local nets reached by each port of `use` instances: "AFE.VDD" → net. */
  portNet: Map<string, string>;
}

/** A unit turned by `rotation` or mirrored, with its pins in sheet directions. */
export function orientNode(n: Node, rotation: Rotation, mirror: boolean): Node {
  if (n.kind === "sheet") {
    const w = n.box.w;
    const pins = (n.ports ?? []).map((p, i, all) => {
      const right = p.right !== mirror;
      const index = all.filter((q, k) => k < i && q.right === p.right).length;
      return {
        ...(n.pins[i] as NodePin),
        x: right ? w : 0,
        y: (index + 1) * GRID,
        outward: right ? 0 : 180,
      };
    });
    return { ...n, pins, mirror, rotation: 0 };
  }
  const base = n.base as SymbolUnit;
  const unit = mirror ? mirrorUnit(base) : rotateUnit(base, rotation);
  const pins = n.pins.map((p) => {
    const a = unit.pins.get(p.id);
    return a ? { ...p, x: a.x, y: -a.y, outward: a.outward } : p;
  });
  const { minX, maxX, minY, maxY } = unit.box;
  return {
    ...n,
    unit,
    pins,
    rotation,
    mirror,
    box: { x: minX, y: -maxY, w: maxX - minX, h: maxY - minY },
  };
}

/** Whether a node is a two-terminal part that may be turned (and attached to a host). */
export const isTwoTerminal = (n: Node) =>
  n.kind === "unit" && turnable.test(n.ref) && n.pins.length === 2;

const vertical = (outward: number) => outward === 90 || outward === 270;
export const isVertical = (n: Node) => n.pins.every((p) => vertical(p.outward));

/**
 * Collects the units and child sheets of a block with their nets, each in its default
 * orientation: a stored rotation, else the conventional one (`orient`); nothing is mirrored
 * yet (that waits for the signal flow).
 */
export function sheetInput(
  block: CktFile,
  plan: DrawingPlan,
  netlist: Netlist,
  blocks: Map<string, CktFile>,
): SheetInput {
  const name = block.block.name;
  const prefix = plan.instancesOf(name)[0]?.prefix ?? "";
  const partsByPath = new Map(netlist.parts.map((p) => [p.path, p]));

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
  const planOf = (net: string) => plan.net(name, net);
  const roleOf = (net: string | undefined): NetRole => {
    if (net === undefined) return "signal";
    const p = planOf(net);
    if (p.kind !== "power") return "signal";
    return p.symbol.bodyDir === 270 ? "ground" : "rail";
  };

  const hints = new Map<string, LayoutHint>();
  const nodes: Node[] = [];
  for (const decl of block.parts) {
    if (decl.layout) hints.set(decl.ref, decl.layout);
    const part = partsByPath.get(prefix + decl.ref);
    const symbol = part && plan.symbolOf(part);
    if (!part || !symbol) continue;
    for (const libUnit of symbol.units) {
      const visible = [...libUnit.pins].filter(([, a]) => !a.hidden);
      const base: Node = {
        id: `u:${decl.ref}:${libUnit.unit}`,
        kind: "unit",
        ref: decl.ref,
        line: decl.location.line,
        pins: visible.map(([number, a]) => {
          const net = pinNet.get(`${decl.ref}#${number}`);
          const own = part.pins.find((p) => p.number === number);
          return {
            id: number,
            name: own?.name ?? number,
            x: a.x,
            y: -a.y,
            outward: a.outward,
            // The part record's type: a generated symbol may not carry one.
            type: own?.type ?? a.type,
            ...(net !== undefined && { net }),
          };
        }),
        box: { x: 0, y: 0, w: 0, h: 0 },
        rotation: 0,
        mirror: false,
        part,
        symbol,
        base: { ...libUnit, pins: new Map(visible) },
      };
      const stored = decl.layout?.rotation;
      const auto = orient(decl.ref, libUnit, (number) => ({
        name: base.pins.find((p) => p.id === number)?.name ?? number,
        role: roleOf(pinNet.get(`${decl.ref}#${number}`)),
      }));
      const rotation = turnable.test(decl.ref) ? (stored ?? auto?.rotation ?? 0) : 0;
      nodes.push(orientNode(base, rotation, false));
    }
  }

  for (const u of block.uses) {
    if (u.layout) hints.set(u.instance, u.layout);
    const child = blocks.get(u.block);
    if (!child) continue;
    const ports = child.ports.filter((p) => {
      const net = child.nets.find((n) => n.port === p.name);
      return !net || plan.net(child.block.name, net.name).kind !== "power";
    });
    const isRight = (k: PortKind) => outputKinds.has(k) || k === "bidir";
    const left = ports.filter((p) => !isRight(p.kind));
    const right = ports.filter((p) => isRight(p.kind));
    const longest = (ps: typeof ports) => Math.max(0, ...ps.map((p) => textWidth(p.name)));
    const w =
      Math.ceil(
        Math.max(30.48, longest(left) + longest(right) + 4 * GRID, textWidth(u.instance) + GRID) /
          GRID,
      ) * GRID;
    const h = (Math.max(left.length, right.length, 1) + 1) * GRID;
    const ordered = [...left, ...right];
    const base: Node = {
      id: `s:${u.instance}`,
      kind: "sheet",
      ref: u.instance,
      line: u.location.line,
      pins: ordered.map((p) => {
        const net = portNet.get(`${u.instance}.${p.name}`);
        return {
          id: p.name,
          name: p.name,
          x: 0,
          y: 0,
          outward: 180,
          type: p.kind,
          ...(net !== undefined && { net }),
        };
      }),
      box: { x: 0, y: 0, w, h },
      rotation: 0,
      mirror: false,
      block: u.block,
      ports: ordered.map((p) => ({ name: p.name, kind: p.kind, right: isRight(p.kind) })),
    };
    nodes.push(orientNode(base, 0, false));
  }

  return { block, plan, nodes, hints, planOf, roleOf, portNet };
}
