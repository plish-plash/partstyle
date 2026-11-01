import type { TextResult } from "../query.js";
import type { LibraryEntry, PartLibrary } from "./library.js";
import { requirementText } from "./schema.js";

export type PartTier = "summary" | "pins" | "full";

function summaryLine(e: LibraryEntry): string {
  const r = e.record;
  const verified = r.provenance.verified_by ? "" : " [unverified]";
  return `${r.id}: ${r.manufacturer} ${r.mpn}, ${r.summary}${verified}`;
}

/** Every word of the query must appear in the record's id, MPN, manufacturer, summary or package. */
export function searchParts(library: PartLibrary, query: string, limit = 20): TextResult {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { ok: false, text: "usage: part_search QUERY" };

  const scored = [...library.values()]
    .map((e) => {
      const r = e.record;
      const strong = `${r.id} ${r.mpn}`.toLowerCase();
      const weak = `${r.manufacturer} ${r.summary} ${r.package}`.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (strong.includes(w)) score += 3;
        else if (weak.includes(w)) score += 1;
        else return undefined;
      }
      return { e, score };
    })
    .filter((x) => x !== undefined)
    .sort((a, b) => b.score - a.score || a.e.record.id.localeCompare(b.e.record.id));

  if (scored.length === 0) return { ok: true, text: `no parts match '${query}'` };
  const shown = scored.slice(0, limit).map(({ e }) => summaryLine(e));
  const more = scored.length > limit ? `\n... ${scored.length - limit} more` : "";
  return { ok: true, text: `${shown.join("\n")}${more}` };
}

/** Reads a part record at the lowest tier that answers the question. */
export function describePart(library: PartLibrary, id: string, tier: PartTier): TextResult {
  const e = library.get(id);
  if (!e) return { ok: false, text: `no part '${id}' in the library (try part_search)` };
  if (tier === "full") return { ok: true, text: `# ${e.file}\n${e.text}` };

  const r = e.record;
  const lines = [summaryLine(e), `package ${r.package}, footprint ${r.footprint}`];
  if (tier === "pins") {
    lines.push(
      "pins:",
      ...Object.entries(r.pins).map(
        ([n, p]) =>
          `  ${n} ${p.name} ${p.type}${p.vmax ? ` max ${p.vmax}` : ""}${p.note ? ` (${p.note})` : ""}`,
      ),
    );
  }
  const ratings = Object.entries(r.ratings ?? {});
  if (ratings.length > 0) lines.push(`ratings: ${ratings.map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (r.temp_c) lines.push(`temperature: ${r.temp_c[0]} to ${r.temp_c[1]} °C`);
  if (tier === "pins") {
    // Checked requirements are marked: the engine verifies those; the rest need judgement.
    for (const req of r.requirements ?? []) {
      lines.push(`requires: ${requirementText(req)}${typeof req === "string" ? "" : " [checked]"}`);
    }
    for (const note of r.notes ?? []) lines.push(`note: ${note}`);
  } else if (r.requirements?.length) {
    lines.push(`requirements: ${r.requirements.length} (tier pins)`);
  }
  return { ok: true, text: lines.join("\n") };
}
