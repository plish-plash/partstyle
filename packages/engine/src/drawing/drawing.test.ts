import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { SymbolUnit } from "../kicad/libsym.js";
import { applyPatch } from "../patch.js";
import { loadProject } from "../project/load.js";
import type { ProjectSource } from "../project/source.js";
import { type ValidationResult, validateProject } from "../validate.js";
import { checkConnectivity } from "./connectivity.js";
import { labelHarm, labelSpot } from "./layout.js";
import { mirrorUnit, type NetRole, orient, rotateUnit } from "./orient.js";
import { paperFor, papers } from "./paper.js";
import { type Drawing, prepareDrawing } from "./prepare.js";
import { route } from "./route.js";
import type { PlacedPin, PlacedUnit, Rect, SheetLayout, WireSegment } from "./types.js";
import { normalizeWires } from "./wires.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const seed = [repo("library")];

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

  it("marks two wires meeting at a pin with a junction", () => {
    const pin = { net: "N", at: { x: 0, y: 0 } };
    const segments = [
      { net: "N", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
      { net: "N", a: { x: 0, y: 0 }, b: { x: 0, y: 10 } },
    ];
    expect(normalizeWires(segments, [pin], [pin]).junctions).toEqual([pin]);
    expect(normalizeWires(segments.slice(0, 1), [pin], [pin]).junctions).toEqual([]);
  });

  it("keeps a break where a pin connects mid-run", () => {
    const { wires } = normalizeWires(
      [{ net: "N", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }],
      [{ net: "N", at: { x: 5, y: 0 } }],
    );
    expect(wires).toHaveLength(2);
  });
});

describe("route", () => {
  const sheet = { width: 60, height: 40, text: [], fixed: [] };

  const around = (groups: [string, string]) =>
    route({
      ...sheet,
      obstacles: [{ x: 20, y: 0, w: 5, h: 30 }],
      points: [
        { net: "A", at: { x: 10.16, y: 10.16 } },
        { net: "A", at: { x: 40.64, y: 10.16 } },
      ],
      nets: [
        {
          net: "A",
          pieces: [
            { points: [{ x: 10.16, y: 10.16 }], segments: [], group: groups[0] },
            { points: [{ x: 40.64, y: 10.16 }], segments: [], group: groups[1] },
          ],
        },
      ],
    });

  it("goes around obstacles within a group, and leaves a long detour between groups", () => {
    const { segments, failed } = around(["U1", "U1"]);
    expect(failed).toEqual([]);
    expect(around(["U1", "J1"]).failed).toEqual(["A"]);
    for (const s of segments) {
      expect(s.a.x === s.b.x || s.a.y === s.b.y).toBe(true);
      // Clear of the obstacle: below it.
      if (s.a.y === s.b.y && Math.max(s.a.x, s.b.x) > 20 && Math.min(s.a.x, s.b.x) < 25) {
        expect(s.a.y).toBeGreaterThan(30);
      }
    }
  });

  it("crosses another net only straight through", () => {
    const blocker = { net: "B", a: { x: 0, y: 20.32 }, b: { x: 60.96, y: 20.32 } };
    const { segments, failed } = route({
      ...sheet,
      fixed: [blocker],
      obstacles: [],
      points: [
        { net: "A", at: { x: 30.48, y: 10.16 } },
        { net: "A", at: { x: 30.48, y: 30.48 } },
      ],
      nets: [
        {
          net: "A",
          pieces: [
            { points: [{ x: 30.48, y: 10.16 }], segments: [] },
            { points: [{ x: 30.48, y: 30.48 }], segments: [] },
          ],
        },
      ],
    });
    expect(failed).toEqual([]);
    const ends = segments.flatMap((s) => [s.a, s.b]);
    expect(ends.some((p) => p.y === 20.32)).toBe(false);
  });
});

