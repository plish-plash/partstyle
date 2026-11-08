import type { Ctx, PinRef, Placement } from "../context.js";
import { isPort } from "../context.js";
import { rectsOverlap, stepOf, transformRect, translate } from "../geometry.js";
import type { Direction, Marker, PlacedPin, PowerSymbol, Pt, Rect, Wire } from "../types.js";
import { pinKey, type Sheet } from "./place.js";
import type { Riser } from "./rows.js";

export function symbolBox(at: Pt, outward: 90 | 270): Rect {
  return outward === 270
    ? { x: at.x - 1, y: at.y, w: 2, h: 2 }
    : { x: at.x - 1, y: at.y - 2, w: 2, h: 2 };
}

const defaultWay = (ctx: Ctx, net: string): 90 | 270 => (ctx.railPointsDown(net) ? 270 : 90);

function makeSymbol(ctx: Ctx, net: string, at: Pt, outward = defaultWay(ctx, net)): PowerSymbol {
  const role = ctx.role(net) === "ground" ? "ground" : "power";
  return {
    net,
    name: net,
    role,
    at,
    outward,
    box: symbolBox(at, outward),
    showName: role !== "ground" || net !== "GND",
  };
}

const thinRect = (w: Wire): Rect => ({
  x: Math.min(w.a.x, w.b.x),
  y: Math.min(w.a.y, w.b.y),
  w: Math.abs(w.a.x - w.b.x),
  h: Math.abs(w.a.y - w.b.y),
});

/**
 * Gives every rail pin not already on a wire its own symbol. Rails always point up and grounds
 * down, so a pin facing the wrong way reaches its symbol over a short stub.
 */
