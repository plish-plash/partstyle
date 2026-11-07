import { printSpec } from "./ckt/print.js";
import type { FlatPart, Netlist } from "./netlist/elaborate.js";
import {
  genericFootprint,
  genericValue,
  parseGenericSpec,
  parseGenericText,
  satisfies,
} from "./parts/generic.js";
import type { PartLibrary } from "./parts/library.js";
import { distributorLink } from "./parts/links.js";
import { type PartRecord, partValue } from "./parts/schema.js";
import type { Distributor } from "./project/config.js";

/**
 * `library`: a part with a record. `unresolved`: a generic, with no part chosen yet. `board`: a
 * footprint with nothing to buy, such as a test point.
 */
export type BomStatus = "library" | "unresolved" | "board";

/** One placed part. */
export interface BomEntry {
  part: FlatPart;
  /** `lib:L7805CV` or `cap(100n, 16V, X7R, 0603)`. */
  spec: string;
  /** The part's library record. */
  record?: PartRecord;
  status: BomStatus;
  footprint?: string;
  /** KiCad Value field. */
  value: string;
}

/**
 * Describes every part as the design has it. A generic stays unresolved until the design names a
 * real part in its place: nothing here chooses one (see `bomCandidates`).
 */
export function buildBom(netlist: Netlist): BomEntry[] {
  return netlist.parts.flatMap((part): BomEntry[] => {
    const spec = printSpec(part.spec);
    if (part.spec.kind === "lib") {
      const r = part.record;
      return [
        {
          part,
          spec,
          status: "library",
          value: r ? partValue(r) : part.spec.id,
          ...(r && { record: r }),
          ...(r?.footprint && { footprint: r.footprint }),
        },
      ];
    }
    const need = parseGenericSpec(part.spec.fn, part.spec.args);
    if (!need) return []; // unknown generic: already an elaboration error
    const footprint = genericFootprint(need);
    return [
      {
        part,
        spec,
        status: need.fn === "fp" ? "board" : "unresolved",
        value: genericValue(part.spec.fn, part.spec.args),
        ...(footprint !== undefined && { footprint }),
      },
    ];
  });
}

/** Lower is better: index of the first preferred distributor that stocks the part. */
function sourcingRank(record: PartRecord, preferred: readonly Distributor[]): number {
  const i = preferred.findIndex((d) => record.sourcing?.[d]);
  return i === -1 ? preferred.length : i;
}

/**
 * Library records whose `generic` field satisfies a generic part, best first: parts in inventory,
 * then those the preferred distributors stock (in order), then the lowest voltage rating that
 * fits, then id. Suggestions for the person: the design only changes when a part replaces it.
 */
export function bomCandidates(
  entry: BomEntry,
  library: PartLibrary,
  preferred: readonly Distributor[],
): PartRecord[] {
  const { spec } = entry.part;
  const need = spec.kind === "generic" ? parseGenericSpec(spec.fn, spec.args) : undefined;
  if (!need) return [];
  const offers = [...library.values()].flatMap((e) => {
    const offer = e.record.generic === undefined ? undefined : parseGenericText(e.record.generic);
    return offer && satisfies(offer, need) ? [{ record: e.record, offer }] : [];
  });
  const inventoryRank = (r: PartRecord) => (r.sourcing?.in_inventory ? 0 : 1);
  return offers
    .sort(
      (a, b) =>
        inventoryRank(a.record) - inventoryRank(b.record) ||
        sourcingRank(a.record, preferred) - sourcingRank(b.record, preferred) ||
        (a.offer.voltage ?? 0) - (b.offer.voltage ?? 0) ||
        a.record.id.localeCompare(b.record.id),
    )
    .map((o) => o.record);
}

function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Grouped BOM: one row per distinct part, references sorted naturally. Unresolved generics are
 * listed with what they have, and every row links to a search at each distributor, as the viewer
 * does.
 */
export function formatBomCsv(entries: BomEntry[], preferred: readonly Distributor[]): string {
  const groups = new Map<string, BomEntry[]>();
  for (const e of entries) {
    if (e.status === "board") continue;
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
    "In inventory",
    ...preferred,
    "Notes",
  ];
  const rows = [...groups.values()].map((group) => {
    const e = group[0] as BomEntry;
    const r = e.record;
    const notes = [
      e.status === "unresolved" ? "unresolved generic" : "",
      r && !r.provenance.verified_by ? "record unverified" : "",
      r && !r.preferred_mpn ? "no preferred MPN" : "",
    ].filter(Boolean);
    return [
      group
        .map((g) => g.part.path)
        .sort(natural)
        .join(" "),
      String(group.length),
      e.value,
      [...new Set(group.map((g) => g.spec))].join("; "),
      r?.manufacturer ?? "",
      r?.preferred_mpn ?? "",
      e.footprint ?? "",
      r?.sourcing?.in_inventory ? "yes" : "",
      ...preferred.map((d) => distributorLink(d, e.part.spec, r).url),
      notes.join("; "),
    ];
  });
  rows.sort((a, b) => natural(a[0] as string, b[0] as string));
  return `${[header, ...rows].map((row) => row.map(csvField).join(",")).join("\n")}\n`;
}

/** How many candidates the reply names for each spec. */
const CANDIDATES_SHOWN = 3;

/** The unresolved generics, a line per spec with the parts that could replace them. */
export function unresolvedLines(
  entries: BomEntry[],
  library: PartLibrary,
  preferred: readonly Distributor[],
): string[] {
  const bySpec = new Map<string, BomEntry[]>();
  for (const e of entries) {
    if (e.status === "unresolved") bySpec.set(e.spec, [...(bySpec.get(e.spec) ?? []), e]);
  }
  return [...bySpec].map(([spec, group]) => {
    const fits = bomCandidates(group[0] as BomEntry, library, preferred);
    const shown = fits.slice(0, CANDIDATES_SHOWN).map((r) => {
      return `lib:${r.id}${r.sourcing?.in_inventory ? " [in inventory]" : ""}`;
    });
    const more = fits.length > shown.length ? ` +${fits.length - shown.length} more` : "";
    return `${spec} x${group.length} (${group.map((e) => e.part.path).join(", ")}): ${
      shown.length > 0 ? `${shown.join(", ")}${more}` : "no library part fits"
    }`;
  });
}
