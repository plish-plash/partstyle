/**
 * Reports how the layout engine drew a project's sheets, from source (no build needed):
 *
 *   pnpm layout-report -p DIR                  one line per sheet, then layout bugs
 *   pnpm layout-report -p DIR SHEET            one sheet: metrics, issues and its parts
 *     --grid          the sheet as a character grid, with sheet grid rulers
 *     --part REF      a part's placement, pins and the rules that placed it (repeatable)
 *     --case [ID]     saves the sheet's layout input as a tester case in layout/captured/
 *   --rules JSON      rule overrides on top of the project's preferences, compared with them
 *   --variant NAME    a variant's design instead of the main circuit
 *   --json            machine-readable output
 *
 * SHEET is a block name or an instance prefix (PWR or PWR/). Coordinates are sheet grid units:
 * millimetres from the paper's top left corner divided by 2.54, the same as the viewer's ?grid.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SheetLayoutDetail } from "@partstyle/engine";
import { Workspace } from "@partstyle/engine/node";
import {
  type LayoutResult,
  layoutBlock,
  type MetricIssue,
  type Metrics,
  measure,
  type Pt,
  type RuleOverrides,
} from "@partstyle/layout";
import { CAPTURED_DIR } from "../layout/packages/tester/scripts/captured.js";
import { textGrid } from "../layout/packages/tester/scripts/grid.js";

const USAGE =
  "usage: pnpm layout-report -p DIR [SHEET] [--grid] [--part REF]... [--case [ID]] [--rules JSON] [--variant NAME] [--json]";

function parseArgs(argv: string[]) {
  const out = {
    project: undefined as string | undefined,
    sheet: undefined as string | undefined,
    grid: false,
    parts: [] as string[],
    caseId: undefined as string | true | undefined,
    rules: undefined as RuleOverrides | undefined,
    variant: undefined as string | undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value\n${USAGE}`);
      return v;
    };
    if (a === "-p" || a === "--project") out.project = value();
    else if (a === "--grid") out.grid = true;
    else if (a === "--part") out.parts.push(value());
    else if (a === "--case") {
      const next = argv[i + 1];
      out.caseId =
        next !== undefined && !next.startsWith("-") && out.sheet !== undefined ? value() : true;
    } else if (a === "--rules") out.rules = JSON.parse(value()) as RuleOverrides;
    else if (a === "--variant") out.variant = value();
    else if (a === "--json") out.json = true;
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (!a.startsWith("-") && out.sheet === undefined) out.sheet = a;
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  return out;
}

/** Overrides `extra` laid over `base`, rule by rule and parameter by parameter. */
function mergeOverrides(base: RuleOverrides, extra: RuleOverrides): RuleOverrides {
  const out: RuleOverrides = structuredClone(base);
  for (const [id, o] of Object.entries(extra)) {
    const b = out[id] ?? {};
    out[id] = {
      ...b,
      ...(o.enabled !== undefined && { enabled: o.enabled }),
      ...((b.params || o.params) && { params: { ...b.params, ...o.params } }),
    };
  }
  return out;
}

const COLUMNS: [string, keyof Metrics][] = [
  ["hard", "hardFailures"],
  ["cross", "crossings"],
  ["rail", "railCrossings"],
  ["bends", "bends"],
  ["wire", "wireLength"],
  ["str%", "straightPercent"],
  ["lbl", "labels"],
  ["back", "signalBackwards"],
  ["pwr", "powerWrongWay"],
  ["shunt", "shuntMisplaced"],
];

interface SheetRun {
  block: string;
  /** Instance prefixes drawn from this sheet ("" for the top). */
  instances: string[];
  detail: SheetLayoutDetail;
  result: LayoutResult;
  metrics: Metrics;
  issues: MetricIssue[];
  ms: number;
  /** With --rules: the project's own layout, for comparison. */
  before?: Metrics;
}

const header = (width: number) =>
  `${"sheet".padEnd(width)} parts  nets ${COLUMNS.map(([h]) => h.padStart(5)).join(" ")}   size     ms`;

