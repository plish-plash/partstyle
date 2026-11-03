import { contextChecks } from "./checks/context.js";
import { partChecks } from "./checks/parts.js";
import type { CktFile } from "./ckt/ast.js";
import { parseCkt } from "./ckt/parser.js";
import { compareIssues, dedupeIssues, type Issue } from "./diagnostics.js";
import { runErc } from "./erc/rules.js";
import { elaborate, type Netlist, type WaiverScope } from "./netlist/elaborate.js";
import { buildLibrary, type PartLibrary } from "./parts/library.js";
import { isDraft } from "./parts/schema.js";
import { type ProjectConfig, parseProjectConfig, TOP_BLOCK } from "./project/config.js";
import type { ProjectSource } from "./project/source.js";

export interface ValidationResult {
  /** Unwaived issues, sorted by location. */
  issues: Issue[];
  /** Number of issues suppressed by `waive` statements. */
  waived: number;
  config?: ProjectConfig;
  netlist?: Netlist;
  /** Parsed circuit files, in source order. */
  blocks: CktFile[];
  library: PartLibrary;
}

/** Parse, elaborate and run structural ERC over a project, then apply waivers. */
export function validateProject(source: ProjectSource): ValidationResult {
  const { config, issues } = parseProjectConfig(
    source.project.text,
    source.project.file,
    source.projectOverride,
  );

  const blocks: CktFile[] = [];
  for (const f of source.circuits) {
    const parsed = parseCkt(f.text, f.file);
    blocks.push(parsed.ast);
    issues.push(...parsed.issues);
  }

  const { library, issues: libraryIssues } = buildLibrary(source.parts);
  issues.push(...libraryIssues);

  if (!config) {
    return { issues: dedupeIssues(issues).sort(compareIssues), waived: 0, blocks, library };
  }

  const elaborated = elaborate(blocks, library, TOP_BLOCK);
  issues.push(
    // A variant that stops using one of main's blocks (replacing it with its own) is not
    // warned about it: the block is main's.
    ...elaborated.issues.filter(
      (i) =>
        !(
          source.variant !== undefined &&
          i.code === "elab.unused-block" &&
          i.location?.file.startsWith("circuit/")
        ),
    ),
    ...runErc(elaborated.netlist),
    ...draftIssues(elaborated.netlist, library),
    ...partChecks(elaborated.netlist, { capDerating: config.checks.cap_derating }),
    ...contextChecks(elaborated.netlist, config, source.project.file),
  );

  const { kept, waived } = applyWaivers(dedupeIssues(issues), elaborated.waiverScopes);
  return {
    issues: kept.sort(compareIssues),
    waived,
    config,
    netlist: elaborated.netlist,
    blocks,
    library,
  };
}

/**
 * The unresolved-parts worklist KiCad import leaves: one warning per draft record in use, until
 * the record is completed from a datasheet or the parts are switched to a real record.
 */
function draftIssues(netlist: Netlist, library: PartLibrary): Issue[] {
  const users = new Map<string, string[]>();
  for (const p of netlist.parts) {
    if (p.record && isDraft(p.record)) {
      users.set(p.record.id, [...(users.get(p.record.id) ?? []), p.path]);
    }
  }
  return [...users].map(([id, paths]) => {
    const r = library.get(id);
    const missing = r?.record.mpn ? "" : "no MPN; ";
    return {
      code: "part.draft",
      severity: "warning" as const,
      message:
        `lib:${id} (${paths.join(" ")}) is a draft from KiCad import: ${missing}identify the part, ` +
        "then complete the record from its datasheet (part_put) or use another record",
      location: { file: r?.file ?? "", line: 1, col: 1 },
      subjects: [id, ...paths],
    };
  });
}

/** A waiver subject (`U2.PD*`) as a regular expression. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Removes issues matched by a waiver; reports waivers that matched nothing in any instance. */
export function applyWaivers(
  issues: Issue[],
  scopes: WaiverScope[],
): { kept: Issue[]; waived: number } {
  const matchers = scopes.flatMap((scope) =>
    scope.waivers.map((decl) => ({ decl, pattern: globToRegExp(scope.prefix + decl.subject) })),
  );
  const used = new Set<object>();
  let waived = 0;

  const kept = issues.filter((issue) => {
    if (issue.code.startsWith("parse.")) return true;
    const match = matchers.find(
      ({ decl, pattern }) =>
        (decl.code === undefined || decl.code === issue.code) &&
        issue.subjects.some((s) => pattern.test(s)),
    );
    if (!match) return true;
    used.add(match.decl);
    waived++;
    return false;
  });

  const reported = new Set<object>();
  for (const { decl } of matchers) {
    if (used.has(decl) || reported.has(decl)) continue;
    reported.add(decl);
    kept.push({
      code: "waive.unused",
      severity: "warning",
      message: `waiver for '${decl.subject}'${decl.code ? ` (${decl.code})` : ""} matches no issue; remove it`,
      location: decl.location,
      subjects: [],
    });
  }
  return { kept, waived };
}
