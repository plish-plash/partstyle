import type { BomEntry } from "../bom.js";
import type { Issue } from "../diagnostics.js";
import {
  type Drawing,
  type KicadLibraries,
  prepareDrawing,
  type SymbolChoice,
} from "../drawing/prepare.js";
import type { ValidationResult } from "../validate.js";
import { type Annotation, formatAnnotationLock } from "./annotate.js";
import { symbolKey } from "./libsym.js";
import { writeKicadNetlist } from "./netlist.js";
import { type SchematicOutput, symbolLibrary, symLibTable, writeSchematics } from "./schematic.js";

export type { KicadLibraries, SymbolCandidate, SymbolChoice } from "../drawing/prepare.js";

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
  bom: BomEntry[];
  drawing: Drawing;
  schematic: SchematicOutput;
  symbols: SymbolChoice[];
  issues: Issue[];
}

/** Turns a validated design into a KiCad project. Throws if the design did not elaborate. */
export async function exportKicad(
  result: ValidationResult,
  annotationLock: string,
  libraries: KicadLibraries = {},
): Promise<KicadExport> {
  const drawing = await prepareDrawing(result, annotationLock, libraries);
  const project = drawing.config.name;
  const schematic = writeSchematics(drawing);

  const files = new Map(schematic.files);
  files.set("partstyle.kicad_sym", symbolLibrary(schematic.symbols));
  files.set("sym-lib-table", symLibTable);
  const netlistFile = `${project}.net`;
  const partsByPath = new Map(drawing.netlist.parts.map((p) => [p.path, p]));
  files.set(
    netlistFile,
    writeKicadNetlist({
      project,
      netlist: drawing.netlist,
      annotation: drawing.annotation,
      bom: drawing.bomByPath,
      instances: schematic.instances,
      symbolUuids: schematic.symbolUuids,
      libIdOf: (path) => {
        const part = partsByPath.get(path);
        return (part && drawing.symbols.get(symbolKey(part))?.libId) ?? "partstyle:unknown";
      },
      netNames: drawing.plan.netNames,
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
    annotation: drawing.annotation,
    annotationLock: formatAnnotationLock(drawing.annotation),
    renumbered: drawing.renumbered,
    bom: drawing.bom,
    drawing,
    schematic,
    symbols: drawing.symbolChoices,
    issues: drawing.issues,
  };
}
