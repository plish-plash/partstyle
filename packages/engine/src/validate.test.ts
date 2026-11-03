import { describe, expect, it } from "vitest";
import type { ProjectSource } from "./project/source.js";
import { validateProject } from "./validate.js";

const part = (id: string, pins: Record<string, [string, string]>) => ({
  file: `lib/${id}.yaml`,
  layer: "global" as const,
  text: [
    `id: ${id}`,
    "manufacturer: ACME",
    `mpn: ${id}`,
    "summary: test part",
    "package: SOT-23",
    "footprint: X:Y",
    "pins:",
    ...Object.entries(pins).map(([n, [name, type]]) => `  ${n}: {name: "${name}", type: ${type}}`),
    "provenance: {extracted_by: ai, verified_by: null}",
  ].join("\n"),
});

const parts = [
  part("REG", { 1: ["IN", "power_in"], 2: ["GND", "power_in"], 3: ["OUT", "power_out"] }),
  part("AMP", {
    1: ["OUT", "output"],
    2: ["IN", "input"],
    3: ["VDD", "power_in"],
    4: ["GND", "power_in"],
    5: ["GND", "power_in"],
    6: ["NC", "nc"],
  }),
];

function project(circuits: Record<string, string>): ProjectSource {
  return {
    project: { file: "partstyle-project.yaml", text: "name: t" },
    circuits: Object.entries(circuits).map(([name, text]) => ({
      file: `circuit/${name}.ckt`,
      text: `block ${name}\n${text}`,
    })),
    parts,
  };
}

const validate = (circuits: Record<string, string>) => validateProject(project(circuits));
const codes = (circuits: Record<string, string>) => validate(circuits).issues.map((i) => i.code);

/** A REG feeding an AMP, everything connected; tests break one thing at a time. */
const good = `
port GND : ground
part U1 lib:REG
part U2 lib:AMP
part C1 cap(1u)
part R1 res(10k)
net VIN : U1.IN C1.1 {source: bench supply}
net VDD : U1.OUT U2.VDD
net SIG : R1.1 U2.IN
net OUT : U2.OUT R1.2
net GND : U1.GND U2.GND C1.2 -> port GND
`;

