import type { Issue, Location } from "../diagnostics.js";
import {
  type BlockDecl,
  type CktFile,
  type NetDecl,
  type PartSpec,
  type PinRef,
  type PortKind,
  portKinds,
  type Statement,
} from "./ast.js";
import { lexLine, type Token, type TokenKind } from "./lexer.js";

class StatementError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

/** Walks the tokens of a single statement; throws StatementError on a mismatch. */
class Cursor {
  private i = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly line: string,
  ) {}

  peek(): Token | undefined {
    return this.tokens[this.i];
  }

  atEnd(): boolean {
    return this.i >= this.tokens.length;
  }

  is(kind: TokenKind, text?: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === kind && (text === undefined || t.text === text);
  }

  next(): Token {
    const t = this.peek();
    if (!t) throw new StatementError("unexpected end of line", this.line.length);
    this.i++;
    return t;
  }

  expect(kind: TokenKind, what: string): Token {
    const t = this.peek();
    if (!t || t.kind !== kind) {
      const found = t ? `'${this.line.slice(t.start, t.end)}'` : "end of line";
      throw new StatementError(`expected ${what}, found ${found}`, t?.start ?? this.line.length);
    }
    this.i++;
    return t;
  }

  optionalIntent(): string | undefined {
    return this.is("intent") ? this.next().text : undefined;
  }

  expectEnd(): void {
    const t = this.peek();
    if (t) {
      throw new StatementError(`unexpected '${this.line.slice(t.start, t.end)}'`, t.start);
    }
  }

  /** Raw source text of the tokens up to (not including) the first token of one of `stops`. */
  rawUntil(stops: TokenKind[], what: string): string {
    const first = this.peek();
    let last: Token | undefined;
    while (!this.atEnd() && !stops.includes((this.peek() as Token).kind)) last = this.next();
    if (!first || !last) {
      throw new StatementError(`expected ${what}`, first?.start ?? this.line.length);
    }
    return this.line.slice(first.start, last.end);
  }
}

const reservedNameChars = /[./]/;

function checkName(token: Token, what: string): string {
  if (reservedNameChars.test(token.text)) {
    throw new StatementError(`${what} '${token.text}' must not contain '.' or '/'`, token.start);
  }
  return token.text;
}

function isPortKind(text: string): text is PortKind {
  return (portKinds as readonly string[]).includes(text);
}

function syntaxIssue(message: string, location: Location): Issue {
  return { code: "parse.syntax", severity: "error", message, location, subjects: [] };
}

/** Parses `REF.PIN`; returns undefined unless a '.' separates two non-empty parts. */
export function parsePinRef(text: string, location: Location): PinRef | undefined {
  const dot = text.indexOf(".");
  if (dot <= 0 || dot === text.length - 1) return undefined;
  return { target: text.slice(0, dot), pin: text.slice(dot + 1), location };
}

/**
 * Parses a single .ckt line. Returns no statement for blank or comment-only lines, or when the
 * line has errors.
 */
export function parseStatement(
  line: string,
  lineNo: number,
  file: string,
): { statement?: Statement; issues: Issue[] } {
  const loc = (offset: number): Location => ({ file, line: lineNo, col: offset + 1 });
  const { tokens, errors } = lexLine(line);
  const issues = errors.map((e) => syntaxIssue(e.message, loc(e.offset)));
  if (tokens.length === 0 || issues.length > 0) return { issues };

  try {
    return { statement: parseTokens(new Cursor(tokens, line), loc), issues };
  } catch (e) {
    if (!(e instanceof StatementError)) throw e;
    return { issues: [syntaxIssue(e.message, loc(e.offset))] };
  }
}

