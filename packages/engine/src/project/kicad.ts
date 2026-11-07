import { execFile } from "node:child_process";
import { access, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Issue } from "../diagnostics.js";
import type { SymbolCandidate } from "../kicad/export.js";
import {
  flattenSymbol,
  genericSymbolId,
  kicadSymbol,
  rankSymbolMatches,
  type SchSymbol,
  symbolKey,
  symbolNames,
} from "../kicad/libsym.js";
import { parseSymbolLib, type SymbolLib } from "../kicad/power.js";
import { children, readSExpr } from "../kicad/sexpr.js";
import type { FlatPart } from "../netlist/elaborate.js";
import { splitGenericText } from "../parts/generic.js";
import type { LibraryEntry } from "../parts/library.js";

const run = promisify(execFile);

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export interface KicadInstall {
  cli?: string;
  footprints?: string;
  /** Stock symbol libraries; power symbols are taken from power.kicad_sym here. */
  symbols?: string;
}

const exe = process.platform === "win32" ? "kicad-cli.exe" : "kicad-cli";

/** Highest-versioned `C:\Program Files\KiCad\<version>\bin\kicad-cli.exe`. */
async function windowsInstall(): Promise<string | undefined> {
  for (const base of [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    "C:\\Program Files",
  ]) {
    if (!base) continue;
    const root = path.join(base, "KiCad");
    const versions = await readdir(root).catch(() => [] as string[]);
    versions.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
    for (const v of versions) {
      const cli = path.join(root, v, "bin", exe);
      if (await exists(cli)) return cli;
    }
  }
  return undefined;
}

/** Absolute paths that override KiCad discovery (the `kicad` section of the user's settings). */
export interface KicadOverrides {
  cli?: string;
  footprints?: string;
  symbols?: string;
  /** Project template for first exports (not discovery, but kept with the KiCad settings). */
  template?: string;
}

/**
 * Finds kicad-cli and the stock footprint libraries: the settings' overrides first, then
 * KICAD_CLI / KICAD*_FOOTPRINT_DIR, then PATH, then the platform's usual install location.
 * kicad-cli is often not on PATH on Windows.
 */
export async function findKicad(overrides: KicadOverrides = {}): Promise<KicadInstall> {
  let cli = overrides.cli ?? process.env.KICAD_CLI;
  if (!cli) {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (dir && (await exists(path.join(dir, exe)))) {
        cli = path.join(dir, exe);
        break;
      }
    }
  }
  if (!cli) {
    const candidates =
      process.platform === "win32"
        ? [await windowsInstall()]
        : process.platform === "darwin"
          ? ["/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"]
          : ["/usr/bin/kicad-cli", "/usr/local/bin/kicad-cli"];
    for (const c of candidates) if (c && (await exists(c))) cli = c;
  }

  /** A stock library folder (`footprints`, `symbols`) next to kicad-cli or in a system location. */
  const libraryDir = async (kind: string, override: string | undefined, envs: string[]) => {
    if (override) return override;
    for (const e of envs) if (process.env[e]) return process.env[e];
    const candidates = [
      ...(cli
        ? [
            path.resolve(path.dirname(cli), "..", "share", "kicad", kind),
            path.resolve(path.dirname(cli), "..", "SharedSupport", kind),
          ]
        : []),
      `/usr/share/kicad/${kind}`,
      `/usr/local/share/kicad/${kind}`,
    ];
    for (const c of candidates) if (await exists(c)) return c;
    return undefined;
  };
  const footprints = await libraryDir("footprints", overrides.footprints, [
    "KICAD10_FOOTPRINT_DIR",
    "KICAD9_FOOTPRINT_DIR",
  ]);
  const symbols = await libraryDir("symbols", overrides.symbols, [
    "KICAD10_SYMBOL_DIR",
    "KICAD9_SYMBOL_DIR",
  ]);
  return { ...(cli && { cli }), ...(footprints && { footprints }), ...(symbols && { symbols }) };
}

/** Whether a `kicad.template` value is a folder path rather than a template name. */
export const isTemplatePath = (t: string) => /[\\/]/.test(t) || t.startsWith(".");

const hasProject = async (dir: string) =>
  (await readdir(dir).catch(() => [] as string[])).some((f) => f.endsWith(".kicad_pro"));

/** Folders holding KiCad project templates: the user's first, then KiCad's own. */
async function templateDirs(cli: string | undefined): Promise<string[]> {
  const versioned = async (base: string) => {
    const versions = await readdir(base).catch(() => [] as string[]);
    versions.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
    return versions.map((v) => path.join(base, v, "template"));
  };
  const home = homedir();
  const candidates = [
    process.env.KICAD_USER_TEMPLATE_DIR,
    ...(await versioned(path.join(home, "Documents", "KiCad"))),
    ...(await versioned(path.join(home, ".local", "share", "kicad"))),
    process.env.KICAD10_TEMPLATE_DIR,
    process.env.KICAD9_TEMPLATE_DIR,
    ...(cli
      ? [
          path.resolve(path.dirname(cli), "..", "share", "kicad", "template"),
          path.resolve(path.dirname(cli), "..", "SharedSupport", "template"),
        ]
      : []),
    "/usr/share/kicad/template",
    "/usr/local/share/kicad/template",
  ];
  const found: string[] = [];
  for (const c of candidates) if (c && (await exists(c)) && !found.includes(c)) found.push(c);
  return found;
}

