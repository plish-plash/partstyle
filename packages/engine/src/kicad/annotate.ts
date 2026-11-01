/** Instance path (`PWR/C1`) → flat KiCad refdes (`C1`). */
export type Annotation = Map<string, string>;

const header = `# Partstyle annotation.lock: instance path -> KiCad reference designator.
# Kept stable across exports so the PCB keeps its parts; edit a refdes here to renumber it.
`;

export function parseAnnotationLock(text: string): Annotation {
  const table: Annotation = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+(\S+)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) table.set(m[1] as string, m[2] as string);
  }
  return table;
}

export function formatAnnotationLock(table: Annotation): string {
  const rows = [...table].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const width = Math.max(0, ...rows.map(([p]) => p.length));
  return (
    header + rows.map(([p, r]) => `${p.padEnd(width)} ${r}`).join("\n") + (rows.length ? "\n" : "")
  );
}

const localRef = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function split(ref: string): [prefix: string, n: number | undefined] {
  const m = /^(.*?)(\d+)$/.exec(ref);
  return m ? [m[1] as string, Number(m[2])] : [ref, undefined];
}

/**
 * Assigns a unique flat refdes to every instance path. Earlier assignments are kept; a new part
 * keeps its local refdes when free, otherwise takes the next number after every refdes with
 * its prefix (so it never steals another part's local name).
 */
export function annotate(
  paths: string[],
  previous: Annotation,
): { table: Annotation; renumbered: [path: string, ref: string][] } {
  const table: Annotation = new Map();
  const used = new Set<string>();
  for (const p of paths) {
    const ref = previous.get(p);
    if (ref !== undefined && !used.has(ref)) {
      table.set(p, ref);
      used.add(ref);
    }
  }

  const pending = paths.filter((p) => !table.has(p));
  const reserved = new Set(pending.map(localRef));
  const conflicts: string[] = [];
  for (const p of pending) {
    const ref = localRef(p);
    if (used.has(ref)) {
      conflicts.push(p);
    } else {
      table.set(p, ref);
      used.add(ref);
    }
  }

  const renumbered: [string, string][] = [];
  for (const p of conflicts) {
    const [prefix] = split(localRef(p));
    let max = 0;
    for (const r of [...used, ...reserved]) {
      const [pre, n] = split(r);
      if (pre === prefix && n !== undefined) max = Math.max(max, n);
    }
    const ref = `${prefix}${max + 1}`;
    table.set(p, ref);
    used.add(ref);
    renumbered.push([p, ref]);
  }
  return { table, renumbered };
}
