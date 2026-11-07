import type { PartSpec } from "../ckt/ast.js";
import type { Distributor } from "../project/config.js";
import { type PartRecord, partName } from "./schema.js";

const distributorSearches: Record<Distributor, { label: string; search: string }> = {
  lcsc: { label: "LCSC", search: "https://www.lcsc.com/search?q=" },
  digikey: { label: "DigiKey", search: "https://www.digikey.com/en/products/result?keywords=" },
  mouser: { label: "Mouser", search: "https://www.mouser.com/c/?q=" },
};

const genericWords: Record<string, string> = {
  res: "resistor",
  cap: "capacitor",
  ind: "inductor",
};

/** Words to search for a part: its name, or for a generic what it is and its spec. */
export function searchTerm(spec: PartSpec, record: PartRecord | undefined): string {
  if (record) return partName(record);
  return spec.kind === "lib"
    ? spec.id
    : `${genericWords[spec.fn] ?? spec.fn} ${spec.args.join(" ")}`;
}

/**
 * A search at a distributor, by the distributor's own part number where the record has one. Shared
 * by the viewer and the BOM.
 */
export function distributorLink(
  distributor: Distributor,
  spec: PartSpec,
  record: PartRecord | undefined,
): { label: string; url: string } {
  const { label, search } = distributorSearches[distributor];
  const term = record?.sourcing?.[distributor] || searchTerm(spec, record);
  return { label, url: search + encodeURIComponent(term) };
}
