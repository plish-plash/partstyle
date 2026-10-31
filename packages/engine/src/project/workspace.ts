import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatBomCsv, resolveBom } from "../bom.js";
import { compareIssues, formatIssue, issueDelta } from "../diagnostics.js";
import { annotate, formatAnnotationLock, parseAnnotationLock } from "../kicad/annotate.js";
import { exportKicad } from "../kicad/export.js";
import { compareNetlists, parseKicadNetlist } from "../kicad/netlist.js";
import { parsePartRecord } from "../parts/library.js";
import { describePart, type PartTier, searchParts } from "../parts/search.js";
import { applyPatch } from "../patch.js";
import { runQuery, type TextResult } from "../query.js";
import { type ValidationResult, validateProject } from "../validate.js";
import { countIssues, formatValidation, issueSummary, overview, readBlock } from "../views.js";
import type { ProjectConfig } from "./config.js";
import {
  checkFootprints,
  findKicad,
  footprintPads,
  type KicadInstall,
  KicadSymbolLibraries,
  parseErcJson,
  runKicadCli,
} from "./kicad.js";
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

  private kicadInstall?: Promise<KicadInstall>;
  /** Indexed lazily on the first export; kept so later exports skip the scan. */
  private symbolLibs?: KicadSymbolLibraries;

  /** KiCad discovery, once per workspace. */
  private kicad(config?: ProjectConfig): Promise<KicadInstall> {
    this.kicadInstall ??= findKicad(this.root, config?.kicad ?? {});
    return this.kicadInstall;
  }

  /** Loads and validates, adding footprint checks for the library parts in use when KiCad is installed. */
  private async load(): Promise<{ source: ProjectSource; result: ValidationResult }> {
    const source = await loadProject(this.root);
    const result = validateProject(source);
    const { footprints } = await this.kicad(result.config);
    if (footprints && result.netlist) {
      const ids = new Set(result.netlist.parts.flatMap((p) => (p.record ? [p.record.id] : [])));
      const entries = [...ids].flatMap((id) => {
        const e = result.library.get(id);
        return e ? [e] : [];
      });
      result.issues = [...result.issues, ...(await checkFootprints(entries, footprints))].sort(
        compareIssues,
      );
    }
    return { source, result };
  }

  private async readOptional(file: string): Promise<string> {
    return readFile(path.join(this.root, file), "utf8").catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return "";
      throw e;
    });
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
      const rel = toPosix(path.relative(this.root, file));
      const { footprints } = await this.kicad(result.config);
      const notes: string[] = [];
      if (footprints) {
        const fpIssues = await checkFootprints(
          [{ record, file: rel, layer: where, text: yaml }],
          footprints,
        );
        const pads = fpIssues.find((i) => i.code === "part.footprint-pads");
        if (pads) return fail(`${pads.message}; not written`);
        notes.push(...fpIssues.map((i) => `warning: ${i.message}`));
      } else {
        notes.push("note: KiCad footprint libraries not found, so pads were not checked");
      }
      if (!record.provenance.verified_by) notes.push("unverified until a human checks it");

      const existed = result.library.get(record.id)?.layer === where;
      await mkdir(dir, { recursive: true });
      await writeFile(file, yaml.endsWith("\n") ? yaml : `${yaml}\n`, "utf8");
      return {
        ok: true,
        text: [`${existed ? "updated" : "created"} ${rel} (lib:${record.id})`, ...notes].join("\n"),
      };
    });
  }

  /**
   * Writes the KiCad project to kicad/ (schematic sheets, symbol library, netlist), updates
   * annotation.lock and bom.lock, then, when kicad-cli is available, re-derives the netlist from
   * the written schematic to prove it matches the design and runs KiCad's ERC. Never touches
   * the .kicad_pcb, and writes the .kicad_pro only if it is missing.
   */
  kicadExport(opts: { check?: boolean } = {}): Promise<TextResult> {
    return this.guard(async () => {
      const { result } = await this.load();
      if (countIssues(result).errors > 0 || !result.netlist || !result.config) {
        return fail(`cannot export with ${issueSummary(result)}; fix the errors first (validate)`);
      }
      const { cli, footprints, symbols } = await this.kicad(result.config);
      if (symbols && this.symbolLibs?.dir !== symbols) {
        this.symbolLibs = new KicadSymbolLibraries(symbols);
      }
      const libs = symbols ? this.symbolLibs : undefined;
      const power = await libs?.library("power");
      const symbolCandidates = await libs?.candidates(result.netlist.parts);
      const x = exportKicad(
        result,
        {
          annotation: await this.readOptional("annotation.lock"),
          bom: await this.readOptional("bom.lock"),
        },
        { ...(power && { power }), ...(symbolCandidates && { symbolCandidates }) },
      );

      const dir = path.join(this.root, KICAD_DIR);
      await mkdir(dir, { recursive: true });
      const lines: string[] = [];
      for (const f of await readdir(dir)) {
        // Sheets for blocks that no longer exist, but only ones partstyle wrote.
        if (!f.endsWith(".kicad_sch") || x.files.has(f)) continue;
        const text = await readFile(path.join(dir, f), "utf8");
        if (text.includes('(generator "partstyle")')) {
          await rm(path.join(dir, f));
          lines.push(`removed stale ${KICAD_DIR}/${f}`);
        }
      }
      for (const [f, text] of x.files) await writeFile(path.join(dir, f), text, "utf8");
      const proFile = path.join(dir, x.projectFile.name);
      if (!(await exists(proFile))) {
        await writeFile(proFile, x.projectFile.text, "utf8");
        lines.push(`created ${KICAD_DIR}/${x.projectFile.name}`);
      }
      await writeFile(path.join(this.root, "annotation.lock"), x.annotationLock, "utf8");
      await writeFile(path.join(this.root, "bom.lock"), x.bom.lock, "utf8");

      const sheets = x.schematic.instances.length;
      lines.unshift(
        `exported ${KICAD_DIR}/: ${x.rootSchematic} (${sheets} sheet${sheets === 1 ? "" : "s"}), ` +
          `partstyle.kicad_sym (${x.schematic.symbols.length} symbols), ${x.netlistFile}`,
      );
      const fromKicad = x.symbols.filter((s) => !s.generated);
      const generated = x.symbols.filter((s) => s.generated);
      if (fromKicad.length > 0) {
        lines.push(
          `KiCad symbols: ${fromKicad
            .map((s) => s.libId)
            .sort()
            .join(", ")}`,
        );
      }
      for (const s of generated) {
        const why =
          s.rejected.length > 0
            ? s.rejected.join("; ")
            : symbols
              ? "no KiCad symbol matches its MPN; set kicad_symbol in the part record"
              : "KiCad symbol libraries not found";
        lines.push(`generated symbol ${s.libId}: ${why}`);
      }
      for (const [p, r] of x.renumbered)
        lines.push(`annotation: ${p} -> ${r} (its refdes was taken)`);
      lines.push(...summarizeLockChanges(x.bom.changes));

      // Footprints the design check did not cover: resolved generics and unresolved chip parts.
      if (footprints) {
        const resolved = new Set(
          x.bom.entries.flatMap((e) => (e.status === "resolved" && e.record ? [e.record.id] : [])),
        );
        const entries = [...resolved].flatMap((id) => {
          const e = result.library.get(id);
          return e ? [e] : [];
        });
        x.issues.push(...(await checkFootprints(entries, footprints)));
        for (const e of x.bom.entries) {
          if (e.status !== "unresolved" || e.footprint === undefined) continue;
          if (!(await footprintPads(footprints, e.footprint))) {
            x.issues.push({
              code: "part.footprint-missing",
              severity: "warning",
              message: `${e.part.path}: footprint ${e.footprint} is not in the KiCad libraries`,
              location: e.part.location,
              subjects: [e.part.path],
            });
          }
        }
      }
      if (x.issues.length > 0) {
        lines.push("issues:", ...x.issues.sort(compareIssues).map((i) => `  ${formatIssue(i)}`));
      }

      let ok = !x.issues.some((i) => i.severity === "error");
      if (opts.check === false) {
        lines.push("checks skipped (--no-check)");
      } else if (!cli) {
        lines.push(
          "KiCad not found: round-trip and ERC skipped (set [kicad] cli in project.toml or KICAD_CLI)",
        );
      } else {
        const tmp = await mkdtemp(path.join(tmpdir(), "partstyle-"));
        const root = path.join(dir, x.rootSchematic);
        try {
          const net = path.join(tmp, "roundtrip.net");
          await runKicadCli(cli, [
            "sch",
            "export",
            "netlist",
            "--format",
            "kicadsexpr",
            "-o",
            net,
            root,
          ]);
          const diffs = compareNetlists(
            result.netlist,
            x.annotation,
            parseKicadNetlist(await readFile(net, "utf8")),
          );
          if (diffs.length === 0) {
            lines.push(`round-trip: KiCad's netlist from the schematic matches the design`);
          } else {
            ok = false;
            lines.push("round-trip MISMATCH (an exporter bug):", ...diffs.map((d) => `  ${d}`));
          }

          const erc = path.join(tmp, "erc.json");
          await runKicadCli(cli, [
            "sch",
            "erc",
            "--format",
            "json",
            "--severity-all",
            "-o",
            erc,
            root,
          ]);
          const violations = parseErcJson(await readFile(erc, "utf8"));
          const errs = violations.filter((v) => v.severity === "error").length;
          lines.push(`KiCad ERC: ${errs} errors, ${violations.length - errs} warnings`);
          for (const v of violations) {
            lines.push(
              `  ${v.severity} ${v.type} on ${v.sheet}: ${v.description}${v.items.length ? ` (${v.items.join("; ")})` : ""}`,
            );
          }
          if (errs > 0) ok = false;
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      }
      lines.push(
        `next: open ${KICAD_DIR}/${x.projectFile.name}; in the PCB editor use Tools > Update PCB from Schematic`,
      );
      return { ok, text: lines.join("\n") };
    });
  }

  /** Resolves generic parts against the library, writes bom.lock and a grouped bom.csv. */
  bomExport(): Promise<TextResult> {
    return this.guard(async () => {
      const { result } = await this.load();
      if (!result.netlist || !result.config)
        return fail(`cannot build a BOM: ${issueSummary(result)}`);
      const { table } = annotate(
        result.netlist.parts.map((p) => p.path),
        parseAnnotationLock(await this.readOptional("annotation.lock")),
      );
      const preferred = result.config.sourcing.distributors;
      const bom = resolveBom(
        result.netlist,
        result.library,
        await this.readOptional("bom.lock"),
        preferred,
      );
      const csv = formatBomCsv(bom.entries, (p) => table.get(p) ?? p, preferred);
      await writeFile(path.join(this.root, "annotation.lock"), formatAnnotationLock(table), "utf8");
      await writeFile(path.join(this.root, "bom.lock"), bom.lock, "utf8");
      await writeFile(path.join(this.root, "bom.csv"), csv, "utf8");

      const count = (s: string) => bom.entries.filter((e) => e.status === s).length;
      const lines = [
        `wrote bom.csv: ${csv.trimEnd().split("\n").length - 1} lines for ${bom.entries.length} parts ` +
          `(${count("library")} library, ${count("resolved")} resolved generics, ${count("unresolved")} unresolved)`,
        ...summarizeLockChanges(bom.changes),
        ...bom.issues.map((i) => formatIssue(i)),
      ];
      if (preferred.length === 0) {
        lines.push(
          "note: no preferred distributors in project.toml [sourcing]; none were used to rank parts",
        );
      }
      return { ok: true, text: lines.join("\n") };
    });
  }
}

const KICAD_DIR = "kicad";

function summarizeLockChanges(changes: string[]): string[] {
  if (changes.length === 0) return [];
  const shown = changes.slice(0, 10).map((c) => `  ${c}`);
  if (changes.length > 10) shown.push(`  ... ${changes.length - 10} more (see bom.lock)`);
  return [`bom.lock: ${changes.length} change${changes.length === 1 ? "" : "s"}`, ...shown];
}
