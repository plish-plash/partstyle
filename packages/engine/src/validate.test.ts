import { describe, expect, it } from "vitest";
import type { ProjectSource } from "./project/source.js";
import { validateProject } from "./validate.js";

const part = (id: string, pins: Record<string, [string, string]>) => ({
  file: `lib/${id}.yaml`,
  layer: "global" as const,
  text: [
    `id: ${id}`,
    "manufacturer: ACME",
    `preferred_mpn: ${id}`,
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
  part("OC", { 1: ["OUT", "open_collector"], 2: ["VCC", "power_in"], 3: ["GND", "power_in"] }),
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
      ["footprint without library", `${good}part TP1 fp(nofootprint)`, "elab.bad-generic"],
      ["footprint with 4 pins", `${good}part TP1 fp(A:B, 4)`, "elab.bad-generic"],
      ["footprint pin count", `${good}part TP1 fp(A:B, x)`, "elab.bad-generic"],
      ["footprint extra argument", `${good}part TP1 fp(A:B, 2, 3)`, "elab.bad-generic"],
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

    it("flattens instances, joins nets through ports, and gives extra copies refdes of their own", () => {
      const r = validate({ main: parent, amp: child });
      expect(r.issues).toEqual([]);
      const nets = Object.fromEntries(
        (r.netlist?.nets ?? []).map((n) => [n.name, n.pins.map((p) => `${p.part}.${p.name}`)]),
      );
      // A has the block's refdes; B, the second copy, has the next free ones.
      expect(nets.VDD).toEqual(["U1.OUT", "U2.VDD", "U3.VDD"]);
      expect(nets["A/FB"]).toEqual(["U2.OUT", "R1.1"]);
      expect(nets.S).toEqual(["U2.IN", "R1.2", "U3.IN", "R2.2"]);
      expect(r.annotationLock).toContain("B/U2 U3\n");
      expect(r.netlist?.refs.get("B/R1")).toBe("R2");
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

    it("keeps refdes unique across the project's blocks, used or not", () => {
      const r = validate({ main: parent, amp: child, spare: "part C1 cap(1u)" });
      const dup = r.issues.find((i) => i.code === "elab.duplicate-ref");
      expect(dup?.message).toBe(
        "C1 is also declared in block main (circuit/main.ckt:5); refdes are unique across the project: rename one (next free: C2)",
      );
      expect(dup?.location?.file).toBe("circuit/spare.ckt");
    });

    it("keeps a copy's reserved refdes, and refuses a block declaring one", () => {
      const lock = (text: string) => ({ file: "annotation.lock", text });
      const reserved = (circuits: Record<string, string>, text: string) =>
        validateProject({ ...project(circuits), annotation: lock(text) });
      // Pinned refdes win over the next free ones, so adding a part elsewhere moves nothing.
      const pinned = reserved({ main: parent, amp: child }, "B/U2 U7\nB/R1 R9\n");
      expect(pinned.netlist?.refs.get("B/U2")).toBe("U7");
      expect(pinned.annotationLock).toContain("B/U2 U7\n");
      // An entry for a part that is gone is dropped.
      const stale = reserved({ main: parent, amp: child }, "B/U2 U7\nB/R1 R9\nB/GONE X1\n");
      expect(stale.annotationLock).not.toContain("GONE");

      const clash = reserved({ main: `${parent}part U7 lib:REG\n`, amp: child }, "B/U2 U7\n");
      const err = clash.issues.find((i) => i.code === "ref.reserved");
      expect(err?.message).toBe(
        "U7 is reserved for U2 in copy B of block amp; rename it (next free: U8)",
      );
      expect(err?.location?.line).toBe(12);
      // The reservation stays for when the clash is fixed; meanwhile the copy has a stand-in.
      expect(clash.annotationLock).toContain("B/U2 U7\n");
      expect(clash.netlist?.refs.get("B/U2")).not.toBe("U7");
    });

    it("applies a block's waivers to each copy's own refdes", () => {
      const spare = child.replace("net SIG : U2.IN R1.2", "net SIG : R1.2");
      const r = validate({
        main: parent,
        amp: `${spare}waive U2.IN erc.unconnected-pin "spare input"`,
      });
      expect(r.waived).toBe(2);
      expect(r.waivers[0]?.issues.map((i) => i.subjects[0])).toEqual(["U2.IN", "U3.IN"]);
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
    it("unconnected power pins are errors, inputs warnings, outputs left alone", () => {
      const r = validate({
        main: `
port GND : ground
part U1 lib:REG
part U2 lib:AMP
part C1 cap(1u)
net VIN : U1.IN C1.1 {source: bench}
net GND : U1.GND U2.GND C1.2 -> port GND
waive U1.OUT erc.unconnected-pin "regulator output unused in this test"
`,
      });
      const unconnected = r.issues
        .filter((i) => i.code === "erc.unconnected-pin")
        .map((i) => [i.subjects[0], i.severity]);
      // Sorted by location, then severity, then message.
      expect(unconnected).toEqual([
        ["U2.VDD", "error"],
        ["U2.IN", "warning"],
      ]);
    });

    it("follows the part record on what may stay open", () => {
      const text = `id: S
summary: test
pins:
  1: {name: GAIN, unused: open}
  2: {name: EN, type: bidir, unused: required}
  3: {name: IO, type: bidir}
  4: {name: A}
  5: {name: VDD, type: power_in, unused: open}
`;
      const r = validateProject({
        ...project({ main: "part U1 lib:S" }),
        parts: [{ file: "lib/S.yaml", text, layer: "global" }],
      });
      expect(r.issues.map((i) => [i.subjects[0], i.severity])).toEqual([
        ["U1.VDD", "error"],
        ["U1.A", "warning"],
        ["U1.EN", "warning"],
      ]);
    });

    describe("nc statements", () => {
      // Leaves U2.IN and U2.OUT unconnected.
      const open = good
        .replace("net SIG : R1.1 U2.IN", "net SIG : R1.1 R1.2")
        .replace("net OUT : U2.OUT R1.2", "");
      const issues = (nc: string) =>
        validate({ main: `${open}${nc}` }).issues.map((i) => `${i.code} ${i.message}`);

      it("mark pins as open on purpose, by name, number or glob", () => {
        expect(issues("nc U2.IN @ spare\nnc U2.OUT")).toEqual([]);
        const r = validate({ main: `${open}nc U2.* @ spare amp` });
        expect(r.issues).toEqual([]);
        expect(r.waived).toBe(0);
      });

      it("leave other pins reported, with a hint", () => {
        expect(issues("nc U2.OUT")).toEqual([
          expect.stringMatching(
            /^erc\.unconnected-pin U2\.IN .* is not connected; connect it, or mark it nc if it is open on purpose$/,
          ),
        ]);
      });

      it("are an error on a pin that is on a net, unless a glob covers it", () => {
        expect(issues("nc U2.IN\nnc U2.OUT\nnc U2.VDD")[0]).toMatch(
          /^elab\.nc-connected U2\.VDD \(pin \d+\) is marked nc but is on net /,
        );
        expect(issues("nc U2.*")).toEqual([]);
      });

      it("name a real pin of a part in the block", () => {
        expect(issues("nc U2.BOGUS\nnc U2.*").map((i) => i.split(" ")[0])).toEqual([
          "elab.unknown-pin",
        ]);
        expect(issues("nc U9.1\nnc U2.*")).toEqual([
          "elab.unknown-ref 'U9' is not a part in block 'main'",
        ]);
      });

      it("cannot clear an unconnected power pin", () => {
        const noPower = good.replace("net VDD : U1.OUT U2.VDD", "net VDD : U1.OUT R1.3");
        const r = validate({ main: `${noPower}nc U2.VDD` });
        expect(r.issues.filter((i) => i.severity === "error").map((i) => i.message)).toContainEqual(
          expect.stringMatching(/^U2\.VDD .* is not connected; a power pin cannot be nc$/),
        );
      });
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

    it("treats ground as sourced, by its port or by its name", () => {
      const noPort = good.replace("-> port GND", "").replace("port GND : ground", "");
      expect(codes({ main: noPort })).toEqual([]);
      // Any other name with only supply inputs on it still needs a source.
      expect(codes({ main: noPort.replace("net GND :", "net RTN :") })).toEqual([
        "erc.unsourced-power",
      ]);
    });

    it("flags two supply outputs on one net", () => {
      const twoRegs =
        `${good}part U3 lib:REG\nnet VIN2 : U3.IN {source: x}\nnet GND2 : U3.GND {source: x}\n`.replace(
          "net VDD : U1.OUT U2.VDD",
          "net VDD : U1.OUT U2.VDD U3.OUT",
        );
      expect(codes({ main: twoRegs })).toContain("erc.output-conflict");
    });

    it("respects a stated source on a net of inputs", () => {
      const external = good
        .replace("net SIG : R1.1 U2.IN", "net SIG : U2.IN {source: function generator}")
        .replace("net OUT : U2.OUT R1.2", "net OUT : U2.OUT R1.1 R1.2");
      expect(codes({ main: external })).toEqual(["erc.single-pin-net"]);
    });

    it("warns about an open-collector output nothing pulls up", () => {
      // U3's open-collector output drives U2.IN; R1 moves aside, across U2's output.
      const oc = `${good}part U3 lib:OC\nnet INT : U3.OUT U2.IN\n`
        .replace("net SIG : R1.1 U2.IN\n", "")
        .replace("net OUT : U2.OUT R1.2", "net OUT : U2.OUT R1.1 R1.2")
        .replace("net VDD : U1.OUT U2.VDD", "net VDD : U1.OUT U2.VDD U3.VCC")
        .replace("U2.GND C1.2", "U2.GND C1.2 U3.GND");
      const issues = validate({ main: oc }).issues;
      expect(issues.map((i) => i.code)).toEqual(["erc.no-pull"]);
      expect(issues[0]?.message).toBe(
        "INT: U3.OUT is open-collector and nothing pulls the net up; add a pull-up resistor, or {source: ...} if one is outside the design",
      );
      // A pull-up from the supply clears it.
      const pulled = `${oc}part R9 res(10k)\n`
        .replace("net INT : U3.OUT U2.IN", "net INT : U3.OUT U2.IN R9.2")
        .replace("U3.VCC", "U3.VCC R9.1");
      expect(codes({ main: pulled })).toEqual([]);
    });

    it("warns about a datasheet NC pin on a net", () => {
      expect(
        codes({ main: good.replace("net SIG : R1.1 U2.IN", "net SIG : R1.1 U2.IN U2.NC") }),
      ).toEqual(["erc.nc-pin-connected"]);
    });

    it("warns about a supply output on ground", () => {
      const shorted = good
        .replace("net VDD : U1.OUT U2.VDD", "net VDD : U2.VDD {source: x}")
        .replace("U1.GND U2.GND", "U1.GND U1.OUT U2.GND");
      const issue = validate({ main: shorted }).issues.find(
        (i) => i.code === "erc.power-out-on-ground",
      );
      expect(issue?.message).toBe(
        "GND: U1.OUT is a supply output on ground net GND, which shorts it",
      );
      expect(issue?.severity).toBe("warning");
    });

    it("refuses a port bound to two nets", () => {
      expect(
        codes({ main: good.replace("net SIG : R1.1 U2.IN", "net SIG : R1.1 U2.IN -> port GND") }),
      ).toContain("elab.port-bound-twice");
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
    // Leaves U2.IN unconnected: a warning to waive.
    const withSpare = good
      .replace("net SIG : R1.1 U2.IN", "net SIG : R1.1 R1.2")
      .replace("net OUT : U2.OUT R1.2", "");

    it("suppress matching issues, count them and list what they hide", () => {
      const r = validate({ main: `${withSpare}waive U2.* erc.unconnected-pin "spare amp"` });
      expect(r.issues).toEqual([]);
      expect(r.waived).toBe(1);
      expect(r.waivers).toMatchObject([
        { subject: "U2.*", code: "erc.unconnected-pin", reason: "spare amp" },
      ]);
      expect(r.waivers[0]?.issues.map((i) => i.subjects[0])).toEqual(["U2.IN"]);
    });

    it("match by refdes and respect the code", () => {
      expect(validate({ main: `${withSpare}waive U2 erc.unconnected-pin "spare"` }).waived).toBe(1);
      expect(codes({ main: `${withSpare}waive U2 erc.output-conflict "wrong code"` })).toEqual([
        "erc.unconnected-pin",
        "waive.unused",
      ]);
    });

    it("are scoped to the instance path of the block that declares them", () => {
      const child = `port VDD : power_in\npart U2 lib:AMP\nnet VDD : U2.VDD U2.GND -> port VDD\nwaive U2.* erc.unconnected-pin "spare"`;
      const parent = `part U1 lib:REG\nuse amp as A\nnet V : U1.OUT U1.IN U1.GND A.VDD {source: x}`;
      const r = validate({ main: parent, amp: child });
      expect(r.issues).toEqual([]);
      expect(r.waived).toBe(1);
    });

    it("never suppress errors, and say so", () => {
      const main = good.replace(" {source: bench supply}", "");
      const r = validate({ main: `${main}waive * erc.unsourced-power "reviewed"` });
      expect(r.waived).toBe(0);
      expect(r.issues.map((i) => [i.code, i.severity])).toEqual([
        ["erc.unsourced-power", "error"],
        ["waive.unused", "warning"],
      ]);
      expect(r.issues[1]?.message).toBe(
        "waiver for '*' (erc.unsourced-power) matches only errors, which cannot be waived; remove it",
      );
    });

    it("suppress a warning but not an error of the same code", () => {
      const main = withSpare.replace("net VDD : U1.OUT U2.VDD", "net VDD : U1.OUT R1.3");
      const r = validate({ main: `${main}waive U2 erc.unconnected-pin "spare"` });
      expect(r.waived).toBe(1);
      expect(r.issues.some((i) => i.severity === "error" && i.subjects[0] === "U2.VDD")).toBe(true);
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
