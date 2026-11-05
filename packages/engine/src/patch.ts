import type { CktFile, PinRef, Statement, StatementKind } from "./ckt/ast.js";
import { parseCkt, parsePinRef, parseStatement } from "./ckt/parser.js";
import { printPinRef, printStatement } from "./ckt/print.js";
import type { Issue } from "./diagnostics.js";
import type { ProjectSource, TextFile } from "./project/source.js";

export interface PatchResult {
  /** Patch errors, located in `<patch>`. Non-empty means nothing was applied. */
  issues: Issue[];
  /** The project with the patch applied (unchanged on error). */
  source: ProjectSource;
  /** Files whose text changed, including created ones. */
  changed: TextFile[];
  /** One line per applied edit. */
  log: string[];
}

const PATCH_FILE = "<patch>";

class PatchError extends Error {}

/** Statement order within a file; new statements go after the last one of the same or an earlier kind. */
const kindOrder: StatementKind[] = ["block", "port", "part", "use", "net", "nc", "waive"];

/** What identifies a statement within its block: a part's ref, a net's name, and so on. */
export function keyOf(s: Statement): string {
  switch (s.kind) {
    case "block":
    case "port":
    case "net":
      return s.decl.name;
    case "part":
      return s.decl.ref;
    case "use":
      return s.decl.instance;
    case "nc":
      return printPinRef(s.decl.pin);
    case "waive":
      return s.decl.subject;
  }
}

/** A file's statements in canonical order: block, ports, parts, uses, nets, ncs, waivers. */
export function statementsOf(ast: CktFile): Statement[] {
  return [
    { kind: "block", decl: ast.block },
    ...ast.ports.map((decl) => ({ kind: "port" as const, decl })),
    ...ast.parts.map((decl) => ({ kind: "part" as const, decl })),
    ...ast.uses.map((decl) => ({ kind: "use" as const, decl })),
    ...ast.nets.map((decl) => ({ kind: "net" as const, decl })),
    ...ast.ncs.map((decl) => ({ kind: "nc" as const, decl })),
    ...ast.waivers.map((decl) => ({ kind: "waive" as const, decl })),
  ];
}

/**
 * A replacement part or use keeps the layout hint of the statement it replaces unless it gives
 * one (`[]` clears it): an edit to a value must not undo the human's layout.
 */
function keepLayout(s: Statement, old: Statement): Statement {
  if (s.kind === "part" && old.kind === "part" && s.decl.layout === undefined) {
    return old.decl.layout ? { kind: "part", decl: { ...s.decl, layout: old.decl.layout } } : s;
  }
  if (s.kind === "use" && old.kind === "use" && s.decl.layout === undefined) {
    return old.decl.layout ? { kind: "use", decl: { ...s.decl, layout: old.decl.layout } } : s;
  }
  return s;
}

const removableKinds = new Set<string>(["port", "part", "use", "net", "nc", "waive"]);
const reservedNameChars = /[./]/;

/** One .ckt file being edited. Re-parsed after every edit so line numbers stay correct. */
class FileEdit {
  lines: string[];
  readonly eol: string;
  ast!: CktFile;
  /** Whether the file has a real block statement (parseCkt invents one when it is missing). */
  private hasBlock = false;

  constructor(
    readonly file: string,
    /** Undefined for a file the patch creates. */
    readonly original: string | undefined,
  ) {
    const text = original ?? "";
    this.eol = text.includes("\r\n") ? "\r\n" : "\n";
    this.lines = text === "" ? [] : text.split(/\r?\n/);
    this.commit();
  }

  get text(): string {
    return this.lines.join(this.eol);
  }

  private commit(): void {
    const { ast, issues } = parseCkt(this.text, this.file);
    this.ast = ast;
    this.hasBlock = !issues.some((i) => i.code === "parse.missing-block");
  }

  private statements(): Statement[] {
    return statementsOf(this.ast).filter((s) => s.kind !== "block" || this.hasBlock);
  }