function line(width: number, s: SheetRun): string {
  const cell = (k: keyof Metrics) => {
    const v = String(s.metrics[k]);
    if (!s.before || s.before[k] === s.metrics[k]) return v.padStart(5);
    return `${v}(${s.before[k]})`.padStart(5);
  };
  const size = `${s.metrics.width}x${s.metrics.height}`.padStart(7);
  return (
    `${s.block.padEnd(width)} ${String(s.detail.input.parts.length).padStart(5)} ` +
    `${String(s.detail.input.nets.length).padStart(5)} ${COLUMNS.map(([, k]) => cell(k)).join(" ")} ` +
    `${size} ${String(Math.round(s.ms)).padStart(6)}`
  );
}

const pt = (p: Pt, off: Pt) => `${p.x + off.x},${p.y + off.y}`;

/** Unrouted messages carry engine coordinates; give them in sheet grid units like the rest. */
function sheetIssue(i: MetricIssue, off: Pt): string {
  const m = /^(.*) \((-?\d+), (-?\d+)\)$/.exec(i.message);
  const text = m ? `${m[1]} (${Number(m[2]) + off.x}, ${Number(m[3]) + off.y})` : i.message;
  return `${i.metric}: ${text}`;
}

function partDetail(s: SheetRun, ref: string): string[] {
  const off = s.detail.offset;
  const parts = s.result.parts.filter((p) => p.ref === ref || p.id === ref);
  if (parts.length === 0) return [`no part ${ref} on ${s.block}`];
  return parts.flatMap((p) => {
    const box = `${pt(p.box, off)} ${p.box.w}x${p.box.h}`;
    const out = [
      `${p.id} ${p.kind}${p.value ? ` ${p.value}` : ""}: at ${pt(p.at, off)} rot ${p.rotation}${p.mirror ? " mirrored" : ""} box ${box} role ${p.role} column ${p.column}`,
    ];
    for (const pin of p.pins) {
      out.push(
        `  pin ${pin.id} ${pin.name} at ${pt(pin.at, off)} out ${pin.outward}${pin.net ? ` net ${pin.net}` : ""}${pin.type === "passive" ? "" : ` ${pin.type}`}`,
      );
    }
    const trace = s.result.trace[p.id] ?? [];
    for (const t of trace) out.push(`  rule ${t.rule}: ${t.note}`);
    if (trace.length === 0) out.push("  (no trace)");
    return out;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) throw new Error(USAGE);
  const base = new Workspace(args.project);
  const ws = args.variant === undefined ? base : await base.variantWorkspace(args.variant);
  if (!ws) throw new Error(`no variant ${args.variant}`);

  const { result, drawing } = await ws.drawing();
  const project = result.config?.name ?? path.basename(ws.root);

  const runs: SheetRun[] = [];
  for (const [block, detail] of drawing.layouts) {
    const instances = drawing.plan.instancesOf(block).map((i) => i.prefix);
    let run: SheetRun = {
      block,
      instances,
      detail,
      result: detail.result,
      ms: detail.ms,
      ...measure(detail.input, detail.result),
    };
    if (args.rules) {
      const overrides = mergeOverrides(detail.overrides, args.rules);
      const start = performance.now();
      const changed = layoutBlock(detail.input, overrides);
      const ms = performance.now() - start;
      const m = measure(detail.input, changed);
      // Offsets differ when the bounds move; recompute as the adapter does.
      const offset = {
        x: detail.offset.x + Math.floor(detail.result.bounds.x) - Math.floor(changed.bounds.x),
        y: detail.offset.y + Math.floor(detail.result.bounds.y) - Math.floor(changed.bounds.y),
      };
      run = {
        ...run,
        detail: { ...detail, offset },
        result: changed,
        ms,
        metrics: m.metrics,
        issues: m.issues,
        before: run.metrics,
      };
    }
    runs.push(run);
  }
  const layoutBugs = drawing.issues.filter((i) => i.code.startsWith("layout."));

  const wanted = args.sheet?.replace(/\/$/, "");
  const chosen =
    wanted === undefined
      ? undefined
      : (runs.find((r) => r.block === wanted) ??
        runs.find((r) => r.instances.some((p) => p === `${wanted}/`)));
  if (wanted !== undefined && !chosen) {
    throw new Error(`no sheet ${wanted}; sheets: ${runs.map((r) => r.block).join(", ")}`);
  }

  if (args.json) {
    const pick = chosen ? [chosen] : runs;
    const out = {
      project,
      sheets: pick.map((s) => ({
        block: s.block,
        instances: s.instances,
        offset: s.detail.offset,
        ms: Math.round(s.ms),
        metrics: s.metrics,
        ...(s.before && { before: s.before }),
        issues: s.issues.map((i) => ({
          metric: i.metric,
          message: sheetIssue(i, s.detail.offset),
        })),
      })),
      layoutBugs: layoutBugs.map((i) => i.message),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const width = Math.max(5, ...runs.map((r) => r.block.length));
  if (!chosen) {
    console.log(
      `${project}: ${runs.length} sheets${args.rules ? " (changed values show the project's own in brackets)" : ""}`,
    );
    console.log(header(width));
    for (const s of runs) console.log(line(width, s));
    const total = (k: keyof Metrics) => runs.reduce((n, s) => n + s.metrics[k], 0);
    console.log(
      `total: ${total("hardFailures")} hard failures, ${total("crossings")} crossings, ` +
        `${total("signalBackwards")} backwards, ${total("shuntMisplaced")} shunts misplaced, ` +
        `${Math.round(runs.reduce((n, s) => n + s.ms, 0))} ms`,
    );
    for (const b of layoutBugs) console.log(`layout bug: ${b.message}`);
    const hard = runs.filter((s) => s.metrics.hardFailures > 0);
    for (const s of hard) {
      for (const i of s.issues.filter((x) => isHard(x.metric))) {
        console.log(`${s.block}: ${sheetIssue(i, s.detail.offset)}`);
      }
    }
    return;
  }

  const s = chosen;
  const off = s.detail.offset;
  const shown = s.instances.map((p) => (p === "" ? "(top)" : p)).join(", ");
  console.log(`${project} sheet ${s.block}, drawn for ${shown}`);
  console.log(header(width));
  console.log(line(width, s));
  if (Object.keys(s.detail.overrides).length > 0 || args.rules) {
    const used = args.rules ? mergeOverrides(s.detail.overrides, args.rules) : s.detail.overrides;
    console.log(`rule overrides: ${JSON.stringify(used)}`);
  }
  for (const b of layoutBugs.filter((x) => x.message.startsWith(`${s.block}:`))) {
    console.log(`layout bug: ${b.message}`);
  }
  if (s.issues.length > 0) {
    console.log(`issues (${s.issues.length}):`);
    for (const i of s.issues) console.log(`  ${sheetIssue(i, off)}`);
  }

  if (args.parts.length > 0) {
    for (const ref of args.parts) for (const l of partDetail(s, ref)) console.log(l);
  } else {
    console.log("parts (ref kind at rotation box role column):");
    for (const p of [...s.result.parts].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)) {
      console.log(
        `  ${p.id} ${p.kind} ${pt(p.at, off)} r${p.rotation}${p.mirror ? "m" : ""} ` +
          `${pt(p.box, off)} ${p.box.w}x${p.box.h} ${p.role} c${p.column}`,
      );
    }
    const nets = new Map<string, number>();
    for (const l of s.result.labels) nets.set(l.kind, (nets.get(l.kind) ?? 0) + 1);
    console.log(
      `${s.result.wires.length} wires, ${s.result.junctions.length} junctions, ` +
        `${s.result.power.length} power symbols, ${nets.get("local") ?? 0} net labels, ` +
        `${nets.get("port") ?? 0} port labels`,
    );
  }

  if (args.grid) console.log(textGrid(s.result, { rulers: off }));

  if (args.caseId !== undefined) {
    const slug = (v: string) => v.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "");
    const id = args.caseId === true ? `${slug(project)}-${slug(s.block)}` : slug(args.caseId);
    const testCase = {
      id,
      category: "Captured",
      title: `${project}: ${s.block}`,
      description: `Sheet ${s.block} of ${project}, captured ${new Date().toISOString().slice(0, 10)}.`,
      input: s.detail.input,
      // The project's preferences, so the tester can reproduce the drawing exactly.
      rules: s.detail.overrides,
    };
    mkdirSync(CAPTURED_DIR, { recursive: true });
    const file = path.join(CAPTURED_DIR, `${id}.json`);
    writeFileSync(file, `${JSON.stringify(testCase, null, 2)}\n`);
    console.log(`saved case ${id} to ${path.relative(process.cwd(), file)}`);
  }
}

const isHard = (m: keyof Metrics) =>
  ["opens", "shorts", "overlaps", "wiresThroughParts", "unrouted", "offGrid"].includes(m);

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
