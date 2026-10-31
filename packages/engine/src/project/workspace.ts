import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatBomCsv, resolveBom } from "../bom.js";
import { compareIssues, formatIssue, issueDelta } from "../diagnostics.js";
import { type KicadLibraries, prepareDrawing } from "../drawing/prepare.js";
import { annotate, formatAnnotationLock, parseAnnotationLock } from "../kicad/annotate.js";
import { exportKicad } from "../kicad/export.js";
import { compareNetlists, parseKicadNetlist } from "../kicad/netlist.js";
import { parsePartRecord } from "../parts/library.js";
import { describePart, type PartTier, searchParts } from "../parts/search.js";
import { applyPatch } from "../patch.js";
import { runQuery, type TextResult } from "../query.js";
import {
  COMMENTS_FILE,
  type Comment,
  FOCUS_FILE,
  type Focus,
  focusText,
  formatComments,
  nextCommentId,
  parseComments,
  parseFocus,
} from "../review.js";
import { type ValidationResult, validateProject } from "../validate.js";
import { describeChange, diffCircuits, formatChanges, opOf } from "../versions/diff.js";
import { planRevert, type RevertPlan } from "../versions/revert.js";
import { buildViewerModel, type VersionState, type ViewerModel } from "../viewer-model.js";
import { countIssues, formatValidation, issueSummary, overview, readBlock } from "../views.js";
import { type ProjectConfig, parseProjectConfig } from "./config.js";
import { filesAt, git, lastCommit, repoInfo } from "./git.js";
import { type ChangeSource, changesOf, History, readCircuits, toFiles } from "./history.js";
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
import { addPending, readPending, removePending } from "./pending.js";
import { projectSkeleton } from "./skeleton.js";
import type { ProjectSource } from "./source.js";
import {
  adoptVariant,
  checkVariantName,
  createVariant,
  listVariants,
  removeVariant,
  type Variant,
} from "./variants.js";

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
  /** The changeset log since the last checkpoint. */
  readonly history: History;

  constructor(dir: string) {
    this.root = path.resolve(dir);
    this.history = new History(this.root);
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
    // Edits made since the last call (by anyone) become a changeset before anything else runs.
    await this.history.record();
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

  /** KiCad's power library and symbol candidates for the parts in use, when KiCad is installed. */
  private async libraries(result: ValidationResult): Promise<KicadLibraries> {
    const { symbols } = await this.kicad(result.config);
    if (!symbols || !result.netlist) return {};
    if (this.symbolLibs?.dir !== symbols) this.symbolLibs = new KicadSymbolLibraries(symbols);
    const power = await this.symbolLibs.library("power");
    const symbolCandidates = await this.symbolLibs.candidates(result.netlist.parts);
    return { ...(power && { power }), symbolCandidates };
  }

  private async locks(): Promise<{ annotation: string; bom: string }> {
    return {
      annotation: await this.readOptional("annotation.lock"),
      bom: await this.readOptional("bom.lock"),
    };
  }

  /** Review comments and the viewer selection, read fresh (they are small and change often). */
  async review(): Promise<{ comments: Comment[]; focus: Focus }> {
    return {
      comments: parseComments(await this.readOptional(COMMENTS_FILE)),
      focus: parseFocus(await this.readOptional(FOCUS_FILE)),
    };
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
    // Checkpoints are git commits; a project already inside a repository uses that one.
    if (!(await repoInfo(this.root))) {
      try {
        await git(this.root, ["init", "-q"]);
        lines.push("initialized a git repository for checkpoints");
      } catch (e) {
        lines.push(`note: no git repository, so no checkpoints (${(e as Error).message})`);
      }
    }
    lines.push(
      "next: fill in context.md with the user, then add blocks (partstyle grammar shows how)",
    );
    return { ok: true, text: lines.join("\n") };
  }

  overview(): Promise<TextResult> {
    return this.guard(async () => {
      const { source, result } = await this.load();
      return { ok: true, text: overview(source, result, await this.versionLines()) };
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

  /**
   * Applies a patch atomically and reports only the issues it introduced or resolved. The edit
   * is logged as its own changeset; in accept mode it is held as a pending change instead.
   */
  apply(patch: string, opts: { dryRun?: boolean } = {}): Promise<TextResult> {
    return this.guard(() =>
      this.applyPatchText(patch, { dryRun: opts.dryRun ?? false, hold: true, source: "apply" }),
    );
  }

  private async applyPatchText(
    patch: string,
    opts: { dryRun: boolean; hold: boolean; source: ChangeSource; note?: string },
  ): Promise<TextResult> {
    const { source, result: before } = await this.load();
    const patched = applyPatch(source, patch);
    if (patched.issues.length > 0) return fail(patched.issues.map(formatIssue).join("\n"));
    if (patched.changed.length === 0) return { ok: true, text: "patch made no changes" };

    const after = validateProject(patched.source);
    const { added, resolved } = issueDelta(before.issues, after.issues);
    const held = opts.hold && !opts.dryRun && before.config?.review.mode === "accept";
    let pendingId: string | undefined;
    if (held) {
      pendingId = await addPending(this.root, patch, patched.log);
    } else if (!opts.dryRun) {
      for (const f of patched.changed) {
        const file = path.join(this.root, f.file);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, f.text, "utf8");
      }
      await this.history.record(opts.source, opts.note ?? patched.log.join("\n"));
    }
    const n = patched.log.length;
    const verb = opts.dryRun
      ? "dry run, would apply"
      : held
        ? `held as ${pendingId} for review; would apply`
        : "applied";
    const lines = [
      `${verb} ${n} edit${n === 1 ? "" : "s"} to ${patched.changed.map((f) => f.file).join(", ")}`,
      ...patched.log.map((l) => `  ${l}`),
    ];
    if (added.length > 0) lines.push("new issues:", ...added.map((i) => `  ${formatIssue(i)}`));
    if (resolved.length > 0) {
      lines.push("resolved:", ...resolved.map((i) => `  ${i.code} ${i.message}`));
    }
    if (held) {
      lines.push(
        `the files are unchanged until the person accepts ${pendingId} in the viewer (review mode: accept)`,
      );
    } else {
      lines.push(`now: ${issueSummary(after)}`);
    }
    return { ok: true, text: lines.join("\n") };
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
      const x = await exportKicad(result, await this.locks(), await this.libraries(result));

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

  /** What the person has selected in the viewer, and the open review comments. */
  focus(): Promise<TextResult> {
    return this.guard(async () => {
      const { result } = await this.load();
      const { comments, focus } = await this.review();
      let url: string | undefined;
      try {
        url = (JSON.parse(await this.readOptional(VIEWER_FILE)) as { url?: string }).url;
      } catch {
        url = undefined;
      }
      return { ok: true, text: focusText(focus, comments, result.netlist, url) };
    });
  }

  /** Absolute paths of the global part libraries in project.toml, for watching. */
  async libraryDirs(): Promise<string[]> {
    const text = await this.readOptional("project.toml");
    const paths = parseProjectConfig(text, "project.toml").config?.library.paths ?? [];
    return paths.map((p) => path.resolve(this.root, p));
  }

  /** Records the viewer's selection for `focus` (and other processes) to read. */
  async setFocus(focus: Focus): Promise<void> {
    await this.writeState(
      FOCUS_FILE,
      `${JSON.stringify({ ...focus, updated: new Date().toISOString() }, null, 2)}\n`,
    );
  }

  /** Where a running viewer can be reached, for `focus` to mention. */
  async setViewerUrl(url: string | undefined): Promise<void> {
    if (url === undefined) await rm(path.join(this.root, VIEWER_FILE), { force: true });
    else await this.writeState(VIEWER_FILE, `${JSON.stringify({ url, pid: process.pid })}\n`);
  }

  private async writeState(file: string, text: string): Promise<void> {
    const full = path.join(this.root, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, text, "utf8");
  }

  async addComment(subject: string, text: string): Promise<Comment> {
    const { comments } = await this.review();
    const comment: Comment = {
      id: nextCommentId(comments),
      subject,
      text: text.trim(),
      status: "open",
      created: new Date().toISOString(),
    };
    await writeFile(
      path.join(this.root, COMMENTS_FILE),
      formatComments([...comments, comment]),
      "utf8",
    );
    return comment;
  }

  async resolveComment(id: string): Promise<TextResult> {
    const { comments } = await this.review();
    const c = comments.find((x) => x.id === id);
    if (!c) return fail(`no comment ${id}`);
    c.status = "resolved";
    await writeFile(path.join(this.root, COMMENTS_FILE), formatComments(comments), "utf8");
    return { ok: true, text: `resolved ${id}` };
  }

  /** Marks a part record checked against its datasheet (`verified_by: human`). */
  verifyPart(id: string): Promise<TextResult> {
    return this.guard(async () => {
      const { result } = await this.load();
      const entry = result.library.get(id);
      if (!entry) return fail(`no part '${id}' in the library`);
      if (entry.record.provenance.verified_by)
        return { ok: true, text: `${id} is already verified` };
      const file = path.resolve(this.root, entry.file);
      const text = await readFile(file, "utf8");
      const updated = text.replace(/verified_by:\s*null/, "verified_by: human");
      if (updated === text) return fail(`could not find 'verified_by: null' in ${entry.file}`);
      await writeFile(file, updated, "utf8");
      return { ok: true, text: `marked ${id} verified in ${entry.file}` };
    });
  }

  /**
   * Everything the viewer draws: the laid-out sheets, symbols, parts, nets, issues and review
   * state. A design that does not elaborate still gets its issues, with no sheets.
   */
  async viewerModel(opts: { preview?: string } = {}): Promise<ViewerModel> {
    const loaded = await this.load();
    let { result } = loaded;
    // A pending change is previewed by drawing the design as if it were accepted.
    let preview: ViewerModel["preview"];
    const pending = opts.preview
      ? (await readPending(this.root)).find((p) => p.id === opts.preview)
      : undefined;
    if (pending) {
      const patched = applyPatch(loaded.source, pending.patch);
      if (patched.issues.length === 0) {
        result = validateProject(patched.source);
        preview = {
          id: pending.id,
          changed: diffCircuits(loaded.source.circuits, patched.source.circuits).map((c) => ({
            block: c.block,
            kind: c.kind,
            key: c.key,
            op: opOf(c),
          })),
        };
      }
    }
    const model = await this.drawModel(result);
    return preview ? { ...model, preview } : model;
  }

  private async drawModel(result: ValidationResult): Promise<ViewerModel> {
    const review = await this.review();
    const { errors, warnings } = countIssues(result);
    const empty: ViewerModel = {
      project: result.config?.name ?? path.basename(this.root),
      top: result.config?.top ?? "main",
      summary: { errors, warnings, waived: result.waived },
      issues: result.issues,
      sheets: [],
      symbols: {},
      parts: {},
      nets: {},
      ...review,
    };
    if (!result.netlist || !result.config) return empty;
    try {
      const drawing = await prepareDrawing(
        result,
        await this.locks(),
        await this.libraries(result),
      );
      return buildViewerModel(drawing, result, review);
    } catch (e) {
      return {
        ...empty,
        issues: [
          ...result.issues,
          {
            code: "layout.failed",
            severity: "error",
            message: `could not draw the design: ${(e as Error).message}`,
            subjects: [],
          },
        ],
      };
    }
  }

  // --- Review and versioning -------------------------------------------------------------

  /** The circuit at the last checkpoint, or where the change log starts when there is no git. */
  private async baseCircuits(): Promise<{ files: Record<string, string>; label: string }> {
    const cp = await lastCommit(this.root);
    if (cp) {
      return {
        files: Object.fromEntries(await filesAt(this.root, cp.id, "circuit")),
        label: `checkpoint ${cp.id.slice(0, 7)} "${cp.message}" (${cp.date.slice(0, 16).replace("T", " ")})`,
      };
    }
    const { changesets } = await this.history.changesets();
    const files: Record<string, string> = await readCircuits(this.root);
    // Undo the log, newest first, so each file ends at its earliest recorded text.
    for (const c of [...changesets].reverse()) {
      for (const [p, t] of Object.entries(c.before)) {
        if (t === null) delete files[p];
        else files[p] = t;
      }
    }
    return { files, label: "the start of the change log (no checkpoints: not a git repository)" };
  }

  /** Checkpoint, changesets, pending changes and variants, for the viewer's review panel. */
  async versionState(): Promise<VersionState> {
    const config = parseProjectConfig(await this.readOptional("project.toml"), "project.toml");
    const info = await repoInfo(this.root);
    const cp = await lastCommit(this.root);
    const { changesets } = await this.history.changesets();
    const base = await this.baseCircuits();
    const now = await readCircuits(this.root);
    return {
      git: info !== undefined,
      mode: config.config?.review.mode ?? "auto",
      ...(cp && { checkpoint: { id: cp.id.slice(0, 7), message: cp.message, date: cp.date } }),
      changesets: changesets.map((cs) => ({
        id: cs.id,
        source: cs.source,
        ...(cs.note !== undefined && cs.source !== "apply" && { note: cs.note }),
        time: cs.time,
        items: changesOf(cs).map((c, i) => ({
          id: `${cs.id}.${i + 1}`,
          block: c.block,
          kind: c.kind,
          key: c.key,
          op: opOf(c),
          text: describeChange(c),
        })),
      })),
      pending: (await readPending(this.root)).map((p) => ({
        id: p.id,
        created: p.created,
        log: p.log,
      })),
      changed: diffCircuits(toFiles(base.files), toFiles(now)).map((c) => ({
        block: c.block,
        kind: c.kind,
        key: c.key,
        op: opOf(c),
      })),
      variants: info ? (await listVariants(this.root, info)).map((v) => v.name) : [],
    };
  }

  /** The overview's lines about checkpoints, changes, pending patches and variants. */
  private async versionLines(): Promise<string[]> {
    const st = await this.versionState();
    const n = st.changed.length;
    const summary =
      n === 0 ? "none" : `${n} statements in ${st.changesets.length} changesets (see diff)`;
    const lines = [
      !st.git
        ? `changes: ${summary}; no checkpoints (not a git repository)`
        : st.checkpoint
          ? `changes since checkpoint ${st.checkpoint.id} "${st.checkpoint.message}": ${summary}`
          : `changes: ${summary}; no checkpoint yet`,
    ];
    if (st.mode === "accept") {
      lines.push("review mode: accept (edit only through apply; each patch waits for approval)");
    }
    if (st.pending.length > 0) {
      lines.push(`pending review: ${st.pending.map((p) => p.id).join(", ")}`);
    }
    if (st.variants.length > 0) lines.push(`variants: ${st.variants.join(", ")}`);
    return lines;
  }

  /**
   * The circuit changes, statement by statement, since `since`: "checkpoint" (the last one),
   * "last" (the previous diff call, to catch up between turns) or a checkpoint id.
   */
  diff(since = "checkpoint"): Promise<TextResult> {
    return this.guard(async () => {
      await this.load();
      const now = await readCircuits(this.root);
      const seen = await this.history.swapSeen(now);
      let base: Record<string, string>;
      let label: string;
      if (since === "last" && seen) {
        base = seen;
        label = "the last diff";
      } else if (since === "checkpoint" || since === "last") {
        ({ files: base, label } = await this.baseCircuits());
      } else {
        try {
          base = Object.fromEntries(await filesAt(this.root, since, "circuit"));
        } catch (e) {
          return fail(`unknown checkpoint '${since}': ${(e as Error).message}`);
        }
        label = `checkpoint ${since}`;
      }
      const changes = diffCircuits(toFiles(base), toFiles(now));
      const lines =
        changes.length === 0
          ? [`no circuit changes since ${label}`]
          : [`since ${label}:`, ...formatChanges(changes)];
      if (since === "checkpoint" && (await lastCommit(this.root))) {
        const other = await this.otherChangedFiles();
        if (other.length > 0) lines.push(`other files changed: ${other.join(", ")}`);
      }
      return { ok: true, text: lines.join("\n") };
    });
  }

  /** Files outside circuit/ changed since the checkpoint (context, parts, notes, locks). */
  private async otherChangedFiles(): Promise<string[]> {
    const spec = ["--", ".", ":(exclude)circuit", ":(exclude).partstyle", ":(exclude)kicad"];
    const changed = await git(this.root, ["diff", "--name-only", "--relative", "HEAD", ...spec]);
    const added = await git(this.root, ["ls-files", "-o", "--exclude-standard", ...spec]);
    return [...new Set(`${changed}\n${added}`.split("\n").filter(Boolean))].sort();
  }

  /** The changesets since the last checkpoint with numbered statements, and pending patches. */
  changes(): Promise<TextResult> {
    return this.guard(async () => {
      await this.load();
      const st = await this.versionState();
      const time = (t: string) => new Date(t).toTimeString().slice(0, 5);
      const lines = [
        st.checkpoint
          ? `since checkpoint ${st.checkpoint.id} "${st.checkpoint.message}":`
          : "since the start of the change log:",
      ];
      if (st.changesets.length === 0) lines.push("  no changesets");
      for (const cs of st.changesets) {
        lines.push(`${cs.id} ${cs.source} ${time(cs.time)}${cs.note ? ` (${cs.note})` : ""}`);
        for (const i of cs.items) lines.push(`  ${i.id} ${i.block}: ${i.text}`);
      }
      if (st.pending.length > 0) {
        lines.push(
          "pending (accept or reject in the viewer, or: partstyle pending accept|reject ID):",
        );
        for (const p of st.pending) {
          lines.push(`${p.id} ${time(p.created)}`, ...p.log.map((l) => `  ${l}`));
        }
      }
      lines.push("revert with: partstyle revert C2 (a changeset) or C2.1 (one statement)");
      return { ok: true, text: lines.join("\n") };
    });
  }

  /** Writes a planned revert to disk; returns an error message if its patch does not apply. */
  private async carryOut(plan: RevertPlan): Promise<string | undefined> {
    if (plan.patch) {
      const patched = applyPatch(await loadProject(this.root), plan.patch);
      if (patched.issues.length > 0) return patched.issues.map(formatIssue).join("\n");
      for (const f of patched.changed) {
        await mkdir(path.dirname(path.join(this.root, f.file)), { recursive: true });
        await writeFile(path.join(this.root, f.file), f.text, "utf8");
      }
    }
    for (const f of plan.deleteFiles) await rm(path.join(this.root, f), { force: true });
    for (const f of plan.writeFiles) {
      await mkdir(path.dirname(path.join(this.root, f.file)), { recursive: true });
      await writeFile(path.join(this.root, f.file), f.text, "utf8");
    }
    return undefined;
  }

  /**
   * Undoes a changeset (`C3`) or one of its statements (`C3.2`). Statements changed again since
   * are left alone and reported. The revert is itself a changeset, so it can be undone too.
   */
  revert(id: string): Promise<TextResult> {
    return this.guard(async () => {
      const m = /^(C\d+)(?:\.(\d+))?$/.exec(id.trim());
      if (!m) return fail("usage: revert C3 (a changeset) or C3.2 (one statement); see changes");
      await this.load();
      const { changesets } = await this.history.changesets();
      const cs = changesets.find((c) => c.id === m[1]);
      if (!cs) return fail(`no changeset ${m[1]} since the last checkpoint (see changes)`);
      const all = changesOf(cs);
      const items = m[2] === undefined ? all : all.slice(Number(m[2]) - 1, Number(m[2]));
      if (items.length === 0) return fail(`${cs.id} has no statement ${m[2]}`);

      const plan = planRevert(items, toFiles(await readCircuits(this.root)), toFiles(cs.before));
      const conflicts = plan.conflicts.map((c) => `  not reverted: ${c}`);
      if (plan.reverted === 0) return fail(["nothing reverted", ...conflicts].join("\n"));
      const error = await this.carryOut(plan);
      if (error) return fail(`revert failed, nothing changed:\n${error}`);
      const logged = await this.history.record("revert", `reverted ${id.trim()}`);
      const n = plan.reverted;
      return {
        ok: true,
        text: [
          `reverted ${id.trim()}: ${n} statement${n === 1 ? "" : "s"}${logged ? ` (as ${logged.id})` : ""}`,
          ...conflicts,
        ].join("\n"),
      };
    });
  }

  /** Commits the project folder as a checkpoint: the person's approval of the changes so far. */
  checkpoint(message: string): Promise<TextResult> {
    return this.guard(async () => {
      if (!message.trim()) return fail("a checkpoint needs a message");
      await this.load();
      if (!(await repoInfo(this.root))) {
        return fail(
          "not in a git repository: run 'git init' in the project (or a parent folder) to enable checkpoints",
        );
      }
      const st = await this.versionState();
      // Local state stays out of checkpoints; naming it when git already ignores it is an error.
      const ignored = await git(this.root, ["check-ignore", "-q", ".partstyle"]).then(
        () => true,
        () => false,
      );
      const spec = ["--", ".", ...(ignored ? [] : [":(exclude).partstyle"])];
      if (!(await git(this.root, ["status", "--porcelain", ...spec])).trim()) {
        return { ok: true, text: "nothing to checkpoint: no changes since the last checkpoint" };
      }
      try {
        await git(this.root, ["add", "-A", ...spec]);
        await git(this.root, ["commit", "-q", "-m", message.trim(), ...spec]);
      } catch (e) {
        return fail(`git could not commit: ${(e as Error).message}`);
      }
      await this.history.restart();
      const cp = await lastCommit(this.root);
      const n = st.changed.length;
      const what = st.checkpoint
        ? `${n} statement change${n === 1 ? "" : "s"} in ${st.changesets.length} changeset${st.changesets.length === 1 ? "" : "s"}`
        : "the project's first checkpoint";
      return { ok: true, text: `checkpoint ${cp?.id.slice(0, 7)} "${message.trim()}": ${what}` };
    });
  }

  /** The project's recent checkpoints, newest first. */
  checkpoints(): Promise<TextResult> {
    return this.guard(async () => {
      await this.load();
      if (!(await repoInfo(this.root))) return fail("not in a git repository: no checkpoints");
      const out = await git(this.root, ["log", "-n", "20", "--format=%h%x09%cI%x09%s", "--", "."]);
      const lines = out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [id, date, ...msg] = l.split("\t");
          return `${id} ${date?.slice(0, 16).replace("T", " ")} ${msg.join("\t")}`;
        });
      return { ok: true, text: lines.length > 0 ? lines.join("\n") : "no checkpoints yet" };
    });
  }

  /** Accepts a pending patch: applies it now, as a changeset of its own. */
  pendingAccept(id: string): Promise<TextResult> {
    return this.guard(async () => {
      const list = await readPending(this.root);
      const p = list.find((x) => x.id === id);
      if (!p) return fail(`no pending change ${id}`);
      const r = await this.applyPatchText(p.patch, {
        dryRun: false,
        hold: false,
        source: "accept",
        note: `accepted ${id}`,
      });
      if (!r.ok) return fail(`${id} no longer applies, so it stays pending:\n${r.text}`);
      await removePending(this.root, id);
      return { ok: true, text: `accepted ${id}\n${r.text}` };
    });
  }

  pendingReject(id: string): Promise<TextResult> {
    return this.guard(async () => {
      if (!(await removePending(this.root, id))) return fail(`no pending change ${id}`);
      return { ok: true, text: `rejected ${id}` };
    });
  }

  private async findVariant(name: string): Promise<Variant | string> {
    const info = await repoInfo(this.root);
    if (!info) return "not in a git repository: variants need git";
    const v = (await listVariants(this.root, info)).find((x) => x.name === name);
    return v ?? `no variant '${name}' (see variant list)`;
  }

  /** A workspace for a variant's working copy, for the viewer. */
  async variantWorkspace(name: string): Promise<Workspace | undefined> {
    const v = await this.findVariant(name);
    return typeof v === "string" ? undefined : new Workspace(v.dir);
  }

  /**
   * Variants are parallel versions of the design on their own git branches, each checked out
   * under .partstyle/variants/. list, create NAME and diff NAME are for anyone; adopt NAME
   * (copy a variant's design over the main line, as one changeset) and remove NAME are the
   * person's decisions.
   */
  variant(op: "list" | "create" | "diff" | "adopt" | "remove", name?: string): Promise<TextResult> {
    return this.guard(async () => {
      await this.load();
      const info = await repoInfo(this.root);
      if (!info) return fail("not in a git repository: variants need git (run 'git init')");
      if (op === "list") {
        const vs = await listVariants(this.root, info);
        if (vs.length === 0)
          return { ok: true, text: "no variants (create one with: variant create NAME)" };
        const now = toFiles(await readCircuits(this.root));
        const lines = [];
        for (const v of vs) {
          const n = diffCircuits(now, toFiles(await readCircuits(v.dir))).length;
          const rel = toPosix(path.relative(this.root, v.dir));
          lines.push(
            `${v.name}: ${n === 0 ? "same as main" : `${n} statements differ from main`} (${rel})`,
          );
        }
        return { ok: true, text: lines.join("\n") };
      }
      if (name === undefined) return fail(`usage: variant ${op} NAME`);
      if (op === "create") {
        const bad = checkVariantName(name);
        if (bad) return fail(bad);
        if (typeof (await this.findVariant(name)) !== "string") {
          return fail(`variant '${name}' already exists`);
        }
        try {
          const { variant: v, ignoredNow } = await createVariant(this.root, info, name);
          const cp = await lastCommit(this.root);
          const rel = toPosix(path.relative(this.root, v.dir));
          return {
            ok: true,
            text: [
              `created variant ${name} at ${rel} (branch ${v.branch}) from checkpoint ${cp?.id.slice(0, 7) ?? "HEAD"}`,
              "changes not yet checkpointed are not in it",
              `edit it with: partstyle -p ${rel} ...; compare with: variant diff ${name}`,
              ...(ignoredNow ? ["added .partstyle/ to .gitignore"] : []),
            ].join("\n"),
          };
        } catch (e) {
          return fail((e as Error).message);
        }
      }
      const v = await this.findVariant(name);
      if (typeof v === "string") return fail(v);
      if (op === "diff") {
        const changes = diffCircuits(
          toFiles(await readCircuits(this.root)),
          toFiles(await readCircuits(v.dir)),
        );
        return {
          ok: true,
          text:
            changes.length === 0
              ? `variant ${name} has the same circuit as the main line`
              : [`main line -> variant ${name}:`, ...formatChanges(changes)].join("\n"),
        };
      }
      if (op === "adopt") {
        const files = await adoptVariant(this.root, v);
        if (files.length === 0) return { ok: true, text: `variant ${name} matches the main line` };
        const logged = await this.history.record("adopt", `adopted variant ${name}`);
        return {
          ok: true,
          text: [
            `adopted variant ${name}${logged ? ` as ${logged.id}` : ""}: ${files.join(", ")}`,
            "review it, then checkpoint (the variant itself is kept until removed)",
          ].join("\n"),
        };
      }
      await removeVariant(this.root, v);
      return { ok: true, text: `removed variant ${name} and its branch ${v.branch}` };
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
const VIEWER_FILE = ".partstyle/viewer.json";

function summarizeLockChanges(changes: string[]): string[] {
  if (changes.length === 0) return [];
  const shown = changes.slice(0, 10).map((c) => `  ${c}`);
  if (changes.length > 10) shown.push(`  ... ${changes.length - 10} more (see bom.lock)`);
  return [`bom.lock: ${changes.length} change${changes.length === 1 ? "" : "s"}`, ...shown];
}
