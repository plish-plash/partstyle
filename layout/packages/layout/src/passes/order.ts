import type { Ctx } from "../context.js";
import type { Flow } from "./flow.js";

/** Anchors of one component by column, each column ordered top to bottom. */
export function orderColumns(ctx: Ctx, flow: Flow, comp: string[]): string[][] {
  const maxRank = Math.max(...comp.map((id) => flow.rank.get(id) ?? 0));
  const minRank = Math.min(...comp.map((id) => flow.rank.get(id) ?? 0));
  const cols: string[][] = [];
  for (let r = minRank; r <= maxRank; r++) {
    const list = comp.filter((id) => (flow.rank.get(id) ?? 0) === r);
    list.sort((a, b) => ctx.part(a).order - ctx.part(b).order);
    cols.push(list);
  }
  if (!ctx.rules.on("min-crossings")) return cols;

  const inComp = new Set(comp);
  const links = flow.links.filter((l) => inComp.has(l.a) && inComp.has(l.b));
  const pinY = (part: string, pin: string) =>
    ctx.part(part).pins.find((p) => p.id === pin)?.y ?? ctx.part(part).box.h / 2;

  // Where each anchor's top would land if the columns were stacked as they stand.
  const positions = () => {
    const pos = new Map<string, number>();
    for (const col of cols) {
      let y = 0;
      for (const id of col) {
        pos.set(id, y);
        y += ctx.part(id).box.h + 6;
      }
    }
    return pos;
  };

  const sweep = (index: number, fromRank: (r: number) => boolean) => {
    const col = cols[index] as string[];
    const pos = positions();
    const key = new Map<string, number>();
    for (const id of col) {
      let sum = 0;
      let n = 0;
      for (const l of links) {
        const mine = l.a === id ? l.a : l.b === id ? l.b : undefined;
        if (mine === undefined) continue;
        const other = l.a === id ? l.b : l.a;
        if (!fromRank(flow.rank.get(other) ?? 0)) continue;
        const otherPin = l.a === id ? l.pb : l.pa;
        const myPin = l.a === id ? l.pa : l.pb;
        sum += (pos.get(other) ?? 0) + pinY(other, otherPin) - pinY(id, myPin);
        n++;
      }
      key.set(id, n > 0 ? sum / n : (pos.get(id) ?? 0));
    }
    col.sort(
      (a, b) => (key.get(a) ?? 0) - (key.get(b) ?? 0) || ctx.part(a).order - ctx.part(b).order,
    );
  };

  const sweeps = ctx.rules.num("min-crossings", "sweeps");
  for (let s = 0; s < sweeps; s++) {
    const forward = s % 2 === 0;
    for (let i = 0; i < cols.length; i++) {
      const c = forward ? i : cols.length - 1 - i;
      const rank = (flow.rank.get(cols[c]?.[0] as string) ?? 0) as number;
      sweep(c, (r) => (forward ? r < rank : r > rank));
    }
  }
  return cols;
}
