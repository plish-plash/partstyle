import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBom } from "../bom.js";
import type { Netlist } from "../netlist/elaborate.js";
import { parseGenericSpec, parseGenericText, satisfies } from "../parts/generic.js";
import { loadProject } from "../project/load.js";
import { type ValidationResult, validateProject } from "../validate.js";
import { annotate, formatAnnotationLock, parseAnnotationLock } from "./annotate.js";
import { exportKicad } from "./export.js";
import { compareNetlists, parseKicadNetlist } from "./netlist.js";
import { parseSymbolLib, powerLibrary } from "./power.js";
import { readSExpr, sym, value, writeSExpr } from "./sexpr.js";
import { GRID, symbolForGeneric, symbolForRecord } from "./symbols.js";
import { stableUuid } from "./uuid.js";

const example = fileURLToPath(new URL("../../../../examples/bench-sensor", import.meta.url));
let result: ValidationResult;
beforeAll(async () => {
  result = validateProject(await loadProject(example));
});

describe("S-expressions", () => {
  it("writes KiCad's layout and reads it back", () => {
    const doc = ["pin", "1", sym("passive"), ["at", 0, -3.81, 90], ["name", 'say "hi"']];
    const text = writeSExpr(doc);
    expect(text).toBe('(pin "1" passive\n\t(at 0 -3.81 90)\n\t(name "say \\"hi\\"")\n)');
    expect(readSExpr(text)).toEqual(doc);
    expect(value(readSExpr(text), "name")).toBe('say "hi"');
  });

  it("prints numbers without float noise", () => {
    expect(writeSExpr(["at", 0.1 + 0.2, -0, 2.54 * 3])).toBe("(at 0.3 0 7.62)");
  });
});

