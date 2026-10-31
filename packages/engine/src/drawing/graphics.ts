import { child, children, type SExpr, value } from "../kicad/sexpr.js";

/** Fill as KiCad names it: none, outline (stroke colour) or background (body colour). */
export type Fill = "none" | "outline" | "background";

/** Drawing primitives of a symbol unit in symbol coordinates (mm, y up). */
export type Prim =
  | { kind: "rect"; x1: number; y1: number; x2: number; y2: number; fill: Fill }
  | { kind: "poly"; pts: [number, number][]; fill: Fill }
  | { kind: "circle"; cx: number; cy: number; r: number; fill: Fill }
  | {
      kind: "arc";
      start: [number, number];
      mid: [number, number];
      end: [number, number];
      fill: Fill;
    }
  | { kind: "text"; text: string; x: number; y: number; angle: number }
  | {
      kind: "pin";
      number: string;
      name: string;
      /** Connection point. */
      x: number;
      y: number;
      /** Direction from the connection point towards the body (KiCad's pin angle). */
      angle: number;
      length: number;
      hidden: boolean;
    };

export interface SymbolGraphics {
  /** Primitives per unit number, each including the unit-independent (unit 0) ones. */
  units: Record<number, Prim[]>;
  pinNames: { hidden: boolean; offset: number };
  pinNumbersHidden: boolean;
}

const nums = (list: SExpr[] | undefined) =>
  (list ?? []).filter((x): x is number => typeof x === "number");
const xy = (list: SExpr[] | undefined): [number, number] => {
  const [x = 0, y = 0] = nums(list);
  return [x, y];
};
const atom = (x: SExpr | undefined) =>
  typeof x === "object" && !Array.isArray(x) ? x.sym : undefined;
const fillOf = (node: SExpr[]): Fill => {
  const f = atom(child(child(node, "fill") ?? [], "type")?.[1]);
  return f === "outline" || f === "background" ? f : "none";
};
const hidden = (node: SExpr[]) =>
  child(node, "hide") !== undefined || node.some((t) => atom(t) === "hide");

/** Converts a (flattened) symbol definition into per-unit primitives for rendering. */
export function symbolGraphics(def: SExpr[]): SymbolGraphics {
  const subs = children(def, "symbol").map((s) => {
    const m = /_(\d+)_(\d+)$/.exec(s[1] as string);
    return { s, unit: Number(m?.[1] ?? 1), style: Number(m?.[2] ?? 1) };
  });
  const usable = subs.filter((x) => x.style <= 1);
  const unitNumbers = [...new Set(usable.map((x) => x.unit).filter((u) => u > 0))];
  if (unitNumbers.length === 0) unitNumbers.push(1);

  const prims = (s: SExpr[]): Prim[] => {
    const out: Prim[] = [];
    for (const g of s) {
      if (!Array.isArray(g)) continue;
      switch (g[0]) {
        case "rectangle": {
          const [x1, y1] = xy(child(g, "start"));
          const [x2, y2] = xy(child(g, "end"));
          out.push({ kind: "rect", x1, y1, x2, y2, fill: fillOf(g) });
          break;
        }
        case "polyline":
        case "bezier":
          out.push({
            kind: "poly",
            pts: children(child(g, "pts") ?? [], "xy").map((p) => xy(p)),
            fill: fillOf(g),
          });
          break;
        case "circle": {
          const [cx, cy] = xy(child(g, "center"));
          out.push({
            kind: "circle",
            cx,
            cy,
            r: nums(child(g, "radius"))[0] ?? 0,
            fill: fillOf(g),
          });
          break;
        }
        case "arc":
          out.push({
            kind: "arc",
            start: xy(child(g, "start")),
            mid: xy(child(g, "mid")),
            end: xy(child(g, "end")),
            fill: fillOf(g),
          });
          break;
        case "text": {
          const [x = 0, y = 0, angle = 0] = nums(child(g, "at"));
          if (!hidden(child(g, "effects") ?? [])) {
            out.push({ kind: "text", text: String(g[1] ?? ""), x, y, angle });
          }
          break;
        }
        case "pin": {
          const [x = 0, y = 0, angle = 0] = nums(child(g, "at"));
          out.push({
            kind: "pin",
            number: value(g, "number") ?? "",
            name: value(g, "name") ?? "",
            x,
            y,
            angle,
            length: nums(child(g, "length"))[0] ?? 2.54,
            hidden: hidden(g),
          });
          break;
        }
      }
    }
    return out;
  };

  const units: Record<number, Prim[]> = {};
  for (const unit of unitNumbers) {
    units[unit] = usable.filter((x) => x.unit === unit || x.unit === 0).flatMap((x) => prims(x.s));
  }
  const pinNamesNode = child(def, "pin_names");
  const pinNumbersNode = child(def, "pin_numbers");
  return {
    units,
    pinNames: {
      hidden: pinNamesNode !== undefined && hidden(pinNamesNode),
      offset: nums(child(pinNamesNode ?? [], "offset"))[0] ?? 0.508,
    },
    pinNumbersHidden: pinNumbersNode !== undefined && hidden(pinNumbersNode),
  };
}
