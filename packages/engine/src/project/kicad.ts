import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
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

/**
 * Finds kicad-cli and the stock footprint libraries: project.toml [kicad] settings first, then
 * KICAD_CLI / KICAD*_FOOTPRINT_DIR, then PATH, then the platform's usual install location.
 * kicad-cli is often not on PATH on Windows.
 */
export async function findKicad(
  root: string,
  overrides: {
    cli?: string | undefined;
    footprints?: string | undefined;
    symbols?: string | undefined;
  },
): Promise<KicadInstall> {
  let cli = overrides.cli ? path.resolve(root, overrides.cli) : process.env.KICAD_CLI;
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
    if (override) return path.resolve(root, override);
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
   * KiCad symbols to try for each part type: the record's `kicad_symbol`, else matches on its
   * MPN; for generics, the Device library's R, C, L, LED and diode symbols.
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
        ids = rankSymbolMatches(part.record, await this.index()).map((m) => ({
          libId: `${m.lib}:${m.name}`,
          explicit: false,
        }));
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

/**
 * Checks that each record's footprint exists and that its numbered pads match the pin table
 * exactly: a mismatch means a wrong pinout or footprint, which is a board respin.
 */
export async function checkFootprints(
  entries: LibraryEntry[],
  footprintsDir: string,
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
    const noPin = [...pads].filter((p) => !pins.has(p));
    if (noPad.length + noPin.length > 0) {
      const parts = [
        noPad.length > 0 ? `pins with no pad: ${noPad.join(" ")}` : "",
        noPin.length > 0 ? `pads with no pin: ${noPin.join(" ")}` : "",
      ].filter(Boolean);
      issues.push({
        code: "part.footprint-pads",
        severity: "error",
        message: `${r.id}: pin table does not match ${r.footprint} (${parts.join("; ")})`,
        location,
        subjects: [r.id],
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
