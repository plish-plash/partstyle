import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parsePartRecord } from "../parts/library.js";
import type { TextResult } from "../query.js";
import { checkFootprints } from "./kicad.js";

/**
 * Validates a part record and writes it to `dir` as `<id>.yaml`, refusing it when KiCad's
 * footprint libraries show its pads do not match the footprint. Shared by a project's part_put
 * and global mode's, which writes to the shared library before any project is open.
 */
export async function writePartRecord(
  yaml: string,
  opts: {
    dir: string;
    layer: "global" | "project";
    /** How the reply names the file, e.g. relative to the project. */
    shown: (file: string) => string;
    /** KiCad's footprint libraries, when found. */
    footprints: string | undefined;
    /** Whether a record with this id is already in this layer. */
    exists: (id: string) => boolean;
  },
): Promise<TextResult> {
  const { record, issues } = parsePartRecord(yaml, "<record>");
  if (!record) return { ok: false, text: issues.map((i) => i.message).join("\n") };

  const file = path.join(opts.dir, `${record.id}.yaml`);
  const shown = opts.shown(file);
  const notes: string[] = [];
  if (opts.footprints) {
    const fpIssues = await checkFootprints(
      [{ record, file: shown, layer: opts.layer, text: yaml }],
      opts.footprints,
    );
    const pads = fpIssues.find((i) => i.code === "part.footprint-pads");
    if (pads) return { ok: false, text: `${pads.message}; not written` };
    notes.push(...fpIssues.map((i) => `warning: ${i.message}`));
  } else {
    notes.push("note: KiCad footprint libraries not found, so pads were not checked");
  }
  if (!record.provenance.verified_by) notes.push("unverified until a human checks it");

  const existed = opts.exists(record.id);
  await mkdir(opts.dir, { recursive: true });
  await writeFile(file, yaml.endsWith("\n") ? yaml : `${yaml}\n`, "utf8");
  return {
    ok: true,
    text: [`${existed ? "updated" : "created"} ${shown} (lib:${record.id})`, ...notes].join("\n"),
  };
}
