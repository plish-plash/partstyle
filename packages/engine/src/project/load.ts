import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PartSource } from "../parts/library.js";
import { PROJECT_FILE } from "./config.js";
import type { ProjectSource, TextFile } from "./source.js";

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
 * user's settings) and the project's parts/.
 */
export async function loadProject(dir: string, libraries: string[]): Promise<ProjectSource> {
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

  const circuits = await Promise.all(
    (await listFiles(path.join(root, "circuit"), [".ckt"])).map((f) => readText(root, f)),
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
  return { project, circuits, parts, ...(comments && { comments }) };
}