  private find(kind: StatementKind, key: string): Statement[] {
    return this.statements().filter((s) => s.kind === kind && keyOf(s) === key);
  }

  /** Applies line replacements (string) and deletions (null), bottom-up so numbers stay valid. */
  private rewrite(edits: Map<number, string | null>): void {
    for (const line of [...edits.keys()].sort((a, b) => b - a)) {
      const text = edits.get(line);
      if (text === null || text === undefined) this.lines.splice(line - 1, 1);
      else this.lines[line - 1] = text;
    }
    this.commit();
  }

  add(s: Statement): void {
    if (s.kind === "block") {
      if (this.hasBlock || this.lines.some((l) => l.trim() !== "")) {
        throw new PatchError(`${this.file} already has a block statement`);
      }
      this.lines = [printStatement(s), ""];
      this.hasBlock = true;
      this.commit();
      return;
    }
    // Parts and instances share a namespace; several waivers may share a subject.
    const namespace: StatementKind[] =
      s.kind === "part" || s.kind === "use" ? ["part", "use"] : [s.kind];
    const clash =
      s.kind === "waive"
        ? undefined
        : this.statements().find((t) => namespace.includes(t.kind) && keyOf(t) === keyOf(s));
    if (clash) {
      throw new PatchError(
        `${clash.kind} ${keyOf(s)} already exists in ${this.ast.block.name} (line ${clash.decl.location.line}); use '=' to replace it`,
      );
    }
    const rank = kindOrder.indexOf(s.kind);
    const before = this.statements().filter((t) => kindOrder.indexOf(t.kind) <= rank);
    const after = Math.max(0, ...before.map((t) => t.decl.location.line));
    this.lines.splice(after === 0 ? this.lines.length : after, 0, printStatement(s));
    this.commit();
  }

  replace(s: Statement): void {
    const existing = this.find(s.kind, keyOf(s));
    if (existing.length === 0) {
      throw new PatchError(`no ${s.kind} ${keyOf(s)} in ${this.ast.block.name}; use '+' to add it`);
    }
    if (existing.length > 1) {
      throw new PatchError(`${s.kind} ${keyOf(s)} is declared more than once; remove one first`);
    }
    const old = existing[0] as Statement;
    this.rewrite(new Map([[old.decl.location.line, printStatement(keepLayout(s, old))]]));
  }

  /** Removes a statement, and pinrefs/port bindings that pointed at it. Returns follow-on notes. */
  remove(kind: StatementKind, key: string): string[] {
    const existing = this.find(kind, key);
    if (existing.length === 0) throw new PatchError(`no ${kind} ${key} in ${this.ast.block.name}`);
    const edits = new Map<number, string | null>(existing.map((s) => [s.decl.location.line, null]));
    const notes: string[] = [];

    for (const net of this.ast.nets) {
      if (edits.has(net.location.line)) continue;
      if (kind === "part" || kind === "use") {
        const pins = net.pins.filter((p) => p.target !== key);
        if (pins.length === net.pins.length) continue;
        if (pins.length === 0) {
          edits.set(net.location.line, null);
          notes.push(`removed net ${net.name} (no pins left)`);
        } else {
          edits.set(net.location.line, printStatement({ kind: "net", decl: { ...net, pins } }));
          notes.push(`disconnected from net ${net.name}`);
        }
      } else if (kind === "port" && net.port === key) {
        const { port: _, ...rest } = net;
        edits.set(net.location.line, printStatement({ kind: "net", decl: rest }));
        notes.push(`unbound from net ${net.name}`);
      }
    }
    if (kind === "part" || kind === "use") {
      for (const n of this.ast.ncs) {
        if (n.pin.target === key) {
          edits.set(n.location.line, null);
          notes.push(`removed nc ${printPinRef(n.pin)}`);
        }
      }
      for (const w of this.ast.waivers) {
        if (w.subject === key || w.subject.startsWith(`${key}.`)) {
          edits.set(w.location.line, null);
          notes.push(`removed waiver ${w.subject}`);
        }
      }
    }
    this.rewrite(edits);
    return notes;
  }

