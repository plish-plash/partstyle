import { type BomEntry, type BomResult, resolveBom } from "../bom.js";
import type { Issue } from "../diagnostics.js";
import type { FlatPart } from "../netlist/elaborate.js";
import type { ValidationResult } from "../validate.js";
import {
  type Annotation,
  annotate,
  formatAnnotationLock,
  parseAnnotationLock,
} from "./annotate.js";
import { generatedSymbol, incompatibility, type SchSymbol, symbolKey } from "./libsym.js";
import { writeKicadNetlist } from "./netlist.js";
import type { SymbolLib } from "./power.js";
import { buildSchematics, type SchematicOutput, symbolLibrary, symLibTable } from "./schematic.js";
import { symbolForGeneric, symbolForRecord } from "./symbols.js";

/** A KiCad library symbol proposed for a part type; `symbol` is absent if it was not found. */
export interface SymbolCandidate {
  libId: string;
  symbol?: SchSymbol;
  /** Named by the part record's `kicad_symbol`, so a failure is worth a warning. */
  explicit?: boolean;
}

export interface KicadLibraries {
  /** KiCad's `power` symbol library. */
  power?: SymbolLib;
  /** Library symbols to try per part type (by `symbolKey`), best first. */
  symbolCandidates?: Map<string, SymbolCandidate[]>;
}

/** How a part type was drawn. */
export interface SymbolChoice {
  key: string;
  libId: string;
  generated: boolean;
  /** Candidates tried and why each was not used. */
  rejected: string[];
}

export interface KicadExport {
  /** Files for the kicad/ folder, by name. */
  files: Map<string, string>;
  /** Written only when missing, so KiCad's own settings survive re-export. */
  projectFile: { name: string; text: string };
  rootSchematic: string;
  netlistFile: string;
  annotation: Annotation;
  annotationLock: string;
  renumbered: [path: string, ref: string][];
  bom: BomResult;
  schematic: SchematicOutput;
  symbols: SymbolChoice[];
  issues: Issue[];
}

/**
 * Picks each part type's symbol: the first KiCad candidate whose pins fit every part using it,
 * else one generated from the part record or generic.
 */
function chooseSymbols(
  parts: FlatPart[],
  candidates: Map<string, SymbolCandidate[]>,
): { chosen: Map<string, SchSymbol>; choices: SymbolChoice[]; issues: Issue[] } {
  const byKey = new Map<string, FlatPart[]>();
  for (const p of parts) byKey.set(symbolKey(p), [...(byKey.get(symbolKey(p)) ?? []), p]);

  const chosen = new Map<string, SchSymbol>();
  const choices: SymbolChoice[] = [];
  const issues: Issue[] = [];
  for (const [key, group] of byKey) {
    const rejected: string[] = [];
    let pick: SchSymbol | undefined;
    for (const c of candidates.get(key) ?? []) {
      const why = c.symbol ? incompatibility(c.symbol, group) : "not found in the KiCad libraries";
      if (!why) {
        pick = c.symbol;
        break;
      }
      rejected.push(`${c.libId}: ${why}`);
      if (c.explicit) {
        const first = group[0] as FlatPart;
        issues.push({
          code: "kicad.symbol-fallback",
          severity: "warning",
          message: `${key.slice(key.indexOf(":") + 1)}: kicad_symbol ${c.libId} cannot be used (${why}); drawing a generated symbol`,
          location: first.location,
          subjects: group.map((p) => p.path),
        });
      }
    }
    if (!pick) {
      const part = group[0] as FlatPart;
      const g =
        part.spec.kind === "lib"
          ? part.record && symbolForRecord(part.record)
          : symbolForGeneric(part.spec.fn);
      if (!g) continue;
      pick = generatedSymbol(g);
    }
    chosen.set(key, pick);
    choices.push({ key, libId: pick.libId, generated: pick.generated !== undefined, rejected });
  }
  return { chosen, choices, issues };
}

/** Turns a validated design into a KiCad project. Throws if the design did not elaborate. */
export function exportKicad(
  result: ValidationResult,
  locks: { annotation: string; bom: string },
  libraries: KicadLibraries = {},
): KicadExport {
  const { config, netlist } = result;
  if (!config || !netlist) throw new Error("design has no netlist; fix validation errors first");
  const project = config.name;

  const { table: annotation, renumbered } = annotate(
    netlist.parts.map((p) => p.path),
    parseAnnotationLock(locks.annotation),
  );
  const bom = resolveBom(netlist, result.library, locks.bom, config.sourcing.distributors);
  const bomByPath = new Map<string, BomEntry>(bom.entries.map((e) => [e.part.path, e]));

  const issues: Issue[] = [...bom.issues];
  for (const e of bom.entries) {
    if (e.footprint === undefined) {
      issues.push({
        code: "kicad.no-footprint",
        severity: "warning",
        message: `${e.part.path} ${e.spec} has no footprint; it will be missing from the PCB`,
        location: e.part.location,
        subjects: [e.part.path],
      });
    }
  }

  const {
    chosen,
    choices,
    issues: symbolIssues,
  } = chooseSymbols(netlist.parts, libraries.symbolCandidates ?? new Map());
  issues.push(...symbolIssues);

  const schematic = buildSchematics({
    project,
    blocks: result.blocks,
    top: config.top,
    netlist,
    annotation,
    bom: bomByPath,
    symbols: chosen,
    ...(libraries.power && { powerLib: libraries.power }),
  });
  const files = new Map(schematic.files);
  files.set("partstyle.kicad_sym", symbolLibrary(schematic.symbols));
  files.set("sym-lib-table", symLibTable);
  const netlistFile = `${project}.net`;
  const partsByPath = new Map(netlist.parts.map((p) => [p.path, p]));
  files.set(
    netlistFile,
    writeKicadNetlist({
      project,
      netlist,
      annotation,
      bom: bomByPath,
      instances: schematic.instances,
      symbolUuids: schematic.symbolUuids,
      libIdOf: (path) => {
        const part = partsByPath.get(path);
        return (part && chosen.get(symbolKey(part))?.libId) ?? "partstyle:unknown";
      },
      netNames: schematic.netNames,
    }),
  );

  return {
    files,
    projectFile: {
      name: `${project}.kicad_pro`,
      text: `${JSON.stringify({ meta: { filename: `${project}.kicad_pro`, version: 3 } }, null, 2)}\n`,
    },
    rootSchematic: `${project}.kicad_sch`,
    netlistFile,
    annotation,
    annotationLock: formatAnnotationLock(annotation),
    renumbered,
    bom,
    schematic,
    symbols: choices,
    issues,
  };
}
