import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const PENDING_FILE = ".partstyle/pending.json";

/** A patch held for the person's approval (accept-before-apply mode). */
export interface PendingChange {
  /** P1, P2, ...; never reused, so an id always means one patch. */
  id: string;
  patch: string;
  /** The edits, one line each, as `apply` reports them. */
  log: string[];
  created: string;
}

interface PendingFile {
  next: number;
  changes: PendingChange[];
}

async function load(root: string): Promise<PendingFile> {
  try {
    return JSON.parse(await readFile(path.join(root, PENDING_FILE), "utf8")) as PendingFile;
  } catch {
    return { next: 1, changes: [] };
  }
}

async function save(root: string, data: PendingFile): Promise<void> {
  const file = path.join(root, PENDING_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(data, null, 1)}\n`, "utf8");
  await rename(`${file}.tmp`, file);
}

export async function readPending(root: string): Promise<PendingChange[]> {
  return (await load(root)).changes;
}

/** Holds a patch; returns its new id. */
export async function addPending(root: string, patch: string, log: string[]): Promise<string> {
  const data = await load(root);
  const id = `P${data.next++}`;
  data.changes.push({ id, patch, log, created: new Date().toISOString() });
  await save(root, data);
  return id;
}

export async function removePending(root: string, id: string): Promise<boolean> {
  const data = await load(root);
  const kept = data.changes.filter((p) => p.id !== id);
  if (kept.length === data.changes.length) return false;
  await save(root, { ...data, changes: kept });
  return true;
}
