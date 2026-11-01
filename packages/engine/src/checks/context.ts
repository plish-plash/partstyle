import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Issue, Location } from "../diagnostics.js";
import type { FlatNet, FlatPart, Netlist } from "../netlist/elaborate.js";
import type { TextFile } from "../project/source.js";
import { parseQuantity } from "../units.js";
import { isGroundNet, isPowerNet, passiveSpec, volts } from "./nets.js";

/** Front matter of context.md, or undefined if absent or malformed. */
export function contextFrontMatter(text: string): Record<string, unknown> | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return undefined;
  try {
    const data = parseYaml(m[1] as string);
    return typeof data === "object" && data !== null
      ? (data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The parts of context.md's front matter that checks read; anything else is for people. */
const ContextSchema = z.looseObject({
  environment: z.looseObject({ temp_c: z.tuple([z.number(), z.number()]).optional() }).optional(),
  assembly: z.looseObject({ method: z.string().optional() }).optional(),
  external_interfaces: z
    .array(
      z.looseObject({
        connector: z.string(),
        connects_to: z.string().optional(),
        signal: z.string().optional(),
        hazards: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

const finePitch = /BGA|QFN|DFN|LGA|WLCSP|CSP|\b0201\b|\b01005\b/i;

/**
 * Checks against the environment in context.md: each external interface's hazards at its
 * connector, the operating temperature range and the assembly method.
 */
export function contextChecks(netlist: Netlist, context: TextFile | undefined): Issue[] {
  if (!context) return [];
  const location: Location = { file: context.file, line: 1, col: 1 };
  const issue = (code: string, message: string, subjects: string[]): Issue => ({
    code,
    severity: "warning",
    message,
    location,
    subjects,
  });
  const fm = contextFrontMatter(context.text);
  if (!fm) return [];
  const parsed = ContextSchema.safeParse(fm);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return [
      issue(
        "context.invalid",
        `context.md front matter: ${first ? `${first.path.join(".")}: ${first.message}` : "invalid"}; its checks were skipped`,
        [],
      ),
    ];
  }
  const ctx = parsed.data;
  const issues: Issue[] = [];
  const nets = new Map(netlist.nets.map((n) => [n.name, n]));
  const parts = new Map(netlist.parts.map((p) => [p.path, p]));
  const netsOf = (p: FlatPart) =>
    new Set(p.pins.flatMap((pin) => (pin.net === undefined ? [] : [pin.net])));

  for (const iface of ctx.external_interfaces) {
    const conn = parts.get(iface.connector);
    if (!conn) {
      issues.push(
        issue(
          "context.unknown-connector",
          `external interface ${iface.connector} is not a part in the design (use its instance path, e.g. PWR/J1)`,
          [iface.connector],
        ),
      );
      continue;
    }
    const connNets = [...netsOf(conn)].flatMap((n) => {
      const net = nets.get(n);
      return net ? [net] : [];
    });
    const signals = connNets.filter((n) => !isPowerNet(n));
    const live = connNets.filter((n) => !isGroundNet(n));
    const others = (n: FlatNet) => netlist.parts.filter((p) => p !== conn && netsOf(p).has(n.name));

    for (const hazard of iface.hazards) {
      const h = hazard.toLowerCase();
      const label = `${iface.connector} (${hazard})`;
      if (/\besd\b/.test(h)) {
        const bare = signals.filter((n) => !others(n).some((p) => clamps(p, n, nets)));
        if (bare.length > 0) {
          issues.push(
            issue(
              "context.hazard",
              `${label}: no ESD/TVS clamp to ground on ${bare.map((n) => n.name).join(", ")}`,
              [iface.connector, ...bare.flatMap((n) => n.aliases)],
            ),
          );
        }
      }
      // Any hazard naming a voltage ("miswiring to 12 V", "24 V surge") is one the connector's
      // signal pins may see.
      const v = /(\d+(?:\.\d+)?)\s*v\b/i.exec(hazard);
      if (v) {
        const limit = Number(v[1]);
        const weak: string[] = [];
        for (const n of signals) {
          for (const p of others(n)) {
            for (const pin of p.pins.filter((x) => x.net === n.name)) {
              const vmax = parseQuantity(p.record?.pins[pin.number]?.vmax ?? "")?.value;
              if (vmax !== undefined && vmax < limit) {
                weak.push(`${p.path}.${pin.name} (max ${volts(vmax)}) on ${n.name}`);
              }
            }
            const spec = passiveSpec(p);
            if (spec?.fn === "cap" && spec.voltage !== undefined && spec.voltage < limit) {
              weak.push(`${p.path} (rated ${volts(spec.voltage)}) on ${n.name}`);
            }
          }
        }
        if (weak.length > 0) {
          issues.push(
            issue("context.hazard", `${label}: ${volts(limit)} would reach ${weak.join(", ")}`, [
              iface.connector,
              ...signals.flatMap((n) => n.aliases),
            ]),
          );
        }
      }
      if (/revers|polarity/.test(h)) {
        const guarded = live.some((n) => others(n).some((p) => isDiode(p) || isFet(p)));
        if (!guarded && live.length > 0) {
          issues.push(
            issue(
              "context.hazard",
              `${label}: no diode or FET on ${live.map((n) => n.name).join(", ")} to block reversed supply`,
              [iface.connector],
            ),
          );
        }
      }
    }
  }

  // Operating temperature, per record in use.
  const temp = ctx.environment?.temp_c;
  const users = new Map<string, { part: FlatPart; paths: string[] }>();
  for (const p of netlist.parts) {
    if (!p.record) continue;
    const u = users.get(p.record.id) ?? { part: p, paths: [] };
    u.paths.push(p.path);
    users.set(p.record.id, u);
  }
  if (temp) {
    const [lo, hi] = temp;
    for (const [id, u] of users) {
      const range = u.part.record?.temp_c;
      if (!range || (range[0] <= lo && range[1] >= hi)) continue;
      issues.push(
        issue(
          "context.temperature",
          `lib:${id} (${u.paths.join(" ")}) is rated ${range[0]} to ${range[1]} °C; context.md needs ${lo} to ${hi} °C`,
          [id, ...u.paths],
        ),
      );
    }
  }

  // Hand assembly and packages that need a stencil and reflow.
  const method = ctx.assembly?.method ?? "";
  if (/hand/i.test(method) && !/service|reflow|house|pcba|stencil|oven|hot.?plate/i.test(method)) {
    const fine = new Map<string, string[]>();
    for (const p of netlist.parts) {
      const pkg = p.record?.package ?? passiveSpec(p)?.package ?? "";
      if (finePitch.test(pkg)) fine.set(pkg, [...(fine.get(pkg) ?? []), p.path]);
    }
    for (const [pkg, paths] of fine) {
      issues.push(
        issue(
          "context.assembly",
          `${paths.join(" ")}: ${pkg} is hard to hand-solder (assembly: ${method})`,
          paths,
        ),
      );
    }
  }
  return issues;
}

const diodeKind = /\b(tvs|esd)\b/i;

/** An ESD/TVS part with one pin on `net` and another on ground. */
function clamps(p: FlatPart, net: FlatNet, nets: Map<string, FlatNet>): boolean {
  const generic =
    p.spec.kind === "generic" && p.spec.fn === "diode" && diodeKind.test(p.spec.args[0] ?? "");
  const record =
    p.record &&
    (diodeKind.test(`${p.record.summary} ${p.record.id}`) ||
      Object.keys(p.record.ratings ?? {}).some((k) => /^(vrwm|esd)/.test(k)));
  if (!generic && !record) return false;
  return (
    p.pins.some((pin) => pin.net === net.name) &&
    p.pins.some((pin) => {
      const other = pin.net === undefined ? undefined : nets.get(pin.net);
      return other !== undefined && other !== net && isGroundNet(other);
    })
  );
}

const isDiode = (p: FlatPart) =>
  (p.spec.kind === "generic" && p.spec.fn === "diode") ||
  (p.record !== undefined &&
    p.pins.some((x) => x.name === "A") &&
    p.pins.some((x) => x.name === "K"));

const isFet = (p: FlatPart) =>
  p.record !== undefined && ["G", "D", "S"].every((n) => p.pins.some((x) => x.name === n));
