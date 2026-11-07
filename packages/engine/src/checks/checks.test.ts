import { describe, expect, it } from "vitest";
import { validateProject } from "../validate.js";
import { parseVoltageRange, railVoltage } from "./nets.js";

/** An LDO with a 6.5 V input limit that wants 1 uF on VIN, and a dual-supply MCU. */
const records = {
  LDO: `id: LDO
manufacturer: ACME
preferred_mpn: LDO
summary: test LDO
package: SOT-23
footprint: Lib:SOT-23
pins:
  1: { name: GND, type: power_in }
  2: { name: VOUT, type: power_out }
  3: { name: VIN, type: power_in, vmax: 6.5V }
temp_c: [-40, 85]
requirements:
  - text: 1 uF on VIN
    cap: { from: VIN, min: 1u }
  - keep the output trace short
provenance: { extracted_by: ai, verified_by: null }
`,
  MCU: `id: MCU
manufacturer: ACME
preferred_mpn: MCU
summary: test MCU
package: QFN-32
footprint: Lib:QFN-32
pins:
  1: { name: VCC, type: power_in }
  2: { name: VCC, type: power_in }
  3: { name: GND, type: power_in }
  4: { name: EN, type: input }
  5: { name: SDA, type: bidir, vmax: 3.6V }
requirements:
  - text: 100 nF on each VCC pin
    cap: { from: VCC, min: 100n, each: true }
  - text: EN tied to VCC
    tie: { from: EN, to: VCC }
  - text: 2.2k-10k pull-up on SDA
    res: { from: SDA, to: VCC, min: 2.2k, max: 10k }
provenance: { extracted_by: ai, verified_by: human }
`,
  CONN: `id: CONN
manufacturer: ACME
preferred_mpn: CONN
summary: test 3-pin connector
package: PinHeader
footprint: Lib:Header
pins:
  1: { name: SIG, type: passive }
  2: { name: PWR, type: passive }
  3: { name: GND, type: passive }
provenance: { extracted_by: ai, verified_by: human }
`,
};

/** `context` and `config` are YAML lines appended to the project file. */
function check(circuit: string, opts: { context?: string; config?: string } = {}) {
  return validateProject({
    project: {
      file: "partstyle-project.yaml",
      text: `name: t\n${opts.context ?? ""}${opts.config ?? ""}`,
    },
    circuits: [{ file: "circuit/main.ckt", text: circuit }],
    parts: Object.entries(records).map(([id, text]) => ({
      file: `parts/${id}.yaml`,
      text,
      layer: "project" as const,
    })),
  }).issues;
}

const codes = (issues: ReturnType<typeof check>, prefix: string) =>
  issues
    .filter((i) => i.code.startsWith(prefix))
    .map((i) => `${i.severity} ${i.code} ${i.message}`);

const ldo = (vin: string, cap: string) => `block main "t"
part U1 lib:LDO
part C1 ${cap}
part C2 cap(1u, 16V, 0603)
net ${vin} : U1.VIN C1.1 {source: bench}
net +3V3 : U1.VOUT C2.1
net GND : U1.GND C1.2 C2.2 {source: bench}
`;

describe("net voltages", () => {
  it("reads attributes and rail names", () => {
    expect(parseVoltageRange("5V")).toEqual({ min: 5, max: 5 });
    expect(parseVoltageRange("12V ±10%")?.max).toBeCloseTo(13.2);
    expect(parseVoltageRange("0-3.3V")).toEqual({ min: 0, max: 3.3 });
    expect(parseVoltageRange("-5V to 5V")).toEqual({ min: -5, max: 5 });
    expect(parseVoltageRange("1A")).toBeUndefined();
    expect(railVoltage("+3V3")).toBe(3.3);
    expect(railVoltage("+12V")).toBe(12);
    expect(railVoltage("-5V")).toBe(-5);
    expect(railVoltage("VBUS")).toBeUndefined();
  });
});

