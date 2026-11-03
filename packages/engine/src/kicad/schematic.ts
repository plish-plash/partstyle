import type { CktFile } from "../ckt/ast.js";
import { paperFor, papers } from "../drawing/layout.js";
import { shapeOf } from "../drawing/plan.js";
import type { Drawing } from "../drawing/prepare.js";
import type { PlacedPower, PlacedText, PlacedUnit } from "../drawing/types.js";
import { TOP_BLOCK } from "../project/config.js";
import type { Annotation } from "./annotate.js";
import { symbolKey } from "./libsym.js";
import { placePower } from "./power.js";
import { type SExpr, sym, writeSExpr, yesNo } from "./sexpr.js";
import { effects, type GeneratedSymbol, LIB, property } from "./symbols.js";
import { stableUuid } from "./uuid.js";

export const SCH_VERSION = 20260306;
export const SYM_LIB_VERSION = 20251024;
const GENERATOR = "partstyle";

/** One placement of a block in the sheet hierarchy, with its KiCad identity. */
export interface SheetInstance {
  /** Instance path prefix of the parts inside: "" for the top block, "PWR/" for `use power as PWR`. */
  prefix: string;
  block: CktFile;
  /** KiCad sheet path: "/<root uuid>" or "/<root uuid>/<sheet uuid>...". */
  path: string;
  /** KiCad hierarchical name: "/" or "/PWR/". */
  names: string;
  page: number;
  file: string;
}

export interface SchematicOutput {
  /** File name (relative to the KiCad folder) → text. */
  files: Map<string, string>;
  instances: SheetInstance[];
  /** UUIDs of a part's placed units, for the netlist's tstamps. */
  symbolUuids: (path: string) => string[];
  /** Generated symbols in use, for the project library. */
  symbols: GeneratedSymbol[];
  powerFlags: number;
}

/** The flat refdes of a part path, falling back to its local refdes. */
const refOf = (annotation: Annotation, path: string) =>
  annotation.get(path) ?? path.slice(path.lastIndexOf("/") + 1);

/**
 * About how wide KiCad's stroke font draws 1.27 mm text; it runs wider than the viewer's font.
 * Erring wide only moves centred text a little further from the part.
 */
const kicadTextWidth = (s: string) => s.length * 1.1;

