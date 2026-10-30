import { printSpec } from "./ckt/print.js";
import type { FlatNet, FlatPart, FlatPin, Netlist } from "./netlist/elaborate.js";
import { parseQuantity } from "./units.js";

export interface TextResult {
  ok: boolean;
  text: string;
}

const ok = (text: string): TextResult => ({ ok: true, text });
const fail = (text: string): TextResult => ({ ok: false, text });

export const queryUsage = `queries:
  part REF                      pins of one part and the net on each
  net NAME                      pins on one net
  parts [where COND [and ...]]  e.g. parts where vin_max < 15V, parts where kind = generic
  nets [where COND [and ...]]   e.g. nets where pins = 1, nets where voltage ~ 5V
  unconnected                   every pin on no net, including waived ones
COND is FIELD OP VALUE; OP is = != < <= > >= or ~ (contains). Part fields: path id mpn
manufacturer package footprint kind fn value verified intent, or any rating. Net fields: name
pins, or any attribute. Quantities compare numerically (35V > 5V). REF and NAME may omit the
instance path when unambiguous (U1 for PWR/U1).`;

/** Resolves a name to a flat path: exact match, else a unique `*\/name` match. */
function resolve(paths: string[], name: string, what: string): string | TextResult {
  if (paths.includes(name)) return name;
  const matches = paths.filter((p) => p.endsWith(`/${name}`));
  if (matches.length === 1) return matches[0] as string;
  if (matches.length > 1) return fail(`${what} '${name}' is ambiguous: ${matches.join(", ")}`);
  return fail(`no ${what} '${name}'`);
}

/** `U4.VCC`, or `U4.VCC[6]` when the part has several VCC pins. */
function pinLabels(netlist: Netlist): (pin: FlatPin) => string {
  const shared = new Set<string>();
  for (const part of netlist.parts) {
    const seen = new Set<string>();
    for (const p of part.pins) {
      if (seen.has(p.name)) shared.add(`${part.path}.${p.name}`);
      seen.add(p.name);
    }
  }
  return (pin) => {
    const label = `${pin.part}.${pin.name}`;
    const numbered = shared.has(label) ? `${label}[${pin.number}]` : label;
    return pin.type === "passive" ? numbered : `${numbered}(${pin.type})`;
  };
}

const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function formatAttrs(attrs: Record<string, string>): string {
  const entries = Object.entries(attrs);
  return entries.length === 0 ? "" : ` {${entries.map(([k, v]) => `${k}: ${v}`).join(", ")}}`;
}

function describePartLine(part: FlatPart): string {
  const r = part.record;
  const identity = r ? ` ${r.summary}${r.provenance.verified_by ? "" : " [unverified]"}` : "";
  return `${part.path} ${printSpec(part.spec)}${identity}${part.intent ? ` @ ${part.intent}` : ""}`;
}

function partFields(part: FlatPart): Record<string, string> {
  const r = part.record;
  const fields: Record<string, string> = {
    path: part.path,
    kind: part.spec.kind,
    intent: part.intent ?? "",
  };
  if (part.spec.kind === "generic") {
    fields.fn = part.spec.fn;
    fields.value = part.spec.args[0] ?? "";
  } else {
    fields.id = part.spec.id;
  }
  if (r) {
    Object.assign(fields, {
      mpn: r.mpn,
      manufacturer: r.manufacturer,
      package: r.package,
      footprint: r.footprint,
      verified: r.provenance.verified_by ? "yes" : "no",
    });
    for (const [k, v] of Object.entries(r.ratings ?? {})) fields[k] = String(v);
  }
  return fields;
}

function netFields(net: FlatNet): Record<string, string> {
  return { ...net.attrs, name: net.name, pins: String(net.pins.length) };
}

type Op = "=" | "!=" | "<" | "<=" | ">" | ">=" | "~";
interface Condition {
  field: string;
  op: Op;
  value: string;
}

const conditionPattern = /^([A-Za-z_][\w.-]*)\s*(<=|>=|!=|<|>|=|~)\s*(.+)$/;

function parseConditions(text: string): Condition[] | TextResult {
  const conditions: Condition[] = [];
  for (const part of text.split(/\s+and\s+/i)) {
    const m = conditionPattern.exec(part.trim());
    if (!m) return fail(`cannot parse condition '${part.trim()}'\n\n${queryUsage}`);
    conditions.push({ field: m[1] as string, op: m[2] as Op, value: (m[3] as string).trim() });
  }
  return conditions;
}

