import { execFile } from "node:child_process";

export class GitError extends Error {}

/** Runs git in `cwd` and returns its stdout; failures carry git's own message. */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        const text = String(stderr || stdout || error.message).trim();
        reject(new GitError(missing ? "git is not installed (or not on PATH)" : text));
      },
    );
  });
}

export interface RepoInfo {
  /** The repository's working-tree root. */
  top: string;
  /** The project folder relative to `top`, with a trailing slash ("" at the root). */
  prefix: string;
}

/** The repository holding `dir`, or undefined when it is not in one (or git is missing). */
export async function repoInfo(dir: string): Promise<RepoInfo | undefined> {
  try {
    const [top, prefix] = (await git(dir, ["rev-parse", "--show-toplevel", "--show-prefix"]))
      .split("\n")
      .map((s) => s.trim());
    return top ? { top, prefix: prefix ?? "" } : undefined;
  } catch {
    return undefined;
  }
}

/** The latest commit touching `dir`'s files: the project's last checkpoint. */
export async function lastCommit(
  dir: string,
): Promise<{ id: string; date: string; message: string } | undefined> {
  try {
    const out = (await git(dir, ["log", "-1", "--format=%H%x09%cI%x09%s", "--", "."])).trim();
    if (!out) return undefined;
    const [id, date, ...message] = out.split("\t");
    return { id: id as string, date: date as string, message: message.join("\t") };
  } catch {
    return undefined;
  }
}

/** Text of the files under `sub` (relative to `dir`) at commit `ref`, keyed by path from `dir`. */
export async function filesAt(dir: string, ref: string, sub: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const names = (await git(dir, ["ls-tree", "-r", "--name-only", ref, "--", sub]))
    .split("\n")
    .filter(Boolean);
  for (const name of names) out.set(name, await git(dir, ["show", `${ref}:./${name}`]));
  return out;
}
