import { printSpec } from "./ckt/print.js";
import type { Issue } from "./diagnostics.js";
import type { FlatPart, Netlist } from "./netlist/elaborate.js";
import {
  genericFootprint,
  parseGenericSpec,
  parseGenericText,
  satisfies,
} from "./parts/generic.js";
import type { PartLibrary } from "./parts/library.js";
import type { PartRecord } from "./parts/schema.js";
import type { distributors } from "./project/config.js";

type Distributor = (typeof distributors)[number];

/** One placed part with what it resolved to. */
export interface BomEntry {
  part: FlatPart;
  /** `lib:L7805CV` or `cap(100n, 16V, X7R, 0603)`. */
  spec: string;
  /** The library record: the part's own, or the one a generic resolved to. */
  record?: PartRecord;
  status: "library" | "resolved" | "unresolved";
  footprint?: string;
  /** KiCad Value field. */
  value: string;
}

export interface BomResult {
  entries: BomEntry[];
  /** New bom.lock text. */
  lock: string;
  /** Lock lines added, changed or dropped, for the reply. */
  changes: string[];
  issues: Issue[];
}

const lockHeader = `# Partstyle bom.lock: how generic parts resolved to library parts (MPNs).
# Kept until the part's spec changes or the record no longer fits; delete a line to re-resolve.
`;

function parseBomLock(text: string): Map<string, { spec: string; id: string }> {
  const lock = new Map<string, { spec: string; id: string }>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+)\s+(.*?)\s+->\s+(\S+)\s*$/.exec(line);
    if (m && !line.startsWith("#")) {
      lock.set(m[1] as string, { spec: m[2] as string, id: m[3] as string });
    }
  }
  return lock;
}

/** Lower is better: index of the first preferred distributor that stocks the part. */
function sourcingRank(record: PartRecord, preferred: readonly Distributor[]): number {
  const i = preferred.findIndex((d) => record.sourcing?.[d]);
  return i === -1 ? preferred.length : i;
}

/**
 * Resolves every generic part to a library record whose `generic` spec satisfies it, preferring
 * records stocked by the preferred distributors (in order), then the lowest voltage rating that
 * fits, then id. Earlier resolutions in bom.lock are kept while they still fit.
 */
export function resolveBom(
  netlist: Netlist,
  library: PartLibrary,
  lockText: string,
  preferred: readonly Distributor[],
): BomResult {
  const previous = parseBomLock(lockText);
  const offers = [...library.values()].flatMap((e) => {
    const spec = e.record.generic === undefined ? undefined : parseGenericText(e.record.generic);
    return spec ? [{ record: e.record, spec }] : [];
  });

  const entries: BomEntry[] = [];
  const issues: Issue[] = [];
  const lockLines: [string, string, string][] = [];
  const changes: string[] = [];

  for (const part of netlist.parts) {
    const spec = printSpec(part.spec);
    if (part.spec.kind === "lib") {
      entries.push({
        part,
        spec,
        status: "library",
        value: part.record?.mpn ?? part.spec.id,
        ...(part.record && { record: part.record, footprint: part.record.footprint }),
      });
      continue;
    }

    const need = parseGenericSpec(part.spec.fn, part.spec.args);
    const value = part.spec.args[0] ?? part.spec.fn;
    if (!need) continue; // unknown generic: already an elaboration error
    const fits = offers.filter((o) => satisfies(o.spec, need));
    const locked = previous.get(part.path);
    let chosen = locked?.spec === spec ? fits.find((o) => o.record.id === locked.id) : undefined;
    if (!chosen) {
      chosen = [...fits].sort(
        (a, b) =>
          sourcingRank(a.record, preferred) - sourcingRank(b.record, preferred) ||
          (a.spec.voltage ?? 0) - (b.spec.voltage ?? 0) ||
          a.record.id.localeCompare(b.record.id),
      )[0];
    }

    if (chosen) {
      lockLines.push([part.path, spec, chosen.record.id]);
      if (locked?.id !== chosen.record.id || locked.spec !== spec) {
        changes.push(`${part.path} ${spec} -> ${chosen.record.id}`);
      }
      entries.push({
        part,
        spec,
        record: chosen.record,
        status: "resolved",
        footprint: chosen.record.footprint,
        value,
      });
    } else {
      if (locked) changes.push(`${part.path} ${spec}: dropped ${locked.id}, nothing fits`);
      const footprint = genericFootprint(need);
      issues.push({
        code: "bom.unresolved",
        severity: "warning",
        message: `${part.path} ${spec}: no library part satisfies it${
          footprint ? "" : " and it names no chip package, so it has no footprint"
        }; add a record with generic: ${spec}`,
        location: part.location,
        subjects: [part.path],
      });
      entries.push({
        part,
        spec,
        status: "unresolved",
        value,
        ...(footprint !== undefined && { footprint }),
      });
    }
  }

  for (const [path] of previous) {
    if (!netlist.parts.some((p) => p.path === path)) changes.push(`${path}: removed from design`);
  }
  const width = Math.max(0, ...lockLines.map(([p]) => p.length));
  const specWidth = Math.max(0, ...lockLines.map(([, s]) => s.length));
  const lock =
    lockHeader +
    lockLines
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([p, s, id]) => `${p.padEnd(width)}  ${s.padEnd(specWidth)}  -> ${id}`)
      .join("\n") +
    (lockLines.length > 0 ? "\n" : "");
  return { entries, lock, changes, issues };
}

function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Grouped BOM: one row per distinct part, references sorted naturally. */
export function formatBomCsv(
  entries: BomEntry[],
  refOf: (path: string) => string,
  preferred: readonly Distributor[],
): string {
  const groups = new Map<string, BomEntry[]>();
  for (const e of entries) {
    const key = e.record ? `lib:${e.record.id}` : `${e.spec}|${e.footprint ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
  const header = [
    "Refs",
    "Qty",
    "Value",
    "Spec",
    "Manufacturer",
    "MPN",
    "Footprint",
    ...preferred,
    "Notes",
  ];
  const rows = [...groups.values()].map((group) => {
    const e = group[0] as BomEntry;
    const r = e.record;
    const notes = [
      e.status === "unresolved" ? "unresolved generic" : "",
      r && !r.provenance.verified_by ? "record unverified" : "",
    ].filter(Boolean);
    return [
      group
        .map((g) => refOf(g.part.path))
        .sort(natural)
        .join(" "),
      String(group.length),
      e.value,
      [...new Set(group.map((g) => g.spec))].join("; "),
      r?.manufacturer ?? "",
      r?.mpn ?? "",
      e.footprint ?? "",
      ...preferred.map((d) => r?.sourcing?.[d] ?? ""),
      notes.join("; "),
    ];
  });
  rows.sort((a, b) => natural(a[0] as string, b[0] as string));
  return `${[header, ...rows].map((row) => row.map(csvField).join(",")).join("\n")}\n`;
}