/**
 * The folder of a KiCad project template: `value` is a folder path (relative to `base`) or the
 * name of a template in KiCad's template folders. `known` lists the names found, for a message.
 */
export async function findKicadTemplate(
  value: string,
  base: string,
  cli: string | undefined,
): Promise<{ dir?: string; known: string[] }> {
  if (isTemplatePath(value) || path.isAbsolute(value)) {
    const dir = path.resolve(base, value);
    return (await hasProject(dir)) ? { dir, known: [] } : { known: [] };
  }
  const known = new Set<string>();
  for (const d of await templateDirs(cli)) {
    if (await hasProject(path.join(d, value))) return { dir: path.join(d, value), known: [] };
    for (const name of await readdir(d).catch(() => [] as string[])) {
      if (await hasProject(path.join(d, name))) known.add(name);
    }
  }
  return { known: [...known].sort() };
}

/**
 * Starts a KiCad project folder from a template: everything but its schematic, its local
 * settings (.kicad_prl) and meta/ (the template's own description), with the project, board and
 * design rules renamed after `project`. Existing files are never overwritten. Returns what was
 * copied.
 */
export async function applyKicadTemplate(
  templateDir: string,
  kicadDir: string,
  project: string,
): Promise<string[]> {
  const entries = await readdir(templateDir, { withFileTypes: true });
  const pro = entries.find((e) => e.isFile() && e.name.endsWith(".kicad_pro"));
  const base = pro ? pro.name.slice(0, -".kicad_pro".length) : "";
  await mkdir(kicadDir, { recursive: true });
  const copied: string[] = [];
  for (const e of entries) {
    if (e.name === "meta" || /\.kicad_(sch|prl)$/.test(e.name)) continue;
    const renamed = /^(.*)\.(kicad_pro|kicad_pcb|kicad_dru)$/.exec(e.name);
    const name = renamed && renamed[1] === base ? `${project}.${renamed[2]}` : e.name;
    const to = path.join(kicadDir, name);
    if (await exists(to)) continue;
    await cp(path.join(templateDir, e.name), to, { recursive: true });
    if (name.endsWith(".kicad_pro")) {
      // KiCad records the project's own file name inside it.
      try {
        const json = JSON.parse(await readFile(to, "utf8")) as { meta?: Record<string, unknown> };
        json.meta = { ...json.meta, filename: name };
        await writeFile(to, `${JSON.stringify(json, null, 2)}\n`, "utf8");
      } catch {
        // Left as the template had it: KiCad still opens it.
      }
    }
    copied.push(name);
  }
  return copied;
}

/**
 * KiCad's stock symbol libraries. Parsing all of them is slow (hundreds of MB), so names are
 * indexed by a text scan and a library is parsed only when one of its symbols is needed.
 */
export class KicadSymbolLibraries {
  private names?: Promise<{ lib: string; name: string }[]>;
  private readonly libs = new Map<string, Promise<SymbolLib | undefined>>();

  constructor(readonly dir: string) {}

  /** Every top-level symbol name, with its library nickname (the file name). */
  index(): Promise<{ lib: string; name: string }[]> {
    this.names ??= (async () => {
      const files = (await readdir(this.dir)).filter((f) => f.endsWith(".kicad_sym")).sort();
      const all: { lib: string; name: string }[] = [];
      for (const f of files) {
        const text = await readFile(path.join(this.dir, f), "utf8");
        const lib = f.slice(0, -".kicad_sym".length);
        for (const name of symbolNames(text)) all.push({ lib, name });
      }
      return all;
    })();
    return this.names;
  }

  /** A parsed library by nickname (`power`, `Device`), or undefined if not installed. */
  library(lib: string): Promise<SymbolLib | undefined> {
    let p = this.libs.get(lib);
    if (!p) {
      p = readFile(path.join(this.dir, `${lib}.kicad_sym`), "utf8").then(
        (text) => parseSymbolLib(text),
        () => undefined,
      );
      this.libs.set(lib, p);
    }
    return p;
  }

  /** A symbol by `Lib:Name`, flattened and ready to place. */
  async symbol(libId: string): Promise<SchSymbol | undefined> {
    const [lib, name] = libId.split(":");
    if (!lib || !name) return undefined;
    const library = await this.library(lib);
    const flat = library && flattenSymbol(library, name);
    return flat && kicadSymbol(libId, flat);
  }

