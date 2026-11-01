import { createHash } from "node:crypto";
import fs from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import * as iso from "isomorphic-git";

// Git through isomorphic-git, so checkpoints and variants work without git installed. The index
// is only written for the main line's checkpoints (to keep `git status` truthful); comparisons
// hash the working files against the commit's tree instead.

export class GitError extends Error {}

/** A variant's working copy names the repository and the branch it commits to in this file. */
export const VARIANT_MARKER = ".partstyle-variant.json";

export interface VariantMarker {
  /** The repository's git directory, relative to the working copy. */
  gitdir: string;
  branch: string;
}

export interface RepoInfo {
  /** The repository's working-tree root (a variant's working copy for a variant). */
  top: string;
  /** The project folder relative to `top`, with a trailing slash ("" at the root). */
  prefix: string;
  gitdir: string;
  /** What checkpoints advance: "HEAD" on the main line, a variant's branch otherwise. */
  ref: string;
}

interface TreeFile {
  oid: string;
  mode: string;
}

export interface Commit {
  id: string;
  /** Committer date, ISO 8601 with the committer's offset (git's %cI). */
  date: string;
  /** The first line of the message (git's %s). */
  message: string;
}

const toPosix = (p: string) => p.split(path.sep).join("/");

const isNotFound = (e: unknown) => e instanceof iso.Errors.NotFoundError;

/** What the folder `d` holds: a repository, a variant copy, nothing (undefined) or a stop (null). */
async function gitdirAt(d: string): Promise<{ gitdir: string; ref: string } | null | undefined> {
  const marker = await readFile(path.join(d, VARIANT_MARKER), "utf8").catch(() => undefined);
  if (marker !== undefined) {
    const m = JSON.parse(marker) as VariantMarker;
    return { gitdir: path.resolve(d, m.gitdir), ref: `refs/heads/${m.branch}` };
  }
  const dotgit = path.join(d, ".git");
  const st = await stat(dotgit).catch(() => undefined);
  if (st === undefined) return undefined;
  if (st.isDirectory()) return { gitdir: dotgit, ref: "HEAD" };
  // A submodule's .git file points at its repository. A git worktree's points at a folder with
  // a commondir, which isomorphic-git cannot use, so treat it as no repository.
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotgit, "utf8"));
  if (!m) return null;
  const gitdir = path.resolve(d, m[1] as string);
  return (await stat(path.join(gitdir, "commondir")).catch(() => undefined))
    ? null
    : { gitdir, ref: "HEAD" };
}

/** The repository holding `dir`, or undefined when it is not in one. */
export async function repoInfo(dir: string): Promise<RepoInfo | undefined> {
  const start = path.resolve(dir);
  for (let d = start; ; d = path.dirname(d)) {
    const found = await gitdirAt(d);
    if (found === null) return undefined;
    if (found) {
      const rel = toPosix(path.relative(d, start));
      return { top: d, prefix: rel ? `${rel}/` : "", ...found };
    }
    if (path.dirname(d) === d) return undefined;
  }
}

async function mustRepo(dir: string): Promise<RepoInfo> {
  const r = await repoInfo(dir);
  if (!r) throw new GitError("not in a git repository");
  return r;
}

export async function initRepo(dir: string): Promise<void> {
  await iso.init({ fs, dir, defaultBranch: "main" });
}

/** The commit the line points at, or undefined before its first commit. */
export function headCommit(r: RepoInfo): Promise<string | undefined> {
  return iso.resolveRef({ fs, gitdir: r.gitdir, ref: r.ref }).catch(() => undefined);
}

/** A commit id from a full or abbreviated id, a branch or HEAD. */
async function resolveCommit(r: RepoInfo, ref: string): Promise<string> {
  if (ref === "HEAD") ref = r.ref;
  try {
    return await iso.resolveRef({ fs, gitdir: r.gitdir, ref });
  } catch {
    if (/^[0-9a-f]{4,40}$/.test(ref)) {
      return iso.expandOid({ fs, gitdir: r.gitdir, oid: ref }).catch(() => {
        throw new GitError(`unknown revision ${ref}`);
      });
    }
    throw new GitError(`unknown revision ${ref}`);
  }
}

