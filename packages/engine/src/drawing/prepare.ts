import { type BomEntry, type BomResult, resolveBom } from "../bom.js";
import type { Issue } from "../diagnostics.js";
import { type Annotation, annotate, parseAnnotationLock } from "../kicad/annotate.js";
import { generatedSymbol, incompatibility, type SchSymbol, symbolKey } from "../kicad/libsym.js";
import { type PowerLibrary, powerLibrary, type SymbolLib } from "../kicad/power.js";
import { symbolForGeneric, symbolForRecord } from "../kicad/symbols.js";
import type { FlatPart, Netlist } from "../netlist/elaborate.js";
import { type ProjectConfig, TOP_BLOCK } from "../project/config.js";
import type { ValidationResult } from "../validate.js";
import { checkConnectivity } from "./connectivity.js";
import { layoutSheet } from "./layout.js";
import { turnable } from "./orient.js";
import { type DrawingPlan, planDrawing } from "./plan.js";
import type { SheetLayout } from "./types.js";

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

/** Everything needed to draw a design: shared by the viewer and the KiCad export. */
export interface Drawing {
  config: ProjectConfig;
  netlist: Netlist;
  annotation: Annotation;
  renumbered: [path: string, ref: string][];
  bom: BomResult;
  bomByPath: Map<string, BomEntry>;
  /** The symbol drawn for each part type, by `symbolKey`. */
  symbols: Map<string, SchSymbol>;
  symbolChoices: SymbolChoice[];
  power: PowerLibrary;
  plan: DrawingPlan;
  /** Laid-out sheet per block in use, by block name. */
  sheets: Map<string, SheetLayout>;
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

/**
 * Prepares a validated design for drawing: stable refdes, BOM resolution, a symbol per part
 * type, how each net is drawn, and a layout of every sheet. Throws if the design did not
 * elaborate. A connectivity mismatch in a laid-out sheet is reported as a `layout.connectivity`
 * error: it is a layout bug, never a design problem.
 */
export async function prepareDrawing(
  result: ValidationResult,
  locks: { annotation: string; bom: string },
  libraries: KicadLibraries = {},
): Promise<Drawing> {
  const { config, netlist } = result;
  if (!config || !netlist) throw new Error("design has no netlist; fix validation errors first");

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

  const power = powerLibrary(libraries.power);
  const plan = planDrawing({
    blocks: result.blocks,
    top: TOP_BLOCK,
    netlist,
    symbols: chosen,
    power,
  });
  const blocks = new Map(result.blocks.map((b) => [b.block.name, b]));
  const sheets = new Map<string, SheetLayout>();
  for (const block of result.blocks) {
    if (plan.instancesOf(block.block.name).length === 0) continue;
    for (const p of block.parts) {
      const bad =
        p.layout?.rotation !== undefined && !turnable.test(p.ref)
          ? `${p.ref} is not a two-terminal part, so it cannot be turned (flip it instead); r${p.layout.rotation} is ignored`
          : p.layout?.flip !== undefined && turnable.test(p.ref)
            ? `${p.ref} is a two-terminal part, so it turns rather than flips (r180 reverses it); ${p.layout.flip ? "flip" : "noflip"} is ignored`
            : undefined;
      if (bad) {
        issues.push({
          code: "layout.bad-hint",
          severity: "warning",
          message: bad,
          location: p.location,
          subjects: [p.ref],
        });
      }
    }
    const sheet = layoutSheet(block, plan, netlist, blocks);
    sheets.set(block.block.name, sheet);
    for (const problem of checkConnectivity(sheet)) {
      issues.push({
        code: "layout.connectivity",
        severity: "error",
        message: `${block.block.name}: ${problem} (a layout bug, please report it)`,
        location: block.block.location,
        subjects: [],
      });
    }
  }

  return {
    config,
    netlist,
    annotation,
    renumbered,
    bom,
    bomByPath,
    symbols: chosen,
    symbolChoices: choices,
    power,
    plan,
    sheets,
    issues,
  };
}
