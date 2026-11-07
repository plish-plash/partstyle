import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type BomEntry, bomCandidates, buildBom, formatBomCsv, unresolvedLines } from "./bom.js";
import { exportKicad } from "./kicad/export.js";
import { adaptedSymbol, kicadSymbol } from "./kicad/libsym.js";
import { type SExpr, sym } from "./kicad/sexpr.js";
import { symbolForRecordGeneric } from "./kicad/symbols.js";
import type { FlatPart, Netlist } from "./netlist/elaborate.js";
import { setInventoryFlag } from "./parts/inventory.js";
import type { PartLibrary } from "./parts/library.js";
import { readPartRecord } from "./parts/schema.js";
import { describePart } from "./parts/search.js";
import { applyPatch } from "./patch.js";
import { loadProject } from "./project/load.js";
import type { ProjectSource } from "./project/source.js";
import { type ValidationResult, validateProject } from "./validate.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

let source: ProjectSource;
let result: ValidationResult;
let entries: BomEntry[];
beforeAll(async () => {
  source = await loadProject(repo("examples/bench-sensor"), [repo("library")]);
  result = validateProject(source);
  entries = buildBom(result.netlist as Netlist);
});

const entry = (path: string) => entries.find((e) => e.part.path === path) as BomEntry;

/** The seed library with a copy of a record under a new id, changed. */
function withCopy(
  id: string,
  from: string,
  change: { sourcing?: Record<string, unknown>; generic?: string },
): PartLibrary {
  const lib = new Map(result.library);
  const base = lib.get(from);
  if (!base) throw new Error("seed record missing");
  lib.set(id, { ...base, record: { ...base.record, ...change, id } });
  return lib;
}

/** The example with a patch applied, validated. */
function patched(patch: string): ValidationResult {
  const p = applyPatch(source, patch);
  expect(p.issues).toEqual([]);
  return validateProject(p.source);
}

describe("buildBom", () => {
  it("leaves a generic unresolved even when a library record satisfies it", () => {
    const e = entry("C2");
    expect(e.status).toBe("unresolved");
    expect(e.record).toBeUndefined();
    expect(e.footprint).toBe("Capacitor_SMD:C_0603_1608Metric");
    expect(e.value).toBe("100n");
  });

  it("shows a real passive's value, and other parts by name", () => {
    const r = patched("in power\n= part C2 lib:CL10B104KB8NNNC");
    const bom = buildBom(r.netlist as Netlist);
    const c2 = bom.find((e) => e.part.path === "C2");
    expect(c2).toMatchObject({ status: "library", value: "100n" });
    expect(bom.find((e) => e.part.path === "U1")?.value).toBe("L7805CV");
  });
});

describe("bomCandidates", () => {
  const ids = (lib: PartLibrary, preferred: ("lcsc" | "digikey")[] = []) =>
    bomCandidates(entry("C2"), lib, preferred).map((r) => r.id);

  it("offers the records that satisfy a generic, and nothing for a library part", () => {
    expect(ids(result.library)).toEqual(["CL10B104KB8NNNC"]);
    expect(bomCandidates(entry("U1"), result.library, [])).toEqual([]);
  });

  it("ranks parts in inventory first, then the preferred distributors", () => {
    const stocked = withCopy("ZZ100N", "CL10B104KB8NNNC", { sourcing: { lcsc: "C0000" } });
    expect(ids(stocked)).toEqual(["CL10B104KB8NNNC", "ZZ100N"]);
    expect(ids(stocked, ["lcsc"])).toEqual(["ZZ100N", "CL10B104KB8NNNC"]);
    const owned = withCopy("ZZ100N", "CL10B104KB8NNNC", { sourcing: { in_inventory: true } });
    expect(ids(owned)).toEqual(["ZZ100N", "CL10B104KB8NNNC"]);
    expect(unresolvedLines([entry("C2")], owned, [])).toEqual([
      "cap(100n, 16V, X7R, 0603) x1 (C2): lib:ZZ100N [in inventory], lib:CL10B104KB8NNNC",
    ]);
  });

  it("names three candidates and counts the rest", () => {
    let lib = result.library;
    for (const id of ["A1", "A2", "A3"]) {
      const next = new Map(lib);
      const base = lib.get("CL10B104KB8NNNC");
      if (!base) throw new Error("seed record missing");
      next.set(id, { ...base, record: { ...base.record, id } });
      lib = next;
    }
    expect(unresolvedLines([entry("C2")], lib, [])[0]).toContain("lib:A3 +1 more");
  });
});

