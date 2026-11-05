import type { NetDecl, PartDecl, Statement, StatementKind } from "../ckt/ast.js";
import { parseCkt } from "../ckt/parser.js";
import { printLayout, printPinRef, printSpec, printStatement } from "../ckt/print.js";
import { keyOf, statementsOf } from "../patch.js";
import type { TextFile } from "../project/source.js";

/**
 * One statement that differs between two versions of a design: added (no `before`), removed
 * (no `after`) or modified. Statements are compared in canonical printed form, so formatting,
 * comments and ordering do not count as changes.
 */
export interface StatementChange {
  block: string;
  /** The .ckt file the block lives in (after the change, or before it for a removed block). */
  file: string;
  kind: StatementKind;
  /** Part ref, net or port name, instance, nc pin, waived subject, or the block name. */
  key: string;
  /** Printed statement(s); waivers sharing a subject are joined by newlines. */
  before?: string;
  after?: string;
  /** Only the layout hint of a part or use changed: presentation, not circuit. */
  layout?: true;
}

export type ChangeOp = "+" | "-" | "~";

export const opOf = (c: StatementChange): ChangeOp =>
  c.before === undefined ? "+" : c.after === undefined ? "-" : "~";

interface Entry {
  file: string;
  printed: string;
  /** For comparison: net pins sorted, since their order means nothing. */
  canonical: string;
  /** The same without its layout hint. */
  circuit: string;
}

const canonical = (s: Statement): string =>
  s.kind === "net"
    ? printStatement({
        kind: "net",
        decl: {
          ...s.decl,
          pins: [...s.decl.pins].sort((a, b) => cmp(printPinRef(a), printPinRef(b))),
        },
      })
    : printStatement(s);

const withoutLayout = (s: Statement): Statement => {
  if (s.kind === "part" || s.kind === "use") {
    const { layout: _, ...decl } = s.decl;
    return { ...s, decl } as Statement;
  }
  return s;
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every statement of a design, keyed `block|kind|key`. */
function index(files: TextFile[]): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const f of files) {
    if (!f.file.endsWith(".ckt")) continue;
    const { ast } = parseCkt(f.text, f.file);
    const block = ast.block.name;
    for (const s of statementsOf(ast)) {
      const id = `${block}|${s.kind}|${keyOf(s)}`;
      const prev = out.get(id);
      // Several waivers may share a subject: keep them together as one entry.
      const entry: Entry =
        prev && s.kind === "waive"
          ? {
              file: f.file,
              printed: `${prev.printed}\n${printStatement(s)}`,
              canonical: [prev.canonical, canonical(s)].sort().join("\n"),
              circuit: [prev.canonical, canonical(s)].sort().join("\n"),
            }
          : {
              file: f.file,
              printed: printStatement(s),
              canonical: canonical(s),
              circuit: canonical(withoutLayout(s)),
            };
      out.set(id, entry);
    }
  }
  return out;
}

const kindOrder: StatementKind[] = ["block", "port", "part", "use", "net", "nc", "waive"];

/** The statements that differ between two sets of circuit files, in block then statement order. */
export function diffCircuits(before: TextFile[], after: TextFile[]): StatementChange[] {
  const a = index(before);
  const b = index(after);
  const changes: StatementChange[] = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id);
    const y = b.get(id);
    if (x && y && x.canonical === y.canonical) continue;
    const [block, kind, key] = id.split("|") as [string, StatementKind, string];
    changes.push({
      block,
      file: (y ?? x)?.file as string,
      kind,
      key,
      ...(x && { before: x.printed }),
      ...(y && { after: y.printed }),
      ...(x && y && x.circuit === y.circuit && { layout: true as const }),
    });
  }
  return changes.sort(
    (p, q) =>
      cmp(p.block, q.block) ||
      kindOrder.indexOf(p.kind) - kindOrder.indexOf(q.kind) ||
      cmp(p.key, q.key),
  );
}

