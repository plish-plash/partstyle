import type { Ctx, Placement, Stack } from "../context.js";
import { inflate, rectsOverlap, transformRect, translate } from "../geometry.js";
import type { Pt, Rect } from "../types.js";
import { placeRun, type Sheet, SYMBOL_HEIGHT, stackHeight } from "./place.js";
import type { RowPlan } from "./rows.js";

/** A block this far from its pins is broken up so each cap can find somewhere closer. */
const TOO_FAR = 24;
/** Added to a spot on the side the rule does not prefer. */
const WRONG_SIDE = 8;

/**
 * Places decoupling after everything else, since it has no wires to route: each anchor's stacks go
 * in the nearest empty space, as one row if that fits and one at a time if not. They never push
 * another part or wire aside.
 */
export function placeDecoupling(ctx: Ctx, plan: RowPlan, anchors: string[], sheet: Sheet) {
  const spacing = ctx.rules.num("decoupling-near-pin", "spacing");
  const preferAbove = ctx.rules.str("decoupling-near-pin", "side") === "above";
  const boxOf = (id: string): Rect => {
    const pl = sheet.placements.get(id) as Placement;
    return translate(transformRect(ctx.part(id).box, pl.rotation, pl.mirror), pl.at.x, pl.at.y);
  };

  const taken: Rect[] = [];
  for (const [id, pl] of sheet.placements) {
    const box = boxOf(id);
    taken.push(inflate(box, 1));
    // Room for the symbols its rail pins will get.
    for (const pin of ctx.part(id).pins) {
      if (pin.net === undefined || ctx.role(pin.net) === "signal") continue;
      const o = transformRect({ x: pin.x, y: pin.y, w: 0, h: 0 }, pl.rotation, pl.mirror);
      const at = { x: pl.at.x + o.x, y: pl.at.y + o.y };
      taken.push({
        x: at.x - 3,
        y: at.y - SYMBOL_HEIGHT - 1,
        w: 6,
        h: (SYMBOL_HEIGHT + 1) * 2,
      });
    }
  }
  for (const group of sheet.prewires) {
    for (const w of group) {
      taken.push(
        inflate(
          {
            x: Math.min(w.a.x, w.b.x),
            y: Math.min(w.a.y, w.b.y),
            w: Math.abs(w.a.x - w.b.x),
            h: Math.abs(w.a.y - w.b.y),
          },
          1,
        ),
      );
    }
  }
  for (const s of sheet.symbols) {
    taken.push({ x: s.at.x - 2, y: s.at.y - SYMBOL_HEIGHT, w: 4, h: SYMBOL_HEIGHT * 2 });
  }

  /** Cheapest free top-left corner for a block, or undefined if none is in range. */
  const search = (w: number, h: number, target: Pt, centre: number) => {
    let best: { x: number; y: number; cost: number } | undefined;
    const reach = 40;
    for (let y = target.y - reach - h; y <= target.y + reach; y++) {
      for (let x = target.x - reach - w; x <= target.x + reach; x++) {
        const cx = x + w / 2;
        const cy = y + h / 2;
        const cost =
          Math.abs(cx - target.x) +
          Math.abs(cy - target.y) +
          (cy < centre === preferAbove ? 0 : WRONG_SIDE);
        if (best && cost >= best.cost) continue;
        if (taken.some((t) => rectsOverlap({ x, y, w, h }, t))) continue;
        best = { x, y, cost };
      }
    }
    return best;
  };

  const put = (s: Stack, x: number, y: number, owner: string) => {
    placeRun(ctx, sheet, s.parts, s.nets, { x, y: y + SYMBOL_HEIGHT }, 270);
    for (const p of s.parts) ctx.note(p, "decoupling-near-pin", `decouples ${owner}`);
  };

  for (const id of anchors) {
    const stacks = plan.decoupling.get(id);
    if (!stacks || stacks.length === 0) continue;
    const box = boxOf(id);
    const centre = box.y + box.h / 2;
    const target: Pt = {
      x: Math.round(box.x + box.w / 2),
      y: Math.round(preferAbove ? box.y : box.y + box.h),
    };
    const heights = stacks.map((s) => stackHeight(ctx, s));
    const w = stacks.length * spacing - 1;
    const h = Math.max(...heights);
    const spot = search(w, h, target, centre);
    if (spot && Math.abs(spot.cost) <= TOO_FAR) {
      stacks.forEach((s, i) => {
        put(s, spot.x + 1 + i * spacing, spot.y, id);
      });
      taken.push({ x: spot.x, y: spot.y, w, h });
      continue;
    }
    stacks.forEach((s, i) => {
      const height = heights[i] as number;
      const one = search(spacing - 1, height, target, centre) ?? spot;
      const x = one?.x ?? box.x;
      const y = one?.y ?? box.y + box.h + 4;
      put(s, x + 1, y, id);
      taken.push({ x, y, w: spacing - 1, h: height });
    });
  }
}