describe("the inventory flag", () => {
  const record = (sourcing: unknown) => ({
    id: "X",
    summary: "x",
    pins: { 1: { name: "A" } },
    sourcing,
  });

  it("reads true and false, and warns about anything else without touching the file", () => {
    expect(readPartRecord(record({ in_inventory: true })).record?.sourcing?.in_inventory).toBe(
      true,
    );
    expect(readPartRecord(record({ in_inventory: false })).record?.sourcing?.in_inventory).toBe(
      false,
    );
    const bad = readPartRecord(record({ in_inventory: "yes" }));
    expect(bad.record?.sourcing?.in_inventory).toBeUndefined();
    expect(bad.warnings).toEqual(["sourcing.in_inventory must be true or false; it is ignored"]);
  });

  it("reaches the CSV and part summaries", () => {
    const lib = withCopy("ZZ100N", "CL10B104KB8NNNC", { sourcing: { in_inventory: true } });
    const r = lib.get("ZZ100N")?.record;
    const owned = { ...entry("U1"), ...(r && { record: r }) };
    const csv = formatBomCsv([owned], []);
    expect(csv.split("\n")[0]).toContain("In inventory");
    expect(csv.split("\n")[1]).toContain(",yes,");
    expect(describePart(lib, "ZZ100N", "summary").text).toContain("[in inventory]");
  });
});

describe("setInventoryFlag", () => {
  const head = "id: X\ntemp_c: [0, 125]\n";

  it("edits a flow mapping in place, keeping quotes and other lines", () => {
    const text = `${head}sourcing: { lcsc: "00123", lifecycle: active }\nnotes: []\n`;
    const on = setInventoryFlag(text, true);
    expect(on).toBe(
      `${head}sourcing: { lcsc: "00123", lifecycle: active, in_inventory: true }\nnotes: []\n`,
    );
    expect(setInventoryFlag(on, true)).toBe(on);
    expect(setInventoryFlag(on, false)).toBe(text);
    expect(setInventoryFlag(text, false)).toBe(text);
  });

  it("edits a block mapping in place, in the file's line endings", () => {
    const text = `${head}sourcing:\n  lifecycle: active\n  mouser: M1\nnotes: []\n`;
    const on = setInventoryFlag(text, true);
    expect(on).toContain("sourcing:\n  in_inventory: true\n  lifecycle: active\n");
    expect(setInventoryFlag(on, false)).toBe(text);

    const crlf = text.replace(/\n/g, "\r\n");
    expect(setInventoryFlag(crlf, true)).toContain("  in_inventory: true\r\n");
    expect(setInventoryFlag(setInventoryFlag(crlf, true), false)).toBe(crlf);
  });

  it("flips a false flag, and adds sourcing to a record without it", () => {
    expect(setInventoryFlag("sourcing: { in_inventory: false }\n", true)).toBe(
      "sourcing: { in_inventory: true }\n",
    );
    expect(setInventoryFlag("sourcing:\n  in_inventory: false\n", true)).toBe(
      "sourcing:\n  in_inventory: true\n",
    );
    expect(setInventoryFlag(head, false)).toBe(head);
    expect(setInventoryFlag(head, true)).toBe(`${head}sourcing: { in_inventory: true }\n`);
    expect(setInventoryFlag("id: X\nsourcing:\n", true)).toContain("in_inventory: true");
  });
});

describe("a real part draws like its generic", () => {
  const swap = `in power
= part C2 lib:CL10B104KB8NNNC
= part C4 lib:CL10B105KA8NNNC`;

  it("uses the generated capacitor without KiCad, once", async () => {
    const x = await exportKicad(patched(swap));
    const choices = x.symbols.filter((s) => s.key.startsWith("lib:CL10"));
    expect(choices.map((s) => s.libId)).toEqual(["partstyle:cap", "partstyle:cap"]);
    const lib = x.files.get("partstyle.kicad_sym") as string;
    expect(lib.match(/\(symbol "cap"/g)).toHaveLength(1);
  });

  it("keeps the box when a diode's pads would draw it backwards", () => {
    const record = result.library.get("LTST-C191KRKT")?.record;
    if (!record) throw new Error("seed record missing");
    const pins = { 1: { name: "A", type: "passive" }, 2: { name: "K", type: "passive" } } as const;
    expect(symbolForRecordGeneric({ ...record, pins })).toBeUndefined();
    expect(symbolForRecordGeneric(record)?.name).toBe("led");
  });

  it("shows the generic's KiCad symbol, adapted to a record's reversed pads", async () => {
    const pads: [string, string][] = [
      ["1", "A"],
      ["2", "K"],
    ];
    const pin = ([number, name]: [string, string]): SExpr[] => [
      "pin",
      sym("passive"),
      sym("line"),
      ["at", 0, 0, 0],
      ["name", name],
      ["number", number === "1" ? "2" : "1"],
    ];
    const led = kicadSymbol("Device:LED", [
      "symbol",
      "LED",
      ["symbol", "LED_1_1", ...pads.map(pin)],
    ]);
    const part = {
      path: "D2",
      spec: { kind: "lib", id: "BACKWARD" },
      pins: pads.map(([number, name]) => ({ number, name, type: "passive" })),
    } as FlatPart;
    const adapted = adaptedSymbol(led, part);
    expect(adapted?.libId).toBe("partstyle:BACKWARD");
    expect(JSON.stringify(adapted?.def)).toContain("BACKWARD_1_1");
  });
});
