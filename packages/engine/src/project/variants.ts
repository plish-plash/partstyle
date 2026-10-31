import { appendFile, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { GitError, git, type RepoInfo } from "./git.js";

/** Variant working copies live here, inside the (gitignored) local state folder. */
export const VARIANTS_DIR = ".partstyle/variants";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

export interface Variant {
  name: string;
  branch: string;
  /** The git worktree's root. */
  worktree: string;
  /** The project folder inside it. */
  dir: string;
}

const same = (a: string, b: string) => {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
};

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
  const out = await git(root, ["worktree", "list", "--porcelain"]);
  const base = path.join(root, VARIANTS_DIR);
  const variants: Variant[] = [];
  for (const entry of out.split(/\n\n+/)) {
    const worktree = /^worktree (.+)$/m.exec(entry)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1];
    if (!worktree || !branch) continue;
    const name = path.basename(worktree);
    if (!same(path.dirname(worktree), base)) continue;
    variants.push({ name, branch, worktree, dir: path.join(worktree, info.prefix) });
  }
  return variants.sort((a, b) => a.name.localeCompare(b.name));
}

/** Makes sure git ignores the variants folder, so a checkpoint never sweeps a worktree in. */
async function ensureIgnored(root: string): Promise<boolean> {
  try {
    await git(root, ["check-ignore", "-q", `${VARIANTS_DIR}/x`]);
    return false;
  } catch {
    const file = path.join(root, ".gitignore");
    const text = await readFile(file, "utf8").catch(() => "");
    await appendFile(
      file,
      `${text === "" || text.endsWith("\n") ? "" : "\n"}.partstyle/\n`,
      "utf8",
    );
    return true;
  }
}

/** Creates a variant on a new branch from the last commit, checked out under VARIANTS_DIR. */
export async function createVariant(
  root: string,
  info: RepoInfo,
  name: string,
): Promise<{ variant: Variant; ignoredNow: boolean }> {
  const worktree = path.join(root, VARIANTS_DIR, name);
  const branch = branchFor(info, name);
  await git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => {
    throw new GitError("the repository has no commits yet: make a checkpoint first");
  });
  const ignoredNow = await ensureIgnored(root);
  await mkdir(path.dirname(worktree), { recursive: true });
  await git(root, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
  return { variant: { name, branch, worktree, dir: path.join(worktree, info.prefix) }, ignoredNow };
}

export async function removeVariant(root: string, v: Variant): Promise<void> {
  await git(root, ["worktree", "remove", "--force", v.worktree]);
  await rm(v.worktree, { recursive: true, force: true });
  await git(root, ["branch", "-D", v.branch]);
}

/** The design files a variant carries over when adopted (not exports, review or local state). */
const adoptable = (f: string) =>
  /^(circuit|parts|notes)\//.test(f) || ["context.md", "bom.lock", "annotation.lock"].includes(f);

/**
 * Copies a variant's design files over the main project's, deleting circuit files the variant
 * no longer has. Returns the paths that changed.
 */
export async function adoptVariant(root: string, v: Variant): Promise<string[]> {
  const listed = (dir: string) =>
    git(dir, ["ls-files", "-co", "--exclude-standard"]).then((out) =>
      out.split("\n").filter((f) => f && adoptable(f)),
    );
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
