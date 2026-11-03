import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Netlist } from "./netlist/elaborate.js";
import { runQuery } from "./query.js";

/** A note a person attached to a part, pin, net or sheet in the viewer. */
export interface Comment {
  id: string;
  /** Flat path of what it is about: `PWR/U1`, `PWR/U1.IN`, a net name, or a sheet `PWR/`. */
  subject: string;
  text: string;
  status: "open" | "resolved";
  /** ISO timestamp. */
  created: string;
}

/** What the person has selected in the viewer; kept in .partstyle/focus.json. */
export interface Focus {
  selection: string[];
  /** Instance prefix of the sheet being viewed: "" for the top, "PWR/" for an instance. */
  sheet?: string;
  /** The variant being viewed; absent for the main circuit. */
  variant?: string;
  updated?: string;
}

export const COMMENTS_FILE = "comments.yaml";
export const FOCUS_FILE = ".partstyle/focus.json";
/** The review mode the person chose in the viewer; local, like the rest of .partstyle/. */
export const REVIEW_MODE_FILE = ".partstyle/review.json";

export type ReviewMode = "auto" | "accept";

const commentsHeader = `# Review comments from the Partstyle viewer, versioned with the design.
# The AI sees open ones through \`partstyle focus\` and \`partstyle overview\`.
`;

export function parseComments(text: string): Comment[] {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.flatMap((c): Comment[] => {
    if (typeof c !== "object" || c === null) return [];
    const r = c as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.subject !== "string" || typeof r.text !== "string") {
      return [];
    }
    return [
      {
        id: r.id,
        subject: r.subject,
        text: r.text,
        status: r.status === "resolved" ? "resolved" : "open",
        created: typeof r.created === "string" ? r.created : "",
      },
    ];
  });
}

export function formatComments(comments: Comment[]): string {
  return comments.length === 0 ? commentsHeader : commentsHeader + stringifyYaml(comments);
}

/** The next free comment id: c1, c2, ... */
export function nextCommentId(comments: Comment[]): string {
  const max = Math.max(0, ...comments.map((c) => Number(/^c(\d+)$/.exec(c.id)?.[1] ?? 0)));
  return `c${max + 1}`;
}

export function parseFocus(text: string): Focus {
  try {
    // Windows editors often prepend a byte-order mark, which JSON.parse rejects.
    const data = JSON.parse(text.replace(/^﻿/, "")) as Partial<Focus>;
    return {
      selection: Array.isArray(data.selection)
        ? data.selection.filter((s) => typeof s === "string")
        : [],
      ...(typeof data.sheet === "string" && { sheet: data.sheet }),
      ...(typeof data.variant === "string" && data.variant !== "" && { variant: data.variant }),
      ...(typeof data.updated === "string" && { updated: data.updated }),
    };
  } catch {
    return { selection: [] };
  }
}

/** One line describing a selected subject, as `query` would. */
export function describeSubject(netlist: Netlist | undefined, subject: string): string {
  if (!netlist) return subject;
  if (subject.endsWith("/")) return `sheet ${subject.slice(0, -1)}`;
  const part = netlist.parts.find((p) => p.path === subject);
  if (part) return runQuery(netlist, `part ${subject}`).text.split("\n")[0] ?? subject;
  const dot = subject.lastIndexOf(".");
  const owner = dot > 0 ? netlist.parts.find((p) => p.path === subject.slice(0, dot)) : undefined;
  if (owner) {
    const key = subject.slice(dot + 1);
    const pin = owner.pins.find((p) => p.number === key) ?? owner.pins.find((p) => p.name === key);
    if (pin) {
      return `pin ${owner.path}.${pin.name} (pin ${pin.number}, ${pin.type}) on ${pin.net ? `net ${pin.net}` : "no net"}`;
    }
  }
  if (netlist.nets.some((n) => n.aliases.includes(subject))) {
    return `net ${runQuery(netlist, `net ${subject}`).text.split("\n")[0] ?? subject}`;
  }
  return `${subject} (no longer in the design)`;
}

/** The `focus` tool's reply: the viewer selection and open comments. */
export function focusText(
  focus: Focus,
  comments: Comment[],
  netlist: Netlist | undefined,
  viewerUrl?: string,
): string {
  const lines: string[] = [];
  const open = comments.filter((c) => c.status === "open");
  if (focus.variant) lines.push(`viewing variant ${focus.variant} (pass variant=${focus.variant})`);
  if (focus.selection.length > 0) {
    const where =
      focus.sheet === undefined
        ? ""
        : ` (viewing sheet ${focus.sheet === "" ? "top" : focus.sheet.slice(0, -1)})`;
    lines.push(`selected in the viewer${where}:`);
    for (const s of focus.selection) lines.push(`  ${describeSubject(netlist, s)}`);
  } else {
    lines.push("nothing selected in the viewer");
  }
  if (open.length > 0) {
    lines.push(`open comments (${open.length}):`);
    for (const c of open) lines.push(`  ${c.id} on ${c.subject}: ${c.text}`);
  } else {
    lines.push("no open comments");
  }
  if (viewerUrl) lines.push(`viewer: ${viewerUrl}`);
  return lines.join("\n");
}
