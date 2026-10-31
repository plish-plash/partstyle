import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { SymbolUnit } from "../kicad/libsym.js";
import { loadProject } from "../project/load.js";
import { type ValidationResult, validateProject } from "../validate.js";
import { checkConnectivity } from "./connectivity.js";
import { gridRoute, paperFor, papers } from "./layout.js";
import { mirrorUnit, type NetRole, orient, rotateUnit } from "./orient.js";
import { type Drawing, prepareDrawing } from "./prepare.js";
import type { Rect, SheetLayout } from "./types.js";
import { normalizeWires } from "./wires.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));

describe("gridRoute", () => {
  it("keeps every segment orthogonal and lands exactly on both ends", () => {
    // ELK placed the last run half a grid step off: independent snapping would leave a dogleg.
    const raw = [
      { x: 10.2, y: 43.815 },
      { x: 30.3, y: 43.815 },
      { x: 30.3, y: 10.1 },
      { x: 50.9, y: 10.1 },
    ];
    const pts = gridRoute(raw, { x: 10.16, y: 43.18 }, { x: 50.8, y: 10.16 });
    expect(pts[0]).toEqual({ x: 10.16, y: 43.18 });
    expect(pts.at(-1)).toEqual({ x: 50.8, y: 10.16 });
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      expect(a?.x === b?.x || a?.y === b?.y).toBe(true);
    }
  });

  it("turns a straight run that snapped apart into a dogleg", () => {
    const pts = gridRoute(
      [
        { x: 0, y: 5 },
        { x: 20, y: 5 },
      ],
      { x: 0, y: 5.08 },
      { x: 20.32, y: 3.81 },
    );
    expect(pts).toHaveLength(4);
    expect(pts[1]?.y).toBe(5.08);
    expect(pts[2]?.y).toBe(3.81);
  });
});

