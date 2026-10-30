import { parse as parseYaml } from "yaml";
import type { Issue } from "../diagnostics.js";
import { type PartRecord, PartRecordSchema } from "./schema.js";

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
}

export type PartLibrary = Map<string, LibraryEntry>;

export function parsePartRecord(
  text: string,
  file: string,
): { record?: PartRecord; issues: Issue[] } {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (e) {
    const message = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return {
      issues: [
        {
          code: "part.yaml",
          severity: "error",
          message: `invalid YAML: ${message}`,
          location: { file, line: 1, col: 1 },
          subjects: [],
        },
      ],
    };
  }
  const result = PartRecordSchema.safeParse(data);
  if (!result.success) {
    return {
      issues: result.error.issues.map((i) => ({
        code: "part.schema",
        severity: "error" as const,
        message: `${i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message}`,
        location: { file, line: 1, col: 1 },
        subjects: [],
      })),
    };
  }
  return { record: result.data, issues: [] };
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
    issues.push(...recordIssues);
    if (!record) continue;
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
    library.set(record.id, { record, file: source.file, layer: source.layer, text: source.text });
  }
  return { library, issues };
}
