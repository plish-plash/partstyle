import { describe, expect, it } from "vitest";
import { applyPatch } from "./patch.js";
import type { ProjectSource } from "./project/source.js";

const power = `block power "rails"

port +5V : power_out
port GND : ground

part U1  lib:REG
part C1  cap(1u)     # aligned by hand
part C2  cap(10u)

net +5V  : U1.OUT C1.1 -> port +5V
net GND  : U1.GND C1.2 C2.2 -> port GND
net BULK : C2.1

waive C2.1 "test"
`;

const main = `block main
use power as PWR
net +5V : PWR.+5V
`;

function source(circuits: Record<string, string> = { power, main }): ProjectSource {
  return {
    config: { file: "project.toml", text: 'name = "t"' },
    circuits: Object.entries(circuits).map(([name, text]) => ({
      file: `circuit/${name}.ckt`,
      text,
    })),
    parts: [],
  };
}

function patched(patch: string, src = source()): string {
  const r = applyPatch(src, patch);
  expect(r.issues).toEqual([]);
  return r.source.circuits.find((c) => c.file === "circuit/power.ckt")?.text ?? "";
}

function error(patch: string, src = source()): string {
  const r = applyPatch(src, patch);
  expect(r.changed).toEqual([]);
  expect(r.source).toBe(src);
  return r.issues.map((i) => `${i.location?.line}: ${i.message}`).join("\n");
}

describe("applyPatch", () => {
  it("adds a statement after the last one of its kind, leaving other lines alone", () => {
    const text = patched("in power\n+ part C3 cap(100n, 16V) @ bypass");
    expect(text.split("\n").slice(5, 10)).toEqual([
      "part U1  lib:REG",
      "part C1  cap(1u)     # aligned by hand",
      "part C2  cap(10u)",
      "part C3 cap(100n, 16V) @ bypass",
      "",
    ]);
  });

  it("puts a first statement of a kind after the kinds that precede it", () => {
    const text = patched("in power\n+ use filter as F");
    expect(text.split("\n")[8]).toBe("use filter as F");
  });

  it("replaces a statement by kind and key", () => {
    const text = patched("in power\n= part C1 cap(2u2, 25V)");
    expect(text).toContain("\npart C1 cap(2u2, 25V)\n");
    expect(text).not.toContain("aligned by hand");
  });

  it("connects and disconnects pins", () => {
    const text = patched("in power\nnet +5V += C2.1\nnet GND -= C2.2\n- net BULK");
    expect(text).toContain("net +5V : U1.OUT C1.1 C2.1 -> port +5V\n");
    expect(text).toContain("net GND : U1.GND C1.2 -> port GND\n");
    expect(text).not.toContain("BULK");
  });

  it("removing a part drops its pins, nets left empty, and its waivers", () => {
    const r = applyPatch(source(), "in power\n- part C2");
    const text = r.source.circuits[0]?.text ?? "";
    expect(text).not.toMatch(/C2/);
    expect(text).not.toContain("BULK");
    expect(r.log).toEqual([
      "power: - part C2 (disconnected from net GND; removed net BULK (no pins left); removed waiver C2.1)",
    ]);
  });

  it("removing a port unbinds its net", () => {
    expect(patched("in power\n- port +5V")).toContain("net +5V : U1.OUT C1.1\n");
  });

  it("removes every waiver with the subject", () => {
    expect(patched("in power\n- waive C2.1")).not.toContain("waive");
  });

  it("renames a part through nets and waivers", () => {
    const text = patched("in power\nrename part C2 C9");
    expect(text).toContain("part C9 cap(10u)");
    expect(text).toContain("net GND : U1.GND C1.2 C9.2 -> port GND");
    expect(text).toContain('waive C9.1 "test"');
  });

  it("renames an instance in the parent", () => {
    const r = applyPatch(source(), "in main\nrename use PWR P");
    expect(r.source.circuits[1]?.text).toBe("block main\nuse power as P\nnet +5V : P.+5V\n");
  });

  it("creates a new block file", () => {
    const r = applyPatch(source(), 'in filter\n+ block filter "RC"\n+ part R1 res(1k)');
    expect(r.issues).toEqual([]);
    expect(r.changed.map((c) => c.file)).toEqual(["circuit/filter.ckt"]);
    expect(r.source.circuits.at(-1)).toEqual({
      file: "circuit/filter.ckt",
      text: 'block filter "RC"\npart R1 res(1k)\n',
    });
  });

  it("defaults to the only block when there is one", () => {
    expect(patched("+ part C3 cap(1u)", source({ power }))).toContain("part C3 cap(1u)");
  });

  it("preserves CRLF line endings", () => {
    const crlf = source({ power: power.replace(/\n/g, "\r\n") });
    expect(patched("+ part C3 cap(1u)", crlf)).toContain(
      "part C2  cap(10u)\r\npart C3 cap(1u)\r\n",
    );
  });

  it("ignores comments and blank lines", () => {
    expect(patched("# bulk cap\n\nin power\n+ part C3 cap(1u)")).toContain("part C3");
  });

  it.each([
    ["+ part C3 cap(1u)", "1: start the patch with 'in BLOCK' to say which block to edit"],
    [
      "in power\n+ part C1 cap(1u)",
      "2: part C1 already exists in power (line 7); use '=' to replace it",
    ],
    [
      "in power\n+ use x as U1",
      "2: part U1 already exists in power (line 6); use '=' to replace it",
    ],
    ["in power\n= part C9 cap(1u)", "2: no part C9 in power; use '+' to add it"],
    ["in power\n- part C9", "2: no part C9 in power"],
    ["in power\n- block power", "2: usage: - part|net|port|use|waive KEY"],
    ["in power\nnet NOPE += C1.1", "2: no net NOPE in power"],
    ["in power\nnet +5V += C1.1", "2: C1.1 is already on net +5V"],
    ["in power\nnet +5V -= C2.1", "2: C2.1 is not on net +5V"],
    ["in power\nnet BULK -= C2.1", "2: net BULK would have no pins; use '- net BULK' instead"],
    ["in power\nnet +5V += C1", "2: expected REF.PIN, found 'C1'"],
    ["in power\nrename part C1 U1", "2: part U1 already exists in power"],
    ["in power\nrename port +5V V", "2: usage: rename part|use|net OLD NEW"],
    ["in power\nrename part C1 C.1", "2: 'C.1' must not contain '.' or '/'"],
    ["in power\n+ part C3 cap(1u", "2: expected ',' or ')', found end of line"],
    [
      "in power\nfrobnicate",
      "2: unknown edit 'frobnicate' (expected in, +, =, -, net NAME +=/-=, or rename)",
    ],
    [
      "in newblock\n+ part R1 res(1k)",
      "2: block newblock is new; its first edit must be '+ block newblock ...'",
    ],
    ["in newblock\n+ block other", "2: '+ block other' must follow 'in other'"],
    ["in power\n+ block power", "2: circuit/power.ckt already has a block statement"],
  ])("rejects %j", (patch, message) => {
    expect(error(patch)).toBe(`${message}; nothing was applied`);
  });

  it("applies nothing when a later edit fails", () => {
    const src = source();
    const r = applyPatch(src, "in power\n+ part C3 cap(1u)\n- part C9");
    expect(r.issues[0]?.location?.line).toBe(3);
    expect(r.source).toBe(src);
  });

  it("reports no change for an empty patch", () => {
    expect(applyPatch(source(), "in power\n").changed).toEqual([]);
  });
});
