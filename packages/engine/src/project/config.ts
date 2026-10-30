import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { Issue } from "../diagnostics.js";

export const distributors = ["lcsc", "digikey", "mouser"] as const;

export const ProjectConfigSchema = z.object({
  name: z.string().min(1),
  /** Block that roots the hierarchy. */
  top: z.string().min(1).default("main"),
  library: z
    .object({
      /** Global part-library folders, relative to the project root. */
      paths: z.array(z.string()).default([]),
    })
    .default({ paths: [] }),
  sourcing: z
    .object({
      distributors: z.array(z.enum(distributors)).default([]),
    })
    .default({ distributors: [] }),
  /** Overrides for KiCad discovery; normally found automatically. */
  kicad: z
    .object({
      cli: z.string().optional(),
      footprints: z.string().optional(),
      symbols: z.string().optional(),
    })
    .default({}),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

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
    data = parseToml(text);
  } catch (e) {
    const err = e as { message?: string; line?: number; column?: number };
    const message = (err.message ?? String(e)).split("\n")[0] ?? "";
    return fail(`invalid TOML: ${message}`, err.line ?? 1, err.column ?? 1);
  }
  const result = ProjectConfigSchema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    return fail(first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "invalid config");
  }
  return { config: result.data, issues: [] };
}