function compare(actual: string, op: Op, expected: string): boolean {
  if (op === "~") return actual.toLowerCase().includes(expected.toLowerCase());
  const a = parseQuantity(actual);
  const b = parseQuantity(expected);
  const numeric = a && b && (a.unit === b.unit || a.unit === "" || b.unit === "");
  if (numeric) {
    const [x, y] = [a.value, b.value];
    switch (op) {
      case "=":
        return x === y;
      case "!=":
        return x !== y;
      case "<":
        return x < y;
      case "<=":
        return x <= y;
      case ">":
        return x > y;
      case ">=":
        return x >= y;
    }
  }
  if (op === "=") return actual.toLowerCase() === expected.toLowerCase();
  if (op === "!=") return actual.toLowerCase() !== expected.toLowerCase();
  return false;
}

/** A missing field never matches, so `parts where vin_max < 15V` skips parts without that rating. */
function matches(fields: Record<string, string>, conditions: Condition[]): boolean {
  return conditions.every((c) => {
    const actual = fields[c.field];
    return actual !== undefined && compare(actual, c.op, c.value);
  });
}

function filterClause(rest: string): Condition[] | TextResult {
  if (rest === "") return [];
  const m = /^where\s+(.+)$/i.exec(rest);
  if (!m) return fail(`expected 'where', found '${rest}'\n\n${queryUsage}`);
  return parseConditions(m[1] as string);
}

const isResult = (x: unknown): x is TextResult =>
  typeof x === "object" && x !== null && "ok" in x && "text" in x;

/** Answers a targeted lookup over the flattened netlist. */
export function runQuery(netlist: Netlist, expr: string): TextResult {
  const [command = "", ...args] = expr.trim().split(/\s+/);
  const rest = expr.trim().slice(command.length).trim();
  const pinWithType = pinLabels(netlist);

  switch (command) {
    case "part": {
      if (args.length !== 1) return fail(`usage: part REF\n\n${queryUsage}`);
      const path = resolve(
        netlist.parts.map((p) => p.path),
        args[0] as string,
        "part",
      );
      if (isResult(path)) return path;
      const part = netlist.parts.find((p) => p.path === path) as FlatPart;
      const pins = part.pins.map(
        (p) => `  ${p.number} ${p.name} ${p.type} -> ${p.net ?? "(unconnected)"}`,
      );
      return ok([describePartLine(part), ...pins].join("\n"));
    }
    case "net": {
      if (args.length !== 1) return fail(`usage: net NAME\n\n${queryUsage}`);
      const aliases = netlist.nets.flatMap((n) => n.aliases.map((a) => [a, n] as const));
      const name = resolve(
        aliases.map(([a]) => a),
        args[0] as string,
        "net",
      );
      if (isResult(name)) return name;
      const net = aliases.find(([a]) => a === name)?.[1] as FlatNet;
      const also = net.aliases.filter((a) => a !== net.name);
      const header = `${net.name}${formatAttrs(net.attrs)}${
        also.length > 0 ? ` (joins ${also.join(", ")})` : ""
      }: ${counted(net.pins.length, "pin")}`;
      return ok(`${header}\n  ${net.pins.map(pinWithType).join(" ")}`);
    }
    case "parts": {
      const conditions = filterClause(rest);
      if (isResult(conditions)) return conditions;
      const shown = new Set(conditions.map((c) => c.field));
      const lines = netlist.parts
        .map((p) => [p, partFields(p)] as const)
        .filter(([, f]) => matches(f, conditions))
        .map(([p, f]) => {
          const extra = [...shown]
            .filter((k) => !["path", "kind", "fn", "id", "intent"].includes(k))
            .map((k) => `${k}=${f[k]}`);
          return [p.path, printSpec(p.spec), ...extra].join("  ");
        });
      return ok(
        lines.length === 0
          ? "no matching parts"
          : `${counted(lines.length, "part")}\n${lines.join("\n")}`,
      );
    }
    case "nets": {
      const conditions = filterClause(rest);
      if (isResult(conditions)) return conditions;
      const lines = netlist.nets
        .filter((n) => matches(netFields(n), conditions))
        .map((n) => `${n.name}${formatAttrs(n.attrs)}: ${n.pins.map(pinWithType).join(" ")}`);
      return ok(
        lines.length === 0
          ? "no matching nets"
          : `${counted(lines.length, "net")}\n${lines.join("\n")}`,
      );
    }
    case "unconnected": {
      const pins = netlist.parts.flatMap((p) => p.pins.filter((pin) => pin.net === undefined));
      if (pins.length === 0) return ok("every pin is connected");
      return ok(
        `${counted(pins.length, "unconnected pin")}\n${pins
          .map((p) => `  ${p.part}.${p.name} (pin ${p.number}, ${p.type})`)
          .join("\n")}`,
      );
    }
    default:
      return fail(`unknown query '${command}'\n\n${queryUsage}`);
  }
}
