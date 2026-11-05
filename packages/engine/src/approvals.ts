import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { printSpec } from "./ckt/print.js";
import type { FlatPart } from "./netlist/elaborate.js";

export const APPROVALS_FILE = "approvals.yaml";

/**
 * A sign-off on one part, as it stood: `snapshot` is what was approved, so a later change to the
 * part or its connections shows up, and reverting the change restores the approval.
 */
export interface Approval {
  snapshot: string;
  by: "person" | "ai";
  /** Local time, `YYYY-MM-DD HH:MM`. */
  at: string;
}

/** By flat part path. */
export type Approvals = Map<string, Approval>;

export type ApprovalStatus = "approved" | "changed" | "none";

const header = `# Parts signed off in the Partstyle viewer, versioned with the design. A part whose spec or
# connections no longer match its snapshot shows as changed since approved.
`;

/** What an approval covers: the part's spec and the net on each pin, not its layout or intent. */
export function partSnapshot(part: FlatPart): string {
  const pins = part.pins.map((p) => `${p.number}=${p.net ?? "-"}`).join(" ");
  return `${printSpec(part.spec)}: ${pins}`;
}

export function approvalStatus(part: FlatPart, approvals: Approvals): ApprovalStatus {
  const a = approvals.get(part.path);
  if (!a) return "none";
  return a.snapshot === partSnapshot(part) ? "approved" : "changed";
}

export function parseApprovals(text: string): Approvals {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch {
    return new Map();
  }
  if (typeof data !== "object" || data === null) return new Map();
  return new Map(
    Object.entries(data).flatMap(([path, v]): [string, Approval][] => {
      if (typeof v !== "object" || v === null) return [];
      const r = v as Record<string, unknown>;
      if (typeof r.snapshot !== "string") return [];
      const at = typeof r.at === "string" ? r.at : "";
      return [[path, { snapshot: r.snapshot, by: r.by === "person" ? "person" : "ai", at }]];
    }),
  );
}

export function formatApprovals(approvals: Approvals): string {
  const sorted = [...approvals].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }));
  return sorted.length === 0 ? header : header + stringifyYaml(Object.fromEntries(sorted));
}
