import { type BomEntry, type BomResult, resolveBom } from "../bom.js";
import type { Issue } from "../diagnostics.js";
import type { ValidationResult } from "../validate.js";
import {
  type Annotation,
  annotate,
  formatAnnotationLock,
  parseAnnotationLock,
} from "./annotate.js";
import { writeKicadNetlist } from "./netlist.js";
import type { SymbolLib } from "./power.js";
import { buildSchematics, type SchematicOutput, symbolLibrary, symLibTable } from "./schematic.js";

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
  issues: Issue[];
}

/** Turns a validated design into a KiCad project. Throws if the design did not elaborate. */
export function exportKicad(
  result: ValidationResult,
  locks: { annotation: string; bom: string },
  /** KiCad's power symbol library, when installed. */
  powerLib?: SymbolLib,
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

  const schematic = buildSchematics({
    project,
    blocks: result.blocks,
    top: config.top,
    netlist,
    annotation,
    bom: bomByPath,
    ...(powerLib && { powerLib }),
  });
  const files = new Map(schematic.files);
  files.set("partstyle.kicad_sym", symbolLibrary(schematic.symbols));
  files.set("sym-lib-table", symLibTable);
  const netlistFile = `${project}.net`;
  files.set(
    netlistFile,
    writeKicadNetlist({
      project,
      netlist,
      annotation,
      bom: bomByPath,
      instances: schematic.instances,
      symbolUuid: schematic.symbolUuid,
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
    issues,
  };
}
