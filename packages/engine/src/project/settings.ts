import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { isTemplatePath, type KicadOverrides } from "./kicad.js";
import { ProjectLoadError } from "./load.js";

/**
 * Per-user state shared across projects (settings and the recently opened list): ~/.partstyle,
 * or PARTSTYLE_STATE_DIR.
 */
export const defaultStateDir = () =>
  process.env.PARTSTYLE_STATE_DIR ?? path.join(homedir(), ".partstyle");

export const SETTINGS_FILE = "settings.yaml";

const SettingsSchema = z.object({
  /** The user's part-library folders, after any shared library; part_put writes to the first. */
  libraries: z.array(z.string()).default([]),
  /** Overrides for KiCad discovery; normally found automatically. */
  kicad: z
    .object({
      cli: z.string().optional(),
      footprints: z.string().optional(),
      symbols: z.string().optional(),
      /** The KiCad project template for first exports, unless a project names its own. */
      template: z.string().min(1).optional(),
    })
    .default({}),
});

/** The shared library of the projects folder the MCP server last served in global mode. */
const SHARED_LIBRARY_FILE = "shared-library.json";

/** The user's settings, with paths made absolute (relative ones are against the state folder). */
export interface Settings {
  file: string;
  /** The shared library first, when there is one, then the user's libraries. */
  libraries: string[];
  kicad: KicadOverrides;
}

/**
 * Reads settings.yaml fresh (it is small), so edits apply without reopening anything. `shared`
 * is the projects folder's library of the server asking; without it, the one the server last
 * remembered (so the CLI sees what the server does).
 */
export async function readSettings(stateDir: string, shared?: string): Promise<Settings> {
  const file = path.join(stateDir, SETTINGS_FILE);
  const text = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  const doc = parseDocument(text);
  const parsed = SettingsSchema.safeParse(doc.errors.length > 0 ? undefined : (doc.toJS() ?? {}));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const why =
      doc.errors[0]?.message.split("\n")[0] ??
      (first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "invalid");
    throw new ProjectLoadError(`${file}: ${why}`);
  }
  const abs = (p: string) => path.resolve(stateDir, p);
  const { cli, footprints, symbols, template } = parsed.data.kicad;
  const first = shared ?? (await rememberedLibrary(stateDir));
  const same = (a: string, b: string) =>
    process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const listed = parsed.data.libraries.map(abs);
  return {
    file,
    libraries: first ? [first, ...listed.filter((l) => !same(l, first))] : listed,
    kicad: {
      ...(cli !== undefined && { cli: abs(cli) }),
      ...(footprints !== undefined && { footprints: abs(footprints) }),
      ...(symbols !== undefined && { symbols: abs(symbols) }),
      // A name is looked up in KiCad's template folders; a path is against the state folder.
      ...(template !== undefined && {
        template: isTemplatePath(template) ? abs(template) : template,
      }),
    },
  };
}

async function rememberedLibrary(stateDir: string): Promise<string | undefined> {
  try {
    const { dir } = JSON.parse(
      await readFile(path.join(stateDir, SHARED_LIBRARY_FILE), "utf8"),
    ) as { dir?: unknown };
    return typeof dir === "string" ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** Remembers the global-mode server's shared library, replacing any earlier one. */
export async function rememberSharedLibrary(stateDir: string, dir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, SHARED_LIBRARY_FILE),
    `${JSON.stringify({ dir: path.resolve(dir) })}\n`,
    "utf8",
  );
}