describe("labelSpot", () => {
  // A pin pointing left at (10.16, 10.16) with a part in line: its wire runs left to 5.08.
  const piece = {
    net: "INT_IN",
    points: [{ x: 10.16, y: 10.16 }],
    segments: [{ net: "INT_IN", a: { x: 10.16, y: 10.16 }, b: { x: 5.08, y: 10.16 } }],
    labelAt: { x: 10.16, y: 10.16 },
    labelDir: 180,
  };
  const choose = (wires: WireSegment[]) =>
    labelSpot(piece, (spot) =>
      labelHarm(
        { ...spot, net: "INT_IN", text: "INT_IN", kind: "local" },
        { wires, pins: [], rects: [] },
      ),
    );
  const across = (y: number): WireSegment => ({ net: "X", a: { x: 0, y }, b: { x: 20.32, y } });

  it("tees a stub off the wire just past the pin, above it when that is clear", () => {
    expect(choose([])).toMatchObject({
      at: { x: 7.62, y: 5.08 },
      angle: 90,
      stub: [{ a: { x: 7.62, y: 10.16 }, b: { x: 7.62, y: 5.08 } }],
    });
  });

  it("goes below when the stub above would end on a wire", () => {
    expect(choose([across(5.08)]).at).toEqual({ x: 7.62, y: 15.24 });
  });

  it("would rather cross a wire than end on one", () => {
    // Both short stubs would end on a wire (the next pin's above, a feedback loop below): a
    // longer stub up crosses the wire above instead.
    expect(choose([across(5.08), across(15.24)])).toMatchObject({
      at: { x: 7.62, y: 2.54 },
      angle: 90,
    });
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
    hints: [],
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
    group: "U1",
    stage: 1,
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

  it("wires nets within and between neighbouring groups and joins adjacent same-net pins", () => {
    const afe = sheetOf(drawing, "sensor_afe");
    expect(afe.wires.some((w) => w.net === "BUF")).toBe(true);
    expect(afe.labels.some((l) => l.text === "BUF")).toBe(false);
    expect(afe.wires.some((w) => w.net === "SENSE")).toBe(true);
    // The ATmega's three bottom GND pins are tied by wire under one GND symbol.
    const mcu = sheetOf(drawing, "mcu");
    const gndPins = unitOf(mcu, "U4").pins.filter((p) => p.net === "GND");
    expect(gndPins).toHaveLength(3);
    expect(mcu.wires.filter((w) => w.net === "GND").length).toBeGreaterThanOrEqual(2);
    const symbolsOnU4Gnd = mcu.power.filter((p) =>
      gndPins.some((g) => g.at.x === p.at.x && g.at.y === p.at.y),
    );
    expect(symbolsOnU4Gnd).toHaveLength(1);
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

  it("draws decoupling capacitors in a row under the part they serve", () => {
    const mcu = sheetOf(drawing, "mcu");
    const u4 = unitOf(mcu, "U4").box;
    for (const ref of ["C9", "C10", "C11"]) {
      const c = unitOf(mcu, ref).box;
      expect(c.y).toBeGreaterThan(u4.y + u4.h);
      expect(c.x).toBeGreaterThanOrEqual(u4.x - 1e-6);
      expect(unitOf(mcu, ref).group).toBe("U4");
    }
  });

  it("hangs shunt parts under the signal wire beside the pin they serve", () => {
    const afe = sheetOf(drawing, "sensor_afe");
    const u3 = pinOf(afe, "U3", "SENSE");
    for (const ref of ["R4", "C6"]) {
      const top = pinOf(afe, ref, "SENSE");
      expect(top.outward).toBe(90);
      expect(top.at.y).toBeGreaterThan(u3.at.y);
      expect(top.at.x).toBeLessThan(u3.at.x);
    }
    // R2's output runs straight into the op-amp's row, the shunts teed off it.
    expect(pinOf(afe, "R2", "SENSE").at.y).toBe(u3.at.y);
  });

  it("orders groups left to right along the signal flow", () => {
    const afe = sheetOf(drawing, "sensor_afe");
    expect(unitOf(afe, "J2").stage).toBeLessThan(unitOf(afe, "U3").stage);
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
    expect(afe.hints.find((h) => h.ref === "J2")).toMatchObject({ flip: true, stored: {} });
  });

  it("puts a hierarchical label on the one pin its net reaches", () => {
    const mcu = sheetOf(drawing, "mcu");
    const pin = pinOf(mcu, "U4", "AIN");
    const label = mcu.labels.find((l) => l.text === "AIN");
    expect(label?.at).toEqual(pin.at);
    expect(label?.angle).toBe(pin.outward);
    expect(mcu.wires.filter((w) => w.net === "AIN")).toEqual([]);
  });

  it("packs every sheet of the example onto A4", () => {
    for (const sheet of drawing.sheets.values()) expect(papers[paperFor(sheet)]?.[0]).toBe("A4");
  });

  it("is deterministic", async () => {
    const again = await prepareDrawing(result, { annotation: "", bom: "" });
    expect([...again.sheets.values()]).toEqual([...drawing.sheets.values()]);
  });

  it("honours stored rotation, flip and stage", async () => {
    // U3 pinned too, as the viewer does on a sheet's first edit: else it follows J2 along.
    const d = await patched(
      "in sensor_afe\n= part J2 lib:TSW-103-07-G-S [3 noflip]\n= part U3 lib:MCP6002-I_SN [2]\n= part R4 res(100k, 1%, 0603) [r0]",
    );
    const afe = sheetOf(d, "sensor_afe");
    expect(checkConnectivity(afe)).toEqual([]);
    expect(unitOf(afe, "J2").mirror).toBe(false);
    expect(unitOf(afe, "J2").stage).toBe(3);
    expect(unitOf(afe, "J2").box.x).toBeGreaterThan(unitOf(afe, "U3").box.x);
    expect(unitOf(afe, "R4").rotation).toBe(0);
    expect(afe.hints.find((h) => h.ref === "J2")?.stored).toEqual({ stage: 3, flip: false });
  });

  it("warns of hints a part cannot take", async () => {
    const d = await patched(
      "in sensor_afe\n= part U3 lib:MCP6002-I_SN [r90]\n= part R4 res(100k, 1%, 0603) [flip]",
    );
    const bad = d.issues.filter((i) => i.code === "layout.bad-hint").flatMap((i) => i.subjects);
    expect(bad.sort()).toEqual(["R4", "U3"]);
  });

  it("gives a passive with a stage a group of its own", async () => {
    const d = await patched("in sensor_afe\n= part R3 res(1k, 1%, 0603) [5]");
    const afe = sheetOf(d, "sensor_afe");
    expect(checkConnectivity(afe)).toEqual([]);
    expect(unitOf(afe, "R3").group).toBe("R3");
    expect(unitOf(afe, "R3").box.x).toBeGreaterThan(unitOf(afe, "U3").box.x);
  });

  it("labels nets between groups that are not neighbours", async () => {
    // U3 moved two stages on: J2 and U3 no longer sit side by side, so SENSE is labelled.
    const d = await patched(
      "in sensor_afe\n= part U3 lib:MCP6002-I_SN [4]\n= part J2 lib:TSW-103-07-G-S [1]\n+ part U9 lib:MCP6002-I_SN [2]",
    );
    const afe = sheetOf(d, "sensor_afe");
    expect(checkConnectivity(afe)).toEqual([]);
    expect(afe.labels.filter((l) => l.text === "SENSE").length).toBeGreaterThanOrEqual(2);
  });

  it("wraps a long chain onto another row", async () => {
    const chain = Array.from({ length: 14 }, (_, i) => i + 1);
    const patch = [
      "in chain",
      "+ block chain",
      ...chain.map((i) => `+ part U${i} lib:MCP6002-I_SN [${i}]`),
      ...chain.slice(1).map((i) => `+ net N${i} : U${i - 1}.OUTA U${i}.VINA+`),
      "in main",
      "+ use chain as CH",
    ].join("\n");
    const d = await patched(patch);
    const s = sheetOf(d, "chain");
    expect(checkConnectivity(s)).toEqual([]);
    const ys = new Set(s.units.filter((u) => u.unit === 1).map((u) => u.box.y));
    expect(ys.size).toBeGreaterThan(1);
    expect(s.width).toBeLessThan(297);
  });

  it("sets narrow groups of one stage side by side, each chain kept together", async () => {
    // Two more LED chains on the 5 V rail: U1 feeds them, so they share the stage of the
    // existing R1–D2 chain, under U2 and its decoupling.
    const n = [7, 8];
    const d = await patched(
      [
        "in power",
        ...n.flatMap((i) => [`+ part R${i} res(1k)`, `+ part D${i} led(red)`]),
        ...n.flatMap((i) => [`net +5V += R${i}.1`, `net GND += D${i}.K`]),
        ...n.map((i) => `+ net A${i} : R${i}.2 D${i}.A`),
      ].join("\n"),
    );
    const s = sheetOf(d, "power");
    expect(checkConnectivity(s)).toEqual([]);
    const [r1, r7, r8] = ["R1", "R7", "R8"].map((r) => unitOf(s, r));
    expect([r1?.stage, r7?.stage, r8?.stage]).toEqual([3, 3, 3]);
    expect(new Set([r1, r7, r8].map((u) => u?.box.y)).size).toBe(1);
    expect((r1 as PlacedUnit).box.x).toBeLessThan((r7 as PlacedUnit).box.x);
    expect((r7 as PlacedUnit).box.x).toBeLessThan((r8 as PlacedUnit).box.x);
    for (const [r, led] of [
      ["R1", "D2"],
      ["R7", "D7"],
      ["R8", "D8"],
    ] as const) {
      // Each LED straight under its own resistor.
      expect(unitOf(s, led).box.x).toBe(unitOf(s, r).box.x);
      expect(unitOf(s, led).box.y).toBeGreaterThan(unitOf(s, r).box.y);
    }
  });

  it("lines a connector up with the pins low on a tall part that feed it", () => {
    // J5 shares a stage with J3, under it; one of its UART pins lines up with the ATmega's, far
    // down (the two parts order them oppositely, so only one can).
    const mcu = sheetOf(drawing, "mcu");
    const level = (net: string) => pinOf(mcu, "J5", net).at.y === pinOf(mcu, "U4", net).at.y;
    expect(level("TXD") || level("RXD")).toBe(true);
  });

  it("lines a group up with the nearer of the parts it follows", async () => {
    // U1 and U2 share stage 1, U2 below U1. U3's upper input comes from U2 and its lower one
    // from U1: it lines up with U1 (the smaller move), not with whichever was placed last.
    const d = await patched(
      [
        "in pick",
        "+ block pick",
        "+ part U1 lib:MCP6002-I_SN [1]",
        "+ part U2 lib:MCP6002-I_SN [1]",
        "+ part U3 lib:MCP6002-I_SN [2]",
        "+ net HI : U2.OUTA U3.VINA-",
        "+ net LO : U1.OUTA U3.VINB+",
        "in main",
        "+ use pick as PK",
      ].join("\n"),
    );
    const s = sheetOf(d, "pick");
    expect(checkConnectivity(s)).toEqual([]);
    expect(unitOf(s, "U2").box.y).toBeGreaterThan(unitOf(s, "U1").box.y);
    expect(pinOf(s, "U3", "LO").at.y).toBe(pinOf(s, "U1", "LO").at.y);
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
      expect(pinOf(sheet, ref, net).at.y).toBeGreaterThan(pinOf(sheet, "U1", net).at.y);
    }
  });

  it("lays out a block used twice", async () => {
    const r = validateProject(await loadProject(repo("packages/engine/test-fixtures/multi"), seed));
    const d = await prepareDrawing(r, { annotation: "", bom: "" });
    expect(d.issues.filter((i) => i.code.startsWith("layout"))).toEqual([]);
    expect(d.plan.instancesOf("filter").map((i) => i.prefix)).toEqual(["F1/", "F2/"]);
  });

  it("never puts a label on a pin that has a wire, and dots pins with two", async () => {
    // BUF reaches a part two slots on (past U8), so it is labelled; U3's output also feeds R3
    // in line.
    const far = await patched(
      "in sensor_afe\n+ part U8 lib:MCP6002-I_SN [4]\n+ part U9 lib:MCP6002-I_SN [6]\nnet BUF += U9.VINA+\n= part U3 lib:MCP6002-I_SN [2]",
    );
    const sheets = [...drawing.sheets.values(), sheetOf(far, "sensor_afe")];
    expect(
      sheetOf(far, "sensor_afe").labels.filter((l) => l.text === "BUF").length,
    ).toBeGreaterThan(1);
    for (const sheet of sheets) {
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

  it("hangs a label off a wire clear of the wire on the next pin", async () => {
    // R2 sits in line on U1's + input, so INT_IN (which reaches U9, two slots on past U8) is
    // labelled on a stub teed off that wire; R1 stands over the wire of the − input, one pin
    // above (as the generated op-amp symbol orders them).
    const d = await patched(
      [
        "in tee",
        "+ block tee",
        "+ part U1 lib:MCP6002-I_SN",
        "+ part R1 res(10k)",
        "+ part R2 res(1k)",
        "+ part U8 lib:MCP6002-I_SN [5]",
        "+ part U9 lib:MCP6002-I_SN [6]",
        "+ net +5V : R1.1 U1.VDD U9.VDD",
        "+ net GND : U1.VSS U9.VSS",
        "+ net P : U1.VINA- R1.2",
        "+ net INT_IN : U1.VINA+ R2.1 U9.VINA+",
        "+ net X : R2.2 U9.VINB+",
        "in main",
        "+ use tee as T",
      ].join("\n"),
    );
    const s = sheetOf(d, "tee");
    expect(unitOf(s, "R2").group).toBe("U1");
    expect(s.labels.filter((l) => l.text === "INT_IN").length).toBe(2);
    expect(checkConnectivity(s)).toEqual([]);
    // No wire leading to a label touches another net's wire, not even to cross it.
    const touch = (a: WireSegment, b: WireSegment) =>
      Math.max(Math.min(a.a.x, a.b.x), Math.min(b.a.x, b.b.x)) <=
        Math.min(Math.max(a.a.x, a.b.x), Math.max(b.a.x, b.b.x)) &&
      Math.max(Math.min(a.a.y, a.b.y), Math.min(b.a.y, b.b.y)) <=
        Math.min(Math.max(a.a.y, a.b.y), Math.max(b.a.y, b.b.y));
    for (const l of s.labels) {
      const at = (p: { x: number; y: number }) => p.x === l.at.x && p.y === l.at.y;
      for (const stub of s.wires.filter((w) => w.net === l.net && (at(w.a) || at(w.b)))) {
        const hit = s.wires.filter((w) => w.net !== l.net && touch(w, stub));
        expect([l.text, hit]).toEqual([l.text, []]);
      }
    }
  });

  it("places text as the viewer draws it: centred over a part, or just right of an upright one", () => {
    const afe = sheetOf(drawing, "sensor_afe");
    // J2 is mirrored, so its library's text placement does not apply.
    const j2 = unitOf(afe, "J2");
    const centre = j2.box.x + j2.box.w / 2;
    expect(j2.valueField).toMatchObject({ at: { x: centre }, justify: [] });
    expect(j2.refField).toMatchObject({ at: { x: centre }, justify: [] });
    expect(j2.valueField.at.y).toBeLessThan(j2.box.y);
    expect(j2.refField.at.y).toBeLessThan(j2.valueField.at.y);
    const r4 = unitOf(afe, "R4");
    for (const f of [r4.refField, r4.valueField]) {
      expect(f).toMatchObject({ at: { x: r4.box.x + r4.box.w + 1.27 }, justify: ["left"] });
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