  /**
   * KiCad symbols to try for each part type: the record's `kicad_symbol`, else the symbol of the
   * generic it satisfies, then matches on its MPN; for generics, the Device library's R, C, L, LED
   * and diode symbols.
   */
  async candidates(parts: FlatPart[]): Promise<Map<string, SymbolCandidate[]>> {
    const out = new Map<string, SymbolCandidate[]>();
    for (const part of parts) {
      const key = symbolKey(part);
      if (out.has(key)) continue;
      let ids: { libId: string; explicit: boolean }[] = [];
      if (part.spec.kind === "generic") {
        const id = genericSymbolId(part.spec.fn, part.spec.args);
        if (id) ids = [{ libId: id, explicit: false }];
      } else if (part.record?.kicad_symbol) {
        ids = [{ libId: part.record.kicad_symbol, explicit: true }];
      } else if (part.record) {
        const satisfied = part.record.generic ? splitGenericText(part.record.generic) : undefined;
        const generic = satisfied && genericSymbolId(satisfied.fn, satisfied.args);
        ids = [
          ...(generic ? [{ libId: generic, explicit: false }] : []),
          ...rankSymbolMatches(part.record, await this.index()).map((m) => ({
            libId: `${m.lib}:${m.name}`,
            explicit: false,
          })),
        ];
      }
      const list: SymbolCandidate[] = [];
      for (const { libId, explicit } of ids) {
        const symbol = await this.symbol(libId);
        list.push({ libId, explicit, ...(symbol && { symbol }) });
      }
      out.set(key, list);
    }
    return out;
  }
}

export async function runKicadCli(cli: string, args: string[]): Promise<{ stdout: string }> {
  const { stdout } = await run(cli, args, { timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  return { stdout };
}

/** Pad numbers of a KiCad footprint, or undefined if the library or footprint is not found. */
export async function footprintPads(
  footprintsDir: string,
  footprint: string,
): Promise<Set<string> | undefined> {
  const [lib, name] = footprint.split(":");
  if (!lib || !name) return undefined;
  const text = await readFile(
    path.join(footprintsDir, `${lib}.pretty`, `${name}.kicad_mod`),
    "utf8",
  ).catch(() => undefined);
  if (text === undefined) return undefined;
  const pads = children(readSExpr(text), "pad")
    .map((p) => (typeof p[1] === "string" ? p[1] : ""))
    .filter((n) => n !== "");
  return new Set(pads);
}

/** A mounting pad: part of the PCB land, not the part's pinout. */
const mountingPad = /^MP\d*$/i;

/**
 * Checks that each record's footprint exists and that its numbered pads match the pin table.
 * A mismatch may be a wrong pinout or footprint, or a pad the datasheet doesn't list, so it is a
 * warning for the person to review. `users` gives the parts using each record, so that a waiver
 * can name them.
 */
export async function checkFootprints(
  entries: LibraryEntry[],
  footprintsDir: string,
  users: (id: string) => string[] = () => [],
): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const e of entries) {
    const r = e.record;
    // An import draft without a footprint is already flagged part.draft.
    if (r.footprint === "") continue;
    const location = { file: e.file, line: 1, col: 1 };
    const pads = await footprintPads(footprintsDir, r.footprint);
    if (!pads) {
      issues.push({
        code: "part.footprint-missing",
        severity: "warning",
        message: `${r.id}: footprint ${r.footprint} is not in the KiCad libraries at ${footprintsDir}`,
        location,
        subjects: [r.id],
      });
      continue;
    }
    const pins = new Set(Object.keys(r.pins));
    const noPad = [...pins].filter((p) => !pads.has(p));
    const noPin = [...pads].filter((p) => !pins.has(p) && !mountingPad.test(p));
    if (noPad.length + noPin.length > 0) {
      const parts = [
        noPad.length > 0 ? `pins with no pad: ${noPad.join(" ")}` : "",
        noPin.length > 0 ? `pads with no pin: ${noPin.join(" ")}` : "",
      ].filter(Boolean);
      issues.push({
        code: "part.footprint-pads",
        severity: "warning",
        message: `${r.id}: pin table does not match ${r.footprint} (${parts.join("; ")})`,
        location,
        subjects: [r.id, ...users(r.id)],
      });
    }
  }
  return issues;
}

export interface ErcViolation {
  severity: string;
  type: string;
  description: string;
  sheet: string;
  items: string[];
}

/** Violations from `kicad-cli sch erc --format json`. */
export function parseErcJson(text: string): ErcViolation[] {
  const report = JSON.parse(text) as {
    sheets?: {
      path: string;
      violations: {
        severity: string;
        type: string;
        description: string;
        items?: { description: string }[];
      }[];
    }[];
  };
  return (report.sheets ?? []).flatMap((s) =>
    s.violations.map((v) => ({
      severity: v.severity,
      type: v.type,
      description: v.description,
      sheet: s.path,
      items: (v.items ?? []).map((i) => i.description),
    })),
  );
}