function isoDate(seconds: number, offsetMinutes: number): string {
  const local = new Date((seconds - offsetMinutes * 60) * 1000).toISOString().slice(0, 19);
  const off = Math.abs(offsetMinutes);
  const hhmm = `${String(Math.floor(off / 60)).padStart(2, "0")}:${String(off % 60).padStart(2, "0")}`;
  return `${local}${offsetMinutes <= 0 ? "+" : "-"}${hhmm}`;
}

/** Commits on the line that touch the project folder, newest first (git log -- .). */
export async function recentCommits(dir: string, depth: number): Promise<Commit[]> {
  const r = await repoInfo(dir);
  if (!r || !(await headCommit(r))) return [];
  try {
    const log = await iso.log({
      fs,
      gitdir: r.gitdir,
      ref: r.ref,
      depth,
      ...(r.prefix && { filepath: r.prefix.slice(0, -1) }),
    });
    return log.map(({ oid, commit }) => ({
      id: oid,
      date: isoDate(commit.committer.timestamp, commit.committer.timezoneOffset),
      message: (commit.message.split("\n")[0] ?? "").trim(),
    }));
  } catch (e) {
    // The project folder is in no commit yet.
    if (isNotFound(e)) return [];
    throw e;
  }
}

/** The latest commit touching `dir`'s files: the project's last checkpoint. */
export async function lastCommit(dir: string): Promise<Commit | undefined> {
  return (await recentCommits(dir, 1).catch(() => []))[0];
}

/** The files under `folder` (from the repository root, "" for all) in a commit, by path. */
async function treeFiles(
  r: RepoInfo,
  commit: string,
  folder: string,
): Promise<Map<string, TreeFile>> {
  const out = new Map<string, TreeFile>();
  let top: iso.ReadTreeResult;
  try {
    top = await iso.readTree({
      fs,
      gitdir: r.gitdir,
      oid: commit,
      ...(folder && { filepath: folder }),
    });
  } catch (e) {
    if (isNotFound(e)) return out;
    throw e;
  }
  const visit = async (entries: iso.TreeEntry[], rel: string): Promise<void> => {
    for (const e of entries) {
      const f = `${rel}${e.path}`;
      if (e.type === "blob") out.set(f, { oid: e.oid, mode: e.mode });
      else if (e.type === "tree") {
        await visit((await iso.readTree({ fs, gitdir: r.gitdir, oid: e.oid })).tree, `${f}/`);
      }
    }
  };
  await visit(top.tree, "");
  return out;
}

/** Text of the files under `sub` (relative to `dir`) at commit `ref`, keyed by path from `dir`. */
export async function filesAt(dir: string, ref: string, sub: string): Promise<Map<string, string>> {
  const r = await mustRepo(dir);
  const commit = await resolveCommit(r, ref);
  const out = new Map<string, string>();
  for (const [f, e] of await treeFiles(r, commit, `${r.prefix}${sub}`)) {
    const { blob } = await iso.readBlob({ fs, gitdir: r.gitdir, oid: e.oid });
    out.set(`${sub}/${f}`, Buffer.from(blob).toString("utf8"));
  }
  return out;
}

/** Whether git ignores `file` (relative to the repository root; a trailing "/" for folders). */
export function isIgnored(r: RepoInfo, file: string): Promise<boolean> {
  return iso.isIgnored({ fs, dir: r.top, gitdir: r.gitdir, filepath: file });
}

const blobOid = (data: Buffer) =>
  createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");

/**
 * The project's files as git would see them: on disk and not ignored (tracked files count even
 * when ignored), without local state. Compared with the line's last commit, by content.
 */
