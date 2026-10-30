/**
 * KiCad S-expressions. A list's first element is its keyword (written bare); other strings are
 * written quoted, numbers bare, and `Sym` atoms bare (`yes`, `passive`, `line`).
 */
export type SExpr = string | number | Sym | SExpr[];

export interface Sym {
  sym: string;
}

export const sym = (s: string): Sym => ({ sym: s });

const isSym = (x: unknown): x is Sym => typeof x === "object" && x !== null && "sym" in x;

/** KiCad booleans: `yes` / `no`. */
export const yesNo = (b: boolean): Sym => sym(b ? "yes" : "no");

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Fixed-point with trailing zeros dropped, so coordinates print as KiCad writes them. */
function formatNumber(n: number): string {
  const s = n.toFixed(4).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

function atom(x: string | number | Sym): string {
  if (typeof x === "number") return formatNumber(x);
  if (isSym(x)) return x.sym;
  return quote(x);
}

/** Writes with KiCad's layout: atoms inline, each sub-list on its own tab-indented line. */
export function writeSExpr(expr: SExpr[], indent = 0): string {
  const [head, ...rest] = expr;
  const pad = "\t".repeat(indent);
  const parts: string[] = [
    `${pad}(${typeof head === "string" ? head : atom(head as number | Sym)}`,
  ];
  let hasChildren = false;
  for (const x of rest) {
    if (Array.isArray(x)) {
      hasChildren = true;
      parts.push(`\n${writeSExpr(x, indent + 1)}`);
    } else {
      parts.push(` ${atom(x)}`);
    }
  }
  parts.push(hasChildren ? `\n${pad})` : ")");
  return parts.join("");
}

export class SExprSyntaxError extends Error {}

/**
 * Reads one S-expression. List heads come back as plain strings; other bare atoms come back as
 * numbers when numeric, otherwise `Sym`; quoted atoms are strings.
 */
export function readSExpr(text: string): SExpr[] {
  let i = 0;
  const skip = () => {
    while (i < text.length && /\s/.test(text.charAt(i))) i++;
  };

  function readList(): SExpr[] {
    i++; // (
    const list: SExpr[] = [];
    for (;;) {
      skip();
      if (i >= text.length) throw new SExprSyntaxError("unexpected end of input");
      const c = text.charAt(i);
      if (c === ")") {
        i++;
        return list;
      }
      if (c === "(") {
        list.push(readList());
      } else if (c === '"') {
        i++;
        let s = "";
        while (i < text.length && text.charAt(i) !== '"') {
          if (text.charAt(i) === "\\") {
            const next = text.charAt(i + 1);
            s += next === "n" ? "\n" : next;
            i += 2;
          } else {
            s += text.charAt(i++);
          }
        }
        if (i >= text.length) throw new SExprSyntaxError("unterminated string");
        i++;
        list.push(s);
      } else {
        const start = i;
        while (i < text.length && !/[\s()"]/.test(text.charAt(i))) i++;
        const word = text.slice(start, i);
        if (list.length === 0) list.push(word);
        else if (/^-?\d+(\.\d+)?$/.test(word)) list.push(Number(word));
        else list.push(sym(word));
      }
    }
  }

  skip();
  if (text.charAt(i) !== "(") throw new SExprSyntaxError("expected '('");
  return readList();
}

/** Child lists with the given keyword. */
export function children(list: SExpr[], keyword: string): SExpr[][] {
  return list.filter((x): x is SExpr[] => Array.isArray(x) && x[0] === keyword);
}

export function child(list: SExpr[], keyword: string): SExpr[] | undefined {
  return children(list, keyword)[0];
}

/** The first atom after the keyword of a child list, as text: `(ref "C1")` → "C1". */
export function value(list: SExpr[], keyword: string): string | undefined {
  const c = child(list, keyword);
  const v = c?.[1];
  if (v === undefined || Array.isArray(v)) return undefined;
  return typeof v === "object" ? v.sym : String(v);
}
