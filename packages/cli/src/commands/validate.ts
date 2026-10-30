import path from "node:path";
import { formatIssue, validateProject } from "@partstyle/engine";
import { loadProject, ProjectLoadError } from "@partstyle/engine/node";
import type { CommandResult } from "./types.js";

export async function validateCommand(
  dir: string,
  opts: { json: boolean },
): Promise<CommandResult> {
  let source: Awaited<ReturnType<typeof loadProject>>;
  try {
    source = await loadProject(dir);
  } catch (e) {
    if (e instanceof ProjectLoadError) return { stdout: "", stderr: e.message, exitCode: 2 };
    throw e;
  }

  const result = validateProject(source);
  const errors = result.issues.filter((i) => i.severity === "error").length;
  const warnings = result.issues.filter((i) => i.severity === "warning").length;
  const exitCode = errors > 0 ? 1 : 0;

  if (opts.json) {
    const out = { errors, warnings, waived: result.waived, issues: result.issues };
    return { stdout: JSON.stringify(out, null, 2), exitCode };
  }

  const name = result.config?.name ?? path.basename(path.resolve(dir));
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const summary = `${name}: ${plural(errors, "error")}, ${plural(warnings, "warning")}${
    result.waived > 0 ? ` (${result.waived} waived)` : ""
  }`;
  return { stdout: [...result.issues.map(formatIssue), summary].join("\n"), exitCode };
}
