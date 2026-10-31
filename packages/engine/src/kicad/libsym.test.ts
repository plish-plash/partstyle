import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { FlatPart, Netlist } from "../netlist/elaborate.js";
import type { PartRecord } from "../parts/schema.js";
import { loadProject } from "../project/load.js";
import { type ValidationResult, validateProject } from "../validate.js";
import { exportKicad, type SymbolCandidate } from "./export.js";
import {
  flattenSymbol,
  genericSymbolId,
  incompatibility,
  kicadSymbol,
  rankSymbolMatches,
  symbolKey,
  symbolNames,
  unitsOf,
} from "./libsym.js";
import { parseSymbolLib } from "./power.js";
import { type SExpr, sym, writeSExpr } from "./sexpr.js";

const pin = (
  type: string,
  n: string,
  name: string,
  x: number,
  y: number,
  angle: number,
  hide = false,
): SExpr[] => [
  "pin",
  sym(type),
  sym("line"),
  ["at", x, y, angle],
  ["length", 2.54],
  ...(hide ? [["hide", sym("yes")] as SExpr[]] : []),
  ["name", name],
  ["number", n],
];

/** A dual op-amp (units A, B and a power unit) and a derived part that renames it. */
const libText = writeSExpr([
  "kicad_symbol_lib",
  [
    "symbol",
    "DUAL",
    ["property", "Reference", "U"],
    ["property", "Value", "DUAL"],
    [
      "symbol",
      "DUAL_1_1",
      pin("output", "1", "", 5, 0, 180),
      pin("input", "2", "-", -5, -2.54, 0),
      pin("input", "3", "+", -5, 2.54, 0),
    ],
    [
      "symbol",
      "DUAL_2_1",
      pin("input", "5", "+", -5, 2.54, 0),
      pin("input", "6", "-", -5, -2.54, 0),
      pin("output", "7", "", 5, 0, 180),
    ],
    [
      "symbol",
      "DUAL_3_1",
      pin("power_in", "4", "V-", 0, -7.62, 90),
      pin("power_in", "8", "V+", 0, 7.62, 270),
    ],
  ],
  [
    "symbol",
    "MCP6002-xSN",
    ["extends", "DUAL"],
    ["property", "Value", "MCP6002-xSN"],
    ["property", "ki_keywords", "opamp"],
  ],
  [
    "symbol",
    "STACKED",
    [
      "symbol",
      "STACKED_1_1",
      pin("power_in", "1", "GND", 0, -5, 90),
      pin("passive", "2", "GND", 0, -5, 90, true),
      pin("passive", "3", "IO", 5, 0, 180),
    ],
  ],
]);

