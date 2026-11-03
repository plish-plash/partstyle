import { describe, expect, it } from "vitest";
import { applyPatch } from "../patch.js";
import type { ProjectSource, TextFile } from "../project/source.js";
import { describeChange, diffCircuits, formatChanges, opOf, type StatementChange } from "./diff.js";
import { planRevert } from "./revert.js";

const power = `block power "rails"

port +5V : power_out
port GND : ground

part U1 lib:L7805CV
part C1 cap(330n, 50V, X7R, 0603) @ input cap
part C2 cap(100n, 16V, X7R, 0603)

net +5V : U1.OUT C2.1 -> port +5V
net GND : U1.GND C1.2 C2.2 -> port GND
waive C2.2 erc.single-pin-net "test"
`;
const file = (text: string): TextFile => ({ file: "circuit/power.ckt", text });

describe("diffCircuits", () => {
  it("ignores formatting, comments and pin order", () => {
    const shuffled = power
      .replace("part U1 lib:L7805CV", "part U1   lib:L7805CV   # the regulator")
      .replace("net GND : U1.GND C1.2 C2.2", "net GND : C2.2 U1.GND C1.2");
    expect(diffCircuits([file(power)], [file(shuffled)])).toEqual([]);
  });

  it("reports added, removed and modified statements tersely", () => {
    const edited = power
      .replace("part C2 cap(100n, 16V, X7R, 0603)", "part C3 cap(10u, 16V, X7R, 0805) @ bulk")
      .replace("part C1 cap(330n, 50V, X7R, 0603)", "part C1 cap(1u, 50V, X7R, 0603)")
      .replace("net +5V : U1.OUT C2.1", "net +5V : U1.OUT C3.1")
      .replace("U1.GND C1.2 C2.2", "U1.GND C1.2 C3.2");
    const changes = diffCircuits([file(power)], [file(edited)]);
    expect(changes.map((c) => `${opOf(c)} ${c.kind} ${c.key}`)).toEqual([
      "~ part C1",
      "- part C2",
      "+ part C3",
      "~ net +5V",
      "~ net GND",
    ]);
    expect(changes.map(describeChange)).toEqual([
      "~ part C1 cap(1u, 50V, X7R, 0603) (was cap(330n, 50V, X7R, 0603))",
      "- part C2",
      "+ part C3 cap(10u, 16V, X7R, 0805) @ bulk",
      "~ net +5V +C3.1 -C2.1",
      "~ net GND +C3.2 -C2.2",
    ]);
  });

  it("marks layout-only edits and folds them into one line", () => {
    const edited = power
      .replace("part U1 lib:L7805CV", "part U1 lib:L7805CV [2 flip]")
      .replace("part C2 cap(100n, 16V, X7R, 0603)", "part C2 cap(1u, 16V, X7R, 0603) [r90]");
    const changes = diffCircuits([file(power)], [file(edited)]);
    expect(changes.map((c) => [c.key, c.layout ?? false])).toEqual([
      ["C2", false],
      ["U1", true],
    ]);
    expect(describeChange(changes[1] as StatementChange)).toBe(
      "~ part U1 layout [2 flip] (was auto)",
    );
    expect(formatChanges(changes)).toEqual([
      "power:",
      "  ~ part C2 cap(1u, 16V, X7R, 0603) [r90] (was cap(100n, 16V, X7R, 0603))",
      "  layout edited: U1",
    ]);
  });

  it("summarizes a new block in one line", () => {
    const mcu = {
      file: "circuit/mcu.ckt",
      text: "block mcu\n\npart U4 lib:X\npart C9 cap(100n)\n",
    };
    const lines = formatChanges(diffCircuits([file(power)], [file(power), mcu]));
    expect(lines).toEqual(["+ block mcu (circuit/mcu.ckt: 2 parts, 0 nets)"]);
  });
});

describe("planRevert", () => {
  const source = (text: string): ProjectSource => ({
    project: { file: "partstyle-project.yaml", text: "name: t" },
    circuits: [file(text)],
    parts: [],
  });
  const edited = applyPatch(
    source(power),
    "in power\n+ part R1 res(1k)\nnet +5V += R1.1\n= part C2 cap(1u, 16V, X7R, 0603)\n- part C1",
  ).source.circuits;

  it("restores every statement of a change", () => {
    const changes = diffCircuits([file(power)], edited);
    const plan = planRevert(changes, edited, [file(power)]);
    expect(plan.conflicts).toEqual([]);
    const reverted = applyPatch({ ...source(power), circuits: edited }, plan.patch).source.circuits;
    expect(diffCircuits([file(power)], reverted)).toEqual([]);
  });

  it("leaves statements changed again since, and says so", () => {
    const changes = diffCircuits([file(power)], edited);
    const later = applyPatch({ ...source(power), circuits: edited }, "in power\n= part R1 res(2k)")
      .source.circuits;
    const plan = planRevert(changes, later, [file(power)]);
    expect(plan.conflicts).toEqual(["power: part R1 has changed since"]);
    const reverted = applyPatch({ ...source(power), circuits: later }, plan.patch).source.circuits;
    // Only R1, edited since, is left; its net connection was still as the change left it.
    expect(diffCircuits([file(power)], reverted).map((c) => `${c.kind} ${c.key}`)).toEqual([
      "part R1",
    ]);
  });

  it("keeps a layout hint through '=' unless [] clears it, and reverts hints", () => {
    const hinted = applyPatch(source(power), "in power\n= part U1 lib:L7805CV [2 flip]").source
      .circuits;
    const kept = applyPatch(
      { ...source(power), circuits: hinted },
      "in power\n= part U1 lib:LM7805",
    ).source.circuits;
    expect(kept[0]?.text).toContain("part U1 lib:LM7805 [2 flip]");
    const cleared = applyPatch(
      { ...source(power), circuits: hinted },
      "in power\n= part U1 lib:L7805CV []",
    ).source.circuits;
    expect(diffCircuits([file(power)], cleared)).toEqual([]);

    const plan = planRevert(diffCircuits([file(power)], hinted), hinted, [file(power)]);
    const reverted = applyPatch({ ...source(power), circuits: hinted }, plan.patch).source.circuits;
    expect(diffCircuits([file(power)], reverted)).toEqual([]);
  });

  it("deletes an added block's file and writes back a removed one", () => {
    const mcu = { file: "circuit/mcu.ckt", text: "block mcu\n\npart U4 lib:X\n" };
    const added = planRevert(
      diffCircuits([file(power)], [file(power), mcu]),
      [file(power), mcu],
      [],
    );
    expect(added.deleteFiles).toEqual(["circuit/mcu.ckt"]);
    const removed = planRevert(
      diffCircuits([file(power), mcu], [file(power)]),
      [file(power)],
      [file(power), mcu],
    );
    expect(removed.writeFiles).toEqual([mcu]);
  });
});
