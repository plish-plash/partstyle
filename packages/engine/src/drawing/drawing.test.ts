import { fileURLToPath } from "node:url";
import { preferenceGroups } from "@partstyle/layout";
import { beforeAll, describe, expect, it } from "vitest";
import { applyPatch } from "../patch.js";
import type { ProjectConfig } from "../project/config.js";
import { loadProject } from "../project/load.js";
import type { ProjectSource } from "../project/source.js";
import { type ValidationResult, validateProject } from "../validate.js";
import { checkConnectivity } from "./connectivity.js";
import { paperFor, papers } from "./paper.js";
import { type Drawing, prepareDrawing } from "./prepare.js";
import type { PlacedPin, PlacedUnit, Rect, SheetLayout } from "./types.js";

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

describe("prepareDrawing", () => {
  let source: ProjectSource;
  let result: ValidationResult;
  let drawing: Drawing;
  /** The example with a patch applied, drawn. */
  const patched = async (patch: string) => {
    const p = applyPatch(source, patch);
    expect(p.issues).toEqual([]);
    return prepareDrawing(validateProject(p.source), { annotation: "", bom: "" });
  };
  beforeAll(async () => {
    source = await loadProject(repo("examples/bench-sensor"), seed);
    result = validateProject(source);
    drawing = await prepareDrawing(result, { annotation: "", bom: "" });
  });
  const sheetOf = (d: Drawing, name: string) => d.sheets.get(name) as SheetLayout;
  const unitOf = (s: SheetLayout, ref: string) => s.units.find((u) => u.ref === ref) as PlacedUnit;
  const pinOf = (s: SheetLayout, ref: string, net: string) =>
    unitOf(s, ref).pins.find((p) => p.net === net) as PlacedPin;

  it("lays out every sheet with faithful connectivity", () => {
    expect([...drawing.sheets.keys()].sort()).toEqual(["main", "mcu", "power", "sensor_afe"]);
    expect(drawing.issues.filter((i) => i.code === "layout.connectivity")).toEqual([]);
    for (const sheet of drawing.sheets.values()) expect(checkConnectivity(sheet)).toEqual([]);
  });

  it("puts every pin and wire vertex on the 2.54 mm grid", () => {
    const onGrid = (v: number) => Math.abs(v / 2.54 - Math.round(v / 2.54)) < 1e-6;
    for (const sheet of drawing.sheets.values()) {
      for (const w of sheet.wires) expect([w.a.x, w.a.y, w.b.x, w.b.y].every(onGrid)).toBe(true);
      for (const u of sheet.units)
        for (const p of u.pins) expect(onGrid(p.at.x) && onGrid(p.at.y)).toBe(true);
    }
  });

  it("turns two-terminal parts: rails up, ground down, series parts in the signal path", () => {
    const power = sheetOf(drawing, "power");
    expect(pinOf(power, "C1", "+12V").outward).toBe(90);
    expect(pinOf(power, "C1", "GND").outward).toBe(270);
    expect(pinOf(power, "R1", "+5V").outward).toBe(90);
    // D1 in series from the jack: anode left, cathode right.
    expect(pinOf(power, "D1", "VIN_RAW").outward).toBe(180);
    expect(pinOf(power, "D1", "+12V").outward).toBe(0);
  });

  it("points rail symbols up and ground symbols down", () => {
    for (const sheet of drawing.sheets.values()) {
      for (const p of sheet.power.filter((p) => !p.flag)) {
        if (p.outward === 0 || p.outward === 180) continue; // beside a crowded side pin
        expect([p.name, p.outward]).toEqual([p.name, p.name === "GND" ? 270 : 90]);
      }
    }
  });

  it("orders groups left to right along the signal flow", () => {
    const afe = sheetOf(drawing, "sensor_afe");
    expect(unitOf(afe, "J2").box.x).toBeLessThan(unitOf(afe, "U3").box.x);
    const power = sheetOf(drawing, "power");
    const x = (ref: string) => unitOf(power, ref).box.x;
    expect(x("J1")).toBeLessThan(x("U1"));
    expect(x("U1")).toBeLessThan(x("U2"));
  });

  it("mirrors a source connector to face its circuit", () => {
    const afe = sheetOf(drawing, "sensor_afe");
    expect(unitOf(afe, "J2").mirror).toBe(true);
    expect(pinOf(afe, "J2", "SENSE_RAW").outward).toBe(0);
    expect(unitOf(afe, "U3").mirror).toBe(false);
  });

  it("ends a row in the hierarchical label of the one pin its net reaches", () => {
    const mcu = sheetOf(drawing, "mcu");
    const pin = pinOf(mcu, "U4", "AIN");
    const label = mcu.labels.find((l) => l.text === "AIN");
    expect(label?.kind).toBe("hier");
    expect(label?.at.y).toBe(pin.at.y);
    expect(label?.angle).toBe(pin.outward);
  });

  it("fits every sheet of the example on A4", () => {
    for (const sheet of drawing.sheets.values()) expect(papers[paperFor(sheet)]?.[0]).toBe("A4");
  });

  it("is deterministic", async () => {
    const again = await prepareDrawing(result, { annotation: "", bom: "" });
    expect([...again.sheets.values()]).toEqual([...drawing.sheets.values()]);
  });

  it("puts grounded parts below the wire that feeds them", async () => {
    const r = validateProject(
      await loadProject(repo("packages/engine/test-fixtures/pulldowns"), seed),
    );
    const d = await prepareDrawing(r, { annotation: "", bom: "" });
    const sheet = sheetOf(d, "main");
    expect(checkConnectivity(sheet)).toEqual([]);
    for (const [ref, net] of [
      ["R1", "BTN0"],
      ["R2", "BTN1"],
      ["R3", "BTN2"],
    ] as const) {
      expect(pinOf(sheet, ref, net).outward).toBe(90);
      expect(pinOf(sheet, ref, "GND").at.y).toBeGreaterThan(pinOf(sheet, ref, net).at.y);
    }
  });

  it("hangs shunts off the signal wire", () => {
    const afe = sheetOf(drawing, "sensor_afe");
    const row = pinOf(afe, "U3", "SENSE").at.y;
    for (const ref of ["R4", "C6"]) {
      expect(pinOf(afe, ref, "SENSE").at.y).toBe(row);
      expect(pinOf(afe, ref, "GND").at.y).toBeGreaterThan(row);
    }
  });

  it("lays out a block used twice", async () => {
    const r = validateProject(await loadProject(repo("packages/engine/test-fixtures/multi"), seed));
    const d = await prepareDrawing(r, { annotation: "", bom: "" });
    expect(d.issues.filter((i) => i.code.startsWith("layout"))).toEqual([]);
    expect(d.plan.instancesOf("filter").map((i) => i.prefix)).toEqual(["F1/", "F2/"]);
  });

  it("never puts a label on a pin that has a wire, and dots pins with two", async () => {
    for (const sheet of drawing.sheets.values()) {
      expect(checkConnectivity(sheet)).toEqual([]);
      const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
      const ends = new Map<string, number>();
      for (const w of sheet.wires)
        for (const p of [w.a, w.b]) ends.set(key(p), (ends.get(key(p)) ?? 0) + 1);
      const pins = new Set(sheet.units.flatMap((u) => u.pins.map((p) => key(p.at))));
      for (const l of sheet.labels) {
        if (pins.has(key(l.at))) expect([l.text, ends.get(key(l.at)) ?? 0]).toEqual([l.text, 0]);
      }
      const dots = new Set(sheet.junctions.map((j) => key(j.at)));
      for (const p of pins)
        if ((ends.get(p) ?? 0) >= 2) expect([p, dots.has(p)]).toEqual([p, true]);
    }
  });

  it("ties a part's adjacent pins on one rail under one symbol", () => {
    const mcu = sheetOf(drawing, "mcu");
    const gndPins = unitOf(mcu, "U4").pins.filter((p) => p.net === "GND");
    expect(gndPins).toHaveLength(3);
    const symbols = mcu.power.filter((p) =>
      gndPins.some((g) => g.at.x === p.at.x && g.at.y === p.at.y),
    );
    expect(symbols).toHaveLength(1);
  });

  it("sets text above a part lying down and beside one standing up", () => {
    const afe = sheetOf(drawing, "sensor_afe");
    const r2 = unitOf(afe, "R2");
    expect(r2.box.w).toBeGreaterThan(r2.box.h);
    expect(r2.refField.justify).toEqual(["bottom"]);
    expect(r2.refField.at.y).toBeLessThan(r2.box.y);
    const r4 = unitOf(afe, "R4");
    expect(r4.box.h).toBeGreaterThan(r4.box.w);
    expect(r4.refField.at.x).toBeGreaterThanOrEqual(r4.box.x + r4.box.w);
    expect(r4.refField.at.y).toBeLessThan(r4.valueField.at.y);
  });

  it("flags rails from outside the design", () => {
    const flags = [...drawing.sheets.values()].flatMap((s) => s.power.filter((p) => p.flag));
    expect(flags.length).toBeGreaterThan(0);
    for (const f of flags) expect(f.name).toBe("PWR_FLAG");
  });

  it("draws a long chain on bigger paper rather than breaking it", async () => {
    const chain = Array.from({ length: 14 }, (_, i) => i + 1);
    const d = await patched(
      [
        "in chain",
        "+ block chain",
        ...chain.map((i) => `+ part U${i} lib:MCP6002`),
        ...chain.slice(1).map((i) => `+ net N${i} : U${i - 1}.OUTA U${i}.VINA+`),
        "in main",
        "+ use chain as CH",
      ].join("\n"),
    );
    expect(checkConnectivity(sheetOf(d, "chain"))).toEqual([]);
  });

  it("dots only where three or more things meet", () => {
    const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    for (const sheet of drawing.sheets.values()) {
      for (const l of sheet.labels) {
        const ends = sheet.wires.filter((w) => key(w.a) === key(l.at) || key(w.b) === key(l.at));
        if (ends.length === 1) {
          expect(sheet.junctions.map((j) => key(j.at))).not.toContain(key(l.at));
        }
      }
      for (const f of sheet.power.filter((p) => p.flag)) {
        const at = key(f.at);
        const things =
          sheet.wires.filter((w) => key(w.a) === at || key(w.b) === at).length +
          sheet.power.filter((p) => key(p.at) === at).length;
        if (things >= 3) expect(sheet.junctions.map((j) => key(j.at))).toContain(at);
      }
    }
  });

  it("follows the project's layout preferences and stays connected at their limits", async () => {
    const draw = (layout: Record<string, Record<string, number | string>>) =>
      prepareDrawing(
        { ...result, config: { ...(result.config as ProjectConfig), layout } },
        { annotation: "", bom: "" },
      );
    const spread = await draw({ "pack-groups": { gap: 12 }, "shunt-hang": { spacing: 10 } });
    expect(spread.sheets).not.toEqual(drawing.sheets);
    expect(spread.issues.filter((i) => i.code.startsWith("layout."))).toEqual([]);
    for (const group of preferenceGroups()) {
      for (const p of group.params) {
        const ends = p.type === "number" ? [p.min, p.max] : p.type === "enum" ? p.options : [];
        for (const value of ends) {
          const d = await draw({ [group.rule]: { [p.key]: value } });
          const name = `${group.rule}.${p.key}=${value}`;
          expect([name, d.issues.filter((i) => i.code.startsWith("layout."))]).toEqual([name, []]);
        }
      }
    }
  });

  it("keeps wires out of every part", () => {
    for (const sheet of drawing.sheets.values()) {
      for (const u of sheet.units) {
        const b = u.box;
        for (const w of sheet.wires) {
          const x0 = Math.min(w.a.x, w.b.x);
          const x1 = Math.max(w.a.x, w.b.x);
          const y0 = Math.min(w.a.y, w.b.y);
          const y1 = Math.max(w.a.y, w.b.y);
          const inside =
            x0 < b.x + b.w - 0.01 && x1 > b.x + 0.01 && y0 < b.y + b.h - 0.01 && y1 > b.y + 0.01;
          expect([u.ref, w.net, inside]).toEqual([u.ref, w.net, false]);
        }
      }
    }
  });

  it("gives every two-terminal part a box as wide as its symbol", () => {
    for (const sheet of drawing.sheets.values()) {
      for (const u of sheet.units) {
        if (u.pins.length === 2) expect(Math.min(u.box.w, u.box.h)).toBeGreaterThan(2);
      }
    }
  });

  it("keeps parts clear of each other", () => {
    const overlap = (a: Rect, b: Rect) =>
      a.x < b.x + b.w - 0.01 &&
      b.x < a.x + a.w - 0.01 &&
      a.y < b.y + b.h - 0.01 &&
      b.y < a.y + a.h - 0.01;
    for (const sheet of drawing.sheets.values()) {
      for (const a of sheet.units) {
        for (const b of sheet.units) {
          if (a !== b) expect([a.ref, b.ref, overlap(a.box, b.box)]).toEqual([a.ref, b.ref, false]);
        }
      }
    }
  });
});