describe("part checks", () => {
  it("flags a pin above its vmax, from the net's attribute or rail name", () => {
    expect(codes(check(ldo("+5V", "cap(1u, 16V, 0603)")), "part.overvoltage")).toEqual([]);
    expect(codes(check(ldo("+12V", "cap(1u, 25V, 0603)")), "part.overvoltage")).toEqual([
      "error part.overvoltage U1.VIN is rated 6.5V max, but +12V reaches 12V",
    ]);
    const attr = ldo("VIN", "cap(1u, 25V, 0603)").replace("{source", "{voltage: 12V ±10%, source");
    expect(codes(check(attr), "part.overvoltage")).toEqual([
      "error part.overvoltage U1.VIN is rated 6.5V max, but VIN reaches 13.2V",
    ]);
  });

  it("derates capacitors by the configured factor", () => {
    const at12 = (cap: string, config?: string) =>
      codes(check(ldo("+12V", cap), config ? { config } : {}), "part.cap-voltage");
    expect(at12("cap(1u, 25V, 0603)")).toEqual([]);
    expect(at12("cap(1u, 16V, 0603)")).toEqual([
      "warning part.cap-voltage C1 cap(1u, 16V, 0603) sees 12V across +12V/GND: rated 16V, under 1.5x (pick ≥ 18V)",
    ]);
    expect(at12("cap(1u, 10V, 0603)")).toEqual([
      "error part.cap-voltage C1 cap(1u, 10V, 0603) is rated 10V but sees 12V across +12V/GND",
    ]);
    expect(at12("cap(1u, 25V, 0603)", "checks: {cap_derating: 2.5}\n")).toHaveLength(1);
  });

  it("errors when a polarized capacitor is certainly reversed, and only then", () => {
    const board = (plus: string, minus: string) =>
      `block main "t"\npart C1 cap(100u, 25V, polarized)\nnet +5V : C1.${plus} {source: bench}\nnet GND : C1.${minus}\n`;
    expect(codes(check(board("+", "-")), "part.cap-polarity")).toEqual([]);
    expect(codes(check(board("-", "+")), "part.cap-polarity")).toEqual([
      "error part.cap-polarity C1 is polarized, but + is on GND (0V), below - on +5V (5V)",
    ]);
    // A net with no known voltage proves nothing.
    const unknown = board("-", "+").replace("net +5V", "net SIG");
    expect(codes(check(unknown), "part.cap-polarity")).toEqual([]);
  });

  it("checks requirements that carry a check, and names what it found", () => {
    expect(codes(check(ldo("+5V", "cap(1u, 16V, 0603)")), "part.requirement")).toEqual([]);
    expect(codes(check(ldo("+5V", "cap(100n, 16V, 0603)")), "part.requirement")).toEqual([
      'warning part.requirement U1: "1 uF on VIN": needs a capacitor ≥ 1uF from VIN (+5V) to ground; found C1 100nF',
    ]);
    const mcu = (extra: string) => `block main "t"
part U1 lib:MCU
part C1 cap(100n, 16V)
part R1 res(4.7k)
${extra}
net +3V3 : U1.VCC C1.1 R1.1 {source: bench}
net GND : U1.GND C1.2 {source: bench}
net EN : U1.EN
net SDA : U1.SDA R1.2
`;
    expect(codes(check(mcu("")), "part.requirement")).toEqual([
      'warning part.requirement U1: "100 nF on each VCC pin": needs 2 capacitors ≥ 100nF from VCC (+3V3) to ground; found C1 100nF',
      'warning part.requirement U1: "EN tied to VCC": EN is on EN, not VCC (+3V3)',
    ]);
  });
});