describe("validateProject", () => {
  it("accepts a correct design", () => {
    const r = validate({ main: good });
    expect(r.issues).toEqual([]);
    expect(r.netlist?.parts.map((p) => p.path)).toEqual(["U1", "U2", "C1", "R1"]);
  });

  it("connects a pin name to every pin that has it, and numbers to one pin", () => {
    const r = validate({ main: good });
    const gnd = r.netlist?.nets.find((n) => n.name === "GND");
    expect(gnd?.pins.map((p) => `${p.part}#${p.number}`)).toEqual(["U1#2", "U2#4", "U2#5", "C1#2"]);

    const byNumber = validate({ main: good.replace("U2.GND", "U2.4") });
    expect(byNumber.issues.map((i) => [i.code, i.subjects[0]])).toEqual([
      ["erc.unconnected-pin", "U2.GND"],
    ]);
  });

  describe("elaboration errors", () => {
    it.each([
      ["unknown part", good.replace("lib:AMP", "lib:NOPE"), "elab.unknown-part"],
      ["unknown pin", good.replace("U2.IN", "U2.INP"), "elab.unknown-pin"],
      ["unknown ref", good.replace("R1.1", "R9.1"), "elab.unknown-ref"],
      ["duplicate ref", `${good}part R1 res(1k)`, "elab.duplicate-ref"],
      ["duplicate net", `${good}net SIG : C1.1`, "elab.duplicate-net"],
      ["bad generic", good.replace("cap(1u)", "cap(1uH)"), "elab.bad-generic"],
      ["unknown generic", good.replace("cap(1u)", "capacitor(1u)"), "elab.bad-generic"],
      ["unbound port", `${good}port X : input`, "elab.unbound-port"],
      ["undeclared port", good.replace("-> port GND", "-> port GROUND"), "elab.unknown-port"],
    ])("%s", (_, text, code) => {
      expect(codes({ main: text })).toContain(code);
    });

    it("reports a pin listed on two nets as a short", () => {
      const r = validate({ main: good.replace("net SIG : R1.1", "net SIG : R1.1 U1.OUT") });
      expect(r.issues.map((i) => i.code)).toEqual(["elab.pin-multiple-nets"]);
      expect(r.issues[0]?.message).toMatch(/U1\.OUT \(pin 3\) is already on net VDD/);
    });

    it("does not cascade errors from an unknown part to its pinrefs", () => {
      expect(codes({ main: good.replace("lib:REG", "lib:NOPE") })).toEqual(
        expect.not.arrayContaining(["elab.unknown-ref"]),
      );
    });

    it("reports a missing top block", () => {
      const r = validateProject(project({ other: good }));
      expect(r.issues.map((i) => i.code)).toEqual(["elab.unknown-top", "elab.unused-block"]);
    });
  });

  describe("hierarchy", () => {
    const child = `
port VDD : power_in
port GND : ground
port SIG : output
part U2 lib:AMP
part R1 res(10k)
net VDD : U2.VDD -> port VDD
net GND : U2.GND -> port GND
net FB  : U2.OUT R1.1 {kind: analog}
net SIG : U2.IN R1.2 -> port SIG
`;
    const parent = `
port GND : ground
part U1 lib:REG
part C1 cap(1u)
use amp as A
use amp as B
net VIN : U1.IN C1.1 {source: bench}
net VDD : U1.OUT A.VDD B.VDD
net GND : U1.GND C1.2 A.GND B.GND -> port GND
net S   : A.SIG B.SIG
`;

    it("flattens instances with path-qualified names and joins nets through ports", () => {
      const r = validate({ main: parent, amp: child });
      expect(r.issues).toEqual([]);
      const nets = Object.fromEntries(
        (r.netlist?.nets ?? []).map((n) => [n.name, n.pins.map((p) => `${p.part}.${p.name}`)]),
      );
      expect(nets.VDD).toEqual(["U1.OUT", "A/U2.VDD", "B/U2.VDD"]);
      expect(nets["A/FB"]).toEqual(["A/U2.OUT", "A/R1.1"]);
      expect(nets.S).toEqual(["A/U2.IN", "A/R1.2", "B/U2.IN", "B/R1.2"]);
      expect(r.netlist?.nets.find((n) => n.name === "VDD")?.aliases).toEqual([
        "VDD",
        "A/VDD",
        "B/VDD",
      ]);
    });

    it("reports errors in a reused block once", () => {
      const r = validate({ main: parent, amp: child.replace("U2.IN", "U2.INP") });
      expect(r.issues.filter((i) => i.code === "elab.unknown-pin")).toHaveLength(1);
    });

    it("warns about unused instance ports and unknown ones", () => {
      expect(codes({ main: parent.replace("A.SIG B.SIG", "B.SIG A.NOPE"), amp: child })).toEqual(
        expect.arrayContaining(["elab.unknown-port", "erc.unused-port"]),
      );
    });

    it("reports unknown, recursive and unused blocks", () => {
      expect(codes({ main: `${good}use nothing as X` })).toContain("elab.unknown-block");
      expect(codes({ main: `${good}use loop as L`, loop: "use loop as L" })).toContain(
        "elab.recursive-use",
      );
      expect(codes({ main: good, spare: "" })).toEqual(["elab.unused-block"]);
    });

    it("warns when joined nets disagree on an attribute", () => {
      const r = validate({
        main: parent.replace("A.SIG B.SIG", "A.SIG B.SIG {kind: digital}"),
        amp: child.replace("-> port SIG", "-> port SIG {kind: analog}"),
      });
      expect(r.issues.map((i) => i.code)).toContain("elab.attr-conflict");
    });
  });

  describe("structural ERC", () => {
    it("unconnected power pins are errors, other pins warnings, nc pins ignored", () => {
      const r = validate({
        main: `
port GND : ground
part U1 lib:REG
part U2 lib:AMP
part C1 cap(1u)
net VIN : U1.IN C1.1 {source: bench}
net GND : U1.GND U2.GND C1.2 -> port GND
waive U1.OUT "regulator output unused in this test"
`,
      });
      const unconnected = r.issues
        .filter((i) => i.code === "erc.unconnected-pin")
        .map((i) => [i.subjects[0], i.severity]);
      // Sorted by location, then severity, then message.
      expect(unconnected).toEqual([
        ["U2.VDD", "error"],
        ["U2.IN", "warning"],
        ["U2.OUT", "warning"],
      ]);
    });

    it("flags two parts driving one net, but not two outputs of the same part", () => {
      const twoParts = good
        .replace("net VDD : U1.OUT U2.VDD", "net VDD : U2.VDD {source: x}")
        .replace("net OUT : U2.OUT R1.2", "net OUT : U2.OUT R1.2 U1.OUT");
      expect(codes({ main: twoParts })).toContain("erc.output-conflict");

      const dual = part("DUAL", { 1: ["A", "output"], 2: ["B", "output"] });
      const samePart = validateProject({
        ...project({ main: "part U9 lib:DUAL\nnet N : U9.A U9.B" }),
        parts: [dual],
      });
      expect(samePart.issues).toEqual([]);
    });

    it("flags power inputs without a source unless the net says where power comes from", () => {
      const unsourced = good.replace(" {source: bench supply}", "");
      const r = validate({ main: unsourced });
      expect(r.issues.map((i) => i.code)).toEqual(["erc.unsourced-power"]);
      expect(r.issues[0]?.message).toMatch(/^VIN: U1\.IN needs power/);
    });

    it("treats nets through a ground port as sourced", () => {
      expect(
        codes({ main: good.replace("-> port GND", "").replace("port GND : ground", "") }),
      ).toEqual(["erc.unsourced-power"]);
    });

    it("warns about single-pin nets and undriven inputs", () => {
      const r = validate({
        main: good
          .replace("net SIG : R1.1 U2.IN", "net SIG : U2.IN")
          .replace("net OUT : U2.OUT R1.2", "net OUT : U2.OUT R1.1 R1.2"),
      });
      expect(r.issues.map((i) => i.code).sort()).toEqual([
        "erc.single-pin-net",
        "erc.undriven-input",
      ]);
    });
  });

  describe("waivers", () => {
    // Leaves U2.IN and U2.OUT unconnected: two warnings to waive.
    const withSpare = good
      .replace("net SIG : R1.1 U2.IN", "net SIG : R1.1 R1.2")
      .replace("net OUT : U2.OUT R1.2", "");

    it("suppress matching issues and count them", () => {
      const r = validate({ main: `${withSpare}waive U2.* erc.unconnected-pin "spare amp"` });
      expect(r.issues).toEqual([]);
      expect(r.waived).toBe(2);
    });

    it("match by refdes and respect the code filter", () => {
      expect(validate({ main: `${withSpare}waive U2 "spare amp"` }).waived).toBe(2);
      expect(codes({ main: `${withSpare}waive U2 erc.output-conflict "wrong code"` })).toEqual([
        "erc.unconnected-pin",
        "erc.unconnected-pin",
        "waive.unused",
      ]);
    });

    it("are scoped to the instance path of the block that declares them", () => {
      const child = `port VDD : power_in\npart U2 lib:AMP\nnet VDD : U2.VDD U2.GND -> port VDD\nwaive U2.* erc.unconnected-pin "spare"`;
      const parent = `part U1 lib:REG\nuse amp as A\nnet V : U1.OUT U1.IN U1.GND A.VDD {source: x}`;
      const r = validate({ main: parent, amp: child });
      expect(r.issues).toEqual([]);
      expect(r.waived).toBe(2);
    });

    it("never suppress parse errors", () => {
      expect(codes({ main: `${good}bogus\nwaive * "everything"` })).toEqual([
        "parse.syntax",
        "waive.unused",
      ]);
    });
  });

  it("reports a broken project file and stops", () => {
    for (const text of ["name: [", "description: no name"]) {
      const r = validateProject({
        ...project({ main: good }),
        project: { file: "partstyle-project.yaml", text },
      });
      expect(r.issues.map((i) => i.code)).toEqual(["project.config"]);
      expect(r.netlist).toBeUndefined();
    }
  });

  it("reports malformed design context as a warning and skips its checks", () => {
    const r = validateProject({
      ...project({ main: good }),
      project: { file: "partstyle-project.yaml", text: "name: t\nexternal_interfaces: nope\n" },
    });
    expect(r.issues.map((i) => i.code)).toEqual(["context.invalid"]);
    expect(r.netlist).toBeDefined();
  });
});
