import type { FlatNet, FlatPart } from "../netlist/elaborate.js";
import { type GenericSpec, parseGenericSpec, parseGenericText } from "../parts/generic.js";
import { parseQuantity } from "../units.js";

/** A voltage range in volts. */
export interface Range {
  min: number;
  max: number;
}

const bare = (name: string) => name.slice(name.lastIndexOf("/") + 1);

/** `5V`, `12V ±10%`, `0-3.3V`, `-5V to 5V`; undefined if it is not a voltage. */
export function parseVoltageRange(text: string): Range | undefined {
  const single = parseQuantity(text);
  if (single) {
    if (single.unit !== "V") return undefined;
    const t = single.tolerance ?? 0;
    const a = single.value * (1 - t);
    const b = single.value * (1 + t);
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const m = /^(.+?)\s*(?:\.\.|to|–|(?<=\d)-)\s*(.+)$/.exec(text.trim());
  if (!m) return undefined;
  const lo = parseQuantity(m[1] as string);
  const hi = parseQuantity(m[2] as string);
  if (!lo || !hi || hi.unit !== "V" || (lo.unit !== "V" && lo.unit !== "")) return undefined;
  return { min: Math.min(lo.value, hi.value), max: Math.max(lo.value, hi.value) };
}

/** The voltage a rail's name states: `+3V3` 3.3, `+5V` 5, `-12V` -12, `+1.8V` 1.8. */
export function railVoltage(name: string): number | undefined {
  const m = /^([+-])?(\d+(?:\.\d+)?)V(\d*)$/i.exec(name);
  if (!m) return undefined;
  const v = Number(m[3] ? `${m[2]}.${m[3]}` : m[2]);
  return m[1] === "-" ? -v : v;
}

const groundName = /^([ADPS]?GND\w*|GND\w*|VSS\w?|0V)$/i;

export const isGroundNet = (n: FlatNet) =>
  n.portKinds.includes("ground") || n.aliases.some((a) => groundName.test(bare(a)));

/** Nets that carry power: power pins on them, or a power or ground port. */
export const isPowerNet = (n: FlatNet) =>
  isGroundNet(n) ||
  n.pins.some((p) => p.type === "power_in" || p.type === "power_out") ||
  n.portKinds.some((k) => k === "power_in" || k === "power_out");

/**
 * What a net's voltage is known to be: its `voltage` attribute, else a ground net's 0 V, else
 * the voltage its name states (`+3V3`). Undefined when nothing says.
 */
export function netVoltage(n: FlatNet): Range | undefined {
  if (n.attrs.voltage !== undefined) return parseVoltageRange(n.attrs.voltage);
  if (isGroundNet(n)) return { min: 0, max: 0 };
  for (const a of n.aliases) {
    const v = railVoltage(bare(a));
    if (v !== undefined) return { min: v, max: v };
  }
  return undefined;
}

/** Largest voltage between two nets. */
export const across = (a: Range, b: Range) =>
  Math.max(Math.abs(a.max - b.min), Math.abs(b.max - a.min));

export const volts = (v: number) => `${Number(v.toFixed(3))}V`;

/** A passive's value and ratings, from its generic or its record's `generic` field. */
export function passiveSpec(p: FlatPart): GenericSpec | undefined {
  if (p.spec.kind === "generic") return parseGenericSpec(p.spec.fn, p.spec.args);
  return p.record?.generic ? parseGenericText(p.record.generic) : undefined;
}