describe("normalizeWires", () => {
  it("splits at T-connections, merges straight runs and marks junctions", () => {
    const { wires, junctions } = normalizeWires(
      [
        { net: "N", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
        { net: "N", a: { x: 10, y: 0 }, b: { x: 20, y: 0 } }, // continues straight: merged
        { net: "N", a: { x: 5, y: 0 }, b: { x: 5, y: 8 } }, // lands mid-wire: a T
        { net: "N", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }, // duplicate
      ],
      [],
    );
    expect(junctions).toEqual([{ net: "N", at: { x: 5, y: 0 } }]);
    expect(wires.map((w) => [w.a, w.b])).toEqual(
      expect.arrayContaining([
        [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
        ],
        [
          { x: 5, y: 0 },
          { x: 20, y: 0 },
        ],
        [
          { x: 5, y: 0 },
          { x: 5, y: 8 },
        ],
      ]),
    );
    expect(wires).toHaveLength(3);
  });

  it("keeps a break where a pin connects mid-run", () => {
    const { wires } = normalizeWires(
      [{ net: "N", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }],
      [{ net: "N", at: { x: 5, y: 0 } }],
    );
    expect(wires).toHaveLength(2);
  });
});

describe("orient", () => {
  // A vertical two-pin symbol like Device:R: pin 1 on top, pin 2 below.
  const upright: SymbolUnit = {
    unit: 1,
    pins: new Map([
      ["1", { x: 0, y: 3.81, outward: 90, hidden: false, type: "passive" }],
      ["2", { x: 0, y: -3.81, outward: 270, hidden: false, type: "passive" }],
    ]),
    box: { minX: -1, maxX: 1, minY: -3.81, maxY: 3.81 },
  };
  const info =
    (roles: Record<string, NetRole>, names: Record<string, string> = {}) =>
    (n: string) => ({ name: names[n] ?? n, role: roles[n] ?? ("signal" as const) });

  it("stands a part to ground upright with ground at the bottom", () => {
    expect(orient("C1", upright, info({ "1": "ground", "2": "rail" }))).toEqual({
      rotation: 180,
      flippable: false,
    });
    expect(orient("C1", upright, info({ "1": "rail", "2": "ground" }))?.rotation).toBe(0);
  });

  it("puts the rail on top of a pull-up and lays series parts horizontally", () => {
    expect(orient("R5", upright, info({ "2": "rail" }))?.rotation).toBe(180);
    expect(orient("R2", upright, info({}))).toEqual({ rotation: 90, flippable: true });
  });

  it("lays a diode anode-first and leaves other parts alone", () => {
    const diode = info({ "1": "rail" }, { "1": "K", "2": "A" });
    expect(orient("D1", upright, diode)).toEqual({ rotation: 270, flippable: false });
    expect(orient("U1", upright, info({}))).toBeUndefined();
  });

  it("rotates pins counter-clockwise with their directions", () => {
    const turned = rotateUnit(upright, 90);
    expect(turned.pins.get("1")).toMatchObject({ x: -3.81, y: 0, outward: 180 });
    expect(turned.box).toEqual({ minX: -3.81, maxX: 3.81, minY: -1, maxY: 1 });
  });

  it("mirrors pins left to right", () => {
    const side: SymbolUnit = {
      unit: 1,
      pins: new Map([["1", { x: -5.08, y: 2.54, outward: 180, hidden: false, type: "passive" }]]),
      box: { minX: -5.08, maxX: 2, minY: -1, maxY: 3 },
    };
    const m = mirrorUnit(side);
    expect(m.pins.get("1")).toMatchObject({ x: 5.08, y: 2.54, outward: 0 });
    expect(m.box).toEqual({ minX: -2, maxX: 5.08, minY: -1, maxY: 3 });
  });
});

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
  const unit = (pins: { number: string; x: number; y: number; net?: string }[]) => ({
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
  let result: ValidationResult;
  let drawing: Drawing;
  beforeAll(async () => {
    result = validateProject(await loadProject(repo("examples/bench-sensor")));
    drawing = await prepareDrawing(result, { annotation: "", bom: "" });
  });

  it("lays out every sheet with faithful connectivity", () => {
    expect([...drawing.sheets.keys()].sort()).toEqual(["main", "mcu", "power", "sensor_afe"]);
    expect(drawing.issues.filter((i) => i.code === "layout.connectivity")).toEqual([]);
    for (const sheet of drawing.sheets.values()) expect(checkConnectivity(sheet)).toEqual([]);
  });

  it("puts every vertex on the 1.27 mm grid", () => {
    const onGrid = (v: number) => Math.abs(v / 1.27 - Math.round(v / 1.27)) < 1e-6;
    for (const sheet of drawing.sheets.values()) {
      for (const w of sheet.wires) expect([w.a.x, w.a.y, w.b.x, w.b.y].every(onGrid)).toBe(true);
      for (const u of sheet.units)
        for (const p of u.pins) expect(onGrid(p.at.x) && onGrid(p.at.y)).toBe(true);
    }
  });

  it("routes small nets as wires and joins adjacent same-net pins", () => {
    const afe = drawing.sheets.get("sensor_afe") as SheetLayout;
    expect(afe.wires.some((w) => w.net === "BUF")).toBe(true);
    expect(afe.labels.some((l) => l.text === "BUF")).toBe(false);
    // The ATmega's three bottom GND pins are tied by wire under one GND symbol.
    const mcu = drawing.sheets.get("mcu") as SheetLayout;
    const u4 = mcu.units.find((u) => u.ref === "U4");
    const gndPins = (u4?.pins ?? []).filter((p) => p.net === "GND");
    expect(gndPins).toHaveLength(3);
    expect(mcu.wires.filter((w) => w.net === "GND").length).toBeGreaterThanOrEqual(2);
    const symbolsOnU4Gnd = mcu.power.filter((p) =>
      gndPins.some((g) => g.at.x === p.at.x && g.at.y === p.at.y),
    );
    expect(symbolsOnU4Gnd).toHaveLength(1);
  });

  it("turns two-terminal parts: rails up, ground down, series parts in the signal path", () => {
    const power = drawing.sheets.get("power") as SheetLayout;
    const pin = (ref: string, net: string) =>
      power.units.find((u) => u.ref === ref)?.pins.find((p) => p.net === net);
    expect(pin("C1", "+12V")?.outward).toBe(90);
    expect(pin("C1", "GND")?.outward).toBe(270);
    expect(pin("R1", "+5V")?.outward).toBe(90);
    // D1 in series from the jack: anode left, cathode right, no wire looping round it.
    expect(pin("D1", "VIN_RAW")?.outward).toBe(180);
    expect(pin("D1", "+12V")?.outward).toBe(0);
  });

  it("points rail symbols up and ground symbols down", () => {
    for (const sheet of drawing.sheets.values()) {
      for (const p of sheet.power.filter((p) => !p.flag)) {
        if (p.outward === 0 || p.outward === 180) continue; // beside a crowded side pin
        expect([p.name, p.outward]).toEqual([p.name, p.name === "GND" ? 270 : 90]);
      }
    }
    const power = drawing.sheets.get("power") as SheetLayout;
    const u1In = power.power.find((p) => p.name === "+12V" && p.outward === 90);
    expect(u1In).toBeDefined();
  });

  it("draws decoupling capacitors in a row under the part they serve", () => {
    const mcu = drawing.sheets.get("mcu") as SheetLayout;
    const u4 = mcu.units.find((u) => u.ref === "U4")?.box as Rect;
    for (const ref of ["C9", "C10", "C11"]) {
      const c = mcu.units.find((u) => u.ref === ref)?.box as Rect;
      expect(c.y).toBeGreaterThan(u4.y + u4.h);
      expect(c.x).toBeGreaterThanOrEqual(u4.x - 1e-6);
    }
  });

  it("hangs shunt parts under the signal wire beside the pin that drives it", () => {
    const afe = drawing.sheets.get("sensor_afe") as SheetLayout;
    const unit = (ref: string) => afe.units.find((u) => u.ref === ref);
    const r2 = unit("R2")?.pins.find((p) => p.net === "SENSE");
    const u3 = unit("U3")?.pins.find((p) => p.net === "SENSE");
    if (!r2 || !u3) throw new Error("SENSE pins missing");
    for (const ref of ["R4", "C6"]) {
      const top = unit(ref)?.pins.find((p) => p.net === "SENSE");
      expect(top?.outward).toBe(90);
      expect(top?.at.y).toBeGreaterThan(r2.at.y);
      expect(top?.at.x).toBeGreaterThan(r2.at.x);
      expect(top?.at.x).toBeLessThan(u3.at.x);
    }
    // R2's output runs straight into the op-amp, the shunts teed off it.
    expect(r2.at.y).toBe(u3.at.y);
  });

  it("mirrors the input connector to face its circuit", () => {
    const afe = drawing.sheets.get("sensor_afe") as SheetLayout;
    const j2 = afe.units.find((u) => u.ref === "J2");
    expect(j2?.mirror).toBe(true);
    expect(j2?.pins.find((p) => p.net === "SENSE_RAW")?.outward).toBe(0);
    expect(afe.units.find((u) => u.ref === "U3")?.mirror).toBe(false);
  });

  it("puts a hierarchical label on the one pin its net reaches", () => {
    const mcu = drawing.sheets.get("mcu") as SheetLayout;
    const pin = mcu.units.find((u) => u.ref === "U4")?.pins.find((p) => p.net === "AIN");
    const label = mcu.labels.find((l) => l.text === "AIN");
    expect(label?.at).toEqual(pin?.at);
    expect(label?.angle).toBe(pin?.outward);
    expect(mcu.wires.filter((w) => w.net === "AIN")).toEqual([]);
  });

  it("packs every sheet of the example onto A4", () => {
    for (const sheet of drawing.sheets.values()) expect(papers[paperFor(sheet)]?.[0]).toBe("A4");
  });

  it("is deterministic", async () => {
    const again = await prepareDrawing(result, { annotation: "", bom: "" });
    expect([...again.sheets.values()]).toEqual([...drawing.sheets.values()]);
  });

  it("lays out a block used twice", async () => {
    const r = validateProject(await loadProject(repo("packages/engine/test-fixtures/multi")));
    const d = await prepareDrawing(r, { annotation: "", bom: "" });
    expect(d.issues.filter((i) => i.code.startsWith("layout"))).toEqual([]);
    expect(d.plan.instancesOf("filter").map((i) => i.prefix)).toEqual(["F1/", "F2/"]);
  });
});
