import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  exposeFlags,
  type KicadNetlist,
  parseNetlistForImport,
  sheetNotes,
} from "../kicad/import.js";
import { runKicadCli } from "./kicad.js";

/** What import reads from a KiCad project through kicad-cli. */
export interface KicadDesign {
  project: string;
  rootFile: string;
  /** Each sheet file's own netlist; the root's is the whole design. */
  sheets: Map<string, KicadNetlist>;
  notes: Map<string, string[]>;
  /** Pins KiCad's ERC reports unconnected; undefined if ERC could not tell. */
  unconnected?: Set<string>;
}

const skipDirs = /^(\.git|\.partstyle|node_modules|.*-backups|\.history)$/;

/** Every .kicad_sch below `dir`, as paths relative to it. */
async function sheetFiles(dir: string, rel = "", depth = 0): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const p = path.join(rel, e.name);
    if (e.isDirectory() && depth < 4 && !skipDirs.test(e.name)) {
      out.push(...(await sheetFiles(dir, p, depth + 1)));
    } else if (e.isFile() && e.name.endsWith(".kicad_sch")) {
      out.push(p);
    }
  }
  return out;
}

/** The root schematic for a .kicad_pro, a .kicad_sch or a folder holding one project. */
async function rootSchematic(source: string): Promise<string> {
  const s = await stat(source).catch(() => undefined);
  if (!s) throw new Error(`${source} does not exist`);
  if (s.isDirectory()) {
    const entries = await readdir(source);
    const pros = entries.filter((f) => f.endsWith(".kicad_pro"));
    if (pros.length > 1) {
      throw new Error(`${source} has several KiCad projects (${pros.join(", ")}); name one`);
    }
    const sch = pros[0]
      ? pros[0].replace(/\.kicad_pro$/, ".kicad_sch")
      : entries.find((f) => f.endsWith(".kicad_sch"));
    if (!sch) throw new Error(`no KiCad project or schematic in ${source}`);
    return path.join(source, sch);
  }
  if (source.endsWith(".kicad_pro")) return source.replace(/\.kicad_pro$/, ".kicad_sch");
  if (source.endsWith(".kicad_sch")) return source;
  throw new Error(`${source} is not a .kicad_pro or .kicad_sch file`);
}

async function exportNetlist(cli: string, sch: string, out: string): Promise<KicadNetlist> {
  await runKicadCli(cli, ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", out, sch]);
  return parseNetlistForImport(await readFile(out, "utf8"));
}

/** Pins in KiCad's ERC "Pin not connected" reports, as `REF.PIN`. */
function unconnectedPins(text: string): Set<string> | undefined {
  const report = JSON.parse(text) as {
    ignored_checks?: { key: string }[];
    sheets?: { violations: { type: string; items?: { description: string }[] }[] }[];
  };
  if (report.ignored_checks?.some((c) => c.key === "pin_not_connected")) return undefined;
  const pins = new Set<string>();
  for (const s of report.sheets ?? []) {
    for (const v of s.violations) {
      if (v.type !== "pin_not_connected") continue;
      for (const i of v.items ?? []) {
        const m = /^Symbol (\S+) Pin (\S+)/.exec(i.description);
        if (m) pins.add(`${m[1]}.${m[2]}`);
      }
    }
  }
  return pins;
}

/**
 * Lets KiCad resolve the design: works on a temporary copy of its schematics (the originals are
 * never written), runs ERC for no-connect flags, then exports the whole design's netlist and each
 * sheet file's own, which carries the sheet's local net and port names.
 */
export async function readKicadDesign(cli: string, source: string): Promise<KicadDesign> {
  const root = await rootSchematic(path.resolve(source));
  const dir = path.dirname(root);
  const tmp = await mkdtemp(path.join(tmpdir(), "partstyle-import-"));
  try {
    const copy = path.join(tmp, "sch");
    const notes = new Map<string, string[]>();
    const texts = new Map<string, string>();
    for (const f of await sheetFiles(dir)) {
      await mkdir(path.dirname(path.join(copy, f)), { recursive: true });
      const t = await readFile(path.join(dir, f), "utf8");
      texts.set(f, t);
      await writeFile(path.join(copy, f), t, "utf8");
    }
    const pro = root.replace(/\.kicad_sch$/, ".kicad_pro");
    if (await stat(pro).catch(() => undefined)) {
      await copyFile(pro, path.join(copy, path.basename(pro)));
    }
    const rootRel = path.relative(dir, root);
    if (!texts.has(rootRel)) throw new Error(`${root} does not exist`);

    let unconnected: Set<string> | undefined;
    try {
      const erc = path.join(tmp, "erc.json");
      await runKicadCli(cli, [
        "sch",
        "erc",
        "--format",
        "json",
        "-o",
        erc,
        path.join(copy, rootRel),
      ]);
      unconnected = unconnectedPins(await readFile(erc, "utf8"));
    } catch {
      unconnected = undefined;
    }

    for (const [f, t] of texts) {
      notes.set(f.split(path.sep).join("/"), sheetNotes(t));
      if (t.includes("PWR_FLAG")) await writeFile(path.join(copy, f), exposeFlags(t), "utf8");
    }

    const rootNet = await exportNetlist(cli, path.join(copy, rootRel), path.join(tmp, "root.net"));
    const rootFile = rootNet.sheets.find((s) => s.names === "/")?.file || path.basename(root);
    const sheets = new Map<string, KicadNetlist>([[rootFile, rootNet]]);
    const wanted = [...new Set(rootNet.sheets.map((s) => s.file))].filter(
      (f) => f !== "" && f !== rootFile,
    );
    let n = 0;
    for (const file of wanted) {
      const rel =
        [...texts.keys()].find((k) => k.split(path.sep).join("/") === file) ??
        [...texts.keys()].find((k) => path.basename(k) === path.basename(file));
      if (!rel) throw new Error(`sheet file ${file} is not in ${dir}`);
      sheets.set(
        file,
        await exportNetlist(cli, path.join(copy, rel), path.join(tmp, `sheet${n++}.net`)),
      );
    }
    return {
      project: path.basename(root, ".kicad_sch"),
      rootFile,
      sheets,
      notes,
      ...(unconnected && { unconnected }),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