describe("library symbols", () => {
  const lib = parseSymbolLib(libText);

  it("lists top-level symbol names without parsing", () => {
    expect(symbolNames(libText)).toEqual(["DUAL", "MCP6002-xSN", "STACKED"]);
  });

  it("flattens a derived symbol under its own name with its own properties", () => {
    const flat = flattenSymbol(lib, "MCP6002-xSN") as SExpr[];
    const text = writeSExpr(flat);
    expect(text).toMatch(/^\(symbol "MCP6002-xSN"/);
    expect(text).toContain('(property "Value" "MCP6002-xSN")');
    expect(text).toContain('(property "Reference" "U")');
    expect(text).toContain('(property "ki_keywords" "opamp")');
    expect(text).toContain('(symbol "MCP6002-xSN_2_1"');
    expect(text).not.toContain("extends");
    expect(flattenSymbol(lib, "NOPE")).toBeUndefined();
  });

  it("splits a multi-unit symbol into units with outward pin directions", () => {
    const units = unitsOf(flattenSymbol(lib, "MCP6002-xSN") as SExpr[]);
    expect(units.map((u) => [u.unit, [...u.pins.keys()]])).toEqual([
      [1, ["1", "2", "3"]],
      [2, ["5", "6", "7"]],
      [3, ["4", "8"]],
    ]);
    expect(units[0]?.pins.get("1")).toMatchObject({ x: 5, y: 0, outward: 0, hidden: false });
    expect(units[2]?.pins.get("8")).toMatchObject({ outward: 90, type: "power_in" });
  });

  it("ranks exact, wildcard and safe prefix matches", () => {
    const names = [
      { lib: "Amp", name: "MCP6002-xSN" },
      { lib: "Amp", name: "MCP6002-xP" },
      { lib: "Reg", name: "MCP1700x-330xxTT" },
      { lib: "Reg", name: "L7805" },
      { lib: "Reg", name: "LM317" },
      { lib: "Diode", name: "1N5819" },
    ];
    const rec = (id: string, mpn = id) => ({ id, mpn }) as PartRecord;
    const ids = (r: PartRecord) => rankSymbolMatches(r, names).map((m) => `${m.lib}:${m.name}`);
    expect(ids(rec("MCP6002-I_SN", "MCP6002-I/SN"))).toEqual(["Amp:MCP6002-xSN"]);
    expect(ids(rec("MCP1700T-3302E_TT", "MCP1700T-3302E/TT"))).toEqual(["Reg:MCP1700x-330xxTT"]);
    expect(ids(rec("L7805CV"))).toEqual(["Reg:L7805"]);
    expect(ids(rec("1N5819", "1N5819RLG"))).toEqual(["Diode:1N5819"]);
    expect(ids(rec("LM3171"))).toEqual([]); // a digit after the prefix is a different part
  });

  it("maps generics to KiCad's Device symbols", () => {
    expect(genericSymbolId("res", ["1k"])).toBe("Device:R");
    expect(genericSymbolId("led", ["red"])).toBe("Device:LED");
    expect(genericSymbolId("diode", ["schottky"])).toBe("Device:D_Schottky");
    expect(genericSymbolId("diode", ["signal"])).toBe("Device:D");
  });
});

describe("compatibility", () => {
  const lib = parseSymbolLib(libText);
  const part = (pins: [string, string | undefined][]): FlatPart => ({
    path: "U1",
    spec: { kind: "lib", id: "X" },
    pins: pins.map(([number, net]) => ({
      id: `U1#${number}`,
      part: "U1",
      number,
      name: number,
      type: "passive",
      ...(net !== undefined && { net }),
    })),
    location: { file: "x", line: 1, col: 1 },
  });
  const symbol = (name: string) => kicadSymbol(`L:${name}`, flattenSymbol(lib, name) as SExpr[]);

  it("needs exactly the same pin numbers", () => {
    const eight = part(["1", "2", "3", "4", "5", "6", "7", "8"].map((n) => [n, "N"]));
    expect(incompatibility(symbol("MCP6002-xSN"), [eight])).toBeUndefined();
    expect(
      incompatibility(symbol("MCP6002-xSN"), [
        part([
          ["1", "A"],
          ["9", "B"],
        ]),
      ]),
    ).toBe("pin numbers differ (symbol lacks 9; symbol has extra 2 3 4 5 6 7 8)");
  });

  it("accepts hidden pins stacked under a visible pin on the same net only", () => {
    expect(
      incompatibility(symbol("STACKED"), [
        part([
          ["1", "GND"],
          ["2", "GND"],
          ["3", "IO"],
        ]),
      ]),
    ).toBeUndefined();
    expect(
      incompatibility(symbol("STACKED"), [
        part([
          ["1", "GND"],
          ["2", "VCC"],
          ["3", "IO"],
        ]),
      ]),
    ).toBe("U1: stacked pins 1 and 2 are on different nets");
  });
});

describe("export with KiCad symbols", () => {
  const example = fileURLToPath(new URL("../../../../examples/bench-sensor", import.meta.url));
  let result: ValidationResult;
  beforeAll(async () => {
    result = validateProject(await loadProject(example));
  });
  const lib = parseSymbolLib(libText);

  it("places every unit of a multi-unit symbol and lists them all in the netlist", () => {
    const op = (result.netlist as Netlist).parts.find((p) => p.path === "AFE/U3") as FlatPart;
    const candidates = new Map<string, SymbolCandidate[]>([
      [
        symbolKey(op),
        [
          {
            libId: "L:MCP6002-xSN",
            symbol: kicadSymbol("L:MCP6002-xSN", flattenSymbol(lib, "MCP6002-xSN") as SExpr[]),
          },
        ],
      ],
    ]);
    const x = exportKicad(result, { annotation: "", bom: "" }, { symbolCandidates: candidates });
    expect(x.symbols.find((s) => s.key === "lib:MCP6002-I_SN")).toMatchObject({
      libId: "L:MCP6002-xSN",
      generated: false,
    });
    const afe = x.files.get("sensor_afe.kicad_sch") as string;
    expect(afe.match(/\(lib_id "L:MCP6002-xSN"\)/g)).toHaveLength(3);
    expect(afe).toContain('(symbol "L:MCP6002-xSN"');
    expect(x.files.get("partstyle.kicad_sym")).not.toContain("MCP6002");
    const comp = (x.files.get(x.netlistFile) as string)
      .split("(comp")
      .find((c) => c.includes('(ref "U3")'));
    expect(comp?.match(/\(tstamps "[^"]+" "[^"]+" "[^"]+"\)/)).not.toBeNull();
  });

  it("falls back to a generated symbol, with a warning when kicad_symbol named the bad one", () => {
    const candidates = new Map<string, SymbolCandidate[]>([
      [
        "lib:L7805CV",
        [
          {
            libId: "L:DUAL",
            explicit: true,
            symbol: kicadSymbol("L:DUAL", flattenSymbol(lib, "DUAL") as SExpr[]),
          },
        ],
      ],
      ["lib:1N5819", [{ libId: "Diode:NOPE", explicit: false }]],
    ]);
    const x = exportKicad(result, { annotation: "", bom: "" }, { symbolCandidates: candidates });
    expect(x.symbols.find((s) => s.key === "lib:L7805CV")).toMatchObject({
      libId: "partstyle:L7805CV",
      generated: true,
      rejected: [expect.stringMatching(/^L:DUAL: pin numbers differ/)],
    });
    expect(x.symbols.find((s) => s.key === "lib:1N5819")?.rejected).toEqual([
      "Diode:NOPE: not found in the KiCad libraries",
    ]);
    expect(x.issues.map((i) => i.code)).toContain("kicad.symbol-fallback");
    expect(x.files.get("partstyle.kicad_sym")).toContain('(symbol "L7805CV"');
  });
});
