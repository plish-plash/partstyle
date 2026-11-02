import type { CktFile } from "../ckt/ast.js";
import { powerRotation, powerValueAt } from "../kicad/power.js";
import type { Netlist } from "../netlist/elaborate.js";
import { buildCell, type Cell, type Piece } from "./cell.js";
import { deriveFlow } from "./flow.js";
import { formGroups } from "./groups.js";
import { CHAR, GRID, outputKinds, sheetInput, textWidth } from "./nodes.js";
import { turnable } from "./orient.js";
import { packCells } from "./pack.js";
import type { DrawingPlan } from "./plan.js";
import { route } from "./route.js";
import type {
  PlacedHint,
  PlacedLabel,
  PlacedPower,
  Pt,
  Rect,
  SheetLayout,
  WireSegment,
} from "./types.js";
import { normalizeWires, snap } from "./wires.js";

export { paperFor, papers } from "./paper.js";

/** The area a label's text covers, from its connection point the way it reads. */
function labelRect(l: PlacedLabel): Rect {
  const len = textWidth(l.text) + (l.kind === "hier" ? 2 * GRID : CHAR);
  const half = CHAR;
  switch (l.angle) {
    case 0:
      return { x: l.at.x + CHAR / 2, y: l.at.y - half, w: len, h: 2 * half };
    case 180:
      return { x: l.at.x - CHAR / 2 - len, y: l.at.y - half, w: len, h: 2 * half };
    case 90:
      return { x: l.at.x - half, y: l.at.y - CHAR / 2 - len, w: 2 * half, h: len };
    default:
      return { x: l.at.x - half, y: l.at.y + CHAR / 2, w: 2 * half, h: len };
  }
}

const step = (p: Pt, outward: number, d: number): Pt => ({
  x: snap(p.x + (outward === 0 ? d : outward === 180 ? -d : 0)),
  y: snap(p.y + (outward === 270 ? d : outward === 90 ? -d : 0)),
});
const same = (a: Pt, b: Pt) => a.x === b.x && a.y === b.y;
/** Direction from `a` to `b` along an axis (0 right, 90 up, 180 left, 270 down). */
const towards = (a: Pt, b: Pt) => (b.x > a.x ? 0 : b.x < a.x ? 180 : b.y < a.y ? 90 : 270);

/** Whether two axis-aligned boxes (segments included, as flat boxes) meet, edges counting. */
const meets = (a: Rect, b: Rect) =>
  a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
const boxOf = (s: WireSegment): Rect => ({
  x: Math.min(s.a.x, s.b.x),
  y: Math.min(s.a.y, s.b.y),
  w: Math.abs(s.a.x - s.b.x),
  h: Math.abs(s.a.y - s.b.y),
});

export type LabelSpot = { at: Pt; angle: number; stub: WireSegment[] };

/**
 * Where a piece's label goes. On its pin when nothing is wired there; a label never shares a
 * pin with a wire. When the pin's only wire runs along the part (a run of joined pins), the
 * label goes out on a short stub; when a wire leaves the pin outward (a series part in line),
 * a stub tees off it just past the pin and the label hangs at its end, above the wire or
 * below it. The end of a shunt row is a wire end, so a label there stays. Of the stubs, the
 * first with the least `harm` is taken (see `harmFor`).
 */
export function labelSpot(piece: Piece, harm: (spot: LabelSpot) => number): LabelSpot {
  const { net, labelAt: at, labelDir: dir } = piece;
  const wired = piece.segments.filter((s) => same(s.a, at) || same(s.b, at));
  if (piece.extension || wired.length === 0) return { at, angle: dir, stub: [] };
  const outward = wired.some((s) => towards(at, same(s.a, at) ? s.b : s.a) === dir);
  const spots: LabelSpot[] = [];
  for (const len of [2 * GRID, 3 * GRID]) {
    if (!outward) {
      const end = step(at, dir, len);
      spots.push({ at: end, angle: dir, stub: [{ net, a: at, b: end }] });
      continue;
    }
    const tee = step(at, dir, GRID);
    for (const across of dir === 0 || dir === 180 ? [90, 270] : [0, 180]) {
      const end = step(tee, across, len);
      spots.push({ at: end, angle: across, stub: [{ net, a: tee, b: end }] });
    }
  }
  const scored = spots.map((s) => ({ s, h: harm(s) }));
  return scored.reduce((a, b) => (b.h < a.h ? b : a)).s;
}

/** Whether `p` lies on segment `s`, ends included. */
const onSeg = (p: Pt, s: WireSegment) => meets({ ...p, w: 0, h: 0 }, boxOf(s));

/**
 * How bad a label spot is among what is drawn around it: 0 clear; 1 when its stub crosses
 * another net's wire, or its text crowds a wire, a part or another label (untidy, but it reads
 * right); 2 when its stub would look connected to another net: ending on a wire, a wire ending
 * on it, running along one, or touching a pin. A stub that crosses a wire beats one that
 * seems to join it.
 */
