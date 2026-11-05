import { printPinRef, printSpec } from "./ckt/print.js";
import { formatIssue, type Issue } from "./diagnostics.js";
import { mergeProjectData, PROJECT_FILE, projectData } from "./project/config.js";
import type { ProjectSource } from "./project/source.js";
import type { TextResult } from "./query.js";
import { parseComments } from "./review.js";
import type { ValidationResult } from "./validate.js";

const MAX_LISTED_ISSUES = 10;

export function countIssues(result: ValidationResult): { errors: number; warnings: number } {
  return {
    errors: result.issues.filter((i) => i.severity === "error").length,
    warnings: result.issues.filter((i) => i.severity === "warning").length,
  };
}

export function issueSummary(result: ValidationResult): string {
  const { errors, warnings } = countIssues(result);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(errors, "error")}, ${plural(warnings, "warning")}${
    result.waived > 0 ? ` (${result.waived} waived)` : ""
  }`;
}

/** One line per issue, then `name: N errors, M warnings`. */
export function formatValidation(result: ValidationResult, fallbackName: string): string {
  const name = result.config?.name ?? fallbackName;
  return [...result.issues.map(formatIssue), `${name}: ${issueSummary(result)}`].join("\n");
}

/** Errors, then warnings, with the often numerous unconnected pins last. */
const importance = (i: Issue) =>
  i.severity === "error" ? 0 : i.code === "erc.unconnected-pin" ? 2 : 1;

/** A hazard from the project file: its text, or `{hazard, accepted}` once the person accepts it. */
function hazardText(h: unknown): string {
  if (typeof h !== "object" || h === null) return String(h);
  const { hazard, accepted } = h as { hazard?: unknown; accepted?: unknown };
  return `${String(hazard)}${accepted === undefined ? "" : ` (accepted: ${String(accepted)})`}`;
}

/** The design context and settings, without the name and the description (prose for people). */
function contextLines(source: ProjectSource): string[] {
  const main = projectData(source.project.text);
  if (!main) return [];
  const over = source.projectOverride && projectData(source.projectOverride.text);
  const fm = over ? mergeProjectData(main, over) : main;
  const lines = [`context: ${String(fm.use_case ?? "(no use_case)")}`];
  for (const [key, value] of Object.entries(fm)) {
    const skip = ["partstyle_version", "name", "description", "use_case", "external_interfaces"];
    if (skip.includes(key)) continue;
    lines.push(`  ${key}: ${JSON.stringify(value)}`);
  }
  const interfaces = Array.isArray(fm.external_interfaces) ? fm.external_interfaces : [];
  for (const i of interfaces as Record<string, unknown>[]) {
    const signal = i.signal === undefined ? "" : ` (${String(i.signal)})`;
    const hazards = Array.isArray(i.hazards)
      ? `; hazards: ${i.hazards.map(hazardText).join(", ")}`
      : "";
    lines.push(
      `  interface ${String(i.connector)}: ${String(i.connects_to ?? "?")}${signal}${hazards}`,
    );
  }
  return lines;
}

/** The cheap first read: blocks, part counts, issues and context in a few hundred tokens. */
export function overview(
  source: ProjectSource,
  result: ValidationResult,
  /** Checkpoint, changes, pending and variant lines from the project's history. */
  versions: string[] = [],
): string {
  const name = result.config?.name ?? `(invalid ${PROJECT_FILE})`;
  const lines = [
    `project ${name}${source.variant === undefined ? "" : `, variant ${source.variant}`}`,
    ...contextLines(source),
  ];

  lines.push("blocks:");
  for (const b of result.blocks) {
    const uses = b.uses.map((u) => `${u.instance}=${u.block}`).join(" ");
    const ports = b.ports.map((p) => p.name).join(" ");
    const desc = b.block.description ? ` "${b.block.description}"` : "";
    lines.push(
      `  ${b.block.name} (${b.file}): ${b.parts.length} parts${ports ? `; ports ${ports}` : ""}${
        uses ? `; uses ${uses}` : ""
      }${desc}`,
    );
  }

  const parts = result.netlist?.parts ?? [];
  const ranked = [...result.issues].sort((a, b) => importance(a) - importance(b));
  const fromLib = parts.filter((p) => p.record);
  const unverified = new Set(
    fromLib.filter((p) => !p.record?.provenance.verified_by).map((p) => p.record?.id),
  );
  lines.push(
    `parts: ${parts.length} (${fromLib.length} library, ${parts.length - fromLib.length} generic; ` +
      `${unverified.size} of ${new Set(fromLib.map((p) => p.record?.id)).size} records unverified)`,
    `nets: ${result.netlist?.nets.length ?? 0}`,
    `issues: ${issueSummary(result)}`,
    ...ranked.slice(0, MAX_LISTED_ISSUES).map((i) => `  ${formatIssue(i)}`),
  );
  if (result.issues.length > MAX_LISTED_ISSUES) {
    lines.push(`  ... ${result.issues.length - MAX_LISTED_ISSUES} more (run validate)`);
  }
  const open = parseComments(source.comments?.text ?? "").filter((c) => c.status === "open");
  if (open.length > 0) {
    lines.push(`comments: ${open.length} open (see focus)`);
    for (const c of open.slice(0, 3)) lines.push(`  ${c.id} on ${c.subject}: ${c.text}`);
  }
  lines.push(...versions);
  return lines.join("\n");
}

/** A block's .ckt text (`full`), or just its ports, parts and net names (`summary`). */
export function readBlock(
  source: ProjectSource,
  result: ValidationResult,
  name: string,
  detail: "summary" | "full",
): TextResult {
  const block = result.blocks.find((b) => b.block.name === name);
  if (!block) {
    const known = result.blocks.map((b) => b.block.name).join(", ");
    return { ok: false, text: `no block '${name}' (blocks: ${known})` };
  }
  if (detail === "full") {
    const text = source.circuits.find((c) => c.file === block.file)?.text ?? "";
    return { ok: true, text: `# ${block.file}\n${text}` };
  }
  const desc = block.block.description ? ` "${block.block.description}"` : "";
  const lines = [
    `block ${name}${desc} (${block.file})`,
    `ports: ${block.ports.map((p) => `${p.name} ${p.kind}`).join(", ") || "(none)"}`,
    block.parts.length === 0 ? "parts: (none)" : "parts:",
    ...block.parts.map(
      (p) => `  ${p.ref} ${printSpec(p.spec)}${p.intent === undefined ? "" : ` @ ${p.intent}`}`,
    ),
    `uses: ${block.uses.map((u) => `${u.instance}=${u.block}`).join(" ") || "(none)"}`,
    `nets: ${block.nets.map((n) => `${n.name}(${n.pins.length})`).join(" ") || "(none)"}`,
  ];
  if (block.ncs.length > 0) lines.push(`nc: ${block.ncs.map((n) => printPinRef(n.pin)).join(" ")}`);
  if (block.waivers.length > 0) lines.push(`waivers: ${block.waivers.length}`);
  return { ok: true, text: lines.join("\n") };
}
