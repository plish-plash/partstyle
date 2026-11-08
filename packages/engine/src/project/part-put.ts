import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
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
  // Only a person verifies a record (in the viewer), so whatever part_put writes is unverified,
  // even an update to a record that was verified. Edited as a document so comments stay.
  const doc = parseDocument(yaml);
  const claimed = doc.getIn(["provenance", "verified_by"]);
  if (claimed != null) doc.setIn(["provenance", "verified_by"], null);
  const text = claimed != null ? doc.toString() : yaml;

  const file = path.join(opts.dir, `${record.id}.yaml`);
  const before = await readFile(file, "utf8").then(
    (old) => parsePartRecord(old, file).record,
    () => undefined,
  );
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
      [{ record, file: shown, layer: opts.layer, text }],
      opts.footprints,
    );
    notes.push(...fpIssues.map((i) => `warning: ${i.message}`));
  } else {
    notes.push("note: KiCad footprint libraries not found, so pads were not checked");
  }
  notes.push(
    before?.provenance.verified_by
      ? "was verified; unverified again until a human rechecks it"
      : "unverified until a human checks it",
  );

  const existed = opts.exists(record.id);
  await mkdir(opts.dir, { recursive: true });
  await writeFile(file, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  return {
    ok: true,
    text: [`${existed ? "updated" : "created"} ${shown} (lib:${record.id})`, ...notes].join("\n"),
  };
}
