import { parseCkt } from "../ckt/parser.js";
import { printStatement } from "../ckt/print.js";
import type { TextFile } from "../project/source.js";
import { diffCircuits, opOf, type StatementChange } from "./diff.js";

export interface RevertPlan {
  /** A patch (see docs/ckt-grammar.md) restoring the statements; empty when there is none. */
  patch: string;
  /** Files of added blocks to delete, and of removed blocks to write back. */
  deleteFiles: string[];
  writeFiles: TextFile[];
  /** Items not reverted because the statement has changed again since. */
  conflicts: string[];
  reverted: number;
}

const blockOf = (text: string) => parseCkt(text, "<revert>").ast.block.name;

/** A part or use printed with `[]` when it has no layout hint, so `=` clears a later one. */
function explicitLayout(printed: string): string {
  const { ast } = parseCkt(`block x\n${printed}\n`, "<revert>");
  const part = ast.parts[0];
  const use = ast.uses[0];
  if (part) return printStatement({ kind: "part", decl: part }, true);
  if (use) return printStatement({ kind: "use", decl: use }, true);
  return printed;
}

/**
 * Plans undoing `changes` against the current circuit files. An item is reverted only while its
 * statement still reads as the change left it; otherwise it is reported as a conflict, so a
 * revert never silently discards a later edit. `beforeFiles` supplies the text of blocks that
 * were removed outright.
 */
export function planRevert(
  changes: StatementChange[],
  current: TextFile[],
  beforeFiles: TextFile[],
): RevertPlan {
  const plan: RevertPlan = {
    patch: "",
    deleteFiles: [],
    writeFiles: [],
    conflicts: [],
    reverted: 0,
  };
  const present = new Map(
    diffCircuits([], current).map((c) => [`${c.block}|${c.kind}|${c.key}`, c.after]),
  );
  const now = (block: string, kind: string, key: string) => present.get(`${block}|${kind}|${key}`);
  /** Whether `text` (printed statements) reads the same as `want`, ignoring pin order. */
  const same = (text: string | undefined, want: string | undefined, c: StatementChange) => {
    if (text === undefined || want === undefined) return text === want;
    const probe = (t: string) => [{ file: c.file, text: `block ${c.block}\n${t}\n` }];
    return diffCircuits(probe(text), probe(want)).every((d) => d.kind === "block");
  };

  const wholeBlocks = new Set<string>();
  for (const c of changes) {
    if (c.kind !== "block" || opOf(c) === "~") continue;
    wholeBlocks.add(c.block);
    const file = current.find((f) => f.file === c.file);
    if (opOf(c) === "+") {
      if (!file || blockOf(file.text) !== c.block) {
        plan.conflicts.push(`block ${c.block}: ${c.file} no longer holds it`);
        continue;
      }
      plan.deleteFiles.push(c.file);
    } else {
      const text = beforeFiles.find((f) => f.file === c.file)?.text;
      if (file || text === undefined) {
        plan.conflicts.push(`block ${c.block}: ${c.file} exists again`);
        continue;
      }
      plan.writeFiles.push({ file: c.file, text });
    }
    plan.reverted++;
  }

  const byBlock = new Map<string, string[]>();
  for (const c of changes) {
    if (wholeBlocks.has(c.block)) continue;
    const current = now(c.block, c.kind, c.key);
    if (!same(current, c.after, c)) {
      plan.conflicts.push(`${c.block}: ${c.kind} ${c.key} has changed since`);
      continue;
    }
    const lines = byBlock.get(c.block) ?? [];
    const op = opOf(c);
    if (c.kind === "waive") {
      if (current !== undefined) lines.push(`- waive ${c.key}`);
      for (const w of c.before?.split("\n") ?? []) lines.push(`+ ${w}`);
    } else if (op === "+") {
      lines.push(`- ${c.kind} ${c.key}`);
    } else if (op === "-") {
      lines.push(`+ ${c.before}`);
    } else {
      lines.push(`= ${explicitLayout(c.before as string)}`);
    }
    byBlock.set(c.block, lines);
    plan.reverted++;
  }
  // Restore declarations before the nets that use them and drop added ones after; waivers go
  // last in their own order (each subject's old waivers are removed, then the old ones added).
  const rank = (l: string) =>
    /^[-+=] waive /.test(l)
      ? 3
      : l.startsWith("+ net") || l.startsWith("= net")
        ? 1
        : l.startsWith("-")
          ? 2
          : 0;
  plan.patch = [...byBlock]
    .flatMap(([block, lines]) => [
      `in ${block}`,
      ...lines
        .map((l, i) => ({ l, i }))
        .sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i)
        .map((x) => x.l),
    ])
    .join("\n");
  return plan;
}
