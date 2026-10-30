import type { CktFile } from "./ckt/ast.js";
import { parseCkt } from "./ckt/parser.js";
import { compareIssues, dedupeIssues, type Issue } from "./diagnostics.js";
import { runErc } from "./erc/rules.js";
import { elaborate, type Netlist, type WaiverScope } from "./netlist/elaborate.js";
import { buildLibrary } from "./parts/library.js";
import { type ProjectConfig, parseProjectConfig } from "./project/config.js";
import type { ProjectSource } from "./project/source.js";

export interface ValidationResult {
  /** Unwaived issues, sorted by location. */
  issues: Issue[];
  /** Number of issues suppressed by `waive` statements. */
  waived: number;
  config?: ProjectConfig;
  netlist?: Netlist;
}

/** Parse, elaborate and run structural ERC over a project, then apply waivers. */
export function validateProject(source: ProjectSource): ValidationResult {
  const { config, issues } = parseProjectConfig(source.config.text, source.config.file);

  const blocks: CktFile[] = [];
  for (const f of source.circuits) {
    const parsed = parseCkt(f.text, f.file);
    blocks.push(parsed.ast);
    issues.push(...parsed.issues);
  }

  const { library, issues: libraryIssues } = buildLibrary(source.parts);
  issues.push(...libraryIssues);

  if (!config) return { issues: dedupeIssues(issues).sort(compareIssues), waived: 0 };

  const elaborated = elaborate(blocks, library, config.top);
  issues.push(...elaborated.issues, ...runErc(elaborated.netlist));

  const { kept, waived } = applyWaivers(dedupeIssues(issues), elaborated.waiverScopes);
  return { issues: kept.sort(compareIssues), waived, config, netlist: elaborated.netlist };
}

function globToRegExp(glob: string): RegExp {
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