it("resolves a net a requirement names in the part's own block instance", () => {
  const tie = `id: TIE
summary: needs EN on its block's VREF
pins:
  1: { name: EN, type: input }
requirements:
  - text: EN to VREF
    tie: { from: EN, to: VREF }
`;
  const issues = validateProject({
    project: { file: "partstyle-project.yaml", text: "name: t\n" },
    circuits: [
      {
        file: "circuit/main.ckt",
        text: "block main\nuse ch as A\npart R9 res(1k)\nnet VREF : R9.1 R9.2\n",
      },
      {
        file: "circuit/ch.ckt",
        text: "block ch\npart U1 lib:TIE\npart R1 res(1k)\nnet VREF : U1.EN R1.1 R1.2\n",
      },
    ],
    parts: [{ file: "parts/TIE.yaml", text: tie, layer: "project" }],
  }).issues;
  // main's VREF is another net: the requirement means A/VREF, where EN is.
  expect(issues.filter((i) => i.code === "part.requirement")).toEqual([]);
});

it("reports a tie requirement on an unconnected pin, which ERC may leave alone", () => {
  const text = `id: TIED
summary: test
pins:
  1: {name: EN, type: bidir}
  2: {name: VIN, type: power_in}
requirements:
  - text: EN tied to VIN
    tie: { from: EN, to: VIN }
`;
  const r = validateProject({
    project: { file: "partstyle-project.yaml", text: "name: t" },
    circuits: [
      {
        file: "circuit/main.ckt",
        text: 'block main "t"\npart U1 lib:TIED\nnet V : U1.VIN {source: bench}\n',
      },
    ],
    parts: [{ file: "lib/TIED.yaml", text, layer: "global" }],
  });
  expect(r.issues.map((i) => i.code)).toContain("part.requirement");
  expect(r.issues.find((i) => i.code === "part.requirement")?.message).toContain(
    "EN is not connected",
  );
});

describe("context checks", () => {
  const board = (protection: string) => `block main "t"
part J1 lib:CONN
part U1 lib:MCU
part C1 cap(100n, 16V)
part C2 cap(100n, 16V)
part R1 res(4.7k)
${protection}
net SIG : J1.SIG U1.SDA R1.2 ${protection ? "D1.1" : ""}
net +3V3 : J1.PWR U1.VCC U1.EN C1.1 C2.1 R1.1 {source: J1}
net GND : J1.GND U1.GND C1.2 C2.2 ${protection ? "D1.2" : ""}
`;
  const context = (hazards: string, more = "") => `environment: {temp_c: [-20, 70]}
external_interfaces:
  - connector: J1
    hazards: [${hazards}]
${more}`;

  it("leaves an interface's hazards to the AI, plain or accepted", () => {
    const hazards = "ESD, miswiring to 12 V, {hazard: reverse polarity, accepted: keyed plug}";
    expect(codes(check(board(""), { context: context(hazards) }), "context")).toEqual([]);
  });

  it("checks temperature against the parts", () => {
    const issues = check(board(""), { context: context("") });
    expect(codes(issues, "context.temperature")).toEqual([]);
    const cold = check(ldo("+5V", "cap(1u, 16V, 0603)"), {
      context: context("", "environment: {temp_c: [-55, 70]}\n").replace(
        "environment: {temp_c: [-20, 70]}\n",
        "",
      ),
    });
    expect(codes(cold, "context.temperature")).toEqual([
      "warning context.temperature lib:LDO (U1) is rated -40 to 85 °C; the environment needs -55 to 70 °C",
    ]);
  });

  it("reports an interface whose connector is not in the design", () => {
    const issues = check(board(""), { context: context("ESD").replace("J1", "J9") });
    expect(codes(issues, "context.unknown")).toEqual([
      "warning context.unknown-connector external interface J9 is not a part in the design (name its refdes, e.g. J1)",
    ]);
  });

  it("waits for the connector's block before reporting it", () => {
    const planned = check(board(""), { context: context("ESD").replace("J1", "PWR/J1") });
    expect(codes(planned, "context.unknown")).toEqual([]);
    const empty = check('block main "t"\n', { context: context("ESD") });
    expect(codes(empty, "context.unknown")).toEqual([]);
  });
});
