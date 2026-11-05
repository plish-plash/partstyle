import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isMap, parseDocument, parse as parseYaml } from "yaml";
import {
  APPROVALS_FILE,
  type Approvals,
  approvalStatus,
  formatApprovals,
  parseApprovals,
  partSnapshot,
} from "../approvals.js";
import { formatBomCsv, resolveBom } from "../bom.js";
import type { LayoutHint } from "../ckt/ast.js";
import { printStatement } from "../ckt/print.js";
import { compareIssues, formatIssue, issueDelta } from "../diagnostics.js";
import type { Rotation } from "../drawing/orient.js";
import { type KicadLibraries, prepareDrawing } from "../drawing/prepare.js";
import { annotate, formatAnnotationLock, parseAnnotationLock } from "../kicad/annotate.js";
import { exportKicad } from "../kicad/export.js";
import { buildImport } from "../kicad/import.js";
import { compareNetlists, parseKicadNetlist } from "../kicad/netlist.js";
import { parsePartRecord } from "../parts/library.js";
import { isDraft } from "../parts/schema.js";
import { describePart, type PartTier, searchParts } from "../parts/search.js";
import { applyPatch } from "../patch.js";
import { findPrompt, prompts } from "../prompts.js";
import { runQuery, selectParts, type TextResult } from "../query.js";
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
  REVIEW_MODE_FILE,
  type ReviewMode,
} from "../review.js";
import { type ValidationResult, validateProject } from "../validate.js";
import {
  describeChange,
  diffCircuits,
  formatChanges,
  opOf,
  type StatementChange,
} from "../versions/diff.js";
import { planRevert, type RevertPlan } from "../versions/revert.js";
import {
  buildViewerModel,
  type VariantSummary,
  type VersionState,
  type ViewerModel,
} from "../viewer-model.js";
import { countIssues, formatValidation, issueSummary, overview, readBlock } from "../views.js";
import { PROJECT_FILE, parseProjectConfig, projectData, TOP_BLOCK } from "./config.js";
import {
  changedFiles,
  commitProject,
  filesAt,
  initRepo,
  lastCommit,
  recentCommits,
  repoInfo,
} from "./git.js";
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
import { type KicadDesign, readKicadDesign } from "./kicad-import.js";
import { loadProject, ProjectLoadError } from "./load.js";
import { writePartRecord } from "./part-put.js";
import { addPending, readPending, removePending } from "./pending.js";
import { defaultStateDir, readSettings, type Settings } from "./settings.js";
import { DECISIONS_FILE, DESIGN_FILE, noteTemplates, projectSkeleton } from "./skeleton.js";
import type { ProjectSource } from "./source.js";
import {
  checkVariantName,
  createVariant,
  forkStatus,
  hashText,
  hasProjectOverrides,
  listVariants,
  overlayCircuits,
  readVariant,
  removeVariant,
  VARIANTS_DIR,
  writeMeta,
} from "./variants.js";
import { partstyleVersion } from "./version.js";

const fail = (text: string): TextResult => ({ ok: false, text });

/** Layout edits the viewer makes: see `Workspace.setLayout`. */
export const layoutOps = ["rotate", "flip", "earlier", "later", "reset"] as const;
export type LayoutOp = (typeof layoutOps)[number];

const toPosix = (p: string) => p.split(path.sep).join("/");

const CLAUDE_SIDECAR = "CLAUDE.partstyle.md";

const VARIANT_OVERRIDES_NOTE = (name: string) =>
  `# Variant ${name}: overrides of the main ${PROJECT_FILE}. Mappings merge key by key; lists and\n# values replace main's; null removes a key. Write back only the keys that differ.`;

/** More than a short summary: the design overview belongs in notes/design.md. */
const isLongDescription = (text: string) => text.trim().length > 200 || text.trim().includes("\n");

