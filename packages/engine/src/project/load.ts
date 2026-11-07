import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ANNOTATION_FILE } from "../kicad/annotate.js";
import type { PartSource } from "../parts/library.js";
import { PROJECT_FILE } from "./config.js";
import type { ProjectSource, TextFile } from "./source.js";
import { VARIANT_FILE, VARIANTS_DIR } from "./variants.js";

export class ProjectLoadError extends Error {}

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** Files in `dir` (not recursive) with one of the extensions, sorted; none if it is missing. */
export async function listFiles(dir: string, extensions: string[]): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return entries
    .filter((name) => extensions.some((ext) => name.endsWith(ext)))
    .sort()
    .map((name) => path.join(dir, name));
}

async function readText(root: string, file: string): Promise<TextFile> {
  return { file: rel(root, file), text: await readFile(file, "utf8") };
}

/**
 * Reads the project file, circuit/*.ckt, the global part libraries (absolute folders, from the
 * user's settings) and the project's parts/. For a variant, its block files replace main's of the
 * same name and keep their own paths (variants/NAME/circuit/x.ckt), so issues point at the file
 * to edit; its project file of overrides comes along too.
 */
export async function loadProject(
  dir: string,
  libraries: string[],
  variant?: string,
): Promise<ProjectSource> {
  const root = path.resolve(dir);
  let project: TextFile;
  try {
    project = await readText(root, path.join(root, PROJECT_FILE));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectLoadError(
        `no ${PROJECT_FILE} in ${root} (create a project with: partstyle init)`,
      );
    }
    throw e;
  }

  const own = variant === undefined ? undefined : path.join(root, VARIANTS_DIR, variant);
  if (own) {
    try {
      await readFile(path.join(own, VARIANT_FILE), "utf8");
    } catch {
      throw new ProjectLoadError(`no variant '${variant}' (see variant list)`);
    }
  }
  const byName = new Map<string, string>();
  for (const f of await listFiles(path.join(root, "circuit"), [".ckt"])) {
    byName.set(path.basename(f), f);
  }
  if (own) {
    for (const f of await listFiles(path.join(own, "circuit"), [".ckt"])) {
      byName.set(path.basename(f), f);
    }
  }
  const circuits = await Promise.all(
    [...byName.keys()].sort().map((n) => readText(root, byName.get(n) as string)),
  );

  const partFiles: { file: string; layer: PartSource["layer"] }[] = [];
  for (const lib of libraries) {
    for (const f of await listFiles(lib, [".yaml", ".yml"])) {
      partFiles.push({ file: f, layer: "global" });
    }
  }
  for (const f of await listFiles(path.join(root, "parts"), [".yaml", ".yml"])) {
    partFiles.push({ file: f, layer: "project" });
  }
  const parts = await Promise.all(
    partFiles.map(async ({ file, layer }) => ({ ...(await readText(root, file)), layer })),
  );

  const optional = (name: string) =>
    readText(root, path.join(root, name)).catch((e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    });
  const comments = await optional("comments.yaml");
  const annotation =
    (variant === undefined
      ? undefined
      : await optional(path.join(VARIANTS_DIR, variant, ANNOTATION_FILE))) ??
    (await optional(ANNOTATION_FILE));
  const projectOverride =
    variant === undefined
      ? undefined
      : await optional(path.join(VARIANTS_DIR, variant, PROJECT_FILE));
  return {
    project,
    circuits,
    parts,
    ...(comments && { comments }),
    ...(annotation && { annotation }),
    ...(variant !== undefined && { variant }),
    ...(projectOverride && { projectOverride }),
  };
}
