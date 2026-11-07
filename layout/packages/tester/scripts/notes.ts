/**
 * Works with the feedback left in the tester.
 *
 *   pnpm notes                          list what is still open
 *   pnpm notes resolve <case> "<text>"  clear an addressed note, telling the reviewer what changed
 *   pnpm notes tidy                     clear the text of notes on cases marked good
 *
 * A running tester picks up changes at once. Cleared notes are kept in feedback/history.jsonl.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Entry {
  verdict?: string;
  note?: string;
  resolved?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const file = join(root, "feedback", "notes.json");
const history = join(root, "feedback", "history.jsonl");
// Feedback is gitignored, so a fresh checkout has none of it.
mkdirSync(dirname(file), { recursive: true });
const data: { cases: Record<string, Entry> } = existsSync(file)
  ? JSON.parse(readFileSync(file, "utf8"))
  : { cases: {} };

function archive(id: string, e: Entry, resolution: string) {
  const { verdict, note, updatedAt } = e;
  const record = { caseId: id, verdict, note, notedAt: updatedAt, resolution };
  appendFileSync(history, `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`);
}

const save = () => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const [command, id, text] = process.argv.slice(2);

if (command === "resolve") {
  const entry = id ? data.cases[id] : undefined;
  if (!id || !entry || !text) throw new Error('usage: pnpm notes resolve <case> "<what changed>"');
  archive(id, entry, text);
  // The verdict goes too: the layout changed, so it needs judging again.
  data.cases[id] = { note: "", resolved: text, updatedAt: new Date().toISOString() };
  save();
  console.log(`Resolved ${id}`);
} else if (command === "tidy") {
  let count = 0;
  for (const [key, entry] of Object.entries(data.cases)) {
    if (entry.verdict !== "good" || !entry.note) continue;
    archive(key, entry, "Marked good");
    entry.note = "";
    count++;
  }
  save();
  console.log(`Cleared ${count} notes on good cases`);
} else {
  for (const [key, e] of Object.entries(data.cases)) {
    if (e.verdict === "good" || (!e.note && !e.verdict)) continue;
    console.log(`${key} [${e.verdict ?? "no verdict"}]\n  ${e.note || "(no note)"}`);
    console.log(`  rules: ${JSON.stringify(e.rules ?? {})}`);
    if (e.shuffle) console.log(`  shuffle: ${e.shuffle}`);
  }
}