it("derives stable, distinct v5-shaped UUIDs", () => {
  const a = stableUuid("p", "symbol", "power", "C1");
  expect(a).toBe(stableUuid("p", "symbol", "power", "C1"));
  expect(a).not.toBe(stableUuid("p", "symbol", "power", "C2"));
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

describe("generic specs", () => {
  it("classifies arguments by form", () => {
    const cap = parseGenericSpec("cap", ["100n", "16V", "x7r", "10%", "0603"]);
    expect(cap?.value).toBeCloseTo(100e-9, 15);
    expect(cap).toEqual({
      fn: "cap",
      value: cap?.value,
      voltage: 16,
      dielectric: "X7R",
      tolerance: 0.1,
      package: "0603",
      other: [],
    });
    expect(parseGenericSpec("diode", ["schottky", "SOD-123"])).toMatchObject({
      value: "schottky",
      package: "SOD-123",
    });
  });

  it("matches offers that meet or exceed every constraint", () => {
    const offer = parseGenericText("cap(100n, 50V, X7R, 10%, 0603)");
    const need = (text: string) => parseGenericText(text) ?? { fn: "", other: [] };
    expect(offer && satisfies(offer, need("cap(100n, 16V, X7R, 0603)"))).toBe(true);
    expect(offer && satisfies(offer, need("cap(100n)"))).toBe(true);
    expect(offer && satisfies(offer, need("cap(100n, 100V)"))).toBe(false);
    expect(offer && satisfies(offer, need("cap(100n, C0G)"))).toBe(false);
    expect(offer && satisfies(offer, need("cap(100n, 5%)"))).toBe(false);
    expect(offer && satisfies(offer, need("cap(100n, 0805)"))).toBe(false);
    expect(offer && satisfies(offer, need("cap(10n)"))).toBe(false);
    expect(offer && satisfies(offer, need("res(100n)"))).toBe(false);
  });
});

describe("annotate", () => {
  it("keeps local refdes, renumbers clashes past every existing number, and stays stable", () => {
    const paths = ["R1", "A/R1", "A/R2", "B/R1", "R7"];
    const first = annotate(paths, new Map());
    expect(Object.fromEntries(first.table)).toEqual({
      R1: "R1",
      "A/R2": "R2",
      R7: "R7",
      "A/R1": "R8",
      "B/R1": "R9",
    });
    const lock = formatAnnotationLock(first.table);
    const again = annotate([...paths, "C/R1"], parseAnnotationLock(lock));
    expect(again.table.get("A/R1")).toBe("R8");
    expect(again.renumbered).toEqual([["C/R1", "R10"]]);
  });
});

describe("symbols", () => {
  it("puts every pin of a record symbol on the grid, supplies on top, grounds at the bottom", () => {
    const record = result.library.get("ATMEGA328P-AU")?.record;
    if (!record) throw new Error("seed record missing");
    const s = symbolForRecord(record);
    expect(s.pins.size).toBe(32);
    for (const a of s.pins.values()) {
      expect(Math.abs(a.x / GRID - Math.round(a.x / GRID))).toBeLessThan(1e-9);
      expect(Math.abs(a.y / GRID - Math.round(a.y / GRID))).toBeLessThan(1e-9);
    }
    expect(s.pins.get("3")?.outward).toBe(270); // GND
    expect(s.pins.get("4")?.outward).toBe(90); // VCC, top
    expect(s.pins.get("12")?.outward).toBe(0); // PB0, right
    expect(s.pins.get("20")?.outward).toBe(180); // AREF, left
  });

  it("keeps a regulator's supply input on the left, in line with its output", () => {
    const record = result.library.get("L7805CV")?.record;
    if (!record) throw new Error("seed record missing");
    const s = symbolForRecord(record);
    expect(s.pins.get("1")?.outward).toBe(180); // IN
    expect(s.pins.get("3")?.outward).toBe(0); // OUT
    expect(s.pins.get("2")?.outward).toBe(270); // GND
  });

  it("has symbols for every generic", () => {
    for (const fn of ["res", "cap", "ind", "led", "diode"]) {
      expect(symbolForGeneric(fn)?.pins.size).toBe(2);
    }
    expect(symbolForGeneric("nope")).toBeUndefined();
  });
});

describe("power symbols", () => {
  const kicadPower = parseSymbolLib(
    writeSExpr([
      "kicad_symbol_lib",
      [
        "symbol",
        "+5V",
        ["power", sym("global")],
        [
          "symbol",
          "+5V_1_1",
          ["pin", sym("power_in"), sym("line"), ["at", 0, 0, 90], ["number", "1"]],
        ],
      ],
    ]),
  );

  it("uses KiCad's symbol of the net's name, else GND for ground and VCC otherwise", () => {
    const lib = powerLibrary(kicadPower);
    expect(lib.forNet("+5V", false)).toMatchObject({ libId: "power:+5V", bodyDir: 90 });
    expect(lib.forNet("GND", true)).toMatchObject({ libId: "power:GND", bodyDir: 270 });
    expect(lib.forNet("AGND", false).libId).toBe("power:GND");
    expect(lib.forNet("VBATT_SW", false).libId).toBe("power:VCC");
    expect(lib.flag()).toMatchObject({ libId: "power:PWR_FLAG", bodyDir: 90 });
    expect(writeSExpr(lib.forNet("+5V", false).def)).toMatch(/^\(symbol "power:\+5V"/);
  });

  it("has fallbacks when KiCad is not installed", () => {
    const lib = powerLibrary(undefined);
    expect(lib.forNet("+5V", false).libId).toBe("power:VCC");
    expect(writeSExpr(lib.flag().def)).toContain("(power global)");
  });
});

describe("exportKicad", () => {
  it("writes a netlist that reads back as the same connectivity", async () => {
    const x = await exportKicad(result, { annotation: "", bom: "" });
    const parsed = parseKicadNetlist(x.files.get(x.netlistFile) as string);
    expect(parsed.refs.size).toBe(30);
    expect(compareNetlists(result.netlist as Netlist, x.annotation, parsed)).toEqual([]);
  });

  it("detects a netlist that differs", async () => {
    const x = await exportKicad(result, { annotation: "", bom: "" });
    const parsed = parseKicadNetlist(x.files.get(x.netlistFile) as string);
    const gnd = parsed.nets.find((n) => n.name === "GND");
    gnd?.nodes.pop();
    parsed.refs.delete("U4");
    const problems = compareNetlists(result.netlist as Netlist, x.annotation, parsed);
    expect(problems[0]).toBe("U4 is missing from the schematic");
    expect(problems.some((p) => p.startsWith("net GND {"))).toBe(true);
  });

  it("is deterministic", async () => {
    const a = await exportKicad(result, { annotation: "", bom: "" });
    const b = await exportKicad(result, { annotation: "", bom: "" });
    expect([...a.files]).toEqual([...b.files]);
  });

  it("flags only nets fed from outside: the 12 V input and ground", async () => {
    const x = await exportKicad(result, { annotation: "", bom: "" });
    expect(x.schematic.powerFlags).toBe(2);
    expect(x.files.get("power.kicad_sch")).toContain('(lib_id "power:PWR_FLAG")');
    expect(x.files.get("partstyle.kicad_sym")).not.toContain("PWR_FLAG");
  });

  it("draws power nets with power symbols and keeps them off sheet pins", async () => {
    const x = await exportKicad(result, { annotation: "", bom: "" });
    const power = x.files.get("power.kicad_sch") as string;
    expect(power).toContain('(lib_id "power:GND")');
    expect(power).not.toMatch(/\(hierarchical_label "(GND|\+5V|\+3V3)"/);
    expect(power).not.toMatch(/\(label "\+12V"/);
    const root = x.files.get("bench-sensor.kicad_sch") as string;
    expect(root.match(/^\t\t\(pin "[^"]+" /gm)?.map((p) => p.trim())).toEqual([
      '(pin "AIN"',
      '(pin "AIN"',
    ]);
    // Power nets are named globally in the netlist, as KiCad names them.
    const names = [...(x.files.get(x.netlistFile) as string).matchAll(/\(name "([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    expect(names).toEqual(expect.arrayContaining(["GND", "+5V", "+3V3", "+12V", "/AIN"]));
  });

  it("falls back to labels when a block's instances put a net on different rails", async () => {
    const source = await loadProject(example);
    // Use the sensor block twice, once on +5V and once on +3V3.
    const main = `block main
use power as PWR
use sensor_afe as A
use sensor_afe as B
use mcu as MCU
net +5V  : PWR.+5V A.+5V
net +3V3 : PWR.+3V3 A.+3V3 B.+3V3 B.+5V MCU.+3V3
net GND  : PWR.GND A.GND B.GND MCU.GND
net AIN  : A.AIN MCU.AIN
net AIN2 : B.AIN`;
    const r = validateProject({
      ...source,
      circuits: source.circuits.map((c) =>
        c.file === "circuit/main.ckt" ? { ...c, text: main } : c,
      ),
    });
    const x = await exportKicad(r, { annotation: "", bom: "" });
    const afe = x.files.get("sensor_afe.kicad_sch") as string;
    expect(afe).toMatch(/\(hierarchical_label "\+5V"/);
    expect(afe).toContain('(lib_id "power:GND")');
  });
});

describe("resolveBom", () => {
  it("prefers parts stocked by the preferred distributors, then keeps the choice locked", () => {
    const lib = new Map(result.library);
    const base = lib.get("CL10B104KB8NNNC");
    if (!base) throw new Error("seed record missing");
    lib.set("ZZ100N", {
      ...base,
      record: { ...base.record, id: "ZZ100N", sourcing: { lcsc: "C0000", lifecycle: "active" } },
    });
    const netlist = result.netlist as Netlist;
    const pick = (lock: string, preferred: ("lcsc" | "digikey")[]) =>
      resolveBom(netlist, lib, lock, preferred).entries.find((e) => e.part.path === "PWR/C2")
        ?.record?.id;

    expect(pick("", [])).toBe("CL10B104KB8NNNC");
    expect(pick("", ["lcsc"])).toBe("ZZ100N");
    const locked = resolveBom(netlist, lib, "", []).lock;
    expect(pick(locked, ["lcsc"])).toBe("CL10B104KB8NNNC");
  });

  it("re-resolves when the spec changes and reports parts removed from the design", () => {
    const netlist = result.netlist as Netlist;
    const lock = "PWR/C2  cap(100n, 6V)  -> CL10B104KB8NNNC\nGONE/R1  res(1k)  -> RC0603FR-071KL\n";
    const r = resolveBom(netlist, result.library, lock, []);
    expect(r.changes).toContain("PWR/C2 cap(100n, 16V, X7R, 0603) -> CL10B104KB8NNNC");
    expect(r.changes).toContain("GONE/R1: removed from design");
  });
});