export function labelHarm(
  label: LabelSpot & { net: string; text: string; kind: PlacedLabel["kind"] },
  around: { wires: WireSegment[]; pins: { at: Pt; net?: string }[]; rects: Rect[] },
): number {
  const { net } = label;
  const wires = around.wires.filter((w) => w.net !== net);
  let harm = 0;
  for (const s of label.stub) {
    for (const w of wires) {
      if (!meets(boxOf(w), boxOf(s))) continue;
      const parallel = (w.a.x === w.b.x) === (s.a.x === s.b.x);
      if (parallel || onSeg(s.b, w) || onSeg(w.a, s) || onSeg(w.b, s)) return 2;
      harm = 1;
    }
    if (around.pins.some((p) => p.net !== net && onSeg(p.at, s))) return 2;
  }
  const rect = labelRect({
    kind: label.kind,
    text: label.text,
    net,
    at: label.at,
    angle: label.angle,
  });
  if (wires.some((w) => meets(boxOf(w), rect)) || around.rects.some((r) => meets(r, rect))) {
    harm = Math.max(harm, 1);
  }
  return harm;
}

/**
 * Lays out one block's sheet. Parts are grouped (each part with the passives that ride along:
 * decoupling, shunts, series chains), the groups ordered by stage along the signal flow, each
 * laid out on its own, and the groups packed into a grid that reads left to right and wraps
 * onto new rows. Nets between groups in the same or neighbouring slots of a row are routed as
 * wires; nets that reach further are labelled. Stored hints (`[2 r90 flip]`) fix a part's stage,
 * rotation or mirroring; everything else is decided once, without trial layouts. The same
 * geometry drives the viewer and the KiCad export.
 */
