import ElkBundled from "elkjs/lib/elk.bundled.js";
import type {
  ELK as ElkApi,
  ElkExtendedEdge,
  ElkNode,
  ElkPort,
  LayoutOptions,
} from "elkjs/lib/elk-api.js";
import type { CktFile, PortKind } from "../ckt/ast.js";
import type { LibField, SchSymbol, SymbolUnit, UnitPin } from "../kicad/libsym.js";
import { powerRotation, powerValueAt } from "../kicad/power.js";
import type { FlatPart, Netlist } from "../netlist/elaborate.js";
import { mirrorUnit, type NetRole, orient, type Rotation, rotateUnit, turnable } from "./orient.js";
import { type DrawingPlan, shapeOf } from "./plan.js";
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
  WireSegment,
} from "./types.js";
import { normalizeWires, snap, snapPt } from "./wires.js";

const GRID = 2.54;
const CHAR = 1.27;
const textWidth = (s: string) => s.length * CHAR;

const sideOf = (outward: number) =>
  outward === 180 ? "WEST" : outward === 0 ? "EAST" : outward === 90 ? "NORTH" : "SOUTH";

/** Hierarchical labels for these port kinds sit at the right edge (signal flows left to right). */
const outputKinds = new Set<PortKind>(["output", "power_out"]);

const rootOptions: LayoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  // Clear of KiCad's sheet frame and its coordinate band.
  "elk.padding": "[top=25.4,left=25.4,bottom=12.7,right=12.7]",
  // Tight: the room power symbols and labels need is reserved as port labels already, and the
  // odd overlapping reference or value text is a fair price for compact sheets.
  "elk.spacing.nodeNode": "2.54",
  "elk.layered.spacing.nodeNodeBetweenLayers": "7.62",
  "elk.spacing.edgeEdge": "2.54",
  "elk.spacing.edgeNode": "2.54",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "2.54",
  "elk.layered.spacing.edgeNodeBetweenLayers": "2.54",
  "elk.spacing.componentComponent": "10.16",
  "elk.layered.mergeEdges": "true",
  "elk.portLabels.placement": "OUTSIDE",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  // Brandes-Köpf stacks a layer's parts more tightly than network simplex, keeping sheets short.
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
};

/** KiCad paper sizes, smallest first (mm, landscape). */
export const papers: [name: string, w: number, h: number][] = [
  ["A4", 297, 210],
  ["A3", 420, 297],
  ["A2", 594, 420],
  ["A1", 841, 594],
  ["A0", 1189, 841],
];

/** Index into `papers` of the smallest sheet a layout fits, clear of the frame and title block. */
export const paperFor = (s: { width: number; height: number }) => {
  const i = papers.findIndex(([, w, h]) => w >= s.width + 10 && h >= s.height + 35);
  return i < 0 ? papers.length - 1 : i;
};

// The bundle is CommonJS whose module.exports is the constructor; its declaration file claims an
// ES default export instead, so type the import by hand.
const ELK = ElkBundled as unknown as new () => ElkApi;
let elk: ElkApi | undefined;

/**
 * ELK loads its in-process worker on first construction. That script takes a global `self`
 * without `document` to mean a web worker and then registers itself instead of exporting
 * anything. Bun defines `self`, so hide it for that moment.
 */
function createElk(): ElkApi {
  const g = globalThis as { self?: unknown };
  const self = "document" in g ? undefined : Object.getOwnPropertyDescriptor(g, "self");
  if (self?.configurable) delete g.self;
  try {
    return new ELK();
  } finally {
    if (self?.configurable) Object.defineProperty(g, "self", self);
  }
}

/** A library field (symbol coords, y up) placed relative to a symbol origin. */
function libText(origin: Pt, f: LibField): PlacedText {
  return { at: { x: origin.x + f.x, y: origin.y - f.y }, angle: f.angle, justify: f.justify };
}

/** The Value text a part shows (as `resolveBom` derives it), for sizing its field. */
const valueText = (part: FlatPart) =>
  part.spec.kind === "lib"
    ? (part.record?.mpn ?? part.spec.id)
    : (part.spec.args[0] ?? part.spec.fn);

/**
 * A centred field of a turned part: above a horizontal part (reference over value), or to the
 * right of an upright one. Centring keeps the text where it is meant to be whatever the
 * symbol's rotation, since KiCad applies justification in the symbol's own frame.
 */
function turnedField(
  box: Rect,
  upright: boolean,
  field: "ref" | "value",
  text: string,
  /** Text wider than the part starts at its left edge rather than overhanging both sides. */
  fromLeft = false,
): PlacedText {
  if (upright) {
    return {
      at: {
        x: box.x + box.w + GRID + textWidth(text) / 2,
        y: snap(box.y + box.h / 2) + (field === "ref" ? -CHAR : CHAR),
      },
      angle: 0,
      justify: [],
    };
  }
  return {
    at: {
      x: box.x + (fromLeft ? Math.max(box.w, textWidth(text)) : box.w) / 2,
      y: box.y - (field === "ref" ? 3 * CHAR : CHAR),
    },
    angle: 0,
    justify: [],
  };
}

/**
 * An ELK route moved onto the grid without breaking it: endpoints are the exact connection
 * points, each segment keeps its orientation (a horizontal segment takes its predecessor's y,
 * a vertical one its x, snapping only the free coordinate), and the last bend absorbs any
 * difference. Snapping points independently can round two ends of a segment apart when ELK
 * puts it exactly half a grid step off, leaving a dangling dogleg.
 */
export function gridRoute(raw: Pt[], start: Pt, end: Pt): Pt[] {
  const horizontal = (i: number) => {
    const a = raw[i] as Pt;
    const b = raw[i + 1] as Pt;
    return Math.abs(a.y - b.y) <= Math.abs(a.x - b.x);
  };
  if (raw.length <= 2) {
    if (start.x === end.x || start.y === end.y) return [start, end];
    // A straight run that snapped apart becomes a dogleg in the middle.
    if (horizontal(0)) {
      const mx = snap((start.x + end.x) / 2);
      return [start, { x: mx, y: start.y }, { x: mx, y: end.y }, end];
    }
    const my = snap((start.y + end.y) / 2);
    return [start, { x: start.x, y: my }, { x: end.x, y: my }, end];
  }
  const pts: Pt[] = [start];
  for (let i = 1; i < raw.length - 1; i++) {
    const prev = pts[i - 1] as Pt;
    const p = raw[i] as Pt;
    pts.push(horizontal(i - 1) ? { x: snap(p.x), y: prev.y } : { x: prev.x, y: snap(p.y) });
  }
  // The final segment must reach `end`; move the last bend along it.
  const last = pts.length - 1;
  const bend = pts[last] as Pt;
  pts[last] = horizontal(raw.length - 2) ? { x: bend.x, y: end.y } : { x: end.x, y: bend.y };
  pts.push(end);
  return pts.filter(
    (p, i) => i === 0 || p.x !== (pts[i - 1] as Pt).x || p.y !== (pts[i - 1] as Pt).y,
  );
}