  netPins(name: string, op: "+=" | "-=", refs: PinRef[]): void {
    const net = this.ast.nets.find((n) => n.name === name);
    if (!net) throw new PatchError(`no net ${name} in ${this.ast.block.name}`);
    const present = new Set(net.pins.map(printPinRef));
    let pins: PinRef[];
    if (op === "+=") {
      const dup = refs.find((r) => present.has(printPinRef(r)));
      if (dup) throw new PatchError(`${printPinRef(dup)} is already on net ${name}`);
      pins = [...net.pins, ...refs];
    } else {
      const missing = refs.find((r) => !present.has(printPinRef(r)));
      if (missing) throw new PatchError(`${printPinRef(missing)} is not on net ${name}`);
      const drop = new Set(refs.map(printPinRef));
      pins = net.pins.filter((p) => !drop.has(printPinRef(p)));
      if (pins.length === 0) {
        throw new PatchError(`net ${name} would have no pins; use '- net ${name}' instead`);
      }
    }
    this.rewrite(
      new Map([[net.location.line, printStatement({ kind: "net", decl: { ...net, pins } })]]),
    );
  }

  rename(kind: "part" | "use" | "net", from: string, to: string): void {
    if (reservedNameChars.test(to)) throw new PatchError(`'${to}' must not contain '.' or '/'`);
    const existing = this.find(kind, from)[0];
    if (!existing) throw new PatchError(`no ${kind} ${from} in ${this.ast.block.name}`);
    const taken =
      kind === "net"
        ? this.find("net", to)[0]
        : (this.find("part", to)[0] ?? this.find("use", to)[0]);
    if (taken) throw new PatchError(`${taken.kind} ${to} already exists in ${this.ast.block.name}`);

    const edits = new Map<number, string | null>();
    const set = (s: Statement) => edits.set(s.decl.location.line, printStatement(s));
    if (existing.kind === "part") set({ kind: "part", decl: { ...existing.decl, ref: to } });
    if (existing.kind === "use") set({ kind: "use", decl: { ...existing.decl, instance: to } });

    for (const net of this.ast.nets) {
      if (kind === "net") {
        if (net.name === from) set({ kind: "net", decl: { ...net, name: to } });
      } else if (net.pins.some((p) => p.target === from)) {
        const pins = net.pins.map((p) => (p.target === from ? { ...p, target: to } : p));
        set({ kind: "net", decl: { ...net, pins } });
      }
    }
    for (const n of this.ast.ncs) {
      if (kind !== "net" && n.pin.target === from) {
        set({ kind: "nc", decl: { ...n, pin: { ...n.pin, target: to } } });
      }
    }
    for (const w of this.ast.waivers) {
      const renamed =
        w.subject === from
          ? to
          : kind !== "net" && w.subject.startsWith(`${from}.`)
            ? to + w.subject.slice(from.length)
            : undefined;
      if (renamed !== undefined) set({ kind: "waive", decl: { ...w, subject: renamed } });
    }
    this.rewrite(edits);
  }
}

function parseEdit(text: string, lineNo: number): Statement {
  const { statement, issues } = parseStatement(text, lineNo, PATCH_FILE);
  if (!statement) throw new PatchError(issues[0]?.message ?? "expected a statement");
  return statement;
}

/**
 * Applies a patch in the .ckt patch language (see docs/ckt-grammar.md). Atomic: on the first
 * error, nothing is applied and the error is returned.
 */
