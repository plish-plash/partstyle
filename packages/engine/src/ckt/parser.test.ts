import { describe, expect, it } from "vitest";
import { parseCkt } from "./parser.js";

const parse = (text: string) => parseCkt(text, "circuit/t.ckt");

describe("parseCkt", () => {
  it("parses every statement form", () => {
    const { ast, issues } = parse(`
# a comment
block power  "12 V input"   # trailing comment

port +5V : power_out
part U1  lib:L7805CV
part C1  cap(330n, 50V, X7R, 0603) @ per U1 datasheet input cap
use sensor as AFE @ remote sensor
net +5V : U1.OUT C1.1 AFE.VDD -> port +5V {voltage: 5V ±5%, kind: power} @ main rail
nc U1.TRIM @ not trimmed
nc U4.PD*
waive U4.PD* erc.single-pin-net "spare GPIO"
`);
    expect(issues).toEqual([]);
    expect(ast.block).toMatchObject({ name: "power", description: "12 V input" });
    expect(ast.ports).toMatchObject([{ name: "+5V", kind: "power_out" }]);
    expect(ast.parts).toMatchObject([
      { ref: "U1", spec: { kind: "lib", id: "L7805CV" } },
      {
        ref: "C1",
        spec: { kind: "generic", fn: "cap", args: ["330n", "50V", "X7R", "0603"] },
        intent: "per U1 datasheet input cap",
      },
    ]);
    expect(ast.uses).toMatchObject([{ block: "sensor", instance: "AFE", intent: "remote sensor" }]);
    expect(ast.nets[0]).toMatchObject({
      name: "+5V",
      pins: [
        { target: "U1", pin: "OUT" },
        { target: "C1", pin: "1" },
        { target: "AFE", pin: "VDD" },
      ],
      port: "+5V",
      attrs: { voltage: "5V ±5%", kind: "power" },
      intent: "main rail",
    });
    expect(ast.ncs).toMatchObject([
      { pin: { target: "U1", pin: "TRIM" }, intent: "not trimmed" },
      { pin: { target: "U4", pin: "PD*" } },
    ]);
    expect(ast.waivers).toMatchObject([
      { subject: "U4.PD*", code: "erc.single-pin-net", reason: "spare GPIO" },
    ]);
  });

  it("records 1-based line and column", () => {
    const { ast } = parse("block b\n\n  part R1 res(1k)\nnet N : R1.1 R1.2");
    expect(ast.parts[0]?.location).toEqual({ file: "circuit/t.ckt", line: 3, col: 3 });
    expect(ast.nets[0]?.pins[1]?.location).toEqual({ file: "circuit/t.ckt", line: 4, col: 14 });
  });

  it("accepts attributes before the port arrow", () => {
    const { ast, issues } = parse("block b\nnet N : R1.1 {voltage: 5V} -> port P");
    expect(issues).toEqual([]);
    expect(ast.nets[0]).toMatchObject({ port: "P", attrs: { voltage: "5V" } });
  });

  it("reports every bad line and keeps the good ones", () => {
    const { ast, issues } = parse(
      [
        "block b",
        "port X : sideways",
        "part R1 res(1k)",
        "net N : R1",
        "frobnicate R1",
        'waive R1 erc.x "unterminated',
        "part R2 res(1k)",
      ].join("\n"),
    );
    expect(ast.parts.map((p) => p.ref)).toEqual(["R1", "R2"]);
    expect(issues.map((i) => [i.location?.line, i.location?.col, i.message])).toEqual([
      [2, 10, expect.stringContaining("unknown port kind 'sideways'")],
      [4, 9, "expected REF.PIN, found 'R1'"],
      [5, 1, expect.stringContaining("unknown statement 'frobnicate'")],
      [6, 16, "unterminated string"],
    ]);
  });

  it.each([
    ["part R1 foo:bar", "unknown part source 'foo:'"],
    ["part R1 res", "expected 'lib:ID' or 'generic(...)'"],
    ["part R1 res(1k", "expected ',' or ')', found end of line"],
    ["part R1.2 res(1k)", "reference designator 'R1.2' must not contain '.' or '/'"],
    ["net N :", "a net needs at least one pin"],
    ["net N : R1.1 -> P", "expected 'port'"],
    ["net N : R1.1 {voltage 5V}", "expected ':', found '5V'"],
    ["net N : R1.1 {a: 1, a: 2}", "duplicate attribute 'a'"],
    ["use x AFE", "expected 'as'"],
    ["waive R1", "expected issue code, found end of line"],
    ['waive R1 "no code"', `expected issue code, found '"no code"'`],
    ["waive R1 erc.single-pin-net", "expected quoted reason, found end of line"],
    ["nc R1", "expected REF.PIN, found 'R1'"],
    ["nc R1.1 R1.2", "unexpected 'R1.2'"],
    ["block c", "a file declares exactly one block"],
  ])("%s", (line, message) => {
    const { issues } = parse(`block b\n${line}`);
    expect(issues.map((i) => i.message)).toEqual([message]);
  });

  it("refuses bracketed layout hints", () => {
    const { issues } = parse("block b\npart R1 res(1k) [2 r90]");
    expect(issues.map((i) => i.message)).toEqual([expect.stringContaining("unexpected '['")]);
  });

  it("requires block to come first", () => {
    const { issues } = parse("part R1 res(1k)\nblock b");
    expect(issues[0]?.message).toBe("'block' must be the first statement");
  });

  it("defaults a missing block to the file name", () => {
    const { ast, issues } = parse("part R1 res(1k)");
    expect(ast.block.name).toBe("t");
    expect(issues.map((i) => i.code)).toEqual(["parse.missing-block"]);
  });
});