interface PinSlot {
  ref: string;
  unit: number;
  number: string;
  anchor: UnitPin;
  net?: string;
  /** Pins after the first in a run of adjacent same-net pins are joined to it by wire. */
  groupRep?: string;
  portId: string;
}

interface UnitNode {
  part: FlatPart;
  ref: string;
  /** The unit as placed, already rotated. */
  unit: SymbolUnit;
  rotation: Rotation;
  mirror: boolean;
  flippable: boolean;
  libId: string;
  id: string;
  textRight: boolean;
  slots: PinSlot[];
  fields?: SchSymbol["fields"];
}

/**
 * Lays out one block's sheet with ELK: parts and child sheets placed left to right, small nets
 * routed as orthogonal wires, and everything snapped to KiCad's 1.27 mm connection grid. The
 * same geometry drives the viewer and the KiCad export.
 *
 * Two-terminal parts are turned to read conventionally (see `orient`). After a first layout,
 * series parts whose neighbours ended up on the wrong side are reversed and other parts whose
 * pins mostly face away from what they connect to are mirrored, and the sheet is laid out again
 * with each change; the layout with the least wiring wins.
 */
export async function layoutSheet(
  block: CktFile,
  plan: DrawingPlan,
  netlist: Netlist,
  blocks: Map<string, CktFile>,
): Promise<SheetLayout> {
  const first = await layoutOnce(block, plan, netlist, blocks, new Set(), new Set());
  let best = first.layout;
  let flips = new Set<string>();
  const mirrors = new Set<string>();
  const attempt = async (f: Set<string>, m: Set<string>) => {
    const { layout } = await layoutOnce(block, plan, netlist, blocks, f, m);
    const better = wiring(layout) < wiring(best);
    if (better) best = layout;
    return better;
  };
  if (first.backwards.length > 0 && (await attempt(new Set(first.backwards), mirrors))) {
    flips = new Set(first.backwards);
  }
  // Mirrors one at a time, each kept only if it helps.
  for (const id of first.mirrorable.slice(0, MAX_MIRROR_TRIALS)) {
    if (await attempt(flips, new Set([...mirrors, id]))) mirrors.add(id);
  }
  return best;
}

/** Layouts tried per sheet for mirroring, bounding the cost of a large sheet. */
const MAX_MIRROR_TRIALS = 6;

interface Trial {
  layout: SheetLayout;
  /** Series parts whose neighbours ended up on the wrong side. */
  backwards: string[];
  /** Units whose side pins mostly face away from what they connect to. */
  mirrorable: string[];
}

/** How much wiring a layout needs, its paper size first: lower is tidier. */
const wiring = (s: SheetLayout) =>
  paperFor(s) * 1e6 +
  s.wires.reduce((sum, w) => sum + Math.abs(w.a.x - w.b.x) + Math.abs(w.a.y - w.b.y), 0) +
  s.wires.length * GRID;

const lexLess = (a: number[], b: number[]) => {
  const i = a.findIndex((v, k) => v !== b[k]);
  return i >= 0 && (a[i] as number) < (b[i] as number);
};

/** Clear of KiCad's sheet frame and its coordinate band. */
const PAD = { top: 15.24, left: 15.24 };
const COMPONENT_GAP = 5.08;

/**
 * Rearranges ELK's connected components (moving each rigidly, wires included) into rows that
 * fit the smallest paper possible, tallest first. ELK's own packing tends to stack small groups
 * above the main circuit and leave the sheet tall and half empty.
 */