/** The project file and Markdown files under notes/ (no hidden or parent segments). */
const isDoc = (f: string) =>
  f === PROJECT_FILE || /^notes\/(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.md$/.test(f);

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

const docsUrl = (name: string) => new URL(`../../../../docs/${name}`, import.meta.url);

const references = {
  ckt: { file: "ckt-grammar.md", about: "The .ckt language and patches: read before writing them" },
  parts: { file: "part-records.md", about: "The part record format: read before part_put" },
  issues: { file: "issues.md", about: "What every issue code means" },
};
type ReferenceTopic = keyof typeof references;

let embeddedReferences: Record<ReferenceTopic, string> | undefined;

/** Uses these texts as the references instead of docs/: for a standalone executable. */
export function embedReferences(texts: Record<ReferenceTopic, string>): void {
  embeddedReferences = texts;
}

/** The topics of `readGuide`: reference documents, then procedures. */
const guideTopics: { topic: string; about: string }[] = [
  ...Object.entries(references).map(([topic, r]) => ({ topic, about: r.about })),
  ...prompts.map((p) => ({ topic: p.name.replace(/_/g, "-"), about: p.description })),
];

/**
 * What the AI reads when it needs it, rather than on every turn: a reference document or a
 * procedure. Without a topic, the list of topics.
 */
export async function readGuide(topic?: string): Promise<TextResult> {
  const list = guideTopics.map((t) => `${t.topic}: ${t.about}`).join("\n");
  if (topic === undefined) return { ok: true, text: list };
  if (Object.hasOwn(references, topic)) {
    const key = topic as ReferenceTopic;
    const text =
      embeddedReferences?.[key] ?? (await readFile(docsUrl(references[key].file), "utf8"));
    return { ok: true, text };
  }
  const procedure = findPrompt(topic);
  if (procedure) return { ok: true, text: procedure.render({}) };
  return { ok: false, text: `no guide topic '${topic}'; topics:\n${list}` };
}

/**
 * Every operation the CLI and the MCP server expose, over one project folder. Each call re-reads
 * the files, since the human or another tool may have edited them in between.
 */
export class Workspace {
  readonly root: string;
  /** Per-user settings and state: ~/.partstyle unless given (tests pass a temporary one). */
  readonly stateDir: string;
  /** The global-mode server's shared library, used before the user's; else the remembered one. */
  readonly sharedLibrary: string | undefined;
  /**
   * The variant this workspace works on (undefined: the main circuit). A variant's design is
   * main's with its own block files and project-file overrides laid over it.
   */
  readonly variantName: string | undefined;
  /** Where this workspace's own files live: the project, or the variant's folder. */
  readonly own: string;
  /** The changeset log since the last checkpoint (of the variant's own files, for a variant). */
  readonly history: History;

  constructor(
    dir: string,
    opts: { stateDir?: string; sharedLibrary?: string; variant?: string } = {},
  ) {
    this.root = path.resolve(dir);
    this.stateDir = path.resolve(opts.stateDir ?? defaultStateDir());
    this.sharedLibrary = opts.sharedLibrary;
    this.variantName = opts.variant;
    const folder = opts.variant === undefined ? "" : `${VARIANTS_DIR}/${opts.variant}`;
    this.own = path.join(this.root, folder);
    this.history = new History(this.root, folder);
  }

  /** The same project's main circuit (undefined) or one of its variants. */
  forVariant(variant: string | undefined): Workspace {
    if (variant === this.variantName) return this;
    return new Workspace(this.root, {
      stateDir: this.stateDir,
      ...(this.sharedLibrary !== undefined && { sharedLibrary: this.sharedLibrary }),
      ...(variant !== undefined && { variant }),
    });
  }

  /** The circuit as this workspace sees it, keyed circuit/x.ckt: main's, with a variant's over it. */
  private async circuitsNow(): Promise<Record<string, string>> {
    const main = await readCircuits(this.root);
    return this.variantName === undefined
      ? main
      : overlayCircuits(main, await readCircuits(this.own));
  }

  /** Where a circuit file (circuit/x.ckt, or a variant's own path) is written from here. */
  private circuitTarget(file: string): string {
    const logical = file.replace(/^variants\/[^/]+\//, "");
    return this.variantName === undefined
      ? logical
      : `${VARIANTS_DIR}/${this.variantName}/${logical}`;
  }

  /**
   * Writes a circuit file. In a variant, a block copied from main records main's text as its
   * base, and a block that ends up identical to main's is deleted so main's applies again.
   */
  private async writeCircuit(file: string, text: string): Promise<void> {
    const target = this.circuitTarget(file);
    const full = path.join(this.root, target);
    const logical = file.replace(/^variants\/[^/]+\//, "");
    if (this.variantName !== undefined) {
      const v = await readVariant(this.root, this.variantName);
      const main = await readFile(path.join(this.root, logical), "utf8").catch(() => undefined);
      if (v) {
        const forked = await readFile(full, "utf8").then(
          () => true,
          () => false,
        );
        if (main !== undefined && text === main) {
          await rm(full, { force: true });
          delete v.base[logical];
          await writeMeta(v);
          return;
        }
        if (!forked && main !== undefined) {
          v.base[logical] = hashText(main);
          await writeMeta(v);
        }
      }
    }
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, text, "utf8");
  }

  private kicadInstall?: { key: string; found: Promise<KicadInstall> };
  /** Indexed lazily on the first export; kept so later exports skip the scan. */
  private symbolLibs?: KicadSymbolLibraries;

  /** The user's settings, read fresh so an edit applies to the next call. */
  settings(): Promise<Settings> {
    return readSettings(this.stateDir, this.sharedLibrary);
  }

  /** KiCad discovery, repeated only when the settings' overrides change. */
  private async kicad(): Promise<KicadInstall> {
    const { kicad } = await this.settings();
    const key = JSON.stringify(kicad);
    if (this.kicadInstall?.key !== key) this.kicadInstall = { key, found: findKicad(kicad) };
    return this.kicadInstall.found;
  }

  /** How to point Partstyle at kicad-cli, for messages when it is not found. */
  private async kicadHint(): Promise<string> {
    return `set kicad: {cli: PATH} in ${(await this.settings()).file}, or KICAD_CLI`;
  }

  private async source(): Promise<ProjectSource> {
    return loadProject(this.root, (await this.settings()).libraries, this.variantName);
  }

  /** Loads and validates, adding footprint checks for the library parts in use when KiCad is installed. */
  private async load(): Promise<{ source: ProjectSource; result: ValidationResult }> {
    const source = await this.source();
    // Edits made since the last call (by anyone) become a changeset before anything else runs.
    await this.history.record();
    const result = validateProject(source);
    const { footprints } = await this.kicad();
    if (footprints && result.netlist) {
      const users = new Map<string, string[]>();
      for (const p of result.netlist.parts) {
        if (p.record) users.set(p.record.id, [...(users.get(p.record.id) ?? []), p.path]);
      }
      const entries = [...users.keys()].flatMap((id) => {
        const e = result.library.get(id);
        return e ? [e] : [];
      });
      const found = await checkFootprints(entries, footprints, (id) => users.get(id) ?? []);
      // Again with them, so that waivers apply to them too.
      if (found.length > 0) return { source, result: validateProject(source, found) };
    }
    return { source, result };
  }

  /** KiCad's power library and symbol candidates for the parts in use, when KiCad is installed. */
  private async libraries(result: ValidationResult): Promise<KicadLibraries> {
    const { symbols } = await this.kicad();
    if (!symbols || !result.netlist) return {};
    if (this.symbolLibs?.dir !== symbols) this.symbolLibs = new KicadSymbolLibraries(symbols);
    const power = await this.symbolLibs.library("power");
    const symbolCandidates = await this.symbolLibs.candidates(result.netlist.parts);
    return { ...(power && { power }), symbolCandidates };
  }

  /** A file of this workspace's own (a variant's under its folder), as written from here. */
  private ownFile(name: string): string {
    return this.variantName === undefined ? name : `${VARIANTS_DIR}/${this.variantName}/${name}`;
  }

  /** A variant's own file, else main's: parts both share keep their refdes, choices and approvals. */
  private async lock(name: string): Promise<string> {
    return (await this.readOptional(this.ownFile(name))) || (await this.readOptional(name));
  }

  private async locks(): Promise<{ annotation: string; bom: string }> {
    return {
      annotation: await this.lock("annotation.lock"),
      bom: await this.lock("bom.lock"),
    };
  }

  /** Review comments and the viewer selection, read fresh (they are small and change often). */
  async review(): Promise<{ comments: Comment[]; focus: Focus }> {
    return {
      comments: parseComments(await this.readOptional(COMMENTS_FILE)),
      focus: parseFocus(await this.readOptional(FOCUS_FILE)),
    };
  }

  /** The project's name from its project file, else its folder's. */
  async name(): Promise<string> {
    const text = await this.readOptional(PROJECT_FILE);
    return parseProjectConfig(text, PROJECT_FILE).config?.name ?? path.basename(this.root);
  }

  /** The docs (the project file, notes/*.md) that exist, by path. */
  private async docs(): Promise<string[]> {
    const notes = await readdir(path.join(this.root, "notes"), { recursive: true }).catch(() => []);
    const found = notes.map((f) => `notes/${toPosix(String(f))}`).filter((f) => isDoc(f));
    return [
      ...((await exists(path.join(this.root, PROJECT_FILE))) ? [PROJECT_FILE] : []),
      ...found,
    ];
  }

  /** The project file or a notes/ file, for clients without file tools. */
  readDoc(file: string): Promise<TextResult> {
    return this.guard(async () => {
      const f = toPosix(file).replace(/^\.\//, "");
      if (!isDoc(f)) return fail(`docs are ${PROJECT_FILE} and notes/*.md (got ${file})`);
      if (f === PROJECT_FILE && this.variantName !== undefined) {
        await this.requireVariant();
        const own = await this.readOptional(this.ownFile(f));
        return {
          ok: true,
          text: `${VARIANT_OVERRIDES_NOTE(this.variantName)}\n${own || "# (none yet)\n"}`,
        };
      }
      const text = await this.readOptional(f);
      if (text) return { ok: true, text };
      const docs = await this.docs();
      return fail(`no ${f}${docs.length > 0 ? `; docs: ${docs.join(", ")}` : ""}`);
    });
  }

  /**
   * Replaces the project file or a notes/ file. A project file that would not load is refused;
   * otherwise the issues it now has are reported.
   */
  writeDoc(file: string, text: string): Promise<TextResult> {
    return this.guard(async () => {
      const f = toPosix(file).replace(/^\.\//, "");
      if (!isDoc(f)) return fail(`docs are ${PROJECT_FILE} and notes/*.md (got ${file})`);
      if (f === DECISIONS_FILE) {
        return fail(`${f} is append-only: add entries with add_decision (partstyle decision)`);
      }
      if (!(await exists(path.join(this.root, PROJECT_FILE)))) {
        return fail(`${this.root} is not a project (no ${PROJECT_FILE})`);
      }
      // A variant's project file holds only its overrides of main's.
      const target = f === PROJECT_FILE ? this.ownFile(f) : f;
      if (f === PROJECT_FILE) {
        if (this.variantName !== undefined) await this.requireVariant();
        const broken = (
          this.variantName === undefined
            ? parseProjectConfig(text, f)
            : parseProjectConfig(await this.readOptional(PROJECT_FILE), PROJECT_FILE, {
                text,
                file: target,
              })
        ).issues[0];
        if (broken) return fail(`not written: ${formatIssue(broken)}`);
      }
      const full = path.join(this.root, target);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, text.endsWith("\n") ? text : `${text}\n`, "utf8");
      const n = text.replace(/\n$/, "").split("\n").length;
      const lines = [`wrote ${target} (${n} line${n === 1 ? "" : "s"})`];
      if (f === PROJECT_FILE) {
        const { result } = await this.load();
        const issues = result.issues.filter(
          (i) => i.location?.file === PROJECT_FILE || i.location?.file === target,
        );
        lines.push(...(issues.length > 0 ? issues.map(formatIssue) : [`${target}: no issues`]));
        const description = projectData(text)?.description;
        if (typeof description === "string" && isLongDescription(description)) {
          lines.push("note: keep description short; the design overview goes in notes/design.md");
        }
      }
      return { ok: true, text: lines.join("\n") };
    });
  }

  /** Adds an entry to notes/decisions.md, which is only ever added to. */
  addDecision(text: string): Promise<TextResult> {
    return this.guard(async () => {
      const entry = text.trim().replace(/\s*\n\s*/g, " ");
      if (entry === "") return fail("a decision needs text");
      if (!(await exists(path.join(this.root, PROJECT_FILE)))) {
        return fail(`${this.root} is not a project (no ${PROJECT_FILE})`);
      }
      const file = path.join(this.root, DECISIONS_FILE);
      const existing = await this.readOptional(DECISIONS_FILE);
      if (existing === "") {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, noteTemplates[DECISIONS_FILE], "utf8");
      }
      // Swedish dates read YYYY-MM-DD HH:MM:SS, in local time.
      const line = `- ${new Date().toLocaleString("sv").slice(0, 16)}: ${entry}`;
      const gap = existing === "" || existing.endsWith("\n") ? "" : "\n";
      await appendFile(file, `${gap}${line}\n`, "utf8");
      return { ok: true, text: `added to ${DECISIONS_FILE}: ${line}` };
    });
  }

  /** Sign-offs on parts: a variant's own once it has any, else main's. */
  private async approvals(): Promise<Approvals> {
    return parseApprovals(await this.lock(APPROVALS_FILE));
  }

  /** The overview's line on sign-offs, once there are any. */
  private async approvalLines(result: ValidationResult): Promise<string[]> {
    const approvals = await this.approvals();
    const parts = result.netlist?.parts ?? [];
    if (approvals.size === 0 || parts.length === 0) return [];
    const count = (s: string) => parts.filter((p) => approvalStatus(p, approvals) === s).length;
    const changed = count("changed");
    return [
      `approved: ${count("approved")} of ${parts.length} parts${
        changed > 0 ? `, ${changed} changed since (query parts where approved = changed)` : ""
      }`,
    ];
  }

  /**
   * Signs off parts as they now stand, or with `undo` takes that back. `select` is `all`,
   * refdes, or `where` conditions. `by` says who: the person in the viewer, or the AI at their
   * request.
   */
  approve(select: string, opts: { by: "person" | "ai"; undo?: boolean }): Promise<TextResult> {
    return this.guard(async () => {
      const { result } = await this.load();
      if (!result.netlist) return fail(`cannot approve: ${issueSummary(result)}`);
      const approvals = await this.approvals();
      const parts = selectParts(result.netlist, select, approvals);
      if (!Array.isArray(parts)) return parts;
      if (parts.length === 0) return fail("no matching parts");
      const at = new Date().toLocaleString("sv").slice(0, 16);
      for (const p of parts) {
        if (opts.undo) approvals.delete(p.path);
        else if (approvalStatus(p, approvals) !== "approved") {
          approvals.set(p.path, { snapshot: partSnapshot(p), by: opts.by, at });
        }
      }
      const file = path.join(this.root, this.ownFile(APPROVALS_FILE));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, formatApprovals(approvals), "utf8");
      const names = parts.map((p) => p.path).join(" ");
      const n = parts.length;
      return {
        ok: true,
        text: `${opts.undo ? "unapproved" : "approved"} ${n} part${n === 1 ? "" : "s"}: ${names}`,
      };
    });
  }

  /** The overview's line on notes: what exists, and whether the design overview is written. */
  private async noteLines(): Promise<string[]> {
    const found = (await this.docs()).filter((f) => f.startsWith("notes/"));
    const planned = Object.keys(noteTemplates);
    const notes = [...new Set([...planned.filter((f) => found.includes(f)), ...found])];
    const missing = !found.includes(DESIGN_FILE);
    const shown = await Promise.all(
      notes.map(async (f) => {
        const name = f.slice("notes/".length);
        const text = await this.readOptional(f);
        if (f === DESIGN_FILE && text === noteTemplates[DESIGN_FILE]) {
          return `${name} (not written yet)`;
        }
        if (f === DECISIONS_FILE) return `${name} (${text.match(/^- /gm)?.length ?? 0})`;
        return name;
      }),
    );
    if (missing) shown.unshift("design.md (not written yet)");
    return [`notes: ${shown.join(", ")}`];
  }

  /** Fails (as a load error) when this workspace's variant does not exist. */
  private async requireVariant(): Promise<void> {
    if (this.variantName !== undefined && !(await readVariant(this.root, this.variantName))) {
      throw new ProjectLoadError(`no variant '${this.variantName}' (see variant list)`);
    }
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
   * Creates a project skeleton in the root folder (created if missing). Refuses if the project
   * file exists; other existing files are kept, not overwritten.
   */
  async init(opts: { name?: string } = {}): Promise<TextResult> {
    if (await exists(path.join(this.root, PROJECT_FILE))) {
      return fail(`${this.root} already has a ${PROJECT_FILE}`);
    }
    const settings = await this.settings();
    const name = opts.name ?? path.basename(this.root);
    const created: string[] = [];
    const kept: string[] = [];
    const notes: string[] = [];
    for (const f of projectSkeleton(name, partstyleVersion())) {
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
    if (settings.libraries.length === 0) {
      lines.push(
        `note: no part libraries listed in ${settings.file}; part_put will write to parts/`,
      );
    }
    // Checkpoints are git commits; a project already inside a repository uses that one.
    if (!(await repoInfo(this.root))) {
      try {
        await initRepo(this.root);
      } catch (e) {
        lines.push(`note: no git repository, so no checkpoints (${(e as Error).message})`);
      }
    }
    lines.push(
      `next: fill in ${PROJECT_FILE} with the user, then add blocks (guide ckt shows how)`,
    );
    return { ok: true, text: lines.join("\n") };
  }

  overview(): Promise<TextResult> {
    return this.guard(async () => {
      const { source, result } = await this.load();
      const lines = [
        ...(await this.noteLines()),
        ...(await this.approvalLines(result)),
        ...(await this.versionLines()),
      ];
      return { ok: true, text: overview(source, result, lines) };
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
      return runQuery(result.netlist, expr, await this.approvals());
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

  /**
   * Applies one patch to several versions of the design ("main" and variant names) at once.
   * Every target is tried first; if the patch fails on any, nothing is written. One target
   * reports as `apply` does; several report a section each.
   */
  applyTo(patch: string, targets: string[], opts: { dryRun?: boolean } = {}): Promise<TextResult> {
    return this.guard(async () => {
      const names = [...new Set(targets.length > 0 ? targets : ["main"])];
      if (names.length === 1) {
        const only = names[0] as string;
        return this.forVariant(only === "main" ? undefined : only).apply(patch, opts);
      }
      // Main first: its edits reach every variant that takes the edited block from it, so with
      // main among the targets a variant gets only the edits to blocks of its own.
      names.sort((a, b) => Number(b === "main") - Number(a === "main"));
      const withMain = names.includes("main");
      const plans = [];
      for (const name of names) {
        const w = this.forVariant(name === "main" ? undefined : name);
        await w.requireVariant();
        plans.push({
          name,
          w,
          patch: name !== "main" && withMain ? await w.ownSections(patch) : patch,
        });
      }
      const failed: string[] = [];
      for (const p of plans) {
        if (!p.patch) continue;
        const r = await p.w.applyPatchText(p.patch, { dryRun: true, hold: false, source: "apply" });
        if (!r.ok) failed.push(`${p.name}:`, ...r.text.split("\n").map((l) => `  ${l}`));
      }
      if (failed.length > 0) {
        return fail(
          ["the patch does not apply everywhere; nothing was applied", ...failed].join("\n"),
        );
      }
      const lines: string[] = [];
      for (const p of plans) {
        const r = p.patch
          ? await p.w.applyPatchText(p.patch, {
              dryRun: opts.dryRun ?? false,
              hold: true,
              source: "apply",
            })
          : { ok: true, text: "takes the edited blocks from main, so main's edit reaches it" };
        lines.push(`${p.name}:`, ...r.text.split("\n").map((l) => `  ${l}`));
      }
      return { ok: true, text: lines.join("\n") };
    });
  }

  /**
   * The parts of a patch (its `in BLOCK` sections) that edit blocks this variant has of its
   * own; empty when there are none. A patch without `in` lines is kept whole.
   */
  private async ownSections(patch: string): Promise<string> {
    const own = new Set(Object.keys(await readCircuits(this.own)).map(blockOf));
    const lines = patch.split(/\r?\n/);
    if (!lines.some((l) => /^\s*in\s+\S/.test(l))) return patch;
    let keep = false;
    const kept = lines.filter((l) => {
      const m = /^\s*in\s+(\S+)/.exec(l);
      if (m) keep = own.has(m[1] as string);
      return keep;
    });
    return kept.some((l) => l.trim() && !/^\s*(#|in\s)/.test(l)) ? kept.join("\n") : "";
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
    const held = opts.hold && !opts.dryRun && (await this.reviewMode()) === "accept";
    let pendingId: string | undefined;
    if (held) {
      pendingId = await addPending(this.root, patch, patched.log, this.variantName);
    } else if (!opts.dryRun) {
      for (const f of patched.changed) await this.writeCircuit(f.file, f.text);
      await this.history.record(opts.source, opts.note ?? patched.log.join("\n"));
    }
    const n = patched.log.length;
    const verb = opts.dryRun
      ? "dry run, would apply"
      : held
        ? `held as ${pendingId} for review; would apply`
        : "applied";
    const lines = [
      `${verb} ${n} edit${n === 1 ? "" : "s"} to ${patched.changed.map((f) => this.circuitTarget(f.file)).join(", ")}`,
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
   * Validates a part record and writes it as `<id>.yaml`, to the first library in the user's
   * settings (default when there is one) or to the project's parts/ folder.
   */
  partPut(yaml: string, scope?: "global" | "project"): Promise<TextResult> {
    return this.guard(async () => {
      const { result } = await this.load();
      const settings = await this.settings();
      const globalPath = settings.libraries[0];
      const where = scope ?? (globalPath === undefined ? "project" : "global");
      if (where === "global" && globalPath === undefined) {
        return fail(`no part libraries listed in ${settings.file}; use scope project`);
      }
      return writePartRecord(yaml, {
        dir: where === "global" ? (globalPath as string) : path.join(this.root, "parts"),
        layer: where,
        shown: (file) => toPosix(path.relative(this.root, file)),
        footprints: (await this.kicad()).footprints,
        exists: (id) => result.library.get(id)?.layer === where,
      });
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
      const { cli, footprints, symbols } = await this.kicad();
      const x = await exportKicad(result, await this.locks(), await this.libraries(result));

      const kicadDir = this.ownFile(KICAD_DIR);
      const dir = path.join(this.root, kicadDir);
      await mkdir(dir, { recursive: true });
      const lines: string[] = [];
      for (const f of await readdir(dir)) {
        // Sheets for blocks that no longer exist, but only ones partstyle wrote.
        if (!f.endsWith(".kicad_sch") || x.files.has(f)) continue;
        const text = await readFile(path.join(dir, f), "utf8");
        if (text.includes('(generator "partstyle")')) {
          await rm(path.join(dir, f));
          lines.push(`removed stale ${kicadDir}/${f}`);
        }
      }
      for (const [f, text] of x.files) await writeFile(path.join(dir, f), text, "utf8");
      const proFile = path.join(dir, x.projectFile.name);
      if (!(await exists(proFile))) {
        await writeFile(proFile, x.projectFile.text, "utf8");
        lines.push(`created ${kicadDir}/${x.projectFile.name}`);
      }
      await writeFile(
        path.join(this.root, this.ownFile("annotation.lock")),
        x.annotationLock,
        "utf8",
      );
      await writeFile(path.join(this.root, this.ownFile("bom.lock")), x.bom.lock, "utf8");

      const sheets = x.schematic.instances.length;
      lines.unshift(
        `exported ${kicadDir}/: ${x.rootSchematic} (${sheets} sheet${sheets === 1 ? "" : "s"}), ` +
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
        if (s.adaptedFrom) {
          lines.push(`adapted symbol ${s.libId} from ${s.adaptedFrom}: pins matched by name`);
          continue;
        }
        const why =
          s.rejected.length > 0
            ? s.rejected.join("; ")
            : symbols
              ? "no KiCad symbol matches its name; set kicad_symbol in the part record"
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
          if (e.status === "library" || e.status === "resolved") continue;
          if (e.footprint === undefined) continue;
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
        lines.push(`KiCad not found: round-trip and ERC skipped (${await this.kicadHint()})`);
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
        `next: open ${kicadDir}/${x.projectFile.name}; in the PCB editor use Tools > Update PCB from Schematic`,
      );
      return { ok, text: lines.join("\n") };
    });
  }

  /**
   * Imports a KiCad project (a .kicad_pro, .kicad_sch or its folder) through kicad-cli, which
   * resolves the connectivity. Creates the project if there is none; importing again replaces
   * circuit/ as one changeset, keeping intents, net attributes, port kinds, nc, waivers and block
   * descriptions. Symbols that match no library record become draft records in parts/.
   */
  kicadImport(source: string, opts: { replace?: boolean } = {}): Promise<TextResult> {
    return this.guard(async () => {
      if (this.variantName !== undefined) {
        return fail("KiCad import replaces the main circuit; run it without a variant");
      }
      const hasProject = await exists(path.join(this.root, PROJECT_FILE));
      const { cli, symbols } = await this.kicad();
      if (!cli) {
        return fail(
          `import needs kicad-cli, which resolves KiCad's connectivity (${await this.kicadHint()})`,
        );
      }
      const lines: string[] = [];
      if (hasProject && !opts.replace) {
        const circuits = Object.keys(await readCircuits(this.root));
        if (circuits.length > 0 && !(await exists(path.join(this.root, IMPORT_NOTES)))) {
          return fail(
            `${this.root} already has a design (${circuits.join(", ")}) that was not imported; ` +
              "import with replace to overwrite circuit/ (it stays revertible as one changeset)",
          );
        }
      }
      let design: KicadDesign;
      try {
        design = await readKicadDesign(cli, source);
      } catch (e) {
        return fail(`cannot read the KiCad project: ${(e as Error).message}`);
      }
      if (!hasProject) {
        const created = await this.init({ name: design.project });
        if (!created.ok) return created;
        lines.push(created.text.split("\n")[0] as string);
      }

      const { result: before } = await this.load();
      const beforeFiles = await readCircuits(this.root);
      const { footprints } = await this.kicad();
      const pads = new Map<string, Set<string>>();
      if (footprints) {
        const used = new Set(
          [...design.sheets.values()].flatMap((n) => n.comps.map((c) => c.footprint)),
        );
        for (const fp of used) {
          const p = fp ? await footprintPads(footprints, fp) : undefined;
          if (p) pads.set(fp, p);
        }
      }
      let stockSymbol: ((libId: string) => boolean) | undefined;
      if (symbols) {
        if (this.symbolLibs?.dir !== symbols) this.symbolLibs = new KicadSymbolLibraries(symbols);
        const names = new Set((await this.symbolLibs.index()).map((s) => `${s.lib}:${s.name}`));
        stockSymbol = (id) => names.has(id);
      }
      const x = buildImport({
        project: design.project,
        rootFile: design.rootFile,
        sheets: design.sheets,
        library: before.library,
        notes: design.notes,
        pads,
        source: toPosix(path.resolve(source)),
        date: new Date().toLocaleDateString("sv"),
        ...(stockSymbol && { stockSymbol }),
        ...(design.unconnected && { unconnected: design.unconnected }),
        ...(hasProject && {
          previous: {
            blocks: before.blocks,
            annotation: parseAnnotationLock(await this.readOptional("annotation.lock")),
          },
        }),
      });

      // circuit/ is replaced; drafts are remade, and records someone completed are left alone.
      const circuitDir = path.join(this.root, "circuit");
      await mkdir(circuitDir, { recursive: true });
      const written = new Set(x.circuits.map((c) => c.file));
      for (const f of Object.keys(beforeFiles)) {
        if (!written.has(f)) await rm(path.join(this.root, f), { force: true });
      }
      for (const c of x.circuits) await writeFile(path.join(this.root, c.file), c.text, "utf8");
      const partsDir = path.join(this.root, "parts");
      const draftFiles = new Set(x.drafts.map((d) => `${d.id}.yaml`));
      for (const f of await readdir(partsDir).catch(() => [] as string[])) {
        if (draftFiles.has(f) || !/\.ya?ml$/.test(f)) continue;
        const text = await readFile(path.join(partsDir, f), "utf8");
        const { record } = parsePartRecord(text, f);
        if (record && isDraft(record)) await rm(path.join(partsDir, f));
      }
      if (x.drafts.length > 0) await mkdir(partsDir, { recursive: true });
      for (const d of x.drafts)
        await writeFile(path.join(partsDir, `${d.id}.yaml`), d.text, "utf8");
      await writeFile(path.join(this.root, "annotation.lock"), x.annotationLock, "utf8");
      await mkdir(path.join(this.root, "notes"), { recursive: true });
      await writeFile(path.join(this.root, IMPORT_NOTES), x.notes, "utf8");
      const logged = await this.history.record("import", `imported KiCad ${design.project}`);

      const after = validateProject(await this.source());
      const files = [
        ...x.circuits.map((c) => c.file),
        ...(x.drafts.length > 0 ? [`parts/ (${x.drafts.length} drafts)`] : []),
        "annotation.lock",
        IMPORT_NOTES,
      ];
      lines.push(`imported into ${files.join(", ")}${logged ? ` as ${logged.id}` : ""}`);
      lines.push(...x.report);
      if (after.netlist) {
        const diffs = compareNetlists(after.netlist, x.annotation, x.expected);
        lines.push(
          diffs.length === 0
            ? "round-trip: the imported design connects exactly what KiCad's netlist does"
            : "round-trip MISMATCH (an import bug):",
          ...diffs.map((d) => `  ${d}`),
        );
      }
      if (hasProject) {
        const changes = diffCircuits(toFiles(beforeFiles), toFiles(await readCircuits(this.root)));
        lines.push(
          changes.length === 0
            ? "changes: none to the circuit"
            : `changes: ${changes.length} statement${changes.length === 1 ? "" : "s"} (see diff)`,
          ...formatChanges(changes)
            .slice(0, 12)
            .map((l) => `  ${l}`),
        );
      }
      lines.push(`now: ${issueSummary(after)}`);
      lines.push(
        x.drafts.length > 0
          ? "next: overview; resolve the drafts (validate lists them as part.draft), then rename auto-named nets"
          : "next: overview, then validate",
      );
      return { ok: true, text: lines.join("\n") };
    });
  }

  /** What the person has selected in the viewer, and the open review comments. */
  focus(): Promise<TextResult> {
    return this.guard(async () => {
      const { comments, focus } = await this.review();
      // The selection names parts of the design the person is looking at.
      const viewed =
        focus.variant !== undefined && (await readVariant(this.root, focus.variant))
          ? this.forVariant(focus.variant)
          : this.forVariant(undefined);
      const { result } = await viewed.load();
      let url: string | undefined;
      try {
        url = (JSON.parse(await this.readOptional(VIEWER_FILE)) as { url?: string }).url;
      } catch {
        url = undefined;
      }
      return { ok: true, text: focusText(focus, comments, result.netlist, url) };
    });
  }

  /** The global part libraries from the user's settings, for watching. */
  async libraryDirs(): Promise<string[]> {
    return (await this.settings().catch(() => ({ libraries: [] }))).libraries;
  }

  /** auto: the AI's edits land at once. accept: each patch it applies waits for the person. */
  async reviewMode(): Promise<ReviewMode> {
    const text = await this.readOptional(REVIEW_MODE_FILE);
    try {
      return (JSON.parse(text) as { mode?: unknown }).mode === "accept" ? "accept" : "auto";
    } catch {
      return "auto";
    }
  }

  /** Sets the review mode: the person's choice in the viewer, kept out of the AI's files. */
  async setReviewMode(mode: ReviewMode): Promise<TextResult> {
    await this.writeState(REVIEW_MODE_FILE, `${JSON.stringify({ mode })}\n`);
    return { ok: true, text: `review mode: ${mode}` };
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
      // Edited as a document so comments stay, whether or not the record has provenance yet.
      const doc = parseDocument(text);
      doc.setIn(["provenance", "verified_by"], "human");
      await writeFile(file, doc.toString(), "utf8");
      return { ok: true, text: `marked ${id} verified in ${entry.file}` };
    });
  }

  /**
   * Changes how a part or child sheet of `block` is drawn, as the human asks in the viewer:
   * turn a two-terminal part a quarter turn, mirror anything else (a two-terminal part turns
   * half way instead), move its group a stage earlier or later (from any part in the group: the
   * stage is written on the group's head), or clear its hint. The first
   * stage edit on a sheet writes the stage every group has now, so the others stay where they
   * are rather than following along. Written as a patch (never held for review: it is the
   * human's own edit), so it is logged and can be reverted like any other change.
   */
  setLayout(block: string, ref: string, op: LayoutOp): Promise<TextResult> {
    return this.guard(async () => {
      const { result } = await this.load();
      const ast = result.blocks.find((b) => b.block.name === block);
      if (!ast) return fail(`no block ${block}`);
      // A hint arranges the drawing, not the circuit: on a block the variant takes from main,
      // it goes to main's file rather than copying the block into the variant.
      if (this.variantName !== undefined && ast.file.startsWith("circuit/")) {
        return this.forVariant(undefined).setLayout(block, ref, op);
      }
      if (!result.netlist || !result.config) return fail("the design does not elaborate yet");
      const drawing = await prepareDrawing(
        result,
        await this.locks(),
        await this.libraries(result),
      );
      const hints = drawing.sheets.get(block)?.hints ?? [];
      const h = hints.find((x) => x.ref === ref);
      if (!h) return fail(`no part or sheet ${ref} drawn in ${block}`);

      const stored = (r: string): LayoutHint =>
        ast.parts.find((p) => p.ref === r)?.layout ??
        ast.uses.find((u) => u.instance === r)?.layout ??
        {};
      const next = new Map<string, LayoutHint>();
      const hintOf = (r: string) => next.get(r) ?? stored(r);
      if (op === "earlier" || op === "later") {
        if (!hints.some((x) => x.stored.stage !== undefined)) {
          for (const x of hints) {
            if (x.ref === x.group) next.set(x.ref, { ...stored(x.ref), stage: x.stage });
          }
        }
        // A part riding in another's group moves with it: the stage goes on the group's head
        // (a stage written on the rider itself would split it off).
        const stage = Math.max(1, h.stage + (op === "earlier" ? -1 : 1));
        next.set(h.group, { ...hintOf(h.group), stage });
      } else if (op === "rotate") {
        if (!h.turnable) return fail(`${ref} is not a two-terminal part; flip it instead`);
        next.set(ref, { ...hintOf(ref), rotation: ((h.rotation + 90) % 360) as Rotation });
      } else if (op === "flip") {
        next.set(
          ref,
          h.turnable
            ? { ...hintOf(ref), rotation: ((h.rotation + 180) % 360) as Rotation }
            : { ...hintOf(ref), flip: !h.flip },
        );
      } else {
        next.set(ref, {});
      }

      const lines = [`in ${block}`];
      for (const [r, layout] of next) {
        const part = ast.parts.find((p) => p.ref === r);
        const use = ast.uses.find((u) => u.instance === r);
        if (part)
          lines.push(`= ${printStatement({ kind: "part", decl: { ...part, layout } }, true)}`);
        else if (use)
          lines.push(`= ${printStatement({ kind: "use", decl: { ...use, layout } }, true)}`);
      }
      return this.applyPatchText(lines.join("\n"), {
        dryRun: false,
        hold: false,
        source: "layout",
        note: `layout: ${op} ${block}/${ref}`,
      });
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
      top: TOP_BLOCK,
      summary: { errors, warnings, waived: result.waived },
      issues: result.issues,
      waivers: result.waivers,
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
      return buildViewerModel(drawing, result, review, await this.approvals());
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

  /**
   * The circuit at the last checkpoint, or where the change log starts when there is no git.
   * A variant's is main's base with the variant's own base laid over it.
   */
  private async baseCircuits(): Promise<{ files: Record<string, string>; label: string }> {
    const own = await this.ownBase();
    if (this.variantName === undefined) return own;
    const main = await this.forVariant(undefined).ownBase();
    return { files: overlayCircuits(main.files, own.files), label: own.label };
  }

  /** This workspace's own circuit files at the base (main's circuit/, or a variant's blocks). */
  private async ownBase(): Promise<{ files: Record<string, string>; label: string }> {
    const cp = await lastCommit(this.root);
    if (cp) {
      return {
        files: (await this.history.atCheckpoint()) ?? {},
        label: `checkpoint ${cp.id.slice(0, 7)} "${cp.message}" (${cp.date.slice(0, 16).replace("T", " ")})`,
      };
    }
    const { changesets } = await this.history.changesets();
    const files: Record<string, string> = await readCircuits(this.own);
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
    const info = await repoInfo(this.root);
    const cp = await lastCommit(this.root);
    const { changesets } = await this.history.changesets();
    const base = await this.baseCircuits();
    const now = await this.circuitsNow();
    const asItem = (c: StatementChange) => ({
      block: c.block,
      kind: c.kind,
      key: c.key,
      op: opOf(c),
    });
    const main = await readCircuits(this.root);
    const variants = [];
    for (const v of await listVariants(this.root)) {
      const status = forkStatus(v, main, await readCircuits(v.dir));
      variants.push({
        name: v.name,
        ...(v.description !== undefined && { description: v.description }),
        projectFile: await hasProjectOverrides(v),
        ...status,
      });
    }
    return {
      git: info !== undefined,
      mode: await this.reviewMode(),
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
      pending: (await readPending(this.root))
        .filter((p) => p.variant === this.variantName)
        .map((p) => ({ id: p.id, created: p.created, log: p.log })),
      changed: diffCircuits(toFiles(base.files), toFiles(now)).map(asItem),
      variants,
      ...(this.variantName !== undefined && {
        vsMain: diffCircuits(toFiles(main), toFiles(now)).map(asItem),
      }),
    };
  }

  /** The overview's lines about changes, pending patches and variants. */
  private async versionLines(): Promise<string[]> {
    const st = await this.versionState();
    const n = st.changed.length;
    const summary =
      n === 0
        ? "none"
        : this.variantName === undefined
          ? `${n} statements in ${st.changesets.length} changesets (see diff)`
          : `${n} statements, main's included; ${st.changesets.length} changesets of its own (see diff)`;
    const lines = [`changes: ${summary}`];
    if (st.mode === "accept") {
      lines.push("review mode: accept (edit only through apply; each patch waits for approval)");
    }
    if (st.pending.length > 0) {
      lines.push(`pending review: ${st.pending.map((p) => p.id).join(", ")}`);
    }
    if (this.variantName !== undefined) {
      const me = st.variants.find((v) => v.name === this.variantName);
      if (me) lines.push(`this variant: ${variantLine(me)}`);
      lines.push(`differs from main in ${st.vsMain?.length ?? 0} statements (variant diff)`);
    } else if (st.variants.length > 0) {
      lines.push("variants (pass variant=NAME):", ...st.variants.map((v) => `  ${variantLine(v)}`));
    }
    return lines;
  }

  /**
   * The circuit changes, statement by statement, since `since`: "checkpoint" (the last one),
   * "last" (the previous diff call, to catch up between turns) or a checkpoint id.
   */
  diff(since = "checkpoint"): Promise<TextResult> {
    return this.guard(async () => {
      await this.load();
      const now = await this.circuitsNow();
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
          base = await this.circuitsAt(since);
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

  /** The circuit as this workspace sees it at a commit. */
  private async circuitsAt(ref: string): Promise<Record<string, string>> {
    const main = Object.fromEntries(await filesAt(this.root, ref, "circuit"));
    if (this.variantName === undefined) return main;
    const prefix = `${VARIANTS_DIR}/${this.variantName}/`;
    const own = await filesAt(this.root, ref, `${prefix}circuit`);
    return overlayCircuits(
      main,
      Object.fromEntries([...own].map(([f, t]) => [f.slice(prefix.length), t])),
    );
  }

  /** Files outside circuit/ changed since the checkpoint (context, parts, notes, locks). */
  private async otherChangedFiles(): Promise<string[]> {
    return (await changedFiles(this.root)).filter(
      (f) => !/^(circuit|kicad)\//.test(f) && !/^variants\/[^/]+\/(circuit|kicad)\//.test(f),
    );
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
      const patched = applyPatch(await this.source(), plan.patch);
      if (patched.issues.length > 0) return patched.issues.map(formatIssue).join("\n");
      for (const f of patched.changed) await this.writeCircuit(f.file, f.text);
    }
    // A variant's revert only touches its own files: deleting one brings main's back.
    for (const f of plan.deleteFiles) {
      await rm(path.join(this.root, this.circuitTarget(f)), { force: true });
    }
    for (const f of plan.writeFiles) await this.writeCircuit(f.file, f.text);
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

      const plan = planRevert(items, toFiles(await this.circuitsNow()), toFiles(cs.before));
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
      // Local state (.partstyle/) stays out of checkpoints.
      let id: string | undefined;
      try {
        id = await commitProject(this.root, message.trim());
      } catch (e) {
        return fail(`git could not commit: ${(e as Error).message}`);
      }
      if (id === undefined) {
        return { ok: true, text: "nothing to checkpoint: no changes since the last checkpoint" };
      }
      await this.history.restart();
      const n = st.changed.length;
      const what = st.checkpoint
        ? `${n} statement change${n === 1 ? "" : "s"} in ${st.changesets.length} changeset${st.changesets.length === 1 ? "" : "s"}`
        : "the project's first checkpoint";
      return { ok: true, text: `checkpoint ${id.slice(0, 7)} "${message.trim()}": ${what}` };
    });
  }

  /** The project's recent checkpoints, newest first. */
  checkpoints(): Promise<TextResult> {
    return this.guard(async () => {
      await this.load();
      if (!(await repoInfo(this.root))) return fail("not in a git repository: no checkpoints");
      const lines = (await recentCommits(this.root, 20)).map(
        (c) => `${c.id.slice(0, 7)} ${c.date.slice(0, 16).replace("T", " ")} ${c.message}`,
      );
      return { ok: true, text: lines.length > 0 ? lines.join("\n") : "no checkpoints yet" };
    });
  }

  /** Accepts a pending patch: applies it now, as a changeset of its own. */
  pendingAccept(id: string): Promise<TextResult> {
    return this.guard(async () => {
      const list = await readPending(this.root);
      const p = list.find((x) => x.id === id);
      if (!p) return fail(`no pending change ${id}`);
      // A pending change applies to the variant it was made for, whichever view accepts it.
      const r = await this.forVariant(p.variant).applyPatchText(p.patch, {
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

  /** A workspace for one of the project's variants, or undefined if there is no such variant. */
  async variantWorkspace(name: string): Promise<Workspace | undefined> {
    return (await readVariant(this.root, name)) ? this.forVariant(name) : undefined;
  }

  /**
   * Variants share every block they do not change. list, create NAME and diff NAME are for
   * anyone; adopt NAME (make the variant's changes main's, as one changeset) and remove NAME are
   * the person's decisions.
   */
  variant(
    op: "list" | "create" | "diff" | "adopt" | "remove",
    name?: string,
    description?: string,
  ): Promise<TextResult> {
    return this.guard(async () => {
      const main = this.forVariant(undefined);
      await main.load();
      if (op === "list") {
        const st = await main.versionState();
        if (st.variants.length === 0) {
          return { ok: true, text: "no variants (create one with: variant create NAME)" };
        }
        return { ok: true, text: st.variants.map(variantLine).join("\n") };
      }
      if (name === undefined) return fail(`usage: variant ${op} NAME`);
      if (op === "create") {
        const bad = checkVariantName(name);
        if (bad) return fail(bad);
        if (await readVariant(this.root, name)) return fail(`variant '${name}' already exists`);
        const v = await createVariant(this.root, name, description);
        return {
          ok: true,
          text: [
            `created variant ${name} (${toPosix(path.relative(this.root, v.dir))}): the same as main until it changes a block`,
            `read it with variant=${name}; apply to it with variants=["${name}"] (or with main: ["main", "${name}"])`,
          ].join("\n"),
        };
      }
      const v = await readVariant(this.root, name);
      if (!v) return fail(`no variant '${name}' (see variant list)`);
      const mainFiles = await readCircuits(this.root);
      const own = await readCircuits(v.dir);
      if (op === "diff") {
        const changes = diffCircuits(toFiles(mainFiles), toFiles(overlayCircuits(mainFiles, own)));
        const status = forkStatus(v, mainFiles, own);
        const lines =
          changes.length === 0
            ? [`variant ${name} has the same circuit as main`]
            : [`main -> variant ${name}:`, ...formatChanges(changes)];
        if (await hasProjectOverrides(v)) {
          lines.push(
            `project file overrides: ${toPosix(path.relative(this.root, v.dir))}/${PROJECT_FILE}`,
          );
        }
        for (const f of status.diverged) {
          lines.push(
            `main changed ${f} since the variant copied it; compare and carry over what applies`,
          );
        }
        return { ok: true, text: lines.join("\n") };
      }
      if (op === "adopt") {
        const changed: string[] = [];
        for (const [f, text] of Object.entries(own)) {
          if (mainFiles[f] === text) continue;
          await mkdir(path.join(this.root, "circuit"), { recursive: true });
          await writeFile(path.join(this.root, f), text, "utf8");
          changed.push(f);
        }
        const overrides = await readFile(path.join(v.dir, PROJECT_FILE), "utf8").catch(
          () => undefined,
        );
        if (overrides !== undefined) {
          const file = path.join(this.root, PROJECT_FILE);
          await writeFile(file, applyOverrides(await readFile(file, "utf8"), overrides), "utf8");
          changed.push(PROJECT_FILE);
        }
        if (changed.length === 0) return { ok: true, text: `variant ${name} matches main` };
        // The variant now equals main, and follows it again.
        await rm(path.join(v.dir, "circuit"), { recursive: true, force: true });
        await rm(path.join(v.dir, PROJECT_FILE), { force: true });
        await writeMeta({ ...v, base: {} });
        const logged = await main.history.record("adopt", `adopted variant ${name}`);
        return {
          ok: true,
          text: [
            `adopted variant ${name}${logged ? ` as ${logged.id}` : ""}: ${changed.join(", ")}`,
            "review it, then checkpoint (the variant is kept, now the same as main, until removed)",
          ].join("\n"),
        };
      }
      await removeVariant(v);
      await rm(path.join(this.root, ".partstyle", VARIANTS_DIR, name), {
        recursive: true,
        force: true,
      });
      return { ok: true, text: `removed variant ${name}` };
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
        parseAnnotationLock(await this.lock("annotation.lock")),
      );
      const preferred = result.config.sourcing.suppliers;
      const bom = resolveBom(
        result.netlist,
        result.library,
        await this.lock("bom.lock"),
        preferred,
      );
      const csv = formatBomCsv(bom.entries, (p) => table.get(p) ?? p, preferred);
      const out = (name: string) => path.join(this.root, this.ownFile(name));
      await mkdir(this.own, { recursive: true });
      await writeFile(out("annotation.lock"), formatAnnotationLock(table), "utf8");
      await writeFile(out("bom.lock"), bom.lock, "utf8");
      await writeFile(out("bom.csv"), csv, "utf8");

      const count = (s: string) => bom.entries.filter((e) => e.status === s).length;
      const lines = [
        `wrote ${this.ownFile("bom.csv")}: ${csv.trimEnd().split("\n").length - 1} lines for ${bom.entries.length} parts ` +
          `(${count("library")} library, ${count("resolved")} resolved generics, ${count("unresolved")} unresolved)`,
        ...summarizeLockChanges(bom.changes),
        ...bom.issues.map((i) => formatIssue(i)),
      ];
      if (preferred.length === 0) {
        lines.push(`note: no sourcing.suppliers in ${PROJECT_FILE}; none were used to rank parts`);
      }
      return { ok: true, text: lines.join("\n") };
    });
  }
}

const KICAD_DIR = "kicad";

const blockOf = (file: string) => path.posix.basename(file, ".ckt");

/** One line about a variant: what it overrides, and where main moved on since. */
function variantLine(v: VariantSummary): string {
  const parts = [...(v.projectFile ? ["project file"] : []), ...v.blocks.map(blockOf)];
  const diverged = v.diverged.map(blockOf);
  return `${v.name}${v.description ? ` "${v.description}"` : ""}: ${
    parts.length > 0 ? `own ${parts.join(", ")}` : "same as main"
  }${diverged.length > 0 ? `; main changed ${diverged.join(", ")} since` : ""}`;
}

/**
 * Main's project file with a variant's overrides written into it, keeping its comments and
 * layout: mappings merge key by key, anything else replaces, null removes.
 */
function applyOverrides(mainText: string, overridesText: string): string {
  const doc = parseDocument(mainText);
  const over = parseYaml(overridesText) as unknown;
  const isMapping = (x: unknown): x is Record<string, unknown> =>
    typeof x === "object" && x !== null && !Array.isArray(x);
  const walk = (at: string[], value: unknown): void => {
    if (value === null) doc.deleteIn(at);
    else if (isMapping(value) && isMap(doc.getIn(at, true))) {
      for (const [k, v] of Object.entries(value)) walk([...at, k], v);
    } else doc.setIn(at, value);
  };
  if (isMapping(over)) for (const [k, v] of Object.entries(over)) walk([k], v);
  return doc.toString();
}
const VIEWER_FILE = ".partstyle/viewer.json";
const IMPORT_NOTES = "notes/kicad-import.md";

function summarizeLockChanges(changes: string[]): string[] {
  if (changes.length === 0) return [];
  const shown = changes.slice(0, 10).map((c) => `  ${c}`);
  if (changes.length > 10) shown.push(`  ... ${changes.length - 10} more (see bom.lock)`);
  return [`bom.lock: ${changes.length} change${changes.length === 1 ? "" : "s"}`, ...shown];
}