export function placePower(
  ctx: Ctx,
  sheet: Sheet,
  risers: Riser[],
  pins: Map<string, PlacedPin>,
  boxes: Rect[],
): { symbols: PowerSymbol[]; markers: Marker[] } {
  const symbols: PowerSymbol[] = [];
  const taken: Rect[] = [...boxes];
  const wires = sheet.prewires.flat().map(thinRect);
  for (const s of sheet.symbols) {
    const sym = makeSymbol(ctx, s.net, s.at);
    symbols.push(sym);
    taken.push(sym.box);
  }
  // Grown a little so a symbol resting on another net's wire counts as touching it.
  const clear = (r: Rect) => {
    const grown = { x: r.x, y: r.y - 0.25, w: r.w, h: r.h + 0.5 };
    return !taken.some((t) => rectsOverlap(r, t)) && !wires.some((w) => rectsOverlap(grown, w));
  };

  const share = ctx.rules.bool("local-power-symbols", "shareAdjacent");

  // Side pins first: a short stub, then straight past the part to a symbol.
  const gap = ctx.rules.num("power-risers", "gap");
  for (const r of useSymbolsNow(ctx) ? risers : []) {
    const refs = r.pins.map((pin) => ({ part: r.anchor, pin }));
    for (const ref of refs) sheet.handled.add(pinKey(ref));
    const placed = refs.map((ref) => pins.get(pinKey(ref)) as PlacedPin);
    const pl = sheet.placements.get(r.anchor) as Placement;
    const box = translate(
      transformRect(ctx.part(r.anchor).box, pl.rotation, pl.mirror),
      pl.at.x,
      pl.at.y,
    );
    const way = defaultWay(ctx, r.net);
    const x = (placed[0] as PlacedPin).at.x + r.side * r.offset;
    const base = r.dir === "up" ? box.y - gap : box.y + box.h + gap;
    const dy = r.dir === "up" ? -1 : 1;
    let at = { x, y: base };
    for (let k = 0; k <= 14; k++) {
      const probe = { x, y: base + dy * k };
      if (clear(symbolBox(probe, way))) {
        at = probe;
        break;
      }
    }
    const far = placed.reduce((a, b) => (dy * (a.at.y - b.at.y) > 0 ? a : b));
    const stub: Wire[] = [{ net: r.net, a: { x, y: far.at.y }, b: at }];
    for (const p of placed) stub.push({ net: r.net, a: p.at, b: { x, y: p.at.y } });
    const sym = makeSymbol(ctx, r.net, at);
    symbols.push(sym);
    taken.push(sym.box);
    sheet.prewires.push(stub);
    wires.push(...stub.map(thinRect));
    // Should that wire not fit, the router joins each pin to the symbol instead.
    for (const pin of refs) sheet.symbols.push({ net: r.net, at, pin });
  }

  const place = (net: string, pin: PlacedPin, ref: PinRef) => {
    // A negative rail on a top pin may stand up: there is no room to hang it from there.
    const negative = ctx.role(net) === "power" && ctx.railPointsDown(net);
    const want: 90 | 270 = negative && pin.outward === 90 ? 90 : defaultWay(ctx, net);
    const step = stepOf(pin.outward);
    const put = (at: Pt, path: Pt[]) => {
      const sym = makeSymbol(ctx, net, at, want);
      symbols.push(sym);
      taken.push(sym.box);
      const stub: Wire[] = [];
      for (let i = 0; i + 1 < path.length; i++) {
        const a = path[i] as Pt;
        const b = path[i + 1] as Pt;
        if (a.x !== b.x || a.y !== b.y) stub.push({ net, a, b });
      }
      if (stub.length > 0) {
        sheet.prewires.push(stub);
        wires.push(...stub.map(thinRect));
        sheet.symbols.push({ net, at, pin: ref });
      }
    };
    const facesWant = pin.outward === want;
    const opposite = pin.outward === (want + 180) % 360;
    if (facesWant || !opposite) {
      for (let k = 0; k <= 14; k++) {
        const at = { x: pin.at.x + step.x * k, y: pin.at.y + step.y * k };
        if (!facesWant && k === 0) continue;
        if (clear(symbolBox(at, want))) {
          put(at, [pin.at, at]);
          return;
        }
      }
    } else {
      // Facing away from its symbol: go out, across, and let the symbol turn back.
      for (let out = 1; out <= 8; out++) {
        for (const dx of [2, -2, 3, -3, 4, -4, 5, -5, 6, -6]) {
          const corner = { x: pin.at.x, y: pin.at.y + step.y * out };
          const at = { x: pin.at.x + dx, y: corner.y };
          if (clear(symbolBox(at, want))) {
            put(at, [pin.at, corner, at]);
            return;
          }
        }
      }
    }
    put(pin.at, [pin.at]);
  };

  const parts = [...ctx.parts.values()].filter((p) => !isPort(p.id));
  parts.sort((a, b) => a.order - b.order);
  const useSymbols = ctx.rules.on("local-power-symbols");
  for (const part of useSymbols ? parts : []) {
    const handled = (p: PlacedPin) => sheet.handled.has(pinKey({ part: part.id, pin: p.id }));
    // Pins already on a wire take no symbol, but a neighbour on their rail can share their wire.
    const rails = part.pins
      .filter((p) => p.net !== undefined && ctx.role(p.net) !== "signal")
      .map((p) => pins.get(pinKey({ part: part.id, pin: p.id })) as PlacedPin);
    rails.sort((a, b) => a.outward - b.outward || a.at.x - b.at.x || a.at.y - b.at.y);
    let prev: PlacedPin | undefined;
    for (const pin of rails) {
      if (handled(pin)) {
        prev = pin;
        continue;
      }
      const net = pin.net as string;
      const distance = prev
        ? Math.abs(prev.at.x - pin.at.x) + Math.abs(prev.at.y - pin.at.y)
        : Number.POSITIVE_INFINITY;
      if (share && prev && prev.net === net && prev.outward === pin.outward && distance <= 2) {
        sheet.prewires.push([{ net, a: prev.at, b: pin.at }]);
        wires.push(thinRect({ net, a: prev.at, b: pin.at }));
        // On the wire now: the router still joins it if this short wire does not fit.
        sheet.handled.add(pinKey({ part: part.id, pin: pin.id }));
      } else {
        place(net, pin, { part: part.id, pin: pin.id });
      }
      prev = pin;
    }
  }
  // Markers go last, in whatever space is left beside a symbol, else beside a pin.
  const markers: Marker[] = [];
  const flagged = ctx.input.nets
    .filter((n) => n.flagged)
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const net of flagged) {
    const spots = [
      ...symbols.filter((s) => s.net === net.name).map((s) => s.at),
      ...[...pins.values()].filter((p) => p.net === net.name).map((p) => p.at),
    ];
    let chosen: Marker | undefined;
    for (const at of spots) {
      for (const outward of [0, 180, 90, 270] as const) {
        const box = markerBox(at, outward);
        const step = stepOf(outward);
        // The box starts a step out, so it may sit beside a symbol that shares `at`.
        const off = translate(box, step.x, step.y);
        const hits =
          taken.some((t) => rectsOverlap(off, t)) || wires.some((w) => rectsOverlap(box, w));
        if (hits) continue;
        chosen = { net: net.name, at, outward, box: off };
        break;
      }
      if (chosen) break;
    }
    const fallback = spots[0];
    if (!chosen && fallback) {
      chosen = { net: net.name, at: fallback, outward: 0, box: markerBox(fallback, 0) };
    }
    if (chosen) {
      markers.push(chosen);
      taken.push(chosen.box);
    }
  }
  return { symbols, markers };
}

function markerBox(at: Pt, outward: Direction): Rect {
  if (outward === 0) return { x: at.x, y: at.y - 1, w: 3, h: 2 };
  if (outward === 180) return { x: at.x - 3, y: at.y - 1, w: 3, h: 2 };
  if (outward === 90) return { x: at.x - 1, y: at.y - 3, w: 2, h: 3 };
  return { x: at.x - 1, y: at.y, w: 2, h: 3 };
}

const useSymbolsNow = (ctx: Ctx) => ctx.rules.on("local-power-symbols");