function packComponents(
  out: ElkNode,
  /** Declaration order of the nodes, which the packing follows. */
  declared: Map<string, number>,
): void {
  const nodes = out.children ?? [];
  const nodeOfPort = new Map<string, string>();
  for (const n of nodes) for (const p of n.ports ?? []) nodeOfPort.set(p.id, n.id);
  const parent = new Map(nodes.map((n) => [n.id, n.id]));
  const find = (id: string): string => {
    const p = parent.get(id) as string;
    if (p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  const edges = (out.edges ?? []) as ElkExtendedEdge[];
  for (const e of edges) {
    const ends = [...e.sources, ...e.targets].map((id) => nodeOfPort.get(id) ?? id);
    for (const id of ends.slice(1)) parent.set(find(id), find(ends[0] as string));
  }

  interface Box {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }
  const boxes = new Map<string, Box>();
  const grow = (root: string, x: number, y: number, w = 0, h = 0) => {
    const b = boxes.get(root) ?? { minX: x, minY: y, maxX: x + w, maxY: y + h };
    b.minX = Math.min(b.minX, x);
    b.minY = Math.min(b.minY, y);
    b.maxX = Math.max(b.maxX, x + w);
    b.maxY = Math.max(b.maxY, y + h);
    boxes.set(root, b);
  };
  for (const n of nodes) {
    const root = find(n.id);
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    grow(root, x, y, n.width, n.height);
    for (const l of n.labels ?? []) grow(root, x + (l.x ?? 0), y + (l.y ?? 0), l.width, l.height);
    for (const p of n.ports ?? []) {
      for (const l of p.labels ?? []) {
        grow(root, x + (p.x ?? 0) + (l.x ?? 0), y + (p.y ?? 0) + (l.y ?? 0), l.width, l.height);
      }
    }
  }
  const edgeRoot = (e: ElkExtendedEdge) => find(nodeOfPort.get(e.sources[0] as string) ?? "");
  for (const e of edges) {
    for (const s of e.sections ?? []) {
      for (const p of [s.startPoint, ...(s.bendPoints ?? []), s.endPoint])
        grow(edgeRoot(e), p.x, p.y);
    }
  }
  // Room for the power symbols and text drawn around the parts.
  const order = new Map<string, number>();
  for (const n of nodes) {
    const root = find(n.id);
    const i = declared.get(n.id) ?? 0;
    order.set(root, Math.min(order.get(root) ?? i, i));
  }
  const comps = [...boxes].map(([root, b]) => ({
    root,
    x: b.minX - CHAR,
    y: b.minY - GRID,
    w: b.maxX - b.minX + 2 * CHAR,
    h: b.maxY - b.minY + 2 * GRID,
  }));
  // In declaration order, so the sheet reads in the order the circuit was written.
  comps.sort((a, b) => (order.get(a.root) ?? 0) - (order.get(b.root) ?? 0));

  // Each component goes right of or under one already placed, wherever keeps the sheet
  // shortest (then highest, then leftmost), no wider than the paper allows.
  const pack = (maxW: number) => {
    const at = new Map<string, Pt>();
    const done: Rect[] = [];
    let width = 0;
    let height = 0;
    const clear = (r: Rect) =>
      done.every(
        (p) =>
          r.x >= p.x + p.w + COMPONENT_GAP - 0.01 ||
          p.x >= r.x + r.w + COMPONENT_GAP - 0.01 ||
          r.y >= p.y + p.h + COMPONENT_GAP - 0.01 ||
          p.y >= r.y + r.h + COMPONENT_GAP - 0.01,
      );
    for (const c of comps) {
      const spots: Pt[] = [
        { x: 0, y: 0 },
        ...done.flatMap((p) => [
          { x: p.x + p.w + COMPONENT_GAP, y: p.y },
          { x: p.x, y: p.y + p.h + COMPONENT_GAP },
        ]),
      ];
      let best: { spot: Pt; score: number[] } | undefined;
      for (const spot of spots) {
        const r = { x: spot.x, y: spot.y, w: c.w, h: c.h };
        if ((spot.x > 0 && spot.x + c.w > maxW) || !clear(r)) continue;
        const score = [Math.max(height, spot.y + c.h), spot.y, spot.x];
        if (!best || lexLess(score, best.score)) best = { spot, score };
      }
      const spot = best?.spot ?? { x: 0, y: height + COMPONENT_GAP };
      at.set(c.root, spot);
      done.push({ x: spot.x, y: spot.y, w: c.w, h: c.h });
      width = Math.max(width, spot.x + c.w);
      height = Math.max(height, spot.y + c.h);
    }
    return { at, width, height };
  };
  let packed = pack(Number.POSITIVE_INFINITY);
  for (const [name, w] of papers) {
    const p = pack(w - 10 - PAD.left - 2 * GRID);
    packed = p;
    const extent = { width: PAD.left + p.width + 2 * GRID, height: PAD.top + p.height + 2 * GRID };
    if (papers[paperFor(extent)]?.[0] === name) break;
  }

  const shift = new Map(
    comps.map((c) => {
      const to = packed.at.get(c.root) as Pt;
      // Whole grid steps, so that snapping treats every part of a component alike.
      return [c.root, { dx: snap(PAD.left + to.x - c.x), dy: snap(PAD.top + to.y - c.y) }];
    }),
  );
  for (const n of nodes) {
    const d = shift.get(find(n.id)) as { dx: number; dy: number };
    n.x = (n.x ?? 0) + d.dx;
    n.y = (n.y ?? 0) + d.dy;
  }
  for (const e of edges) {
    const d = shift.get(edgeRoot(e));
    if (!d) continue;
    for (const s of e.sections ?? []) {
      for (const p of [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]) {
        p.x += d.dx;
        p.y += d.dy;
      }
    }
  }
  out.width = PAD.left + packed.width;
  out.height = PAD.top + packed.height;
}

async function layoutOnce(
  block: CktFile,
  plan: DrawingPlan,
  netlist: Netlist,
  blocks: Map<string, CktFile>,
  /** Refdes of series parts to lay the other way round. */
  flips: Set<string>,
  /** Units (`u:J2:1`) to mirror left to right. */
  mirrors: Set<string>,
): Promise<Trial> {
  elk ??= createElk();
  const name = block.block.name;
  const inst = plan.instancesOf(name)[0];
  const prefix = inst?.prefix ?? "";
  const partsByPath = new Map(netlist.parts.map((p) => [p.path, p]));

  // Which local net each part pin and each instance port is on.
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
  /** Text drawn at a connection point for label- and power-drawn nets; undefined for wires. */
  const tagText = (net: string | undefined): string | undefined => {
    if (net === undefined) return undefined;
    const p = planOf(net);
    return p.kind === "power" ? p.name : p.kind === "label" ? p.text : undefined;
  };
  const tagLabel = (net: string | undefined, vertical: boolean) => {
    const text = tagText(net);
    if (text === undefined) return [];
    const power = planOf(net as string).kind === "power";
    // A power symbol beside a side pin usually stands on a stub with its name centred over it;
    // sized for that (where it points sideways instead, its name may overhang a little).
    if (power && !vertical) {
      return [{ text, width: GRID + textWidth(text) / 2 + CHAR, height: 3 * GRID }];
    }
    // Above or below a pin it points straight out, its name level and centred.
    if (power) return [{ text, width: GRID, height: 2 * GRID }];
    const width = textWidth(text) + (power ? 2 * GRID : GRID);
    return [vertical ? { text, width: GRID, height: width } : { text, width, height: GRID }];
  };

  const children: ElkNode[] = [];
  const edges: ElkExtendedEdge[] = [];
  const unitNodes: UnitNode[] = [];
  /** A pin's role for orienting its part: power nets are rails, or ground if drawn pointing down. */
  const roleOf = (net: string | undefined): NetRole => {
    if (net === undefined) return "signal";
    const p = planOf(net);
    if (p.kind !== "power") return "signal";
    return p.symbol.bodyDir === 270 ? "ground" : "rail";
  };
  const slots: PinSlot[] = [];
  /** Wires joining adjacent same-net pins, by port id. */
  const spines: { net: string; from: string; to: string }[] = [];
  /**
   * Connection items per wired net, as ELK port ids, with the direction signal flows through
   * them: out of right-side (east) pins, into left-side (west) ones.
   */
  const wiredItems = new Map<string, { portId: string; flow: "out" | "in" | "any" }[]>();
  const flowOf = (outward: number) => (outward === 0 ? "out" : outward === 180 ? "in" : "any");
  const addItem = (net: string, portId: string, flow: "out" | "in" | "any") => {
    if (planOf(net).kind !== "wire") return;
    wiredItems.set(net, [...(wiredItems.get(net) ?? []), { portId, flow }]);
  };

  for (const decl of block.parts) {
    const part = partsByPath.get(prefix + decl.ref);
    const symbol = part && plan.symbolOf(part);
    if (!part || !symbol) continue;
    for (const libUnit of symbol.units) {
      const orientation = orient(decl.ref, libUnit, (number) => ({
        name: part.pins.find((p) => p.number === number)?.name ?? number,
        role: roleOf(pinNet.get(`${decl.ref}#${number}`)),
      }));
      const rotation = (((orientation?.rotation ?? 0) + (flips.has(decl.ref) ? 180 : 0)) %
        360) as Rotation;
      const id = `u:${decl.ref}:${libUnit.unit}`;
      const mirror = !orientation && mirrors.has(id);
      const unit = mirror ? mirrorUnit(libUnit) : rotateUnit(libUnit, rotation);
      const visible = [...unit.pins].filter(([, a]) => !a.hidden);

      // Runs of adjacent pins on one side and one net become one connection.
      const unitSlots: PinSlot[] = visible.map(([number, anchor]) => ({
        ref: decl.ref,
        unit: unit.unit,
        number,
        anchor,
        portId: `${id}:${number}`,
        ...(pinNet.has(`${decl.ref}#${number}`) && {
          net: pinNet.get(`${decl.ref}#${number}`) as string,
        }),
      }));
      for (const outward of [0, 90, 180, 270]) {
        const along = (s: PinSlot) => (outward === 0 || outward === 180 ? -s.anchor.y : s.anchor.x);
        const side = unitSlots
          .filter((s) => s.anchor.outward === outward)
          .sort((a, b) => along(a) - along(b));
        for (let i = 1; i < side.length; i++) {
          const prev = side[i - 1] as PinSlot;
          const cur = side[i] as PinSlot;
          if (cur.net !== undefined && cur.net === prev.net) {
            cur.groupRep = prev.groupRep ?? prev.portId;
            spines.push({ net: cur.net, from: prev.portId, to: cur.portId });
          }
        }
      }
      slots.push(...unitSlots);

      unitNodes.push({
        part,
        ref: decl.ref,
        unit,
        rotation,
        mirror,
        flippable: orientation?.flippable ?? false,
        libId: symbol.libId,
        id,
        textRight: !visible.some(([, a]) => a.outward === 0 || a.outward === 180),
        slots: unitSlots,
        ...(symbol.fields && { fields: symbol.fields }),
      });
    }
  }

  // Satellites: two-terminal parts on power nets only (decoupling capacitors, say) have no wire
  // to place them by and would float off on their own. Each is drawn in a row under (or over)
  // the part it serves: the nearest declared IC or connector on one of its rails whose bottom
  // (or top) edge carries no signal.
  const declIndex = (n: UnitNode) => block.parts.findIndex((p) => p.ref === n.ref);
  const edgeFree = (n: UnitNode, outward: number) =>
    n.slots.every(
      (s) => s.anchor.outward !== outward || s.net === undefined || roleOf(s.net) !== "signal",
    );
  const satellites = new Map<string, UnitNode[]>(); // owner id → its satellites
  for (const n of unitNodes) {
    if (!turnable.test(n.ref) || n.slots.length !== 2) continue;
    if (n.slots.some((s) => roleOf(s.net) === "signal")) continue;
    const rails = new Set(
      n.slots.flatMap((s) => (roleOf(s.net) === "rail" ? [s.net as string] : [])),
    );
    const here = declIndex(n);
    // Parts with a supply pin on the rail (an IC's input or a regulator's output) come before
    // ones that merely carry it (a connector), then the nearest declared.
    const consumes = (o: UnitNode) =>
      o.slots.some(
        (s) =>
          s.net !== undefined &&
          rails.has(s.net) &&
          (s.anchor.type === "power_in" || s.anchor.type === "power_out"),
      )
        ? 0
        : 1;
    const owner = unitNodes
      .filter(
        (o) =>
          !turnable.test(o.ref) &&
          (edgeFree(o, 270) || edgeFree(o, 90)) &&
          o.slots.some((s) => s.net !== undefined && rails.has(s.net)),
      )
      .sort(
        (a, b) =>
          consumes(a) - consumes(b) ||
          Math.abs(declIndex(a) - here) - Math.abs(declIndex(b) - here),
      )[0];
    if (owner) satellites.set(owner.id, [...(satellites.get(owner.id) ?? []), n]);
  }
  // Riders are drawn at a fixed place beside another part (their host) rather than laid out by
  // ELK: the host's ELK node grows to cover them. Offsets are from the host's symbol origin, in
  // sheet directions (y down).
  const rides = new Map<string, { owner: string; x: number; y: number }>();
  /** Areas riders take up around each host, in the same coordinates. */
  const rideAreas = new Map<string, Rect[]>();
  const addArea = (owner: string, r: Rect) =>
    rideAreas.set(owner, [...(rideAreas.get(owner) ?? []), r]);
  const localBox = (n: UnitNode): Rect => ({
    x: n.unit.box.minX,
    y: -n.unit.box.maxY,
    w: n.unit.box.maxX - n.unit.box.minX,
    h: n.unit.box.maxY - n.unit.box.minY,
  });
  /** Room for a rider's reference and value, drawn to its right. */
  const textRoom = (n: UnitNode) =>
    Math.max(textWidth(n.ref), textWidth(valueText(n.part))) + 2 * GRID;

  for (const [owner, row] of satellites) {
    const n = unitNodes.find((u) => u.id === owner) as UnitNode;
    const { minX, maxY, minY } = n.unit.box;
    // Each satellite stands with its rail symbol over it, ground under it, text to its right.
    const rowH = Math.max(...row.map((s) => s.unit.box.maxY - s.unit.box.minY));
    const below = edgeFree(n, 270);
    const pins = n.slots.some((s) => s.anchor.outward === (below ? 270 : 90));
    const gap = (pins ? 3 * GRID : GRID) + (below ? 0 : 2 * GRID); // owner's tags and text
    const rowTop = below ? -minY + gap + 2 * GRID : -maxY - gap - 2 * GRID - rowH;
    let x = minX;
    for (const s of row) {
      rides.set(s.id, { owner, x: x - s.unit.box.minX, y: rowTop + s.unit.box.maxY });
      const w = s.unit.box.maxX - s.unit.box.minX + textRoom(s);
      addArea(owner, { x, y: rowTop - 2 * GRID, w, h: rowH + 4 * GRID });
      x += w + GRID;
    }
  }

  // Shunts: a two-terminal part from a wired net to ground (or a rail) hangs under (or stands
  // over) the net's wire, beside a pin on another part, instead of taking a place of its own in
  // the signal path. The host pin's ELK port moves to the end of the row, so the net's wires
  // start there and run back along the row to the pin.
  const isSatellite = new Set([...satellites.values()].flat().map((s) => s.id));
  const shuntsOf = new Map<string, { n: UnitNode; signal: PinSlot; below: boolean }[]>();
  for (const n of unitNodes) {
    if (isSatellite.has(n.id) || !turnable.test(n.ref) || n.slots.length !== 2) continue;
    const signal = n.slots.find((s) => roleOf(s.net) === "signal");
    const supply = n.slots.find((s) => s !== signal && roleOf(s.net) !== "signal");
    if (!signal?.net || !supply || planOf(signal.net).kind !== "wire") continue;
    const list = shuntsOf.get(signal.net) ?? [];
    list.push({ n, signal, below: roleOf(supply.net) === "ground" });
    shuntsOf.set(signal.net, list);
  }
  const shuntIds = new Set([...shuntsOf.values()].flat().map((s) => s.n.id));
  /** Host ports moved to the end of their shunt rows: port id → x offset from the pin. */
  const portShift = new Map<string, number>();
  const drops: { net: string; host: string; shunt: string }[] = [];
  const overlaps = (a: Rect, b: Rect) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  for (const [net, shunts] of shuntsOf) {
    const hosts = unitNodes
      .filter((h) => !shuntIds.has(h.id) && !isSatellite.has(h.id))
      .flatMap((h) =>
        h.slots
          .filter(
            (s) =>
              s.net === net &&
              (s.anchor.outward === 0 || s.anchor.outward === 180) &&
              !s.groupRep &&
              !h.slots.some((o) => o.groupRep === s.portId),
          )
          .map((s) => ({ h, s })),
      )
      // Prefer the pin signal flows out of, so the shunts sit where the net starts.
      .sort((a, b) => a.s.anchor.outward - b.s.anchor.outward);
    for (const { h, s } of hosts) {
      const d = s.anchor.outward === 0 ? 1 : -1;
      const px = s.anchor.x;
      const py = -s.anchor.y;
      const placed: { id: string; x: number; y: number; area: Rect }[] = [];
      let farthest = px;
      for (const below of [true, false]) {
        let cursor = px + d * 2 * GRID;
        for (const { n, signal } of shunts.filter((x) => x.below === below)) {
          const { minX, maxX, maxY } = n.unit.box;
          const left = signal.anchor.x - minX;
          const right = maxX - signal.anchor.x + textRoom(n);
          const pinX =
            d > 0
              ? Math.ceil((cursor + left) / GRID) * GRID
              : Math.floor((cursor - right) / GRID) * GRID;
          cursor = d > 0 ? pinX + right + GRID : pinX - left - GRID;
          const pinY = py + (below ? 2 * GRID : -2 * GRID);
          const ox = pinX - signal.anchor.x;
          const oy = pinY + signal.anchor.y;
          const body = {
            x: ox + minX,
            y: oy - maxY,
            w: maxX - minX + textRoom(n),
            h: n.unit.box.maxY - n.unit.box.minY,
          };
          // From the wire to past the supply symbol at the far end.
          const top = below ? py : body.y - 3 * GRID;
          const bottom = below ? body.y + body.h + 3 * GRID : py;
          placed.push({
            id: n.id,
            x: ox,
            y: oy,
            area: { x: body.x, y: top, w: body.w, h: bottom - top },
          });
          farthest = d > 0 ? Math.max(farthest, body.x + body.w) : Math.min(farthest, body.x);
        }
      }
      const end = d > 0 ? Math.ceil(farthest / GRID) * GRID : Math.floor(farthest / GRID) * GRID;
      // Clear of the host's other connected pins on that side, and of its other riders.
      const blocked = placed.some(
        ({ area }) =>
          h.slots.some(
            (o) =>
              o !== s &&
              o.net !== undefined &&
              o.anchor.outward === s.anchor.outward &&
              -o.anchor.y >= area.y - GRID &&
              -o.anchor.y <= area.y + area.h + GRID,
          ) || (rideAreas.get(h.id) ?? []).some((r) => overlaps(r, area)),
      );
      if (blocked) continue;
      for (const p of placed) {
        rides.set(p.id, { owner: h.id, x: p.x, y: p.y });
        addArea(h.id, p.area);
        drops.push({
          net,
          host: s.portId,
          shunt: `${p.id}:${shunts.find((x) => x.n.id === p.id)?.signal.number}`,
        });
      }
      // Wires continue from the end of the row only if the net goes anywhere else.
      const p = planOf(net);
      const onward =
        slots.some((o) => o.net === net && o !== s && !shuntIds.has(`u:${o.ref}:${o.unit}`)) ||
        [...portNet.values()].includes(net) ||
        (p.kind === "wire" && p.port !== undefined);
      if (onward) portShift.set(s.portId, end - px);
      break;
    }
  }

  /** Where each host's symbol origin sits inside its ELK node. */
  const originIn = new Map<string, Pt>();

  for (const n of unitNodes) {
    if (rides.has(n.id)) continue;
    const { minX, maxX, minY, maxY } = n.unit.box;
    const own = localBox(n);
    const areas = [own, ...(rideAreas.get(n.id) ?? [])];
    const x0 = Math.min(...areas.map((r) => r.x));
    const y0 = Math.min(...areas.map((r) => r.y));
    const width = Math.max(Math.max(...areas.map((r) => r.x + r.w)) - x0, maxX - minX, CHAR);
    const height = Math.max(Math.max(...areas.map((r) => r.y + r.h)) - y0, maxY - minY, CHAR);
    originIn.set(n.id, { x: -x0, y: -y0 });
    children.push({
      id: n.id,
      width,
      height,
      layoutOptions: {
        "elk.portConstraints": "FIXED_POS",
        "elk.nodeLabels.placement": n.textRight
          ? "OUTSIDE H_RIGHT V_CENTER"
          : n.rotation !== 0
            ? "OUTSIDE V_TOP H_CENTER"
            : "OUTSIDE V_TOP H_LEFT",
      },
      labels: [
        {
          text: n.ref,
          width: Math.max(textWidth(valueText(n.part)), textWidth(n.ref)) + GRID,
          height: 2 * GRID,
        },
      ],
      ports: n.slots.map((s): ElkPort => {
        const vertical = s.anchor.outward === 90 || s.anchor.outward === 270;
        return {
          id: s.portId,
          x: s.anchor.x - x0 + (portShift.get(s.portId) ?? 0),
          y: -s.anchor.y - y0,
          width: 0,
          height: 0,
          layoutOptions: { "elk.port.side": sideOf(s.anchor.outward) },
          labels: s.groupRep ? [] : tagLabel(s.net, vertical),
        };
      }),
    });
    for (const s of n.slots) {
      if (s.net !== undefined && !s.groupRep) addItem(s.net, s.portId, flowOf(s.anchor.outward));
    }
  }

  // Child sheets: one pin per port that is not a global power net.
  const sheetNodes: {
    id: string;
    instance: string;
    block: string;
    w: number;
    h: number;
    pins: PlacedSheet["pins"];
    portIds: string[];
  }[] = [];
  for (const u of block.uses) {
    const child = blocks.get(u.block);
    if (!child) continue;
    const ports = child.ports.filter((p) => {
      const net = child.nets.find((n) => n.port === p.name);
      return !net || plan.net(child.block.name, net.name).kind !== "power";
    });
    const left = ports.filter((p) => !outputKinds.has(p.kind) && p.kind !== "bidir");
    const right = ports.filter((p) => outputKinds.has(p.kind) || p.kind === "bidir");
    const longest = (ps: typeof ports) => Math.max(0, ...ps.map((p) => textWidth(p.name)));
    const w =
      Math.ceil(
        Math.max(30.48, longest(left) + longest(right) + 4 * GRID, textWidth(u.instance) + GRID) /
          GRID,
      ) * GRID;
    const h = (Math.max(left.length, right.length, 1) + 1) * GRID;
    const id = `s:${u.instance}`;
    const elkPorts: ElkPort[] = [];
    const pins: PlacedSheet["pins"] = [];
    const portIds: string[] = [];
    const add = (p: (typeof ports)[number], i: number, isRight: boolean) => {
      const portId = `${id}:${p.name}`;
      const net = portNet.get(`${u.instance}.${p.name}`);
      elkPorts.push({
        id: portId,
        x: isRight ? w : 0,
        y: (i + 1) * GRID,
        width: 0,
        height: 0,
        layoutOptions: { "elk.port.side": isRight ? "EAST" : "WEST" },
        labels: tagLabel(net, false),
      });
      pins.push({
        port: p.name,
        kind: p.kind,
        at: { x: isRight ? w : 0, y: (i + 1) * GRID },
        outward: isRight ? 0 : 180,
        ...(net !== undefined && { net }),
      });
      portIds.push(portId);
      if (net !== undefined) addItem(net, portId, isRight ? "out" : "in");
    };
    left.forEach((p, i) => {
      add(p, i, false);
    });
    right.forEach((p, i) => {
      add(p, i, true);
    });
    sheetNodes.push({ id, instance: u.instance, block: u.block, w, h, pins, portIds });
    children.push({
      id,
      width: w,
      height: h,
      layoutOptions: {
        "elk.portConstraints": "FIXED_POS",
        "elk.nodeLabels.placement": "OUTSIDE V_TOP H_LEFT",
      },
      labels: [{ text: u.instance, width: textWidth(u.instance), height: GRID }],
      ports: elkPorts,
    });
  }

  // Hierarchical labels of wired port nets are nodes too, pinned to the first or last layer.
  const hierNodes: {
    id: string;
    net: string;
    text: string;
    shape: string;
    right: boolean;
    w: number;
  }[] = [];
  /** Hierarchical labels drawn straight on the one pin their net reaches in this sheet. */
  const pinLabels: { net: string; text: string; shape: string; portId: string }[] = [];
  const elkPorts = new Map(children.flatMap((c) => c.ports ?? []).map((p) => [p.id, p]));
  for (const n of block.nets) {
    const p = planOf(n.name);
    if (p.kind !== "wire" || !p.port) continue;
    const only = wiredItems.get(n.name);
    if (only?.length === 1) {
      const portId = (only[0] as { portId: string }).portId;
      pinLabels.push({ net: n.name, text: p.port.name, shape: shapeOf[p.port.kind], portId });
      const port = elkPorts.get(portId);
      const side = port?.layoutOptions?.["elk.port.side"];
      const w = textWidth(p.port.name) + 2 * GRID;
      port?.labels?.push(
        side === "NORTH" || side === "SOUTH"
          ? { text: p.port.name, width: GRID, height: w }
          : { text: p.port.name, width: w, height: GRID },
      );
      continue;
    }
    const right = outputKinds.has(p.port.kind);
    const w = textWidth(p.port.name) + 1.5 * GRID;
    const id = `h:${n.name}`;
    hierNodes.push({ id, net: n.name, text: p.port.name, shape: shapeOf[p.port.kind], right, w });
    children.push({
      id,
      width: w,
      height: GRID,
      layoutOptions: {
        "elk.portConstraints": "FIXED_POS",
        "elk.layered.layering.layerConstraint": right ? "LAST" : "FIRST",
      },
      ports: [
        {
          id: `${id}:p`,
          x: right ? 0 : w,
          y: GRID / 2,
          width: 0,
          height: 0,
          layoutOptions: { "elk.port.side": right ? "WEST" : "EAST" },
        },
      ],
    });
    // An input label feeds its net from the left; an output label is fed from the right.
    const items = wiredItems.get(n.name) ?? [];
    const item = { portId: `${id}:p`, flow: right ? ("in" as const) : ("out" as const) };
    wiredItems.set(n.name, right ? [...items, item] : [item, ...items]);
  }

  // Each wired net is a star from a hub, preferably a pin signal flows out of; every edge runs
  // out of an east pin or into a west pin where it can, so ELK layers parts left to right.
  for (const [net, items] of wiredItems) {
    const hub =
      items.find((i) => i.flow === "out") ?? items.find((i) => i.flow === "any") ?? items[0];
    if (!hub) continue;
    let n = 0;
    for (const item of items) {
      if (item === hub) continue;
      const reversed = item.flow === "out" && hub.flow !== "out";
      edges.push({
        id: `e:${net}:${n++}`,
        sources: [reversed ? item.portId : hub.portId],
        targets: [reversed ? hub.portId : item.portId],
      });
    }
  }

  // A two-terminal part to ground goes at the bottom of its column, so its wire drops into its
  // top pin instead of hooking over it; one to a rail goes at the top. Listing them last (or
  // first) is a hint ELK follows where crossings don't decide; a second pass enforces it.
  const nodeRank = new Map<string, number>();
  for (const n of unitNodes) {
    if (rides.has(n.id) || !turnable.test(n.ref) || n.slots.length !== 2) continue;
    const roles = n.slots.map((s) => roleOf(s.net));
    if (roles.includes("ground")) nodeRank.set(n.id, 2);
    else if (roles.includes("rail")) nodeRank.set(n.id, 0);
  }
  const rankOf = (id: string) => nodeRank.get(id) ?? 1;
  const declared = new Map(children.map((c, i) => [c.id, i]));
  const edgeRank = (e: ElkExtendedEdge) => {
    const ranks = [...e.sources, ...e.targets].map((p) => rankOf(p.slice(0, p.lastIndexOf(":"))));
    return ranks.includes(2) ? 2 : ranks.includes(0) ? 0 : 1;
  };
  children.sort((a, b) => rankOf(a.id) - rankOf(b.id));
  edges.sort((a, b) => edgeRank(a) - edgeRank(b));

  const graph: ElkNode = { id: name, layoutOptions: rootOptions, children, edges };
  let out = await elk.layout(graph);
  if (nodeRank.size > 0) {
    // Lay out again keeping each column's order from the first pass, except that grounded
    // parts move to the bottom of theirs and rail-connected ones to the top.
    const first = new Map((out.children ?? []).map((c) => [c.id, c]));
    const shift = (id: string) => (rankOf(id) - 1) * 1e5;
    out = await elk.layout({
      id: name,
      layoutOptions: { ...rootOptions, "elk.layered.crossingMinimization.strategy": "INTERACTIVE" },
      children: children.map((c) => ({
        ...c,
        x: first.get(c.id)?.x ?? 0,
        y: (first.get(c.id)?.y ?? 0) + shift(c.id),
      })),
      edges: edges.map((e) => ({ id: e.id, sources: e.sources, targets: e.targets })),
    });
  }
  packComponents(out, declared);
  const placed = new Map((out.children ?? []).map((c) => [c.id, c]));
  const portPoint = new Map<string, Pt>();

  // Symbol origins: hosts where ELK put their nodes, riders at their offsets from the host.
  const origin = new Map<string, Pt>();
  for (const n of unitNodes) {
    if (rides.has(n.id)) continue;
    const node = placed.get(n.id) as ElkNode;
    const o = originIn.get(n.id) as Pt;
    origin.set(n.id, snapPt({ x: (node.x ?? 0) + o.x, y: (node.y ?? 0) + o.y }));
  }
  for (const [id, r] of rides) {
    const host = origin.get(r.owner) as Pt;
    origin.set(id, snapPt({ x: host.x + r.x, y: host.y + r.y }));
  }

  const units: PlacedUnit[] = [];
  for (const n of unitNodes) {
    const { minX, maxX, minY, maxY } = n.unit.box;
    const at = origin.get(n.id) as Pt;
    const pins: PlacedPin[] = [];
    for (const s of n.slots) {
      const p = { x: snap(at.x + s.anchor.x), y: snap(at.y - s.anchor.y) };
      portPoint.set(s.portId, p);
      pins.push({
        number: s.number,
        at: p,
        outward: s.anchor.outward,
        ...(s.net !== undefined && { net: s.net }),
      });
    }
    const box = { x: at.x + minX, y: at.y - maxY, w: maxX - minX, h: maxY - minY };
    units.push({
      ref: n.ref,
      path: n.part.path,
      libId: n.libId,
      unit: n.unit.unit,
      at,
      rotation: n.rotation,
      mirror: n.mirror,
      box,
      pins,
      // KiCad symbols carry their author's field placement; generated and turned ones get ours.
      // Fields of turned or mirrored parts are centred: KiCad interprets justification in the
      // symbol's frame.
      refField:
        n.rotation !== 0 || n.mirror
          ? turnedField(box, n.textRight, "ref", n.ref, n.mirror)
          : n.fields?.reference
            ? libText(at, n.fields.reference)
            : n.textRight
              ? {
                  at: { x: snap(box.x + box.w + GRID), y: snap(at.y - CHAR) },
                  angle: 0,
                  justify: ["left"],
                }
              : {
                  at: { x: box.x, y: snap(box.y - 2 * GRID) },
                  angle: 0,
                  justify: ["left", "bottom"],
                },
      valueField:
        n.rotation !== 0 || n.mirror
          ? turnedField(box, n.textRight, "value", valueText(n.part), n.mirror)
          : n.fields?.value
            ? libText(at, n.fields.value)
            : n.textRight
              ? {
                  at: { x: snap(box.x + box.w + GRID), y: snap(at.y + CHAR) },
                  angle: 0,
                  justify: ["left"],
                }
              : {
                  at: { x: box.x, y: snap(box.y - 0.5 * CHAR) },
                  angle: 0,
                  justify: ["left", "bottom"],
                },
    });
  }

  const sheets: PlacedSheet[] = sheetNodes.map((s) => {
    const node = placed.get(s.id) as ElkNode;
    const at = snapPt({ x: node.x ?? 0, y: node.y ?? 0 });
    const pins = s.pins.map((p, i) => {
      const point = { x: snap(at.x + p.at.x), y: snap(at.y + p.at.y) };
      portPoint.set(s.portIds[i] as string, point);
      return { ...p, at: point };
    });
    return { instance: s.instance, block: s.block, at, size: { w: s.w, h: s.h }, pins };
  });

  const labels: PlacedLabel[] = [];
  for (const h of hierNodes) {
    const node = placed.get(h.id) as ElkNode;
    const point = snapPt({ x: (node.x ?? 0) + (h.right ? 0 : h.w), y: (node.y ?? 0) + GRID / 2 });
    portPoint.set(`${h.id}:p`, point);
    labels.push({
      kind: "hier",
      text: h.text,
      net: h.net,
      at: point,
      angle: h.right ? 0 : 180,
      shape: h.shape,
    });
  }

  // A host pin's wires start at the end of its shunt row and run back along it to the pin; each
  // shunt drops (or rises) to that run.
  const segments: WireSegment[] = [];
  const edgePoint = new Map<string, Pt>();
  for (const [portId, dx] of portShift) {
    const p = portPoint.get(portId) as Pt;
    const end = { x: snap(p.x + dx), y: p.y };
    edgePoint.set(portId, end);
    const net = slots.find((s) => s.portId === portId)?.net as string;
    segments.push({ net, a: p, b: end });
  }
  for (const l of pinLabels) {
    const slot = slots.find((s) => s.portId === l.portId);
    const sheetPin = sheets
      .flatMap((s, i) => s.pins.map((p, k) => ({ p, id: sheetNodes[i]?.portIds[k] })))
      .find((x) => x.id === l.portId)?.p;
    const at = edgePoint.get(l.portId) ?? portPoint.get(l.portId);
    if (!at) continue;
    const angle = slot?.anchor.outward ?? sheetPin?.outward ?? 0;
    labels.push({ kind: "hier", text: l.text, net: l.net, at, angle, shape: l.shape });
  }
  for (const d of drops) {
    const host = portPoint.get(d.host) as Pt;
    const pin = portPoint.get(d.shunt) as Pt;
    segments.push({ net: d.net, a: host, b: { x: pin.x, y: host.y } });
    segments.push({ net: d.net, a: { x: pin.x, y: host.y }, b: pin });
  }

  // Routed wires, rebuilt on the grid from their exact endpoints.
  for (const e of out.edges ?? []) {
    if (!e.id.startsWith("e:")) continue;
    const net = e.id.slice(2, e.id.lastIndexOf(":"));
    const endOf = (id: string) => edgePoint.get(id) ?? portPoint.get(id);
    const start = endOf((e as ElkExtendedEdge).sources[0] as string);
    const end = endOf((e as ElkExtendedEdge).targets[0] as string);
    for (const s of (e as ElkExtendedEdge).sections ?? []) {
      const raw = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
      const pts = gridRoute(raw, start ?? snapPt(s.startPoint), end ?? snapPt(s.endPoint));
      for (let i = 0; i + 1 < pts.length; i++) {
        segments.push({ net, a: pts[i] as Pt, b: pts[i + 1] as Pt });
      }
    }
  }
  // Spines joining runs of adjacent same-net pins.
  for (const s of spines) {
    const a = portPoint.get(s.from);
    const b = portPoint.get(s.to);
    if (a && b) segments.push({ net: s.net, a, b });
  }

  // Labels and power symbols at pins and sheet pins of label- and power-drawn nets.
  const power: PlacedPower[] = [];
  const shownByUnitSide = new Set<string>();
  /** The end of the first power stub of each net and its direction, where a PWR_FLAG can go. */
  const stubs = new Map<string, { at: Pt; outward: number }>();
  const tag = (net: string, at: Pt, outward: number, sideKey?: string, stub = false) => {
    const p = planOf(net);
    if (p.kind === "label") {
      labels.push({
        kind: p.shape ? "hier" : "local",
        text: p.text,
        net,
        at,
        angle: outward,
        ...(p.shape && { shape: p.shape }),
      });
    } else if (p.kind === "power") {
      const k = sideKey && `${sideKey}|${p.name}`;
      const repeat = k !== undefined && shownByUnitSide.has(k);
      if (k) shownByUnitSide.add(k);
      if (stub) {
        // At a side pin, a short stub carries the symbol clear of the part so that it can
        // point the conventional way: rails up, ground down.
        const end = { x: at.x + (outward === 0 ? GRID : -GRID), y: at.y };
        segments.push({ net, a: at, b: end });
        if (!stubs.has(net)) stubs.set(net, { at: end, outward });
        at = end;
        outward = p.symbol.bodyDir === 270 ? 270 : 90;
      }
      power.push({
        libId: p.symbol.libId,
        name: p.name,
        net,
        at,
        outward,
        rotation: powerRotation(p.symbol, outward),
        valueAt: powerValueAt(at, outward, p.name),
        hideValue: repeat,
        flag: false,
      });
    }
  };
  // One tag per run of joined pins: at its first pin, but a side run's rail symbol goes on its
  // top pin and its ground on its bottom one. There it stands on a stub when no other connected
  // pin on that side is in its way; otherwise it points straight out of the pin.
  const runs = new Map<string, PinSlot[]>();
  for (const s of slots) {
    const rep = s.groupRep ?? s.portId;
    runs.set(rep, [...(runs.get(rep) ?? []), s]);
  }
  for (const [rep, members] of runs) {
    const first = members.find((s) => s.portId === rep) as PinSlot;
    if (first.net === undefined) continue;
    const role = roleOf(first.net);
    const y = (s: PinSlot) => (portPoint.get(s.portId) as Pt).y;
    const s =
      role === "signal" || first.anchor.outward === 90 || first.anchor.outward === 270
        ? first
        : members.reduce((a, b) => ((role === "ground" ? y(b) > y(a) : y(b) < y(a)) ? b : a));
    const clear = slots.every((o) => {
      if (o.ref !== s.ref || o.unit !== s.unit || o.anchor.outward !== s.anchor.outward)
        return true;
      if (o.net === undefined || members.includes(o)) return true;
      const dy = (y(o) - y(s)) * (role === "ground" ? 1 : -1);
      return dy <= 0 || dy > 3 * GRID;
    });
    tag(
      first.net,
      portPoint.get(s.portId) as Pt,
      s.anchor.outward,
      `${s.ref}:${s.unit}:${s.anchor.outward}`,
      role !== "signal" && (s.anchor.outward === 0 || s.anchor.outward === 180) && clear,
    );
  }
  for (const s of sheets)
    for (const p of s.pins) if (p.net !== undefined) tag(p.net, p.at, p.outward);

  // PWR_FLAGs: at the end of a power stub, continuing it; on a lone pin, pointing across the pin; on a
  // run, beyond its last pin.
  for (const net of plan.flags(name)) {
    const candidates = slots.filter((s) => s.net === net);
    const lone = candidates.find(
      (s) => !s.groupRep && !candidates.some((q) => q.groupRep === s.portId),
    );
    const last = [...candidates].reverse().find((s) => s.groupRep);
    const stub = stubs.get(net);
    let at: Pt | undefined;
    let outward = 90;
    if (stub) {
      at = stub.at;
      outward = stub.outward;
    } else if (lone) {
      at = portPoint.get(lone.portId);
      outward = lone.anchor.outward === 90 || lone.anchor.outward === 270 ? 0 : 90;
    } else if (last) {
      at = portPoint.get(last.portId);
      const first = portPoint.get(last.groupRep as string) as Pt;
      outward =
        at && at.x !== first.x ? (at.x > first.x ? 0 : 180) : at && at.y > first.y ? 270 : 90;
    } else {
      const sp = sheets.flatMap((s) => s.pins).find((p) => p.net === net);
      if (sp) {
        at = sp.at;
        outward = 90;
      }
    }
    if (at) {
      power.push({
        libId: plan.flagSymbol.libId,
        name: "PWR_FLAG",
        net,
        at,
        outward,
        rotation: powerRotation(plan.flagSymbol, outward),
        valueAt: powerValueAt(at, outward, "PWR_FLAG"),
        hideValue: false,
        flag: true,
      });
    }
  }

  const noConnects = slots
    .filter((s) => s.net === undefined)
    .map((s) => portPoint.get(s.portId) as Pt);

  const connectionPoints = [
    ...slots.flatMap((s) =>
      s.net === undefined ? [] : [{ net: s.net, at: portPoint.get(s.portId) as Pt }],
    ),
    ...sheets.flatMap((s) =>
      s.pins.flatMap((p) => (p.net === undefined ? [] : [{ net: p.net, at: p.at }])),
    ),
    ...labels.map((l) => ({ net: l.net, at: l.at })),
  ];
  const { wires, junctions } = normalizeWires(segments, connectionPoints);

  const xs = [
    ...units.flatMap((u) => [u.box.x, u.box.x + u.box.w + textWidth(u.ref) + GRID]),
    ...sheets.flatMap((s) => [s.at.x, s.at.x + s.size.w]),
    ...wires.flatMap((w) => [w.a.x, w.b.x]),
    ...labels.map((l) => l.at.x + (l.angle === 180 ? -1 : 1) * textWidth(l.text)),
  ];
  const ys = [
    ...units.flatMap((u) => [u.box.y - 3 * GRID, u.box.y + u.box.h]),
    ...sheets.flatMap((s) => [s.at.y, s.at.y + s.size.h]),
    ...wires.flatMap((w) => [w.a.y, w.b.y]),
    ...power.map((p) => p.at.y + 3 * GRID),
  ];
  // A series part is backwards when what its left pin connects to lies further right, on
  // average, than what its right pin connects to: its wires would loop around it.
  const backwards: string[] = [];
  const meanPartnerX = (s: PinSlot | undefined) => {
    if (s?.net === undefined) return undefined;
    const xs = (wiredItems.get(s.net) ?? [])
      .filter((i) => i.portId !== s.portId)
      .flatMap((i) => {
        const p = portPoint.get(i.portId);
        return p ? [p.x] : [];
      });
    return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
  };
  for (const n of unitNodes) {
    if (!n.flippable) continue;
    const own = slots.filter((s) => s.ref === n.ref && s.unit === n.unit.unit);
    const west = own.find((s) => s.anchor.outward === 180);
    const east = own.find((s) => s.anchor.outward === 0);
    if (!west || !east) continue;
    const mid = ((portPoint.get(west.portId)?.x ?? 0) + (portPoint.get(east.portId)?.x ?? 0)) / 2;
    const wx = meanPartnerX(west) ?? mid;
    const ex = meanPartnerX(east) ?? mid;
    if (wx > ex) backwards.push(n.ref);
  }

  // A part is worth trying mirrored when at least as many of its side pins' wired neighbours lie
  // behind the pins as in front of them (an input connector facing away from its circuit).
  const mirrorable: string[] = [];
  for (const n of unitNodes) {
    if (turnable.test(n.ref) || rides.has(n.id)) continue;
    let ahead = 0;
    let behind = 0;
    for (const s of n.slots) {
      if (s.net === undefined || s.groupRep) continue;
      if (s.anchor.outward !== 0 && s.anchor.outward !== 180) continue;
      const at = portPoint.get(s.portId) as Pt;
      for (const i of wiredItems.get(s.net) ?? []) {
        const p = portPoint.get(i.portId);
        // The part's own pins (an op-amp's feedback) say nothing about which way it should face.
        if (!p || i.portId.startsWith(`${n.id}:`) || p.x === at.x) continue;
        if (p.x > at.x === (s.anchor.outward === 0)) ahead++;
        else behind++;
      }
    }
    if (behind > 0 && behind >= ahead) mirrorable.push(n.id);
  }

  return {
    layout: {
      block: name,
      width: Math.max(out.width ?? 0, ...xs) + 2 * GRID,
      height: Math.max(out.height ?? 0, ...ys) + 2 * GRID,
      units,
      sheets,
      labels,
      power,
      wires,
      junctions,
      noConnects,
    },
    backwards,
    mirrorable,
  };
}
