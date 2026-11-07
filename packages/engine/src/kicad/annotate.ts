/**
 * Refdes reserved for the parts of extra copies of reused blocks, by instance path and the
 * refdes the block declares: `F2/R1` → `R3`. Every other part's refdes is the one its block
 * declares.
 */
export type Annotation = Map<string, string>;

export const ANNOTATION_FILE = "annotation.lock";

const header = `# Partstyle annotation.lock: refdes reserved for extra copies of reused blocks.
# instance path and the refdes the block declares -> the copy's refdes. Maintained by Partstyle.
`;

export function parseAnnotationLock(text: string): Annotation {
  const table: Annotation = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+(\S+)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) table.set(m[1] as string, m[2] as string);
  }
  return table;
}

/** The lock's text, or empty when nothing is reserved (the file is then left out). */
export function formatAnnotationLock(table: Annotation): string {
  if (table.size === 0) return "";
  const rows = [...table].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const width = Math.max(0, ...rows.map(([p]) => p.length));
  return `${header}${rows.map(([p, r]) => `${p.padEnd(width)} ${r}`).join("\n")}\n`;
}
