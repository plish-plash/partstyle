import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Issue } from "../diagnostics.js";

/** The file that makes a folder a Partstyle project. */
export const PROJECT_FILE = "partstyle-project.yaml";

/** The block that roots the hierarchy, in circuit/main.ckt. */
export const TOP_BLOCK = "main";

export const suppliers = ["lcsc", "digikey", "mouser"] as const;
export type Supplier = (typeof suppliers)[number];

/**
 * The settings in the project file. The design context (use case, environment, interfaces) sits
 * beside them in the same file and is read by `contextChecks`; other keys are for people.
 */
export const ProjectConfigSchema = z.looseObject({
  /** The Partstyle version that created the project, for future format changes. */
  partstyle_version: z.string().optional(),
  name: z.string().min(1),
  sourcing: z
    .object({
      suppliers: z.array(z.enum(suppliers)).default([]),
    })
    .default({ suppliers: [] }),
  checks: z
    .object({
      /** A capacitor's rated voltage should be at least this many times what it sees. */
      cap_derating: z.number().min(1).default(1.5),
    })
    .default({ cap_derating: 1.5 }),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/** The project file's YAML as a mapping, or undefined if it does not parse to one. */
export function projectData(text: string): Record<string, unknown> | undefined {
  try {
    const data = parseYaml(text) as unknown;
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A variant's project file laid over main's: mappings merge key by key at any depth, lists and
 * single values replace main's, and null removes a key.
 */
export function mergeProjectData(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === null) delete out[key];
    else if (isMapping(value) && isMapping(out[key])) {
      out[key] = mergeProjectData(out[key] as Record<string, unknown>, value);
    } else out[key] = value;
  }
  return out;
}

/**
 * The project's settings and context from its project file, with a variant's overrides (another
 * file) merged over them when given.
 */
export function parseProjectConfig(
  text: string,
  file: string,
  override?: { text: string; file: string },
): { config?: ProjectConfig; issues: Issue[] } {
  const fail = (message: string, line = 1, col = 1, at = file) => ({
    issues: [
      {
        code: "project.config",
        severity: "error" as const,
        message,
        location: { file: at, line, col },
        subjects: [],
      },
    ],
  });
  const read = (t: string): { data: unknown } | { error: string; line: number; col: number } => {
    try {
      return { data: parseYaml(t) ?? {} };
    } catch (e) {
      const err = e as { message?: string; linePos?: { line: number; col: number }[] };
      const pos = err.linePos?.[0];
      return {
        error: `invalid YAML: ${(err.message ?? String(e)).split("\n")[0] ?? ""}`,
        line: pos?.line ?? 1,
        col: pos?.col ?? 1,
      };
    }
  };

  const main = read(text);
  if ("error" in main) return fail(main.error, main.line, main.col);
  let data = main.data;
  if (override) {
    const over = read(override.text);
    if ("error" in over) return fail(over.error, over.line, over.col, override.file);
    if (!isMapping(over.data)) {
      return fail("a variant's project file holds a mapping of overrides", 1, 1, override.file);
    }
    if (isMapping(data)) data = mergeProjectData(data, over.data);
  }
  const result = ProjectConfigSchema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    return fail(
      first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "invalid project file",
    );
  }
  return { config: result.data, issues: [] };
}
