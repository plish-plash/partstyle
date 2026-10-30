import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatIssue, issueDelta } from "../diagnostics.js";
import { parsePartRecord } from "../parts/library.js";
import { describePart, type PartTier, searchParts } from "../parts/search.js";
import { applyPatch } from "../patch.js";
import { runQuery, type TextResult } from "../query.js";
import { type ValidationResult, validateProject } from "../validate.js";
import { countIssues, formatValidation, issueSummary, overview, readBlock } from "../views.js";
import { loadProject, ProjectLoadError } from "./load.js";
import { projectSkeleton } from "./skeleton.js";
import type { ProjectSource } from "./source.js";

const fail = (text: string): TextResult => ({ ok: false, text });

const toPosix = (p: string) => p.split(path.sep).join("/");

const CLAUDE_SIDECAR = "CLAUDE.partstyle.md";

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

const referenceUrl = new URL("../../../../docs/ckt-grammar.md", import.meta.url);

/** The .ckt grammar and patch reference, served to the AI as an MCP resource and by the CLI. */
export async function readGrammarReference(): Promise<string> {
  return readFile(referenceUrl, "utf8");
}

/**
 * Every operation the CLI and the MCP server expose, over one project folder. Each call re-reads
 * the files, since the human or another tool may have edited them in between.
 */
export class Workspace {
  readonly root: string;

  constructor(dir: string) {
    this.root = path.resolve(dir);
  }

  private async load(): Promise<{ source: ProjectSource; result: ValidationResult }> {
    const source = await loadProject(this.root);
    return { source, result: validateProject(source) };
  }

  /** Runs `op`, turning a missing project into a failed result instead of an exception. */
  private async guard(op: () => Promise<TextResult>): Promise<TextResult> {
    try {
      return await op();
    } catch (e) {
      if (e instanceof ProjectLoadError) return fail(e.message);
      throw e;
    }
  }

  /**
   * How to write a path into project.toml: relative when it is near the project (so a repo of
   * projects plus a library can move together), absolute when it is far away, e.g. a shared
   * library elsewhere on disk.
   */
  private storedPath(p: string): string {
    const absolute = path.resolve(this.root, p);
    const relative = path.relative(this.root, absolute);
    const climbs = relative.split(path.sep).filter((s) => s === "..").length;
    return toPosix(path.isAbsolute(relative) || climbs > 2 ? absolute : relative);
  }

  /**
   * Creates a project skeleton in the root folder (created if missing). Refuses if project.toml
   * exists; other existing files are kept, not overwritten. Library paths may be absolute or
   * relative to the project root.
   */
  async init(opts: { name?: string; libraryPaths?: string[] } = {}): Promise<TextResult> {
    if (await exists(path.join(this.root, "project.toml"))) {
      return fail(`${this.root} already has a project.toml`);
    }
    const libraryPaths = (opts.libraryPaths ?? []).map((p) => this.storedPath(p));
    const name = opts.name ?? path.basename(this.root);
    const created: string[] = [];
    const kept: string[] = [];
    const notes: string[] = [];
    for (const f of projectSkeleton({ name, libraryPaths })) {
      let target = f.file;
      if (await exists(path.join(this.root, target))) {
        kept.push(target);
        // Don't lose the AI instructions: write them alongside for the user to import.
        if (target !== "CLAUDE.md" || (await exists(path.join(this.root, CLAUDE_SIDECAR)))) {
          continue;
        }
        target = CLAUDE_SIDECAR;
        notes.push(
          `note: add the line '@${CLAUDE_SIDECAR}' to CLAUDE.md to load the partstyle instructions`,
        );
      }
      const file = path.join(this.root, target);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, f.text, "utf8");
      created.push(target);
    }

