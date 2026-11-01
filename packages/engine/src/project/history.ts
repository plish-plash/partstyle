import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { diffCircuits, type StatementChange } from "../versions/diff.js";
import { filesAt, lastCommit } from "./git.js";
import type { TextFile } from "./source.js";

export const HISTORY_FILE = ".partstyle/history.json";

/** Edits closer together than this are one changeset: roughly, one turn of the AI's work. */
export const BURST_MS = 60_000;

export type ChangeSource = "edit" | "apply" | "revert" | "accept" | "adopt" | "import";

/** Circuit file texts by project-relative path; null where the file did not exist. */
export type FileStates = Record<string, string | null>;

export interface Changeset {
  /** C1, C2, ... numbered from the last checkpoint. */
  id: string;
  source: ChangeSource;
  /** What made it: the patch's edits, the reverted id, the adopted variant. */
  note?: string;
  time: string;
  updated: string;
  before: FileStates;
  after: FileStates;
}

interface State {
  /** The commit the log counts from; null when the project has none (or no git). */
  checkpoint: string | null;
  /** Circuit files as last recorded. */
  snapshot: Record<string, string>;
  changesets: Changeset[];
  next: number;
  /** Circuit files when `diff --since last` last ran. */
  seen?: Record<string, string>;
}

export const toFiles = (states: FileStates | Record<string, string>): TextFile[] =>
  Object.entries(states).flatMap(([file, text]) => (text === null ? [] : [{ file, text }]));

/** The statement changes a changeset made, in a stable order (its items, C3.1, C3.2, ...). */
export const changesOf = (c: Changeset): StatementChange[] =>
  diffCircuits(toFiles(c.before), toFiles(c.after));

/** The project's circuit files on disk. */
export async function readCircuits(root: string): Promise<Record<string, string>> {
  const dir = path.join(root, "circuit");
  const out: Record<string, string> = {};
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  for (const name of names.filter((n) => n.endsWith(".ckt")).sort()) {
    out[`circuit/${name}`] = await readFile(path.join(dir, name), "utf8");
  }
  return out;
}

/**
 * The changeset log since the last checkpoint, kept in .partstyle/history.json. Every recorded
 * difference between the circuit on disk and the last snapshot becomes a changeset; direct file
 * edits made in quick succession merge into one. Calls are serialized within a process.
 */
export class History {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly root: string) {}

  private file() {
    return path.join(this.root, HISTORY_FILE);
  }

  /** Runs `op` after every earlier call has finished. */
  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<State | undefined> {
    try {
      return JSON.parse(await readFile(this.file(), "utf8")) as State;
    } catch {
      return undefined;
    }
  }

  private async write(state: State): Promise<void> {
    const file = this.file();
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 1)}\n`, "utf8");
    await rename(tmp, file);
  }

  /** The state, restarted from the checkpoint when it has moved (a commit made outside). */
  private async current(): Promise<State> {
    const checkpoint = (await lastCommit(this.root))?.id ?? null;
    const state = await this.read();
    if (state && state.checkpoint === checkpoint) return state;
    const snapshot = checkpoint
      ? Object.fromEntries(await filesAt(this.root, checkpoint, "circuit"))
      : state
        ? state.snapshot
        : await readCircuits(this.root);
    const fresh = { checkpoint, snapshot, changesets: [], next: 1 };
    this.restarted.add(fresh);
    return fresh;
  }

  /** States made by `current` that are not on disk yet. */
  private restarted = new WeakSet<State>();

  /**
   * Logs whatever changed on disk since the last record as a changeset from `source`. Returns
   * it, or undefined when nothing changed the circuit (formatting and comments do not count).
   */
  record(source: ChangeSource = "edit", note?: string): Promise<Changeset | undefined> {
    return this.serial(async () => {
      const state = await this.current();
      const now = await readCircuits(this.root);
      const paths = [...new Set([...Object.keys(state.snapshot), ...Object.keys(now)])].filter(
        (p) => state.snapshot[p] !== now[p],
      );
      const before: FileStates = Object.fromEntries(
        paths.map((p) => [p, state.snapshot[p] ?? null]),
      );
      const after: FileStates = Object.fromEntries(paths.map((p) => [p, now[p] ?? null]));
      state.snapshot = now;
      if (paths.length === 0 || diffCircuits(toFiles(before), toFiles(after)).length === 0) {
        // Write only what is new: the viewer watches this file, and must not wake itself.
        if (paths.length > 0 || this.restarted.has(state)) await this.write(state);
        return undefined;
      }

      const time = new Date();
      const last = state.changesets.at(-1);
      if (
        source === "edit" &&
        last?.source === "edit" &&
        time.getTime() - Date.parse(last.updated) < BURST_MS
      ) {
        for (const p of paths) {
          if (!(p in last.before)) last.before[p] = before[p] ?? null;
          last.after[p] = after[p] ?? null;
        }
        last.updated = time.toISOString();
        // Edits that undid themselves leave nothing to show.
        if (changesOf(last).length === 0) state.changesets.pop();
        await this.write(state);
        return last;
      }
      const changeset: Changeset = {
        id: `C${state.next++}`,
        source,
        ...(note !== undefined && { note }),
        time: time.toISOString(),
        updated: time.toISOString(),
        before,
        after,
      };
      state.changesets.push(changeset);
      await this.write(state);
      return changeset;
    });
  }

  async changesets(): Promise<{ checkpoint: string | null; changesets: Changeset[] }> {
    await this.record();
    const state = await this.serial(() => this.current());
    return { checkpoint: state.checkpoint, changesets: state.changesets };
  }

  /** Starts a fresh log after a checkpoint. */
  restart(): Promise<void> {
    return this.serial(async () => {
      const checkpoint = (await lastCommit(this.root))?.id ?? null;
      await this.write({
        checkpoint,
        snapshot: await readCircuits(this.root),
        changesets: [],
        next: 1,
      });
    });
  }

  /** The circuit when `diff --since last` last ran, replaced by the current one. */
  swapSeen(now: Record<string, string>): Promise<Record<string, string> | undefined> {
    return this.serial(async () => {
      const state = await this.current();
      const seen = state.seen;
      state.seen = now;
      await this.write(state);
      return seen;
    });
  }
}
