import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parsePartRecord } from "../parts/library.js";
import type { TextResult } from "../query.js";
import { checkFootprints } from "./kicad.js";

/**
 * Writes a part record to `dir` as `<id>.yaml`, refusing only one the engine cannot use at all
 * and reporting everything else for review. Shared by a project's part_put and global mode's,
 * which writes to the shared library before any project is open.
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
  const { record, issues, notes: readNotes } = parsePartRecord(yaml, "<record>");
  if (!record) return { ok: false, text: issues.map((i) => i.message).join("\n") };

  const file = path.join(opts.dir, `${record.id}.yaml`);
  const shown = opts.shown(file);
  const notes = [
    ...issues.map((i) => `warning: ${i.message}`),
    ...readNotes.map((n) => `note: ${n}`),
  ];
  if (record.extras.length > 0) {
    notes.push(`free-form sections, kept for tier full: ${record.extras.join(", ")}`);
  }
  if (record.footprint === "") {
    notes.push("note: no footprint yet, so pads were not checked");
  } else if (opts.footprints) {
    const fpIssues = await checkFootprints(
      [{ record, file: shown, layer: opts.layer, text: yaml }],
      opts.footprints,
    );
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