    const lines = [`created project ${name} in ${this.root}`, ...created.map((f) => `  ${f}`)];
    for (const f of kept) lines.push(`kept existing ${f}`);
    lines.push(...notes);
    for (const p of libraryPaths) {
      if (!(await exists(path.resolve(this.root, p)))) {
        lines.push(`note: library path ${p} does not exist yet`);
      }
    }
    if (libraryPaths.length === 0) {
      lines.push("note: no global part library; part_put will write to parts/");
    }
    lines.push(
      "next: fill in context.md with the user, then add blocks (partstyle grammar shows how)",
    );
    return { ok: true, text: lines.join("\n") };
  }

  overview(): Promise<TextResult> {
    return this.guard(async () => {
      const { source, result } = await this.load();
      return { ok: true, text: overview(source, result) };
    });
  }

  readBlock(block: string, detail: "summary" | "full" = "full"): Promise<TextResult> {
    return this.guard(async () => {
      const { source, result } = await this.load();
      return readBlock(source, result, block, detail);
    });
  }

  query(expr: string): Promise<TextResult> {
    return this.guard(async () => {
      const { result } = await this.load();
      if (!result.netlist) return fail(`cannot query: ${issueSummary(result)}`);
      return runQuery(result.netlist, expr);
    });
  }

  /** Raw validation result, for callers that want structured issues. */
  async validateResult(): Promise<ValidationResult> {
    return (await this.load()).result;
  }

  /** Terse issue list plus a summary line; `ok` is false when there are errors. */
  validate(): Promise<TextResult> {
    return this.guard(async () => {
      const result = await this.validateResult();
      return {
        ok: countIssues(result).errors === 0,
        text: formatValidation(result, path.basename(this.root)),
      };
    });
  }

  /** Applies a patch atomically and reports only the issues it introduced or resolved. */
  apply(patch: string, opts: { dryRun?: boolean } = {}): Promise<TextResult> {
    return this.guard(async () => {
      const { source, result: before } = await this.load();
      const patched = applyPatch(source, patch);
      if (patched.issues.length > 0) return fail(patched.issues.map(formatIssue).join("\n"));
      if (patched.changed.length === 0) return { ok: true, text: "patch made no changes" };

      const after = validateProject(patched.source);
      const { added, resolved } = issueDelta(before.issues, after.issues);
      if (!opts.dryRun) {
        for (const f of patched.changed) {
          const file = path.join(this.root, f.file);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, f.text, "utf8");
        }
      }
      const n = patched.log.length;
      const lines = [
        `${opts.dryRun ? "dry run, would apply" : "applied"} ${n} edit${n === 1 ? "" : "s"} to ${patched.changed
          .map((f) => f.file)
          .join(", ")}`,
        ...patched.log.map((l) => `  ${l}`),
      ];
      if (added.length > 0) lines.push("new issues:", ...added.map((i) => `  ${formatIssue(i)}`));
      if (resolved.length > 0) {
        lines.push("resolved:", ...resolved.map((i) => `  ${i.code} ${i.message}`));
      }
      lines.push(`now: ${issueSummary(after)}`);
      return { ok: true, text: lines.join("\n") };
    });
  }

  partSearch(query: string): Promise<TextResult> {
    return this.guard(async () => searchParts((await this.load()).result.library, query));
  }

  partGet(id: string, tier: PartTier = "summary"): Promise<TextResult> {
    return this.guard(async () => describePart((await this.load()).result.library, id, tier));
  }

  /**
   * Validates a part record and writes it as `<id>.yaml`, to the first global library path
   * (default when configured) or to the project's parts/ folder.
   */
  partPut(yaml: string, scope?: "global" | "project"): Promise<TextResult> {
    return this.guard(async () => {
      const { result } = await this.load();
      const { record, issues } = parsePartRecord(yaml, "<record>");
      if (!record) return fail(issues.map((i) => i.message).join("\n"));

      const globalPath = result.config?.library.paths[0];
      const where = scope ?? (globalPath === undefined ? "project" : "global");
      if (where === "global" && globalPath === undefined) {
        return fail("no [library] paths in project.toml; use scope project");
      }
      const dir =
        where === "global"
          ? path.resolve(this.root, globalPath as string)
          : path.join(this.root, "parts");
      const file = path.join(dir, `${record.id}.yaml`);
      const existed = result.library.get(record.id)?.layer === where;
      await mkdir(dir, { recursive: true });
      await writeFile(file, yaml.endsWith("\n") ? yaml : `${yaml}\n`, "utf8");

      const rel = toPosix(path.relative(this.root, file));
      const note = record.provenance.verified_by ? "" : "; unverified until a human checks it";
      // TODO(M2): check pad count and numbering against the KiCad footprint.
      return {
        ok: true,
        text: `${existed ? "updated" : "created"} ${rel} (lib:${record.id})${note}`,
      };
    });
  }
}
