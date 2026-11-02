import { type Cell, moveCell } from "./cell.js";
import { GRID } from "./nodes.js";
import { paperFor, papers } from "./paper.js";
import { PITCH, snap } from "./wires.js";

/** Clear of KiCad's sheet frame and its coordinate band. */
export const PAD = { top: 15.24, left: 15.24 };
const ROW_GAP = 5 * GRID;
const STACK_GAP = 3 * GRID;
const MIN_CHANNEL = 3 * GRID;
const MAX_CHANNEL = 10 * GRID;

/** Cells of one stage, stacked in declaration order. */
interface Slot {
  stage: number;
  cells: Cell[];
  w: number;
}

const up = (v: number) => snap(Math.ceil(v / PITCH - 1e-6) * PITCH);

/**
 * Packs cells into a grid: each stage is a slot (its cells stacked), slots run left to right
 * and wrap onto a new row when the paper is full; the smallest paper that fits wins. Channels
 * between slots widen with the wires that cross them. Each cell is lowered (or the row before
 * it is) so that its first connection lines up with what it connects to (see `aligned`). Moves
 * the cells in place, by whole steps of the pin grid.
 */
export function packCells(
  cells: Cell[],
  wired: (net: string) => boolean,
): { width: number; height: number; grid: Map<Cell, { row: number; slot: number }> } {
  const slots: Slot[] = [];
  for (const c of [...cells].sort((a, b) => a.stage - b.stage || a.group.line - b.group.line)) {
    const last = slots[slots.length - 1];
    if (last && last.stage === c.stage) last.cells.push(c);
    else slots.push({ stage: c.stage, cells: [c], w: 0 });
  }
  for (const s of slots) s.w = up(Math.max(...s.cells.map((c) => c.box.w)));

  // Wired nets spanning each boundary between consecutive slots.
  const spans = new Map<string, [number, number]>();
  for (const c of cells) {
    for (const p of c.pieces) {
      if (!wired(p.net)) continue;
      const s = spans.get(p.net) ?? [c.stage, c.stage];
      spans.set(p.net, [Math.min(s[0], c.stage), Math.max(s[1], c.stage)]);
    }
  }
  const channel = (i: number) => {
    const a = slots[i]?.stage ?? 0;
    const b = slots[i + 1]?.stage ?? a;
    const crossing = [...spans.values()].filter(([lo, hi]) => lo <= a && hi >= b).length;
    return up(Math.min(MAX_CHANNEL, MIN_CHANNEL + crossing * GRID));
  };

  const arrange = (maxW: number) => {
    const at = new Map<Cell, { x: number; y: number }>();
    const grid = new Map<Cell, { row: number; slot: number }>();
    let x = 0;
    let row = 0;
    let rowY = 0;
    let width = 0;
    let rowCells: Cell[] = [];
    const bottom = () => Math.max(rowY, ...rowCells.map((c) => (at.get(c)?.y ?? 0) + c.box.h));
    slots.forEach((slot, i) => {
      if (x > 0 && x + slot.w > maxW) {
        rowY = up(bottom() + ROW_GAP);
        row++;
        x = 0;
        rowCells = [];
      }
      let y = rowY;
      slot.cells.forEach((c, k) => {
        const want = aligned(c, rowCells, at);
        if (want !== undefined && want > y) y = want;
        else if (want !== undefined && want < y && k === 0 && rowCells.length > 0) {
          // Lower what came before in the row instead, keeping it lined up with itself.
          for (const o of rowCells) {
            const p = at.get(o) as { x: number; y: number };
            at.set(o, { x: p.x, y: snap(p.y + y - want) });
          }
        }
        at.set(c, { x: up(x + (slot.w - c.box.w) / 2), y: up(y) });
        grid.set(c, { row, slot: i });
        rowCells.push(c);
        y = up(y + c.box.h + STACK_GAP);
      });
      width = Math.max(width, x + slot.w);
      x = up(x + slot.w + channel(i));
    });
    return { at, grid, width, height: bottom() };
  };

  let best = arrange(Number.POSITIVE_INFINITY);
  for (const [name, w] of papers) {
    const p = arrange(w - 10 - PAD.left - 2 * GRID);
    best = p;
    const extent = { width: PAD.left + p.width + 2 * GRID, height: PAD.top + p.height + 2 * GRID };
    if (papers[paperFor(extent)]?.[0] === name) break;
  }
  for (const c of cells) {
    const to = best.at.get(c) as { x: number; y: number };
    moveCell(c, snap(PAD.left + to.x - c.box.x), snap(PAD.top + to.y - c.box.y));
  }
  return { width: PAD.left + best.width, height: PAD.top + best.height, grid: best.grid };
}

/** How far below its wire a pin pointing this way sits, so the wire drops into it. */
const drop = (dir: number) => (dir === 90 ? 2 * GRID : dir === 270 ? -2 * GRID : 0);

/**
 * Where a cell's top should be for its first piece to line up with a piece of the same net
 * already placed in the row (the nearest): level with it for side pins, a step below for a pin
 * pointing up, a step above for one pointing down. Wires then run straight, or drop into a pin
 * without hooking back over it. Undefined when nothing lines up within reach.
 */
function aligned(c: Cell, placed: Cell[], at: Map<Cell, { x: number; y: number }>) {
  for (const mine of c.pieces) {
    for (const o of [...placed].reverse()) {
      const theirs = o.pieces.find(
        (p) => p.net === mine.net && (drop(p.labelDir) === 0 || drop(mine.labelDir) === 0),
      );
      const pos = at.get(o);
      if (!theirs || !pos) continue;
      const target =
        pos.y + theirs.labelAt.y - o.box.y + drop(mine.labelDir) - drop(theirs.labelDir);
      const top = snap(target - (mine.labelAt.y - c.box.y));
      return Math.abs(top - pos.y) <= 30 * GRID ? top : undefined;
    }
  }
  return undefined;
}
