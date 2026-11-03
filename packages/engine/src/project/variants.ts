import { appendFile, copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { PROJECT_FILE } from "./config.js";
import {
  createVariantCopy,
  deleteBranch,
  GitError,
  headCommit,
  isIgnored,
  projectFiles,
  type RepoInfo,
  readVariantMarker,
} from "./git.js";

/** Variant working copies live here, inside the (gitignored) local state folder. */
export const VARIANTS_DIR = ".partstyle/variants";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

export interface Variant {
  name: string;
  branch: string;
  /** The working copy's root: the whole repository's files at the variant's branch. */
  copy: string;
  /** The project folder inside it. */
  dir: string;
}

function branchFor(info: RepoInfo, name: string): string {
  const project = (info.prefix.replace(/\/$/, "") || path.basename(info.top)).replace(
    /[^A-Za-z0-9._-]+/g,
    "-",
  );
  return `variant/${project}/${name}`;
}

export function checkVariantName(name: string): string | undefined {
  return NAME.test(name)
    ? undefined
    : `variant names are letters, digits, '.', '_' and '-' (got '${name}')`;
}

export async function listVariants(root: string, info: RepoInfo): Promise<Variant[]> {
  const base = path.join(root, VARIANTS_DIR);
  const variants: Variant[] = [];
  for (const name of await readdir(base).catch(() => [])) {
    const copy = path.join(base, name);
    const marker = await readVariantMarker(copy);
    if (!marker) continue;
    variants.push({ name, branch: marker.branch, copy, dir: path.join(copy, info.prefix) });
  }
  return variants.sort((a, b) => a.name.localeCompare(b.name));
}

/** Makes sure git ignores the variants folder, so a checkpoint never sweeps a copy in. */
async function ensureIgnored(root: string, info: RepoInfo): Promise<boolean> {
  if (await isIgnored(info, `${info.prefix}${VARIANTS_DIR}/x`)) return false;
  const file = path.join(root, ".gitignore");
  const text = await readFile(file, "utf8").catch(() => "");
  await appendFile(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}.partstyle/\n`, "utf8");
  return true;
}

/** Creates a variant on a new branch from the last commit, copied out under VARIANTS_DIR. */
export async function createVariant(
  root: string,
  info: RepoInfo,
  name: string,
): Promise<{ variant: Variant; ignoredNow: boolean }> {
  const copy = path.join(root, VARIANTS_DIR, name);
  const branch = branchFor(info, name);
  const commit = await headCommit(info);
  if (!commit) throw new GitError("the repository has no commits yet: make a checkpoint first");
  const ignoredNow = await ensureIgnored(root, info);
  await createVariantCopy(info, commit, branch, copy);
  return { variant: { name, branch, copy, dir: path.join(copy, info.prefix) }, ignoredNow };
}

export async function removeVariant(info: RepoInfo, v: Variant): Promise<void> {
  await rm(v.copy, { recursive: true, force: true });
  await deleteBranch(info, v.branch);
}

/** The design files a variant carries over when adopted (not exports, review or local state). */
const adoptable = (f: string) =>
  /^(circuit|parts|notes)\//.test(f) || [PROJECT_FILE, "bom.lock", "annotation.lock"].includes(f);

/**
 * Copies a variant's design files over the main project's, deleting circuit files the variant
 * no longer has. Returns the paths that changed.
 */
export async function adoptVariant(root: string, v: Variant): Promise<string[]> {
  const listed = async (dir: string) => (await projectFiles(dir)).filter(adoptable);
  const theirs = await listed(v.dir);
  const ours = await listed(root);
  const changed: string[] = [];
  for (const f of theirs) {
    const from = path.join(v.dir, f);
    const to = path.join(root, f);
    const [a, b] = await Promise.all([
      readFile(from, "utf8"),
      readFile(to, "utf8").catch(() => undefined),
    ]);
    if (a === b) continue;
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    changed.push(f);
  }
  for (const f of ours) {
    if (f.startsWith("circuit/") && !theirs.includes(f)) {
      await rm(path.join(root, f));
      changed.push(f);
    }
  }
  return changed;
}