export function layoutSheet(
  block: CktFile,
  plan: DrawingPlan,
  netlist: Netlist,
  blocks: Map<string, CktFile>,
): SheetLayout {
  const name = block.block.name;
  const input = sheetInput(block, plan, netlist, blocks);
  const { planOf } = input;
  const groups = formGroups(input);
  const flow = deriveFlow(input, groups);
  const cells = groups.map((g) => buildCell(g, flow.stages.get(g.id) ?? 1, flow.flips, input));
  const { grid } = packCells(cells, (net) => planOf(net).kind === "wire");

  const piecesOf = new Map<string, { cell: Cell; piece: Piece }[]>();
  for (const cell of cells) {
    for (const piece of cell.pieces) {
      piecesOf.set(piece.net, [...(piecesOf.get(piece.net) ?? []), { cell, piece }]);
    }
  }
  /**
   * All of a net's groups sit in one row, in consecutive slots: each wire joins neighbours.
   * A gap (a slot in between that the net does not reach) or another row means labels.
   */
  const near = (list: { cell: Cell }[]) => {
    const at = list.map(({ cell }) => grid.get(cell) as { row: number; slot: number });
    const slots = new Set(at.map((a) => a.slot));
    const lo = Math.min(...slots);
    const hi = Math.max(...slots);
    return at.every((a) => a.row === at[0]?.row) && hi - lo < 3 && slots.size === hi - lo + 1;
  };

  const labels: PlacedLabel[] = [];
  const fixed: WireSegment[] = [];
  /** Stubs carrying a wired net's hierarchical label. */
  const stubs = new Map<string, { piece: Piece; stub: WireSegment }>();
  const toRoute: { net: string; pieces: { points: Pt[]; segments: WireSegment[] }[] }[] = [];
  const segsOf = (p: Piece, extend: boolean) => [
    ...p.segments,
    ...(extend && p.extension ? [{ net: p.net, a: p.extension[0], b: p.extension[1] }] : []),
  ];
  // What a label's stub and text should stay clear of: every other net's wires and pins (as the
  // groups drew them, and once routed, the routed wires too), part bodies and power symbols,
  // and the labels placed before it.
  const drawn = cells.flatMap((c) => [...c.segments, ...c.pieces.flatMap((p) => segsOf(p, true))]);
  const pinsDrawn = cells.flatMap((c) => [
    ...c.units.flatMap((u) => u.pins),
    ...c.sheets.flatMap((s) => s.pins),
  ]);
  const bodies = cells.flatMap((c) => c.obstacles);
  const harmFor = (net: string, text: string, kind: PlacedLabel["kind"]) => (spot: LabelSpot) =>
    labelHarm(
      { ...spot, net, text, kind },
      {
        wires: [...drawn, ...fixed],
        pins: pinsDrawn,
        rects: [...bodies, ...labels.map(labelRect)],
      },
    );

  const labelEach = (net: string, list: { piece: Piece }[]) => {
    const p = planOf(net);
    const port = p.kind === "wire" ? p.port : undefined;
    const text = p.kind === "label" ? p.text : port ? port.name : net;
    const kind = p.kind === "label" ? (p.shape ? "hier" : "local") : port ? "hier" : "local";
    for (const { piece } of list) {
      const { at, angle, stub } = labelSpot(piece, harmFor(net, text, kind));
      fixed.push(...segsOf(piece, true), ...stub);
      labels.push(
        p.kind === "label"
          ? {
              kind: p.shape ? "hier" : "local",
              text: p.text,
              net,
              at,
              angle,
              ...(p.shape && { shape: p.shape }),
            }
          : port
            ? { kind: "hier", text: port.name, net, at, angle, shape: shapeOfKind(port.kind) }
            : { kind: "local", text: net, net, at, angle },
      );
    }
  };

  for (const [net, list] of piecesOf) {
    const p = planOf(net);
    if (p.kind === "power") continue;
    if (p.kind === "label" || !near(list)) {
      labelEach(net, list);
      continue;
    }
    const port = p.port;
    if (port) {
      // The hierarchical label goes on the piece furthest toward its edge of the sheet.
      const right = outputKinds.has(port.kind);
      const facing = list.filter(({ piece }) => piece.labelDir === (right ? 0 : 180));
      const pick = (facing.length > 0 ? facing : list).reduce((a, b) =>
        (right ? b.piece.labelAt.x > a.piece.labelAt.x : b.piece.labelAt.x < a.piece.labelAt.x)
          ? b
          : a,
      );
      const spot = labelSpot(pick.piece, harmFor(net, port.name, "hier"));
      if (spot.stub.length === 0 && list.length > 1 && !pick.piece.extension) {
        // A bare pin: out on a stub all the same, so the wire to the rest of the net can tee
        // into it.
        const end = step(spot.at, spot.angle, 2 * GRID);
        spot.stub.push({ net, a: spot.at, b: end });
        spot.at = end;
      }
      const stub = spot.stub[0];
      if (stub) {
        stubs.set(net, { piece: pick.piece, stub });
        pick.piece.segments.push(stub);
        pick.piece.points.push(stub.b);
      }
      labels.push({
        kind: "hier",
        text: port.name,
        net,
        at: spot.at,
        angle: spot.angle,
        shape: shapeOfKind(port.kind),
      });
    }
    if (list.length > 1) {
      toRoute.push({
        net,
        pieces: list.map(({ cell, piece }) => ({
          points: piece.points,
          segments: segsOf(piece, true),
          group: cell.group.id,
        })),
      });
    } else {
      fixed.push(...segsOf(list[0]?.piece as Piece, port !== undefined));
    }
  }

  const units = cells.flatMap((c) => c.units);
  const sheets = cells.flatMap((c) => c.sheets);
  const power: PlacedPower[] = cells.flatMap((c) => c.power);
  for (const c of cells) fixed.push(...c.segments);

  const extentOf = (rects: Rect[], pts: Pt[]) => ({
    width: Math.max(0, ...rects.map((r) => r.x + r.w), ...pts.map((p) => p.x)),
    height: Math.max(0, ...rects.map((r) => r.y + r.h), ...pts.map((p) => p.y)),
  });
  const obstacles = [...cells.flatMap((c) => c.obstacles), ...labels.map(labelRect)];
  const text = cells.flatMap((c) => c.text);
  const before = extentOf(
    [...obstacles, ...text],
    fixed.flatMap((s) => [s.a, s.b]),
  );
  const points: { net?: string; at: Pt }[] = [
    ...units.flatMap((u) =>
      u.pins.map((p) => ({ ...(p.net !== undefined && { net: p.net }), at: p.at })),
    ),
    ...sheets.flatMap((s) =>
      s.pins.map((p) => ({ ...(p.net !== undefined && { net: p.net }), at: p.at })),
    ),
    ...labels.map((l) => ({ net: l.net, at: l.at })),
    ...power.map((p) => ({ net: p.net, at: p.at })),
  ];
  const routed = route({
    width: before.width + 20 * GRID,
    height: before.height + 20 * GRID,
    obstacles,
    text,
    fixed,
    points,
    nets: toRoute,
  });
  // Labels placed from here on keep their stubs off the routed wires too.
  drawn.push(...routed.segments);
  for (const net of routed.failed) {
    // Label every piece instead, like a net that reaches too far.
    for (const l of labels.filter((x) => x.net === net)) labels.splice(labels.indexOf(l), 1);
    const s = stubs.get(net);
    if (s) s.piece.segments.splice(s.piece.segments.indexOf(s.stub), 1);
    labelEach(net, piecesOf.get(net) ?? []);
  }
  // A routed net's shunt rows end where its wires actually join them: the rest would dangle.
  const ends = routed.segments.flatMap((s) => [s.a, s.b]);
  const trimmed = (net: string, piece: Piece): WireSegment[] => {
    const ext = piece.extension;
    if (!ext) return piece.segments;
    const [a, b] = ext;
    const along = (p: Pt) => Math.abs(p.x - a.x) + Math.abs(p.y - a.y);
    const on = ends.filter(
      (p) =>
        (a.y === b.y
          ? p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
          : p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)) && along(p) > 0,
    );
    if (on.length === 0) return piece.segments;
    const far = on.reduce((x, y) => (along(y) > along(x) ? y : x));
    return [...piece.segments, { net, a, b: far }];
  };
  const segments = [
    ...fixed,
    ...toRoute
      .filter((r) => !routed.failed.includes(r.net))
      .flatMap((r) => (piecesOf.get(r.net) ?? []).flatMap(({ piece }) => trimmed(r.net, piece))),
    ...routed.segments,
  ];

  // PWR_FLAGs: at the end of a power stub, continuing it; on a lone pin, pointing across the pin;
  // on a run, beyond its last pin; else on a sheet pin.
  const spots = cells.flatMap((c) => c.flagSpots);
  for (const net of plan.flags(name)) {
    const spot =
      spots.find((s) => s.net === net && s.kind === "stub") ??
      spots.find((s) => s.net === net && s.kind === "lone") ??
      [...spots].reverse().find((s) => s.net === net && s.kind === "run");
    const sheetPin = sheets.flatMap((s) => s.pins).find((p) => p.net === net);
    const at = spot?.at ?? sheetPin?.at;
    if (!at) continue;
    const outward = spot?.outward ?? 90;
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

  const noConnects = cells.flatMap((c) => c.noConnects);
  const pins = [
    ...units.flatMap((u) =>
      u.pins.flatMap((p) => (p.net === undefined ? [] : [{ net: p.net, at: p.at }])),
    ),
    ...sheets.flatMap((s) =>
      s.pins.flatMap((p) => (p.net === undefined ? [] : [{ net: p.net, at: p.at }])),
    ),
  ];
  const connectionPoints = [...pins, ...labels.map((l) => ({ net: l.net, at: l.at }))];
  const { wires, junctions } = normalizeWires(segments, connectionPoints, pins);

  const hints: PlacedHint[] = [];
  const groupOf = new Map<string, string>();
  for (const g of groups) {
    for (const a of g.anchors) groupOf.set(a.ref, g.id);
    for (const t of g.attached) groupOf.set(t.node.ref, g.id);
  }
  for (const n of input.nodes) {
    if (hints.some((h) => h.ref === n.ref)) continue;
    const group = groupOf.get(n.ref) ?? n.ref;
    const placed = units.find((u) => u.ref === n.ref);
    const sheet = sheets.find((s) => s.instance === n.ref);
    const stored = input.hints.get(n.ref) ?? {};
    hints.push({
      ref: n.ref,
      group,
      stage: flow.stages.get(group) ?? 1,
      turnable: n.kind === "unit" && turnable.test(n.ref),
      rotation: placed?.rotation ?? 0,
      flip: placed?.mirror ?? (sheet ? (flow.flips.get(n.id) ?? false) : false),
      stored: {
        ...(stored.stage !== undefined && { stage: stored.stage }),
        ...(stored.rotation !== undefined && { rotation: stored.rotation }),
        ...(stored.flip !== undefined && { flip: stored.flip }),
      },
    });
  }

  const xs = [
    ...units.flatMap((u) => [u.box.x, u.box.x + u.box.w + textWidth(u.ref) + GRID]),
    ...sheets.flatMap((s) => [s.at.x, s.at.x + s.size.w]),
    ...wires.flatMap((w) => [w.a.x, w.b.x]),
    ...labels.map((l) => l.at.x + (l.angle === 180 ? -1 : 1) * textWidth(l.text)),
    ...text.map((r) => r.x + r.w),
  ];
  const ys = [
    ...units.flatMap((u) => [u.box.y - 3 * GRID, u.box.y + u.box.h]),
    ...sheets.flatMap((s) => [s.at.y, s.at.y + s.size.h]),
    ...wires.flatMap((w) => [w.a.y, w.b.y]),
    ...power.map((p) => p.at.y + 3 * GRID),
    ...text.map((r) => r.y + r.h),
  ];
  return {
    block: name,
    width: Math.max(0, ...xs) + 2 * GRID,
    height: Math.max(0, ...ys) + 2 * GRID,
    units,
    sheets,
    labels,
    power,
    wires,
    junctions,
    noConnects,
    hints,
  };
}

const shapeOfKind = (kind: string) =>
  kind === "power_in" || kind === "input"
    ? "input"
    : kind === "power_out" || kind === "output"
      ? "output"
      : kind === "bidir"
        ? "bidirectional"
        : "passive";
