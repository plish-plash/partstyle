import { parse as parseYaml } from "yaml";
import type { Issue } from "../diagnostics.js";
import { type PartRecord, readPartRecord } from "./schema.js";

export interface PartSource {
  file: string;
  text: string;
  /** Project records override global ones with the same id. */
  layer: "global" | "project";
}

export interface LibraryEntry {
  record: PartRecord;
  file: string;
  layer: PartSource["layer"];
  /** YAML source, for full-detail reads. */
  text: string;
  /** `part.format` issues: reported only for records a design uses. */
  warnings?: Issue[];
}

export type PartLibrary = Map<string, LibraryEntry>;

/**
 * Reads a record file. Without a `record` the file is unusable (`part.yaml`, `part.schema`);
 * these are warnings, since a library file a design does not use is no fault of the design, and
 * one that does gets `elab.unknown-part`. With a `record`, `issues` are `part.format` warnings
 * and `notes` are worth saying once, when it is written.
 */
export function parsePartRecord(
  text: string,
  file: string,
): { record?: PartRecord; issues: Issue[]; notes: string[] } {
  const location = { file, line: 1, col: 1 };
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (e) {
    const message = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return {
      issues: [
        {
          code: "part.yaml",
          severity: "warning",
          message: `invalid YAML: ${message}`,
          location,
          subjects: [],
        },
      ],
      notes: [],
    };
  }
  const { record, problems, warnings, notes } = readPartRecord(data);
  if (!record) {
    return {
      issues: problems.map((message) => ({
        code: "part.schema",
        severity: "warning" as const,
        message,
        location,
        subjects: [],
      })),
      notes: [],
    };
  }
  return {
    record,
    issues: warnings.map((message) => ({
      code: "part.format",
      severity: "warning" as const,
      message: `lib:${record.id}: ${message}`,
      location,
      subjects: [record.id],
    })),
    notes,
  };
}

/** Builds the effective library: global records first, then project records override by id. */
export function buildLibrary(sources: PartSource[]): { library: PartLibrary; issues: Issue[] } {
  const library: PartLibrary = new Map();
  const issues: Issue[] = [];
  const ordered = [
    ...sources.filter((s) => s.layer === "global"),
    ...sources.filter((s) => s.layer === "project"),
  ];
  for (const source of ordered) {
    const { record, issues: recordIssues } = parsePartRecord(source.text, source.file);
    if (!record) {
      issues.push(...recordIssues);
      continue;
    }
    const existing = library.get(record.id);
    if (existing && existing.layer === source.layer) {
      issues.push({
        code: "part.duplicate-id",
        severity: "warning",
        message: `part id '${record.id}' is also defined in ${existing.file}; using this one`,
        location: { file: source.file, line: 1, col: 1 },
        subjects: [],
      });
    }
    library.set(record.id, {
      record,
      file: source.file,
      layer: source.layer,
      text: source.text,
      ...(recordIssues.length > 0 && { warnings: recordIssues }),
    });
  }
  return { library, issues };
}
