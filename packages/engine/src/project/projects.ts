import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { buildLibrary, type PartLibrary } from "../parts/library.js";
import { describePart, type PartTier, searchParts } from "../parts/search.js";
import type { TextResult } from "../query.js";
import { findKicad } from "./kicad.js";
import { listFiles } from "./load.js";
import { writePartRecord } from "./part-put.js";

/** Where projects go when no folder is given: ~/Documents/partstyle. */
export const defaultProjectsDir = () => path.join(homedir(), "Documents", "partstyle");

/** The user folders an MCP Bundle manifest names as variables. */
const folderVariables: Record<string, () => string> = {
  HOME: () => homedir(),
  DOCUMENTS: () => path.join(homedir(), "Documents"),
  DESKTOP: () => path.join(homedir(), "Desktop"),
  DOWNLOADS: () => path.join(homedir(), "Downloads"),
};

/**
 * The projects folder from a --projects-dir value. Claude Desktop passes a setting's default
 * unexpanded (the literal `${DOCUMENTS}/partstyle`), so the folder variables are expanded here.
 * An empty value, or one with any other `${...}` left in it, means the default folder; `warn`
 * says why.
 */
export function projectsDirFrom(value: string | undefined, warn: (m: string) => void): string {
  if (value === undefined || value.trim() === "") return defaultProjectsDir();
  const expanded = value.replace(/\$\{(\w+)\}/g, (all, name: string) =>
    folderVariables[name] ? (folderVariables[name] as () => string)() : all,
  );
  if (expanded.includes("${")) {
    warn(`ignoring --projects-dir ${value} (unknown variable); using ${defaultProjectsDir()}`);
    return defaultProjectsDir();
  }
  return path.resolve(expanded);
}

/**
 * Per-user state shared across projects (the recently opened list): ~/.partstyle, or
 * PARTSTYLE_STATE_DIR.
 */
export const defaultStateDir = () =>
  process.env.PARTSTYLE_STATE_DIR ?? path.join(homedir(), ".partstyle");

const RECENT = "recent.json";
const MAX_RECENT = 20;

const isProject = (dir: string) =>
  stat(path.join(dir, "project.toml")).then(
    (s) => s.isFile(),
    () => false,
  );

const caseless = process.platform === "win32" || process.platform === "darwin";

const same = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * A folder of projects (with a shared part library in its library/), plus the projects opened
 * from elsewhere: what one MCP server configured once can work on.
 */
export class Projects {
  readonly dir: string;
  readonly stateDir: string;

  constructor(dir = defaultProjectsDir(), stateDir = defaultStateDir()) {
    this.dir = path.resolve(dir);
    this.stateDir = path.resolve(stateDir);
  }

  /** The shared part library new projects here use. */
  get libraryDir(): string {
    return path.join(this.dir, "library");
  }

  /** Creates the shared library folder, so new projects can point at it. */
  async ensureLibrary(): Promise<void> {
    await mkdir(this.libraryDir, { recursive: true });
  }

  /** The shared library on its own, for looking parts up before any project is open. */
  private async library(): Promise<PartLibrary | undefined> {
    const files = await listFiles(this.libraryDir, [".yaml", ".yml"]);
    if (files.length === 0) return undefined;
    const sources = await Promise.all(
      files.map(async (f) => ({
        file: `library/${path.basename(f)}`,
        text: await readFile(f, "utf8"),
        layer: "global" as const,
      })),
    );
    return buildLibrary(sources).library;
  }

  private emptyLibrary(): TextResult {
    return {
      ok: true,
      text: `no part records in the shared library ${this.libraryDir} yet (unzip partstyle-library.zip in ${this.dir}, or add records with part_put)`,
    };
  }

  /** part_search over the shared library, when no project is open. */
  async partSearch(query: string): Promise<TextResult> {
    const library = await this.library();
    return library ? searchParts(library, query) : this.emptyLibrary();
  }

  /** part_get from the shared library, when no project is open. */
  async partGet(id: string, tier: PartTier): Promise<TextResult> {
    const library = await this.library();
    return library ? describePart(library, id, tier) : this.emptyLibrary();
  }

  /** part_put into the shared library, when no project is open. */
  async partPut(yaml: string): Promise<TextResult> {
    const library = await this.library();
    return writePartRecord(yaml, {
      dir: this.libraryDir,
      layer: "global",
      shown: (file) => `library/${path.basename(file)}`,
      footprints: (await findKicad(this.dir, {})).footprints,
      exists: (id) => library?.has(id) ?? false,
    });
  }

  /** A project name (a folder in dir) or a path, absolute or relative to dir. */
  resolve(nameOrPath: string): string {
    return path.resolve(this.dir, nameOrPath);
  }

  /** Why a new project cannot go in `root`: it would be the shared library or inside it. */
  refuseNew(root: string): string | undefined {
    // Windows and macOS file systems ignore case by default: Library is library there.
    const fold = (p: string) => (caseless ? p.toLowerCase() : p);
    const rel = path.relative(fold(this.libraryDir), fold(path.resolve(root)));
    const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    return inside
      ? `${root} is the shared part library (${this.libraryDir}) or inside it: choose another name`
      : undefined;
  }

  private async recent(): Promise<string[]> {
    try {
      const list = JSON.parse(await readFile(path.join(this.stateDir, RECENT), "utf8")) as unknown;
      return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
    } catch {
      return [];
    }
  }

  /** Puts a project first in the recently opened list. */
  async remember(root: string): Promise<void> {
    const list = [root, ...(await this.recent()).filter((p) => !same(p, root))].slice(
      0,
      MAX_RECENT,
    );
    await mkdir(this.stateDir, { recursive: true });
    const file = path.join(this.stateDir, RECENT);
    await writeFile(`${file}.tmp`, `${JSON.stringify(list, null, 2)}\n`, "utf8");
    await rename(`${file}.tmp`, file);
  }

  /** The projects in dir, then recently opened ones elsewhere; `open` is marked. */
  async list(open?: string): Promise<TextResult> {
    const mark = (root: string) => (open !== undefined && same(root, open) ? " (open)" : "");
    const names = await readdir(this.dir, { withFileTypes: true }).catch(() => []);
    const here: string[] = [];
    for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const root = path.join(this.dir, e.name);
      if (e.isDirectory() && (await isProject(root))) here.push(`  ${e.name}${mark(root)}`);
    }
    const elsewhere: string[] = [];
    for (const root of await this.recent()) {
      if (same(path.dirname(root), this.dir) || !(await isProject(root))) continue;
      elsewhere.push(`  ${root}${mark(root)}`);
    }
    const lines =
      here.length > 0 ? [`projects in ${this.dir}:`, ...here] : [`no projects in ${this.dir} yet`];
    if (elsewhere.length > 0) lines.push("opened recently, elsewhere:", ...elsewhere);
    return { ok: true, text: lines.join("\n") };
  }
}
