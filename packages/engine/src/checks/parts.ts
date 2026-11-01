import { printSpec } from "../ckt/print.js";
import type { Issue } from "../diagnostics.js";
import type { FlatNet, FlatPart, FlatPin, Netlist } from "../netlist/elaborate.js";
import type { Requirement } from "../parts/schema.js";
import { parseQuantity } from "../units.js";
import { across, isGroundNet, netVoltage, passiveSpec, volts } from "./nets.js";

export interface PartCheckOptions {
  /** A capacitor's rating should be at least this many times the voltage across it. */
  capDerating: number;
}

const pinSubjects = (pin: FlatPin) => [
  `${pin.part}.${pin.name}`,
  `${pin.part}.${pin.number}`,
  pin.part,
];

const value = (q: string | undefined) => (q === undefined ? undefined : parseQuantity(q)?.value);

const fmt = (v: number, unit: string) => {
  const prefixes: [number, string][] = [
    [1e6, "M"],
    [1e3, "k"],
    [1, ""],
    [1e-3, "m"],
    [1e-6, "u"],
    [1e-9, "n"],
    [1e-12, "p"],
  ];
  const [scale, p] = prefixes.find(([s]) => Math.abs(v) >= s * 0.999) ?? [1e-12, "p"];
  return `${Number((v / scale).toFixed(3))}${p}${unit}`;
};

/**
 * Checks that need part data: pin voltage limits against net voltages, capacitor voltage
 * derating, and datasheet requirements that carry a check. (Unverified records are counted
 * by overview rather than repeated in every validate.)
 */
export function partChecks(netlist: Netlist, options: PartCheckOptions): Issue[] {
  const issues: Issue[] = [];
  const nets = new Map(netlist.nets.map((n) => [n.name, n]));
  const netOf = (pin: FlatPin) => (pin.net === undefined ? undefined : nets.get(pin.net));

  for (const part of netlist.parts) {
    // Pins with an absolute maximum.
    for (const pin of part.pins) {
      const limit = value(part.record?.pins[pin.number]?.vmax);
      const net = netOf(pin);
      const v = net && netVoltage(net);
      if (limit === undefined || !net || !v) continue;
      const peak = Math.max(Math.abs(v.min), Math.abs(v.max));
      if (peak > limit * (1 + 1e-9)) {
        issues.push({
          code: "part.overvoltage",
          severity: "error",
          message: `${part.path}.${pin.name} is rated ${volts(limit)} max, but ${net.name} reaches ${volts(peak)}`,
          location: part.location,
          subjects: [...pinSubjects(pin), ...net.aliases],
        });
      }
    }

    // Capacitor voltage rating against what it sees.
    const spec = passiveSpec(part);
    if (spec?.fn === "cap" && spec.voltage !== undefined && part.pins.length === 2) {
      const [a, b] = part.pins.map(netOf);
      const va = a && netVoltage(a);
      const vb = b && netVoltage(b);
      if (a && b && va && vb) {
        const v = across(va, vb);
        const rating = spec.voltage;
        const where = `${volts(v)} across ${a.name}/${b.name}`;
        const what = part.spec.kind === "lib" ? `lib:${part.spec.id}` : printSpec(part.spec);
        if (v > rating * (1 + 1e-9)) {
          issues.push({
            code: "part.cap-voltage",
            severity: "error",
            message: `${part.path} ${what} is rated ${volts(rating)} but sees ${where}`,
            location: part.location,
            subjects: [part.path],
          });
        } else if (rating < options.capDerating * v * (1 - 1e-9)) {
          issues.push({
            code: "part.cap-voltage",
            severity: "warning",
            message: `${part.path} ${what} sees ${where}: rated ${volts(rating)}, under ${options.capDerating}x (pick ≥ ${volts(options.capDerating * v)})`,
            location: part.location,
            subjects: [part.path],
          });
        }
      }
    }

    for (const req of part.record?.requirements ?? []) {
      if (typeof req === "string") continue;
      const problem = checkRequirement(part, req, netlist, nets);
      if (problem) {
        issues.push({
          code: "part.requirement",
          severity: "warning",
          message: `${part.path}: "${req.text}": ${problem}`,
          location: part.location,
          subjects: [part.path],
        });
      }
    }
  }

  return issues;
}

/** Pins of a part named by number, else by name. */
function pinsOf(part: FlatPart, token: string): FlatPin[] {
  const byNumber = part.pins.filter((p) => p.number === token);
  return byNumber.length > 0 ? byNumber : part.pins.filter((p) => p.name === token);
}

