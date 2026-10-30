import { parseQuantity } from "../units.js";
import type { PinType } from "./schema.js";

export interface GenericPin {
  number: string;
  name: string;
  type: PinType;
}

interface GenericDef {
  pins: GenericPin[];
  /** Unit expected on the first argument (the value); undefined if the first argument is free-form. */
  valueUnit?: string;
  usage: string;
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
  res: { pins: twoPin, valueUnit: "Ω", usage: "res(value, [tolerance], [package])" },
  cap: { pins: twoPin, valueUnit: "F", usage: "cap(value, [voltage], [dielectric], [package])" },
  ind: { pins: twoPin, valueUnit: "H", usage: "ind(value, [current], [package])" },
  led: { pins: diodePins, usage: "led(color, [package])" },
  diode: { pins: diodePins, usage: "diode(kind, [package])" },
};

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
  return undefined;
}