async function compare(r: RepoInfo, dir: string) {
  const commit = await headCommit(r);
  const base = commit ? await treeFiles(r, commit, r.prefix.slice(0, -1)) : new Map();
  const files = new Map<string, Buffer>();
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const f = `${rel}${e.name}`;
      if (e.name === ".git" || f === ".partstyle" || f === VARIANT_MARKER) continue;
      if (e.isDirectory()) {
        const tracked = [...base.keys()].some((k) => k.startsWith(`${f}/`));
        if (tracked || !(await isIgnored(r, `${r.prefix}${f}/`))) await walk(`${f}/`);
      } else if (e.isFile() && (base.has(f) || !(await isIgnored(r, `${r.prefix}${f}`)))) {
        files.set(f, await readFile(path.join(dir, f)));
      }
    }
  };
  await walk("");
  const changed = new Set<string>();
  for (const [f, data] of files) if (base.get(f)?.oid !== blobOid(data)) changed.add(f);
  for (const f of base.keys()) if (!files.has(f) && !f.startsWith(".partstyle/")) changed.add(f);
  return { commit, base, files, changed: [...changed].sort() };
}

/** The project's files (relative to `dir`) that git would track (git ls-files -co). */
export async function projectFiles(dir: string): Promise<string[]> {
  return [...(await compare(await mustRepo(dir), dir)).files.keys()].sort();
}

/** Project files (relative to `dir`) that differ from the line's last commit. */
export async function changedFiles(dir: string): Promise<string[]> {
  return (await compare(await mustRepo(dir), dir)).changed;
}

async function writeFolder(r: RepoInfo, files: Map<string, TreeFile>): Promise<string> {
  const here: iso.TreeEntry[] = [];
  const subs = new Map<string, Map<string, TreeFile>>();
  for (const [f, e] of files) {
    const i = f.indexOf("/");
    if (i < 0) {
      here.push({ mode: e.mode, path: f, oid: e.oid, type: "blob" });
      continue;
    }
    const name = f.slice(0, i);
    const sub = subs.get(name) ?? new Map<string, TreeFile>();
    subs.set(name, sub.set(f.slice(i + 1), e));
  }
  for (const [name, sub] of subs) {
    here.push({ mode: "040000", path: name, oid: await writeFolder(r, sub), type: "tree" });
  }
  return iso.writeTree({ fs, gitdir: r.gitdir, tree: here });
}

/** `tree` with the folder at `segments` replaced by the tree `sub`. */
async function splice(
  r: RepoInfo,
  tree: string | undefined,
  segments: string[],
  sub: string,
): Promise<string> {
  const [name, ...rest] = segments;
  if (name === undefined) return sub;
  const entries = tree ? (await iso.readTree({ fs, gitdir: r.gitdir, oid: tree })).tree : [];
  const old = entries.find((e) => e.path === name && e.type === "tree");
  const oid = await splice(r, old?.oid, rest, sub);
  return iso.writeTree({
    fs,
    gitdir: r.gitdir,
    tree: [
      ...entries.filter((e) => e.path !== name),
      { mode: "040000", path: name, oid, type: "tree" },
    ],
  });
}

