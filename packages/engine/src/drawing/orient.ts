import type { SymbolUnit, UnitPin } from "../kicad/libsym.js";

export type Rotation = 0 | 90 | 180 | 270;

/** What a pin's net is, for orienting parts: a supply rail, ground, or anything else. */
export type NetRole = "rail" | "ground" | "signal";

const cos = (r: number) => Math.round(Math.cos((r * Math.PI) / 180));
const sin = (r: number) => Math.round(Math.sin((r * Math.PI) / 180));

/** A symbol unit rotated counter-clockwise by `r` (symbol coords, y up), as KiCad rotates it. */
export function rotateUnit(unit: SymbolUnit, r: Rotation): SymbolUnit {
  if (r === 0) return unit;
  const c = cos(r);
  const s = sin(r);
  const rot = (x: number, y: number) => ({ x: x * c - y * s, y: x * s + y * c });
  const pins = new Map<string, UnitPin>();
  for (const [n, p] of unit.pins) {
    const q = rot(p.x, p.y);
    pins.set(n, { ...p, x: q.x, y: q.y, outward: (p.outward + r) % 360 });
  }
  const { minX, maxX, minY, maxY } = unit.box;
  const corners = [rot(minX, minY), rot(minX, maxY), rot(maxX, minY), rot(maxX, maxY)];
  return {
    unit: unit.unit,
    pins,
    box: {
      minX: Math.min(...corners.map((p) => p.x)),
      maxX: Math.max(...corners.map((p) => p.x)),
      minY: Math.min(...corners.map((p) => p.y)),
      maxY: Math.max(...corners.map((p) => p.y)),
    },
  };
}

/** A symbol unit mirrored left to right, as KiCad's `(mirror y)` draws it. */
export function mirrorUnit(unit: SymbolUnit): SymbolUnit {
  const pins = new Map<string, UnitPin>();
  for (const [n, p] of unit.pins) {
    pins.set(n, { ...p, x: -p.x, outward: (540 - p.outward) % 360 });
  }
  const { minX, maxX, minY, maxY } = unit.box;
  return { unit: unit.unit, pins, box: { minX: -maxX, maxX: -minX, minY, maxY } };
}

/** Parts whose symbol may be turned: two-terminal resistors, capacitors, inductors, fuses, diodes. */
export const turnable = /^(R|C|L|F|FB|D|LED)\d/i;

/** The rotation that makes `pin` point `toward` (0 right, 90 up, 180 left, 270 down). */
const rotationFor = (pin: UnitPin, toward: number): Rotation =>
  ((((toward - pin.outward) % 360) + 360) % 360) as Rotation;

export interface Orientation {
  rotation: Rotation;
  /** A horizontal series part whose direction may be reversed to shorten its wires. */
  flippable: boolean;
}

/**
 * How to turn a two-terminal part so the schematic reads conventionally: a part to ground stands
 * upright with ground at the bottom; a part between a rail and a signal stands with the rail on
 * top; anything else lies horizontally in the signal path, a diode with its anode on the left.
 * Returns undefined for parts that keep their library orientation.
 */
export function orient(
  ref: string,
  unit: SymbolUnit,
  pinInfo: (number: string) => { name: string; role: NetRole },
): Orientation | undefined {
  const visible = [...unit.pins].filter(([, p]) => !p.hidden);
  if (visible.length !== 2 || !turnable.test(ref)) return undefined;
  const [[na, a], [nb, b]] = visible as [[string, UnitPin], [string, UnitPin]];
  const ia = pinInfo(na);
  const ib = pinInfo(nb);
  const names = [ia.name, ib.name];
  const diode = names.includes("A") && names.includes("K");

  if (ia.role === "ground" && ib.role === "ground") return undefined;
  if (ia.role === "ground") return { rotation: rotationFor(a, 270), flippable: false };
  if (ib.role === "ground") return { rotation: rotationFor(b, 270), flippable: false };
  if (!diode && ia.role === "rail" && ib.role === "signal") {
    return { rotation: rotationFor(a, 90), flippable: false };
  }
  if (!diode && ib.role === "rail" && ia.role === "signal") {
    return { rotation: rotationFor(b, 90), flippable: false };
  }
  const left = diode ? (ia.name === "A" ? a : b) : a;
  return { rotation: rotationFor(left, 180), flippable: !diode };
}
