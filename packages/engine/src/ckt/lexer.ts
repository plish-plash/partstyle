export type TokenKind =
  | "word"
  | "string"
  | "colon"
  | "lbrace"
  | "rbrace"
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "comma"
  | "arrow"
  | "intent";

export interface Token {
  kind: TokenKind;
  /** Word text, unescaped string contents, or trimmed intent text. */
  text: string;
  /** 0-based offsets into the line; `end` is exclusive. */
  start: number;
  end: number;
}

export interface LexError {
  message: string;
  /** 0-based offset into the line. */
  offset: number;
}

const punctuation: Record<string, TokenKind> = {
  ":": "colon",
  "{": "lbrace",
  "}": "rbrace",
  "(": "lparen",
  ")": "rparen",
  "[": "lbracket",
  "]": "rbracket",
  ",": "comma",
};

const wordStop = /[\s:{}()[\],"@#]/;

/** Tokenizes one line of a .ckt file. `#` starts a comment; `@` takes the rest of the line as intent. */
export function lexLine(line: string): { tokens: Token[]; errors: LexError[] } {
  const tokens: Token[] = [];
  const errors: LexError[] = [];
  let i = 0;

  while (i < line.length) {
    const ch = line.charAt(i);
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === "#") {
      break;
    } else if (ch === "@") {
      tokens.push({ kind: "intent", text: line.slice(i + 1).trim(), start: i, end: line.length });
      break;
    } else if (ch === '"') {
      const start = i;
      let text = "";
      i++;
      let closed = false;
      while (i < line.length) {
        const c = line.charAt(i);
        if (c === "\\" && i + 1 < line.length) {
          text += line.charAt(i + 1);
          i += 2;
        } else if (c === '"') {
          i++;
          closed = true;
          break;
        } else {
          text += c;
          i++;
        }
      }
      if (!closed) errors.push({ message: "unterminated string", offset: start });
      tokens.push({ kind: "string", text, start, end: i });
    } else if (line.startsWith("->", i)) {
      tokens.push({ kind: "arrow", text: "->", start: i, end: i + 2 });
      i += 2;
    } else if (ch in punctuation) {
      tokens.push({ kind: punctuation[ch] as TokenKind, text: ch, start: i, end: i + 1 });
      i++;
    } else {
      const start = i;
      while (i < line.length && !wordStop.test(line.charAt(i))) i++;
      tokens.push({ kind: "word", text: line.slice(start, i), start, end: i });
    }
  }
  return { tokens, errors };
}
