export type Severity = "error" | "warning" | "info";

export interface Location {
  /** Path relative to the project root, with forward slashes. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  col: number;
}

export interface Issue {
  /** Stable machine-readable identifier, e.g. `erc.output-conflict`. */
  code: string;
  severity: Severity;
  message: string;
  location?: Location;
  /** Flat paths of the things the issue concerns (`PWR/U1`, `PWR/U1.IN`, `PWR/+5V`); waivers match these. */
  subjects: string[];
}

/** A subject or pin glob (`U2.PD*`) as a regular expression. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

const severityRank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function compareIssues(a: Issue, b: Issue): number {
  const fa = a.location?.file ?? "";
  const fb = b.location?.file ?? "";
  if (fa !== fb) return fa < fb ? -1 : 1;
  const byLine = (a.location?.line ?? 0) - (b.location?.line ?? 0);
  if (byLine !== 0) return byLine;
  const byCol = (a.location?.col ?? 0) - (b.location?.col ?? 0);
  if (byCol !== 0) return byCol;
  const bySeverity = severityRank[a.severity] - severityRank[b.severity];
  if (bySeverity !== 0) return bySeverity;
  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
}

/** Drops exact duplicates, which arise when a block is instantiated more than once. */
export function dedupeIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const loc = issue.location;
    const key = `${issue.code}|${loc?.file}:${loc?.line}:${loc?.col}|${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Issues present only in `after` (added) or only in `before` (resolved). Matching ignores
 * location, since edits shift line numbers.
 */
export function issueDelta(before: Issue[], after: Issue[]): { added: Issue[]; resolved: Issue[] } {
  const key = (i: Issue) => `${i.code}|${i.severity}|${i.message}`;
  const subtract = (from: Issue[], other: Issue[]) => {
    const counts = new Map<string, number>();
    for (const i of other) counts.set(key(i), (counts.get(key(i)) ?? 0) + 1);
    return from.filter((i) => {
      const n = counts.get(key(i)) ?? 0;
      if (n === 0) return true;
      counts.set(key(i), n - 1);
      return false;
    });
  };
  return { added: subtract(after, before), resolved: subtract(before, after) };
}

export function formatIssue(issue: Issue): string {
  const loc = issue.location;
  const where = loc ? `${loc.file}:${loc.line}:${loc.col} ` : "";
  return `${where}${issue.severity} ${issue.code} ${issue.message}`;
}
