import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Issue } from "../diagnostics.js";

/** The file that makes a folder a Partstyle project. */
export const PROJECT_FILE = "partstyle-project.yaml";

/** The block that roots the hierarchy, in circuit/main.ckt. */
export const TOP_BLOCK = "main";

export const distributors = ["lcsc", "digikey", "mouser"] as const;

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
      distributors: z.array(z.enum(distributors)).default([]),
    })
    .default({ distributors: [] }),
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

export function parseProjectConfig(
  text: string,
  file: string,
): { config?: ProjectConfig; issues: Issue[] } {
  const fail = (message: string, line = 1, col = 1) => ({
    issues: [
      {
        code: "project.config",
        severity: "error" as const,
        message,
        location: { file, line, col },
        subjects: [],
      },
    ],
  });

  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (e) {
    const err = e as { message?: string; linePos?: { line: number; col: number }[] };
    const message = (err.message ?? String(e)).split("\n")[0] ?? "";
    const pos = err.linePos?.[0];
    return fail(`invalid YAML: ${message}`, pos?.line ?? 1, pos?.col ?? 1);
  }
  const result = ProjectConfigSchema.safeParse(data ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    return fail(
      first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "invalid project file",
    );
  }
  return { config: result.data, issues: [] };
}