/** The nets a requirement's `to` means: a pin of the part, a net by name, or ground. */
function targets(
  part: FlatPart,
  to: string | undefined,
  netlist: Netlist,
): { nets: Set<string>; label: string } {
  if (to === undefined || /^(gnd|ground)$/i.test(to)) {
    return { nets: new Set(netlist.nets.filter(isGroundNet).map((n) => n.name)), label: "ground" };
  }
  const pins = pinsOf(part, to);
  if (pins.length > 0) {
    const nets = new Set(pins.flatMap((p) => (p.net === undefined ? [] : [p.net])));
    return { nets, label: `${to} (${[...nets].join(", ") || "unconnected"})` };
  }
  return { nets: netsNamed(part, to, netlist), label: to };
}

/** A net by name, preferring the one in the part's own block instance. */
function netsNamed(part: FlatPart, name: string, netlist: Netlist): Set<string> {
  const prefix = part.path.slice(0, part.path.lastIndexOf("/") + 1);
  const local = netlist.nets.filter((n) => n.aliases.includes(prefix + name));
  const found =
    local.length > 0
      ? local
      : netlist.nets.filter((n) => n.aliases.some((a) => a.endsWith(`/${name}`) || a === name));
  return new Set(found.map((n) => n.name));
}

function checkRequirement(
  part: FlatPart,
  req: Exclude<Requirement, string>,
  netlist: Netlist,
  nets: Map<string, FlatNet>,
): string | undefined {
  const check = req.cap ?? req.res ?? req.tie;
  if (!check) return undefined;
  // The pins (or net) the requirement starts from, grouped by net.
  const fromPins = pinsOf(part, check.from);
  const fromNets = new Map<string, number>();
  if (fromPins.length > 0) {
    for (const p of fromPins) {
      if (p.net !== undefined) fromNets.set(p.net, (fromNets.get(p.net) ?? 0) + 1);
    }
  } else {
    for (const n of netsNamed(part, check.from, netlist)) fromNets.set(n, 1);
  }
  if (fromNets.size === 0) return undefined; // an unconnected pin is ERC's to report
  const to = targets(part, check.to, netlist);

  if (req.tie) {
    const off = [...fromNets.keys()].filter((n) => !to.nets.has(n));
    return off.length === 0 ? undefined : `${check.from} is on ${off.join(", ")}, not ${to.label}`;
  }

  const fn = req.cap ? "cap" : "res";
  const min = value(req.cap?.min ?? req.res?.min);
  const max = value(req.res?.max);
  const unit = fn === "cap" ? "F" : "Ω";
  const range =
    min !== undefined && max !== undefined
      ? `${fmt(min, unit)}..${fmt(max, unit)}`
      : min !== undefined
        ? `≥ ${fmt(min, unit)}`
        : max !== undefined
          ? `≤ ${fmt(max, unit)}`
          : "";
  const missing: string[] = [];
  for (const [net, count] of fromNets) {
    const need = req.cap?.each ? count : 1;
    const fits: string[] = [];
    const near: string[] = [];
    for (const other of netlist.parts) {
      const spec = passiveSpec(other);
      if (spec?.fn !== fn || other.pins.length !== 2 || other === part) continue;
      const [a, b] = other.pins.map((p) => p.net);
      const between =
        (a === net && b !== undefined && to.nets.has(b)) ||
        (b === net && a !== undefined && to.nets.has(a));
      if (!between) continue;
      const v = typeof spec.value === "number" ? spec.value : undefined;
      const ok =
        v !== undefined &&
        (min === undefined || v >= min * (1 - 1e-6)) &&
        (max === undefined || v <= max * (1 + 1e-6));
      (ok ? fits : near).push(
        `${other.path.slice(other.path.lastIndexOf("/") + 1)} ${v === undefined ? "?" : fmt(v, unit)}`,
      );
    }
    if (fits.length < need) {
      const what = fn === "cap" ? "capacitor" : "resistor";
      const n = need > 1 ? `${need} ${what}s` : `a ${what}`;
      const found = [...fits, ...near];
      missing.push(
        `needs ${n} ${range} from ${check.from} (${nets.get(net)?.name ?? net}) to ${to.label}; found ${found.length > 0 ? found.join(", ") : "none"}`,
      );
    }
  }
  return missing.length > 0 ? missing.join("; ") : undefined;
}