/** user.name and user.email from the global git config, which isomorphic-git does not read. */
async function globalUser(): Promise<Record<string, string>> {
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
  const out: Record<string, string> = {};
  for (const file of [path.join(xdg, "git", "config"), path.join(homedir(), ".gitconfig")]) {
    let section = "";
    for (const line of (await readFile(file, "utf8").catch(() => "")).split(/\r?\n/)) {
      const s = /^\s*\[\s*([^\]\s"]+)/.exec(line);
      if (s) section = (s[1] as string).toLowerCase();
      const kv = /^\s*(name|email)\s*=\s*"?(.*?)"?\s*$/i.exec(line);
      if (section === "user" && kv)
        out[`user.${(kv[1] as string).toLowerCase()}`] = kv[2] as string;
    }
  }
  return out;
}

async function author(r: RepoInfo): Promise<{ name: string; email: string }> {
  const global = await globalUser();
  const get = async (key: string) =>
    ((await iso.getConfig({ fs, gitdir: r.gitdir, path: key })) as string | undefined) ??
    global[key];
  return {
    name: (await get("user.name")) ?? "Partstyle",
    email: (await get("user.email")) ?? "partstyle@localhost",
  };
}

/**
 * Commits the project folder (and nothing else) on its line, as `git commit -- .` would.
 * Returns the new commit, or undefined when nothing changed.
 */
export async function commitProject(dir: string, message: string): Promise<string | undefined> {
  const r = await mustRepo(dir);
  const { commit, base, files, changed } = await compare(r, dir);
  if (changed.length === 0) return undefined;

  // The working files, plus any local state an older commit happens to hold.
  const entries = new Map<string, TreeFile>();
  for (const [f, e] of base) if (f.startsWith(".partstyle/")) entries.set(f, e);
  for (const [f, data] of files) {
    const oid = await iso.writeBlob({ fs, gitdir: r.gitdir, blob: data });
    entries.set(f, { oid, mode: base.get(f)?.mode === "100755" ? "100755" : "100644" });
  }
  const root = commit && (await iso.readTree({ fs, gitdir: r.gitdir, oid: commit })).oid;
  const tree = await splice(
    r,
    root,
    r.prefix.split("/").filter(Boolean),
    await writeFolder(r, entries),
  );

  let branch: string | undefined = r.ref;
  if (r.ref === "HEAD") {
    // Stage what is committed, so the person's git sees a clean project folder.
    for (const f of changed) {
      const filepath = `${r.prefix}${f}`;
      if (files.has(f)) await iso.add({ fs, dir: r.top, gitdir: r.gitdir, filepath, force: true });
      else await iso.remove({ fs, dir: r.top, gitdir: r.gitdir, filepath });
    }
    branch = (await iso.currentBranch({ fs, gitdir: r.gitdir, fullname: true })) ?? undefined;
  }
  const id = await iso.commit({
    fs,
    gitdir: r.gitdir,
    message,
    author: await author(r),
    tree,
    parent: commit ? [commit] : [],
    ...(branch ? { ref: branch } : { noUpdateBranch: true }),
  });
  // A detached HEAD moves itself.
  if (!branch) await iso.writeRef({ fs, gitdir: r.gitdir, ref: "HEAD", value: id, force: true });
  return id;
}

/** Starts a variant: a branch at `commit` and a working copy of that commit's files in `copy`. */
export async function createVariantCopy(
  r: RepoInfo,
  commit: string,
  branch: string,
  copy: string,
): Promise<void> {
  await iso.writeRef({ fs, gitdir: r.gitdir, ref: `refs/heads/${branch}`, value: commit });
  for (const [f, e] of await treeFiles(r, commit, "")) {
    const { blob } = await iso.readBlob({ fs, gitdir: r.gitdir, oid: e.oid });
    const file = path.join(copy, f);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, blob);
  }
  const marker: VariantMarker = { gitdir: toPosix(path.relative(copy, r.gitdir)), branch };
  await writeFile(path.join(copy, VARIANT_MARKER), `${JSON.stringify(marker)}\n`, "utf8");
}

export async function readVariantMarker(copy: string): Promise<VariantMarker | undefined> {
  const text = await readFile(path.join(copy, VARIANT_MARKER), "utf8").catch(() => undefined);
  return text === undefined ? undefined : (JSON.parse(text) as VariantMarker);
}

export async function deleteBranch(r: RepoInfo, branch: string): Promise<void> {
  await iso.deleteBranch({ fs, gitdir: r.gitdir, ref: branch }).catch((e: unknown) => {
    if (!isNotFound(e)) throw e;
  });
}