function parseTokens(c: Cursor, loc: (offset: number) => Location): Statement {
  const keyword = c.expect("word", "a statement keyword");
  const location = loc(keyword.start);

  switch (keyword.text) {
    case "block": {
      const name = checkName(c.expect("word", "block name"), "block name");
      const description = c.is("string") ? c.next().text : undefined;
      c.expectEnd();
      return {
        kind: "block",
        decl: { name, location, ...(description !== undefined && { description }) },
      };
    }
    case "port": {
      const name = checkName(c.expect("word", "port name"), "port name");
      c.expect("colon", "':'");
      const kindToken = c.expect("word", "port kind");
      if (!isPortKind(kindToken.text)) {
        throw new StatementError(
          `unknown port kind '${kindToken.text}' (expected one of: ${portKinds.join(", ")})`,
          kindToken.start,
        );
      }
      c.expectEnd();
      return { kind: "port", decl: { name, kind: kindToken.text, location } };
    }
    case "part": {
      const ref = checkName(c.expect("word", "reference designator"), "reference designator");
      const head = c.expect("word", "'lib:ID' or 'generic(...)'");
      let spec: PartSpec;
      if (c.is("colon")) {
        if (head.text !== "lib") {
          throw new StatementError(`unknown part source '${head.text}:'`, head.start);
        }
        c.next();
        spec = { kind: "lib", id: c.expect("word", "part id").text };
      } else if (c.is("lparen")) {
        c.next();
        const args: string[] = [];
        if (!c.is("rparen")) {
          for (;;) {
            args.push(c.rawUntil(["comma", "rparen"], "argument"));
            if (c.is("rparen")) break;
            c.expect("comma", "',' or ')'");
          }
        }
        c.expect("rparen", "')'");
        spec = { kind: "generic", fn: head.text, args };
      } else {
        throw new StatementError("expected 'lib:ID' or 'generic(...)'", head.start);
      }
      const intent = c.optionalIntent();
      c.expectEnd();
      return {
        kind: "part",
        decl: { ref, spec, location, ...(intent !== undefined && { intent }) },
      };
    }
    case "net": {
      const name = checkName(c.expect("word", "net name"), "net name");
      c.expect("colon", "':'");
      const pins: PinRef[] = [];
      while (c.is("word")) {
        const t = c.next();
        const ref = parsePinRef(t.text, loc(t.start));
        if (!ref) throw new StatementError(`expected REF.PIN, found '${t.text}'`, t.start);
        pins.push(ref);
      }
      if (pins.length === 0) throw new StatementError("a net needs at least one pin", keyword.end);

      const net: NetDecl = { name, pins, attrs: {}, location };
      while (c.is("arrow") || c.is("lbrace")) {
        if (c.is("arrow")) {
          const arrow = c.next();
          if (net.port !== undefined) {
            throw new StatementError("net already has a port", arrow.start);
          }
          const kw = c.expect("word", "'port'");
          if (kw.text !== "port") throw new StatementError("expected 'port'", kw.start);
          net.port = checkName(c.expect("word", "port name"), "port name");
        } else {
          c.next();
          while (!c.is("rbrace")) {
            const key = c.expect("word", "attribute name");
            c.expect("colon", "':'");
            const value = c.rawUntil(["comma", "rbrace"], "attribute value");
            if (key.text in net.attrs) {
              throw new StatementError(`duplicate attribute '${key.text}'`, key.start);
            }
            net.attrs[key.text] = value;
            if (!c.is("rbrace")) c.expect("comma", "',' or '}'");
          }
          c.next();
        }
      }
      const intent = c.optionalIntent();
      if (intent !== undefined) net.intent = intent;
      c.expectEnd();
      return { kind: "net", decl: net };
    }
    case "use": {
      const block = c.expect("word", "block name").text;
      const as = c.expect("word", "'as'");
      if (as.text !== "as") throw new StatementError("expected 'as'", as.start);
      const instance = checkName(c.expect("word", "instance name"), "instance name");
      const intent = c.optionalIntent();
      c.expectEnd();
      return {
        kind: "use",
        decl: { block, instance, location, ...(intent !== undefined && { intent }) },
      };
    }
    case "waive": {
      const subject = c.expect("word", "waiver subject").text;
      const code = c.is("word") ? c.next().text : undefined;
      const reason = c.expect("string", "quoted reason").text;
      c.expectEnd();
      return {
        kind: "waive",
        decl: { subject, reason, location, ...(code !== undefined && { code }) },
      };
    }
    default:
      throw new StatementError(
        `unknown statement '${keyword.text}' (expected block, port, part, net, use or waive)`,
        keyword.start,
      );
  }
}

/** Parses one .ckt file. Errors are reported per line, and parsing continues with the next line. */
export function parseCkt(text: string, file: string): { ast: CktFile; issues: Issue[] } {
  const issues: Issue[] = [];
  let block: BlockDecl | undefined;
  const ast: Omit<CktFile, "block"> = {
    file,
    ports: [],
    parts: [],
    nets: [],
    uses: [],
    waivers: [],
  };

  text.split(/\r?\n/).forEach((line, index) => {
    const { statement, issues: lineIssues } = parseStatement(line, index + 1, file);
    issues.push(...lineIssues);
    if (!statement) return;
    switch (statement.kind) {
      case "block":
        if (block) {
          issues.push(syntaxIssue("a file declares exactly one block", statement.decl.location));
        } else if (ast.ports.length + ast.parts.length + ast.nets.length + ast.uses.length > 0) {
          issues.push(syntaxIssue("'block' must be the first statement", statement.decl.location));
        } else {
          block = statement.decl;
        }
        break;
      case "port":
        ast.ports.push(statement.decl);
        break;
      case "part":
        ast.parts.push(statement.decl);
        break;
      case "net":
        ast.nets.push(statement.decl);
        break;
      case "use":
        ast.uses.push(statement.decl);
        break;
      case "waive":
        ast.waivers.push(statement.decl);
        break;
    }
  });

  if (!block) {
    const stem = file.replace(/^.*\//, "").replace(/\.ckt$/, "");
    issues.push({
      code: "parse.missing-block",
      severity: "error",
      message: `file has no 'block' statement; assuming 'block ${stem}'`,
      location: { file, line: 1, col: 1 },
      subjects: [],
    });
    block = { name: stem, location: { file, line: 1, col: 1 } };
  }
  return { ast: { ...ast, block }, issues };
}