/** Writes the laid-out sheets as KiCad schematic files: geometry comes from `drawing.sheets`. */
export function writeSchematics(drawing: Drawing): SchematicOutput {
  const { annotation, plan, config } = drawing;
  const project = config.name;
  const top = TOP_BLOCK;

  const rootUuid = stableUuid(project, "root");
  const fileOf = (block: string) =>
    block === top
      ? `${project}.kicad_sch`
      : `${block === project ? `${block}_block` : block}.kicad_sch`;
  const sheetUuid = (parentBlock: string, instance: string) =>
    stableUuid(project, "sheet", parentBlock, instance);
  const symbolUuidFor = (block: string, ref: string) => stableUuid(project, "symbol", block, ref);
  /** Unit 1 keeps the single-unit UUID, so PCBs made before multi-unit support stay linked. */
  const unitUuid = (block: string, ref: string, unit: number) =>
    unit === 1
      ? symbolUuidFor(block, ref)
      : stableUuid(project, "symbol", block, ref, String(unit));

  const instances: SheetInstance[] = plan.instances.map((i) => ({
    prefix: i.prefix,
    block: i.block,
    path: `/${rootUuid}${i.chain.map((c) => `/${sheetUuid(c.parent, c.instance)}`).join("")}`,
    names: i.names,
    page: i.page,
    file: fileOf(i.block.block.name),
  }));
  const instancesOf = (block: string) => instances.filter((i) => i.block.block.name === block);
  const symbolsByLibId = new Map([...drawing.symbols.values()].map((s) => [s.libId, s]));

  let flagCounter = 0;
  let powerCounter = 0;
  const files = new Map<string, string>();

  for (const [name, sheet] of drawing.sheets) {
    const insts = instancesOf(name);
    const block = insts[0]?.block;
    if (!block) continue;
    const items: SExpr[][] = [];
    const libSymbols = new Map<string, SExpr[]>();
    let uuidCounter = 0;
    const nextUuid = (kind: string) =>
      stableUuid(project, "item", name, kind, String(uuidCounter++));

    for (const u of sheet.units) {
      const s = symbolsByLibId.get(u.libId);
      if (s) libSymbols.set(s.libId, s.def);
      items.push(placedUnit(u));
    }

    for (const s of sheet.sheets) {
      const pins = s.pins.map((p): SExpr[] => [
        "pin",
        p.port,
        sym(shapeOf[p.kind]),
        ["at", p.at.x, p.at.y, p.outward],
        ["uuid", stableUuid(project, "sheetpin", name, s.instance, p.port)],
        effects({ justify: [p.outward === 180 ? "left" : "right"] }),
      ]);
      const pages = insts.map((parent) => ({
        parent,
        child: instances.find((i) => i.prefix === `${parent.prefix}${s.instance}/`),
      }));
      items.push([
        "sheet",
        ["at", s.at.x, s.at.y],
        ["size", s.size.w, s.size.h],
        ["exclude_from_sim", yesNo(false)],
        ["in_bom", yesNo(true)],
        ["on_board", yesNo(true)],
        ["dnp", yesNo(false)],
        ["stroke", ["width", 0.1524], ["type", sym("solid")]],
        ["fill", ["color", 0, 0, 0, 0]],
        ["uuid", sheetUuid(name, s.instance)],
        property("Sheetname", s.instance, [s.at.x, s.at.y - 0.7116, 0], {
          justify: ["left", "bottom"],
        }),
        property("Sheetfile", fileOf(s.block), [s.at.x, s.at.y + s.size.h + 0.5984, 0], {
          justify: ["left", "top"],
        }),
        ...pins,
        [
          "instances",
          [
            "project",
            project,
            ...pages.map(
              ({ parent, child }) =>
                ["path", parent.path, ["page", String(child?.page ?? 0)]] as SExpr[],
            ),
          ],
        ],
      ]);
    }

    for (const l of sheet.labels) {
      const justify = l.angle === 180 || l.angle === 270 ? "right" : "left";
      items.push(
        l.kind === "hier"
          ? [
              "hierarchical_label",
              l.text,
              ["shape", sym(l.shape ?? "passive")],
              ["at", l.at.x, l.at.y, l.angle],
              effects({ justify: [justify] }),
              ["uuid", nextUuid("label")],
            ]
          : [
              "label",
              l.text,
              ["at", l.at.x, l.at.y, l.angle],
              effects({ justify: [justify, "bottom"] }),
              ["uuid", nextUuid("label")],
            ],
      );
    }

    for (const p of sheet.power) items.push(placedPower(p));

    for (const w of sheet.wires) {
      items.push([
        "wire",
        ["pts", ["xy", w.a.x, w.a.y], ["xy", w.b.x, w.b.y]],
        ["stroke", ["width", 0], ["type", sym("default")]],
        ["uuid", nextUuid("wire")],
      ]);
    }
    for (const j of sheet.junctions) {
      items.push([
        "junction",
        ["at", j.at.x, j.at.y],
        ["diameter", 0],
        ["color", 0, 0, 0, 0],
        ["uuid", nextUuid("junction")],
      ]);
    }
    for (const p of sheet.noConnects) {
      items.push(["no_connect", ["at", p.x, p.y], ["uuid", nextUuid("nc")]]);
    }

    const paper = papers[paperFor(sheet)];
    const isRoot = name === top;
    const doc: SExpr[] = [
      "kicad_sch",
      ["version", SCH_VERSION],
      ["generator", GENERATOR],
      ["generator_version", "0.1"],
      ["uuid", isRoot ? rootUuid : stableUuid(project, "file", name)],
      ["paper", paper?.[0] ?? "A4"],
      [
        "title_block",
        ["title", isRoot ? project : `${project}: ${name}`],
        ["comment", 1, block.block.description ?? ""],
        ["comment", 2, "Generated by Partstyle from circuit/*.ckt; edit those, not this file"],
      ],
      ["lib_symbols", ...[...libSymbols].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, d]) => d)],
      ...items,
      ...(isRoot ? [["sheet_instances", ["path", "/", ["page", "1"]]] as SExpr[]] : []),
      ["embedded_fonts", yesNo(false)],
    ];
    files.set(fileOf(name), `${writeSExpr(doc)}\n`);

    function placedPower(p: PlacedPower): SExpr[] {
      const symbol = drawing.power.byLibId(p.libId);
      libSymbols.set(symbol.libId, symbol.def);
      const refs = insts.map(
        (i) =>
          [
            i.path,
            p.flag
              ? `#FLG${String(++flagCounter).padStart(2, "0")}`
              : `#PWR${String(++powerCounter).padStart(2, "0")}`,
          ] as [string, string],
      );
      const uuid = nextUuid(p.flag ? "flag" : "power");
      return placePower(symbol, {
        at: p.at,
        outward: p.outward,
        value: p.name,
        valueAt: p.valueAt,
        uuid,
        pinUuid: stableUuid(uuid, "pin"),
        project,
        refs,
        hideValue: p.hideValue,
      });
    }

    function placedUnit(u: PlacedUnit): SExpr[] {
      /**
       * A field as the layout placed it (on the sheet, as the viewer draws it), in KiCad's
       * terms: KiCad reads justification in the symbol's frame, so a mirrored symbol's left is
       * its right, and a turned symbol's turns with it. Text left- or right-justified on a turned
       * symbol is centred instead, its middle reckoned from the width KiCad's font draws.
       */
      const field = (name: string, value: string, t: PlacedText): SExpr[] => {
        const side = t.justify.find((j) => j === "left" || j === "right");
        const rest = t.justify.filter((j) => j !== side);
        let x = t.at.x;
        let justify = t.justify;
        if (side && u.rotation !== 0) {
          x += ((side === "left" ? 1 : -1) * kicadTextWidth(value)) / 2;
          justify = rest;
        } else if (side && u.mirror) {
          justify = [side === "left" ? "right" : "left", ...rest];
        }
        return property(
          name,
          value,
          [x, t.at.y, angle(t.angle)],
          justify.length > 0 ? { justify } : {},
        );
      };
      const entry = drawing.bomByPath.get(u.path);
      const record = entry?.record;
      const s = symbolsByLibId.get(u.libId);
      const unit = s?.units.find((x) => x.unit === u.unit);
      const fields: [string, string][] = [
        ["MPN", record?.mpn ?? ""],
        ["Manufacturer", record?.manufacturer ?? ""],
        ["Spec", entry?.spec ?? ""],
        ["LCSC", record?.sourcing?.lcsc ?? ""],
        ["DigiKey", record?.sourcing?.digikey ?? ""],
        ["Mouser", record?.sourcing?.mouser ?? ""],
      ];
      const at = u.at;
      // Field angles are stored relative to the symbol's rotation.
      const angle = (display: number) => (((display - u.rotation) % 180) + 180) % 180;
      return [
        "symbol",
        ["lib_id", u.libId],
        ["at", at.x, at.y, u.rotation],
        ...(u.mirror ? [["mirror", sym("y")] as SExpr[]] : []),
        ["unit", u.unit],
        ["body_style", 1],
        ["exclude_from_sim", yesNo(false)],
        ["in_bom", yesNo(true)],
        ["on_board", yesNo(true)],
        ["in_pos_files", yesNo(true)],
        ["dnp", yesNo(false)],
        ["uuid", unitUuid(name, u.ref, u.unit)],
        field("Reference", refOf(annotation, u.path), u.refField),
        field("Value", entry?.value ?? u.libId, u.valueField),
        property("Footprint", entry?.footprint ?? "", [at.x, at.y, 0], { hide: true }),
        property("Datasheet", record?.provenance.datasheet?.url ?? "", [at.x, at.y, 0], {
          hide: true,
        }),
        property("Description", record?.summary ?? entry?.spec ?? "", [at.x, at.y, 0], {
          hide: true,
        }),
        ...fields
          .filter(([, v]) => v !== "")
          .map(([k, v]) => property(k, v, [at.x, at.y, 0], { hide: true })),
        ...[...(unit?.pins.keys() ?? [])].map(
          (n) => ["pin", n, ["uuid", stableUuid(project, "pin", name, u.ref, n)]] as SExpr[],
        ),
        [
          "instances",
          [
            "project",
            project,
            ...insts.map(
              (i) =>
                [
                  "path",
                  i.path,
                  ["reference", refOf(annotation, i.prefix + u.ref)],
                  ["unit", u.unit],
                ] as SExpr[],
            ),
          ],
        ],
      ];
    }
  }

  const partsByPath = new Map(drawing.netlist.parts.map((p) => [p.path, p]));
  return {
    files,
    instances,
    symbolUuids: (path) => {
      const slash = path.lastIndexOf("/");
      const prefix = path.slice(0, slash + 1);
      const block = instances.find((i) => i.prefix === prefix)?.block.block.name ?? "";
      const part = partsByPath.get(path);
      const units = (part && drawing.symbols.get(symbolKey(part))?.units) ?? [{ unit: 1 }];
      return units.map((u) => unitUuid(block, path.slice(slash + 1), u.unit));
    },
    symbols: [...new Set(drawing.symbols.values())].flatMap((s) =>
      s.generated ? [s.generated] : [],
    ),
    powerFlags: flagCounter,
  };
}

/** The project symbol library: every generated symbol. */
export function symbolLibrary(symbols: GeneratedSymbol[]): string {
  const doc: SExpr[] = [
    "kicad_symbol_lib",
    ["version", SYM_LIB_VERSION],
    ["generator", GENERATOR],
    ["generator_version", "0.1"],
    ...[...symbols].sort((a, b) => a.name.localeCompare(b.name)).map((s) => s.def),
  ];
  return `${writeSExpr(doc)}\n`;
}

export const symLibTable = `(sym_lib_table
  (version 7)
  (lib (name "${LIB}")(type "KiCad")(uri "\${KIPRJMOD}/${LIB}.kicad_sym")(options "")(descr "Generated by Partstyle"))
)
`;
