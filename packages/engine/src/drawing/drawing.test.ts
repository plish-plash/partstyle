import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { kicadSymbol } from "../kicad/libsym.js";
import { type SExpr, sym } from "../kicad/sexpr.js";
import { applyPatch } from "../patch.js";
import type { ProjectConfig } from "../project/config.js";
import { loadProject } from "../project/load.js";
import type { ProjectSource } from "../project/source.js";
import { type ValidationResult, validateProject } from "../validate.js";
import { checkConnectivity } from "./connectivity.js";
import { paperFor, papers } from "./paper.js";
import { type Drawing, prepareDrawing } from "./prepare.js";
import type { PlacedUnit, Rect, SheetLayout } from "./types.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const seed = [repo("library")];

describe("checkConnectivity", () => {
  const sheet = (over: Partial<SheetLayout>): SheetLayout => ({
    block: "b",
    width: 100,
    height: 100,
    units: [],
    sheets: [],
    labels: [],
    power: [],
    wires: [],
    junctions: [],
    noConnects: [],
    ...over,
  });
  const unit = (pins: { number: string; x: number; y: number; net?: string }[]): PlacedUnit => ({
    ref: "U1",
    path: "U1",
    libId: "x:y",
    unit: 1,
    at: { x: 0, y: 0 },
    rotation: 0,
    mirror: false,
    box: { x: 0, y: 0, w: 1, h: 1 },
    pins: pins.map((p) => ({
      number: p.number,
      at: { x: p.x, y: p.y },
      outward: 0,
      ...(p.net !== undefined && { net: p.net }),
    })),
    refField: { at: { x: 0, y: 0 }, angle: 0, justify: [] },
    valueField: { at: { x: 0, y: 0 }, angle: 0, justify: [] },
  });

  it("reports opens, shorts and pins lying on another net's wire", () => {
    const problems = checkConnectivity(
      sheet({
        units: [
          unit([
            { number: "1", x: 0, y: 0, net: "A" },
            { number: "2", x: 10, y: 0, net: "A" },
            { number: "3", x: 0, y: 5, net: "B" },
            { number: "4", x: 5, y: 10, net: "C" },
          ]),
        ],
        wires: [
          { net: "B", a: { x: 0, y: 5 }, b: { x: 0, y: 0 } }, // touches A's pin: short
          { net: "D", a: { x: 0, y: 10 }, b: { x: 10, y: 10 } }, // passes through C's pin
        ],
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        "U1.4 (net C) lies on a wire of net D",
        "nets A, B are shorted together",
      ]),
    );
  });

  it("connects labels by text and power symbols by name", () => {
    const problems = checkConnectivity(
      sheet({
        units: [
          unit([
            { number: "1", x: 0, y: 0, net: "A" },
            { number: "2", x: 10, y: 0, net: "A" },
          ]),
        ],
        labels: [
          { kind: "local", text: "A", net: "A", at: { x: 0, y: 0 }, angle: 180 },
          { kind: "local", text: "A", net: "A", at: { x: 10, y: 0 }, angle: 0 },
        ],
      }),
    );
    expect(problems).toEqual([]);
  });
});

/**
 * The adapter on a real design: what Partstyle adds around @partstyle/layout (records, symbols,
 * power symbols, hierarchy, paper). Placement rules are the layout package's to test, on its
 * own cases.
 */
