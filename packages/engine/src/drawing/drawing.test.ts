import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
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
