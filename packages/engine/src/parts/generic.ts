import { parseQuantity } from "../units.js";
import type { PinType } from "./schema.js";

export interface GenericPin {
  number: string;
  name: string;
  type: PinType;
}

interface GenericDef {
  pins: GenericPin[];
  /** Unit expected on the first argument (the value); undefined if it is a word (color, kind). */
  valueUnit?: string;
  usage: string;
  /** KiCad library and footprint prefix for chip packages, e.g. Resistor_SMD + R → R_0603_1608Metric. */
  footprint: [lib: string, prefix: string];
}

const twoPin: GenericPin[] = [
  { number: "1", name: "1", type: "passive" },
  { number: "2", name: "2", type: "passive" },
];
const diodePins: GenericPin[] = [
  { number: "1", name: "K", type: "passive" },
  { number: "2", name: "A", type: "passive" },
];

/** Built-in constraint parts, resolved to an MPN at BOM time. */
export const generics: Record<string, GenericDef> = {
  res: {
    pins: twoPin,
    valueUnit: "Ω",
    usage: "res(value, [tolerance], [power], [package])",
    footprint: ["Resistor_SMD", "R"],
  },
  cap: {
    pins: twoPin,
    valueUnit: "F",
    usage: "cap(value, [voltage], [dielectric], [tolerance], [package])",
    footprint: ["Capacitor_SMD", "C"],
  },
  ind: {
    pins: twoPin,
    valueUnit: "H",
    usage: "ind(value, [current], [package])",
    footprint: ["Inductor_SMD", "L"],
  },
  led: { pins: diodePins, usage: "led(color, [package])", footprint: ["LED_SMD", "LED"] },
  diode: { pins: diodePins, usage: "diode(kind, [package])", footprint: ["Diode_SMD", "D"] },
};

/** Imperial chip size → metric code used in KiCad footprint names. */
const chipSizes: Record<string, string> = {
  "0201": "0603",
  "0402": "1005",
  "0603": "1608",
  "0805": "2012",
  "1206": "3216",
  "1210": "3225",
  "1812": "4532",
  "2010": "5025",
  "2512": "6332",
};

const dielectrics = /^(X5R|X6S|X7R|X7S|X8R|C0G|NP0|Y5V|Z5U)$/i;
const packageLike = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)+$/; // SOD-123, DO-214AC

/** A generic part's arguments sorted by meaning. Quantities are in base units (F, Ω, V, A, W). */
export interface GenericSpec {
  fn: string;
  /** Numeric value (res/cap/ind) or a lower-case word (led color, diode kind). */
  value?: number | string;
  voltage?: number;
  current?: number;
  power?: number;
  /** Fraction: 1% → 0.01. */
  tolerance?: number;
  dielectric?: string;
  package?: string;
  /** Arguments that fit no category; they must match literally when resolving. */
  other: string[];
}

/** Classifies `cap(100n, 16V, X7R, 0603)` arguments; returns undefined for an unknown fn. */
export function parseGenericSpec(fn: string, args: string[]): GenericSpec | undefined {
  const def = generics[fn];
  if (!def) return undefined;
  const spec: GenericSpec = { fn, other: [] };
  const [first, ...rest] = args;
  if (first !== undefined) {
    if (def.valueUnit === undefined) {
      spec.value = first.toLowerCase();
    } else {
      const q = parseQuantity(first);
      if (q && (q.unit === "" || q.unit === def.valueUnit)) spec.value = q.value;
      else spec.other.push(first);
    }
  }
  for (const arg of rest) {
    const pct = /^±?(\d+(?:\.\d+)?)%$/.exec(arg);
    const q = parseQuantity(arg);
    if (pct) spec.tolerance = Number(pct[1]) / 100;
    else if (chipSizes[arg] !== undefined || packageLike.test(arg))
      spec.package = arg.toUpperCase();
    else if (dielectrics.test(arg)) spec.dielectric = arg.toUpperCase().replace("NP0", "C0G");
    else if (q?.unit === "V") spec.voltage = q.value;
    else if (q?.unit === "A") spec.current = q.value;
    else if (q?.unit === "W") spec.power = q.value;
    else spec.other.push(arg);
  }
  return spec;
}

/** Parses the text form used in part records: `cap(100n, 50V, X7R, 10%, 0603)`. */
export function parseGenericText(text: string): GenericSpec | undefined {
  const m = /^\s*([a-z]+)\((.*)\)\s*$/.exec(text);
  if (!m) return undefined;
  const args = (m[2] as string)
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  return parseGenericSpec(m[1] as string, args);
}

const sameNumber = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 1e-6;

/** Whether a concrete part (`offer`, from its record) meets every constraint in `need`. */
export function satisfies(offer: GenericSpec, need: GenericSpec): boolean {
  if (offer.fn !== need.fn) return false;
  if (need.value !== undefined) {
    if (offer.value === undefined) return false;
    if (typeof need.value === "number") {
      if (typeof offer.value !== "number" || !sameNumber(offer.value, need.value)) return false;
    } else if (offer.value !== need.value) {
      return false;
    }
  }
  const atLeast = (o?: number, n?: number) => n === undefined || (o !== undefined && o >= n);
  if (!atLeast(offer.voltage, need.voltage)) return false;
  if (!atLeast(offer.current, need.current)) return false;
  if (!atLeast(offer.power, need.power)) return false;
  if (need.tolerance !== undefined) {
    if (offer.tolerance === undefined || offer.tolerance > need.tolerance) return false;
  }
  if (need.dielectric !== undefined && offer.dielectric !== need.dielectric) return false;
  if (need.package !== undefined && offer.package !== need.package) return false;
  const offered = new Set(offer.other.map((o) => o.toLowerCase()));
  return need.other.every((o) => offered.has(o.toLowerCase()));
}

/** KiCad footprint for an unresolved generic chip part (`R_0603_1608Metric`), if its package says. */
export function genericFootprint(spec: GenericSpec): string | undefined {
  const def = generics[spec.fn];
  const metric = spec.package === undefined ? undefined : chipSizes[spec.package];
  if (!def || metric === undefined) return undefined;
  const [lib, prefix] = def.footprint;
  return `${lib}:${prefix}_${spec.package}_${metric}Metric`;
}

/** Returns a problem description, or undefined if the arguments are acceptable. */
export function checkGenericArgs(fn: string, args: string[]): string | undefined {
  const def = generics[fn];
  if (!def) {
    return `unknown generic part '${fn}' (expected one of: ${Object.keys(generics).join(", ")})`;
  }
  const first = args[0];
  if (first === undefined) return `missing value; usage: ${def.usage}`;
  if (def.valueUnit !== undefined) {
    const q = parseQuantity(first);
    // A bare number with a prefix (330n) is fine; an explicit unit must be the right one.
    if (!q || (q.unit !== "" && q.unit !== def.valueUnit)) {
      return `'${first}' is not a valid ${fn} value; usage: ${def.usage}`;
    }
  }
  const unknown = parseGenericSpec(fn, args)?.other ?? [];
  if (unknown.length > 0) {
    return `unrecognized argument${unknown.length > 1 ? "s" : ""} ${unknown.map((u) => `'${u}'`).join(", ")}; usage: ${def.usage}`;
  }
  return undefined;
}