export function applyPatch(source: ProjectSource, patch: string): PatchResult {
  const files = new Map<string, FileEdit>();
  const blockFiles = new Map<string, string>();
  for (const c of source.circuits) {
    const edit = new FileEdit(c.file, c.text);
    files.set(c.file, edit);
    blockFiles.set(edit.ast.block.name, c.file);
  }

  const log: string[] = [];
  let target: FileEdit | undefined =
    files.size === 1 ? (files.values().next().value as FileEdit) : undefined;

  const lines = patch.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const lineNo = index + 1;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    try {
      const words = line.split(/\s+/);
      const head = words[0] as string;

      if (head === "in") {
        const name = words[1];
        if (name === undefined || words.length > 2) throw new PatchError("usage: in BLOCK");
        const file = blockFiles.get(name) ?? `circuit/${name}.ckt`;
        if (!files.has(file)) {
          if (source.circuits.some((c) => c.file === file)) {
            throw new PatchError(`${file} exists but does not declare block ${name}`);
          }
          files.set(file, new FileEdit(file, undefined));
          blockFiles.set(name, file);
        }
        target = files.get(file);
        continue;
      }

      if (!target) {
        throw new PatchError("start the patch with 'in BLOCK' to say which block to edit");
      }
      const t: FileEdit = target;
      const where = t.ast.block.name;
      const statement =
        head === "+" || head === "="
          ? parseEdit(raw.slice(raw.indexOf(head) + 1), lineNo)
          : undefined;
      if (t.lines.length === 0 && !(head === "+" && statement?.kind === "block")) {
        throw new PatchError(
          `block ${where} is new; its first edit must be '+ block ${where} ...'`,
        );
      }

      if (statement) {
        if (head === "=") {
          t.replace(statement);
        } else {
          if (statement.kind === "block" && blockFiles.get(statement.decl.name) !== t.file) {
            throw new PatchError(
              `'+ block ${statement.decl.name}' must follow 'in ${statement.decl.name}'`,
            );
          }
          t.add(statement);
        }
        log.push(`${where}: ${head} ${printStatement(statement)}`);
      } else if (head === "-") {
        const [, kind, key, ...extra] = words;
        if (
          kind === undefined ||
          key === undefined ||
          extra.length > 0 ||
          !removableKinds.has(kind)
        ) {
          throw new PatchError("usage: - part|net|port|use|nc|waive KEY");
        }
        const notes = t.remove(kind as StatementKind, key);
        log.push(`${where}: - ${kind} ${key}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`);
      } else if (head === "net" && (words[2] === "+=" || words[2] === "-=")) {
        const name = words[1] as string;
        const refs = words.slice(3).map((w) => {
          const ref = parsePinRef(w, { file: PATCH_FILE, line: lineNo, col: 1 });
          if (!ref) throw new PatchError(`expected REF.PIN, found '${w}'`);
          return ref;
        });
        if (refs.length === 0) throw new PatchError(`usage: net NAME ${words[2]} REF.PIN ...`);
        t.netPins(name, words[2], refs);
        log.push(`${where}: net ${name} ${words[2]} ${refs.map(printPinRef).join(" ")}`);
      } else if (head === "rename") {
        const [, kind, from, to, ...extra] = words;
        if (
          (kind !== "part" && kind !== "use" && kind !== "net") ||
          from === undefined ||
          to === undefined ||
          extra.length > 0
        ) {
          throw new PatchError("usage: rename part|use|net OLD NEW");
        }
        t.rename(kind, from, to);
        log.push(`${where}: rename ${kind} ${from} -> ${to}`);
      } else {
        throw new PatchError(
          `unknown edit '${head}' (expected in, +, =, -, net NAME +=/-=, or rename)`,
        );
      }
    } catch (e) {
      if (!(e instanceof PatchError)) throw e;
      return {
        issues: [
          {
            code: "patch.error",
            severity: "error",
            message: `${e.message}; nothing was applied`,
            location: { file: PATCH_FILE, line: lineNo, col: 1 },
            subjects: [],
          },
        ],
        source,
        changed: [],
        log: [],
      };
    }
  }

  const changed = [...files.values()]
    .filter((f) => f.text !== (f.original ?? ""))
    .map((f) => ({ file: f.file, text: f.text }));
  const byFile = new Map(changed.map((c) => [c.file, c]));
  const circuits = [
    ...source.circuits.map((c) => byFile.get(c.file) ?? c),
    ...changed.filter((c) => !source.circuits.some((s) => s.file === c.file)),
  ];
  return { issues: [], source: { ...source, circuits }, changed, log };
}
