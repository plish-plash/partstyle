import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { PROJECT_FILE } from "./config.js";

/**
 * Variants are alternative versions of the design that share everything they do not change.
 * Each is a folder `variants/NAME/` in the project, committed with it: `variant.yaml`, the block
 * files it overrides (`circuit/*.ckt`), and optionally a project file of overrides. Every other
 * block comes from main, so edits to main reach the variant.
 */
export const VARIANTS_DIR = "variants";
export const VARIANT_FILE = "variant.yaml";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

export interface VariantMeta {
  description?: string;
  /** For each block file copied from main (circuit/x.ckt): main's text hash at the copy. */
  base: Record<string, string>;
}

export interface Variant extends VariantMeta {
  name: string;
  /** The variant's folder. */
  dir: string;
}

export const hashText = (text: string) =>
  createHash("sha1").update(text).digest("hex").slice(0, 12);

export const variantDir = (root: string, name: string) => path.join(root, VARIANTS_DIR, name);

export function checkVariantName(name: string): string | undefined {
  if (name === "main") return "'main' is the main circuit; choose another variant name";
  return NAME.test(name)
    ? undefined
    : `variant names are letters, digits, '.', '_' and '-' (got '${name}')`;
}

function parseMeta(text: string): VariantMeta {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch {
    data = undefined;
  }
  const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const base = typeof d.base === "object" && d.base !== null ? d.base : {};
  return {
    ...(typeof d.description === "string" &&
      d.description !== "" && {
        description: d.description,
      }),
    base: Object.fromEntries(
      Object.entries(base).filter((e): e is [string, string] => typeof e[1] === "string"),
    ),
  };
}

export async function readVariant(root: string, name: string): Promise<Variant | undefined> {
  const dir = variantDir(root, name);
  const text = await readFile(path.join(dir, VARIANT_FILE), "utf8").catch(() => undefined);
  return text === undefined ? undefined : { name, dir, ...parseMeta(text) };
}

export async function writeMeta(v: Variant): Promise<void> {
  const data = {
    ...(v.description !== undefined && { description: v.description }),
    ...(Object.keys(v.base).length > 0 && { base: v.base }),
  };
  const body = Object.keys(data).length > 0 ? stringifyYaml(data) : "";
  await writeFile(
    path.join(v.dir, VARIANT_FILE),
    `# A Partstyle variant: the blocks in circuit/ replace main's; every other block is main's.\n${body}`,
    "utf8",
  );
}

export async function listVariants(root: string): Promise<Variant[]> {
  const names = await readdir(path.join(root, VARIANTS_DIR)).catch(() => [] as string[]);
  const found = await Promise.all(names.map((n) => readVariant(root, n)));
  return found
    .filter((v): v is Variant => v !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function createVariant(
  root: string,
  name: string,
  description?: string,
): Promise<Variant> {
  const v: Variant = {
    name,
    dir: variantDir(root, name),
    base: {},
    ...(description?.trim() && { description: description.trim() }),
  };
  await mkdir(v.dir, { recursive: true });
  await writeMeta(v);
  return v;
}

export async function removeVariant(v: Variant): Promise<void> {
  await rm(v.dir, { recursive: true, force: true });
}

/** Main's circuit files with a variant's laid over them, file by file. */
export function overlayCircuits(
  main: Record<string, string>,
  overlay: Record<string, string>,
): Record<string, string> {
  return { ...main, ...overlay };
}

/** The variant's own block files, and those whose main copy changed since the variant copied it. */
export function forkStatus(
  v: Variant,
  main: Record<string, string>,
  own: Record<string, string>,
): { blocks: string[]; diverged: string[] } {
  const blocks = Object.keys(own).sort();
  const diverged = blocks.filter((f) => {
    const base = v.base[f];
    const now = main[f];
    return base !== undefined && now !== undefined && hashText(now) !== base;
  });
  return { blocks, diverged };
}

/** Whether a variant has a project file of overrides. */
export async function hasProjectOverrides(v: Variant): Promise<boolean> {
  return readFile(path.join(v.dir, PROJECT_FILE), "utf8").then(
    () => true,
    () => false,
  );
}
