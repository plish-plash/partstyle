import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PartSource } from "../parts/library.js";
import { parseProjectConfig } from "./config.js";
import type { ProjectSource, TextFile } from "./source.js";

export class ProjectLoadError extends Error {}

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

async function listFiles(dir: string, extensions: string[]): Promise<string[]> {
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

/** Reads project.toml, circuit/*.ckt, the configured global part libraries and project parts/. */
export async function loadProject(dir: string): Promise<ProjectSource> {
  const root = path.resolve(dir);
  let config: TextFile;
  try {
    config = await readText(root, path.join(root, "project.toml"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectLoadError(`no project.toml in ${root}`);
    }
    throw e;
  }

  const circuits = await Promise.all(
    (await listFiles(path.join(root, "circuit"), [".ckt"])).map((f) => readText(root, f)),
  );

  // A broken config is reported by validateProject; here we just skip the global libraries.
  const libraryPaths = parseProjectConfig(config.text, config.file).config?.library.paths ?? [];
  const partFiles: { file: string; layer: PartSource["layer"] }[] = [];
  for (const lib of libraryPaths) {
    for (const f of await listFiles(path.resolve(root, lib), [".yaml", ".yml"])) {
      partFiles.push({ file: f, layer: "global" });
    }
  }
  for (const f of await listFiles(path.join(root, "parts"), [".yaml", ".yml"])) {
    partFiles.push({ file: f, layer: "project" });
  }
  const parts = await Promise.all(
    partFiles.map(async ({ file, layer }) => ({ ...(await readText(root, file)), layer })),
  );

  return { config, circuits, parts };
}