/** The parsed statement of a printed one, for describing what about it changed. */
function parsed(printed: string) {
  return parseCkt(`block x\n${printed}\n`, "<diff>").ast;
}
const netOf = (printed: string): NetDecl | undefined => parsed(printed).nets[0];

/** One terse line for a change: `+ part C9 cap(...)`, `~ net +5V +U2.VIN -C3.1`, `- part R4`. */
export function describeChange(c: StatementChange): string {
  const op = opOf(c);
  if (op === "+") return `+ ${(c.after as string).split("\n").join("; ")}`;
  if (op === "-") return `- ${c.kind} ${c.key}`;
  if (c.layout) {
    const hint = (printed: string) => {
      const { parts, uses } = parsed(printed);
      return printLayout(parts[0]?.layout ?? uses[0]?.layout).trim() || "auto";
    };
    return `~ ${c.kind} ${c.key} layout ${hint(c.after as string)} (was ${hint(c.before as string)})`;
  }
  if (c.kind === "net") {
    const x = netOf(c.before as string);
    const y = netOf(c.after as string);
    if (x && y) {
      const was = new Set(x.pins.map(printPinRef));
      const now = new Set(y.pins.map(printPinRef));
      const pinDelta = [
        ...[...now].filter((p) => !was.has(p)).map((p) => `+${p}`),
        ...[...was].filter((p) => !now.has(p)).map((p) => `-${p}`),
      ];
      const rest = (n: NetDecl) => printStatement({ kind: "net", decl: { ...n, pins: [] } });
      if (rest(x) === rest(y)) return `~ net ${c.key} ${pinDelta.join(" ")}`;
    }
  }
  if (c.kind === "part") {
    // Name only what changed: the spec, the intent, or both.
    const x = parsed(c.before as string).parts[0];
    const y = parsed(c.after as string).parts[0];
    if (x && y && printLayout(x.layout) === printLayout(y.layout)) {
      const spec = (p: PartDecl) => printSpec(p.spec);
      const intent = (p: PartDecl) => (p.intent === undefined ? "(no intent)" : `@ ${p.intent}`);
      if (x.intent === y.intent) return `~ part ${c.key} ${spec(y)} (was ${spec(x)})`;
      if (spec(x) === spec(y)) return `~ part ${c.key} ${intent(y)} (was ${intent(x)})`;
    }
  }
  const head = `${c.kind} ${c.key}`;
  const tail = (s: string) => (s.startsWith(head) ? s.slice(head.length).trim() : s);
  return `~ ${head} ${tail(c.after as string)} (was ${tail(c.before as string)})`;
}

/**
 * Changes grouped by block, one line each; a block added or removed as a whole is one line with
 * its size rather than every statement in it.
 */
export function formatChanges(changes: StatementChange[], ids?: string[]): string[] {
  const lines: string[] = [];
  const blocks = [...new Set(changes.map((c) => c.block))];
  for (const block of blocks) {
    const mine = changes.filter((c) => c.block === block);
    const whole = mine.find((c) => c.kind === "block" && opOf(c) !== "~");
    if (whole) {
      const count = (k: StatementKind) => mine.filter((c) => c.kind === k).length;
      const id = ids ? `${ids[changes.indexOf(whole)]} ` : "";
      lines.push(
        `${id}${opOf(whole)} block ${block} (${whole.file}: ${count("part")} parts, ${count("net")} nets)`,
      );
      continue;
    }
    lines.push(`${block}:`);
    // Without ids to revert by, layout edits are one line: the AI only needs to know they happened.
    const folded = ids ? [] : mine.filter((c) => c.layout);
    for (const c of mine) {
      if (folded.includes(c)) continue;
      const id = ids ? `${ids[changes.indexOf(c)]} ` : "";
      lines.push(`  ${id}${describeChange(c)}`);
    }
    if (folded.length > 0) lines.push(`  layout edited: ${folded.map((c) => c.key).join(" ")}`);
  }
  return lines;
}