describe("prepareDrawing", () => {
  let source: ProjectSource;
  let result: ValidationResult;
  let drawing: Drawing;
  beforeAll(async () => {
    source = await loadProject(repo("examples/bench-sensor"), seed);
    result = validateProject(source);
    drawing = await prepareDrawing(result);
  });
  const sheetOf = (d: Drawing, name: string) => d.sheets.get(name) as SheetLayout;

  it("draws every sheet of the example faithfully and cleanly", () => {
    expect([...drawing.sheets.keys()].sort()).toEqual(["main", "mcu", "power", "sensor_afe"]);
    expect(drawing.issues.filter((i) => i.code.startsWith("layout."))).toEqual([]);
    const onGrid = (v: number) => Math.abs(v / 2.54 - Math.round(v / 2.54)) < 1e-6;
    const overlap = (a: Rect, b: Rect) =>
      a.x < b.x + b.w - 0.01 &&
      b.x < a.x + a.w - 0.01 &&
      a.y < b.y + b.h - 0.01 &&
      b.y < a.y + a.h - 0.01;
    for (const [name, sheet] of drawing.sheets) {
      expect([name, checkConnectivity(sheet)]).toEqual([name, []]);
      expect([name, papers[paperFor(sheet)]?.[0]]).toEqual([name, "A4"]);
      for (const w of sheet.wires) expect([w.a.x, w.a.y, w.b.x, w.b.y].every(onGrid)).toBe(true);
      for (const a of sheet.units) {
        for (const p of a.pins) expect(onGrid(p.at.x) && onGrid(p.at.y)).toBe(true);
        for (const b of sheet.units) {
          if (a !== b) expect([a.ref, b.ref, overlap(a.box, b.box)]).toEqual([a.ref, b.ref, false]);
        }
        for (const w of sheet.wires) {
          const wire = {
            x: Math.min(w.a.x, w.b.x),
            y: Math.min(w.a.y, w.b.y),
            w: Math.abs(w.a.x - w.b.x),
            h: Math.abs(w.a.y - w.b.y),
          };
          expect([a.ref, w.net, overlap(a.box, wire)]).toEqual([a.ref, w.net, false]);
        }
      }
    }
  });

  it("warns about a part that would have no footprint on the PCB", async () => {
    const p = applyPatch(source, "in power\n+ part C20 cap(1u, 25V)\nnet GND += C20.1 C20.2");
    expect(p.issues).toEqual([]);
    const d = await prepareDrawing(validateProject(p.source));
    expect(d.issues.filter((i) => i.code === "kicad.no-footprint").map((i) => i.message)).toEqual([
      "C20 cap(1u, 25V) has no footprint; it will be missing from the PCB",
    ]);
  });

  it("flags only the rails that come from outside the design", () => {
    const flags = [...drawing.sheets.values()].flatMap((s) => s.power.filter((p) => p.flag));
    expect(flags.length).toBeGreaterThan(0);
    for (const f of flags) expect(f.name).toBe("PWR_FLAG");
  });

  it("is deterministic", async () => {
    const again = await prepareDrawing(result);
    expect([...again.sheets.values()]).toEqual([...drawing.sheets.values()]);
  });

  it("draws parts not wired in yet, a pin or both on no net", async () => {
    const p = applyPatch(
      source,
      "in power\n+ part R20 res(1k, 0603)\n+ part C20 cap(1u, 25V, 0603)\nnet GND += C20.2",
    );
    expect(p.issues).toEqual([]);
    const d = await prepareDrawing(validateProject(p.source));
    const power = sheetOf(d, "power");
    for (const ref of ["R20", "C20"]) expect(power.units.map((u) => u.ref)).toContain(ref);
    expect(checkConnectivity(power)).toEqual([]);
  });

  it("leaves unused no-connect pins off a generated symbol, but shows a wired one", async () => {
    const sot23 = `id: SOTDIODE
summary: diode in SOT-23 with a no-connect pin
pins:
  1: { name: A }
  2: { name: NC, type: nc }
  3: { name: K }
`;
    const draw = async (nets: string) => {
      const r = validateProject({
        project: { file: "partstyle-project.yaml", text: "name: t" },
        circuits: [{ file: "circuit/main.ckt", text: `block main\npart D1 lib:SOTDIODE\n${nets}` }],
        parts: [{ file: "parts/SOTDIODE.yaml", text: sot23, layer: "project" }],
      });
      const unit = (await prepareDrawing(r)).sheets.get("main")?.units[0];
      return unit?.pins.map((q) => q.number).sort();
    };
    expect(await draw("")).toEqual(["1", "3"]);
    // ERC warns about a wired no-connect pin, but the drawing must still show the wire.
    expect(await draw("net X : D1.2 D1.1\n")).toEqual(["1", "2", "3"]);
  });

  it("wires a KiCad symbol whose pins are off the grid, placing it so they run straight", async () => {
    // Device:R_Potentiometer: the wiper is 1.5 grid units from both ends.
    const pin = (n: string, x: number, y: number, angle: number): SExpr[] => [
      "pin",
      sym("passive"),
      sym("line"),
      ["at", x, y, angle],
      ["length", 1.27],
      ["name", n],
      ["number", n],
    ];
    const symbol = kicadSymbol("Device:R_Potentiometer", [
      "symbol",
      "R_Potentiometer",
      ["property", "Reference", "RV"],
      [
        "symbol",
        "R_Potentiometer_1_1",
        pin("1", 0, 3.81, 270),
        pin("2", 3.81, 0, 180),
        pin("3", 0, -3.81, 90),
      ],
    ]);
    const pot =
      "id: POT\nsummary: pot\npins:\n  1: { name: CCW }\n  2: { name: WIPER }\n  3: { name: CW }\n";
    const r = validateProject({
      project: { file: "partstyle-project.yaml", text: "name: t" },
      circuits: [
        {
          file: "circuit/main.ckt",
          text: [
            "block main",
            "part RV1 lib:POT",
            "part R1 res(1k)",
            "part R2 res(1k)",
            "part R3 res(1k)",
            "net A : RV1.CCW R1.1",
            "net B : RV1.WIPER R2.1",
            "net C : RV1.CW R3.1",
            "net D : R1.2 R2.2 R3.2",
          ].join("\n"),
        },
      ],
      parts: [{ file: "parts/POT.yaml", text: pot, layer: "project" }],
    });
    const candidates = new Map([["lib:POT", [{ libId: "Device:R_Potentiometer", symbol }]]]);
    const d = await prepareDrawing(r, { symbolCandidates: candidates });
    const main = sheetOf(d, "main");
    expect(d.issues.filter((i) => i.code.startsWith("layout."))).toEqual([]);
    expect(checkConnectivity(main)).toEqual([]);
    // Its origin on the grid: then every pin can run straight out to a grid point.
    const onGrid = (v: number) => Math.abs(v / 2.54 - Math.round(v / 2.54)) < 1e-6;
    const rv = main.units.find((u) => u.ref === "RV1") as PlacedUnit;
    expect([onGrid(rv.at.x), onGrid(rv.at.y)]).toEqual([true, true]);
    for (const p of rv.pins) {
      const stub = main.wires.find(
        (w) => (w.a.x === p.at.x && w.a.y === p.at.y) || (w.b.x === p.at.x && w.b.y === p.at.y),
      );
      expect(stub && (stub.a.x === stub.b.x || stub.a.y === stub.b.y)).toBe(true);
    }
  });

  it("draws a block used twice once, for both instances", async () => {
    const r = validateProject(await loadProject(repo("packages/engine/test-fixtures/multi"), seed));
    const d = await prepareDrawing(r);
    expect(d.issues.filter((i) => i.code.startsWith("layout"))).toEqual([]);
    expect(d.plan.instancesOf("filter").map((i) => i.prefix)).toEqual(["F1/", "F2/"]);
  });

  it("draws a long chain on bigger paper rather than breaking it", async () => {
    const chain = Array.from({ length: 14 }, (_, i) => i + 1);
    const patch = [
      "in chain",
      "+ block chain",
      ...chain.map((i) => `+ part U${i} lib:MCP6002`),
      ...chain.slice(1).map((i) => `+ net N${i} : U${i - 1}.OUTA U${i}.VINA+`),
      "in main",
      "+ use chain as CH",
    ].join("\n");
    const p = applyPatch(source, patch);
    expect(p.issues).toEqual([]);
    const sheet = sheetOf(await prepareDrawing(validateProject(p.source)), "chain");
    expect(checkConnectivity(sheet)).toEqual([]);
    expect(papers[paperFor(sheet)]?.[0]).not.toBe("A4");
  });

  it("passes the project's layout preferences to the layout", async () => {
    const layout = { "pack-groups": { gap: 12 }, "shunt-hang": { spacing: 10 } };
    const spread = await prepareDrawing({
      ...result,
      config: { ...(result.config as ProjectConfig), layout },
    });
    expect(spread.sheets).not.toEqual(drawing.sheets);
    expect(spread.issues.filter((i) => i.code.startsWith("layout."))).toEqual([]);
  });
});
