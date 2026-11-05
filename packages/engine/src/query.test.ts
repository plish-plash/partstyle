import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Netlist } from "./netlist/elaborate.js";
import { describePart, searchParts } from "./parts/search.js";
import { loadProject } from "./project/load.js";
import { runQuery } from "./query.js";
import { type ValidationResult, validateProject } from "./validate.js";
import { overview, readBlock } from "./views.js";

const example = fileURLToPath(new URL("../../../examples/bench-sensor", import.meta.url));

let result: ValidationResult;
let netlist: Netlist;
let source: Awaited<ReturnType<typeof loadProject>>;
beforeAll(async () => {
  source = await loadProject(example, [
    fileURLToPath(new URL("../../../library", import.meta.url)),
  ]);
  result = validateProject(source);
  netlist = result.netlist as Netlist;
});

const q = (expr: string) => runQuery(netlist, expr);

describe("runQuery", () => {
  it("lists a part's pins and nets, resolving an unqualified refdes", () => {
    expect(q("part U1")).toEqual({
      ok: true,
      text: [
        "PWR/U1 lib:L7805CV 5 V 1.5 A linear regulator, TO-220 [unverified]",
        "  1 IN power_in -> PWR/+12V",
        "  2 GND power_in -> GND",
        "  3 OUT power_out -> +5V",
      ].join("\n"),
    });
  });

  it("lists a net's pins, numbering pins that share a name", () => {
    const r = q("net AFE/+3V3");
    expect(r.text.split("\n")[0]).toBe(
      "+3V3 {voltage: 3.3V} (joins PWR/+3V3, AFE/+3V3, MCU/+3V3): 12 pins",
    );
    expect(r.text).toContain("MCU/U4.VCC[4](power_in) MCU/U4.VCC[6](power_in)");
  });

  it("filters parts by rating with numeric comparison", () => {
    expect(q("parts where vin_max < 15V").text).toBe(
      "1 part\nPWR/U2  lib:MCP1700-3302  vin_max=6V",
    );
    expect(q("parts where vin_max >= 6V").text.split("\n")[0]).toBe("2 parts");
  });

  it("combines conditions", () => {
    expect(q("parts where fn = cap and value = 10n").text).toBe(
      "1 part\nAFE/C6  cap(10n, 16V, X7R, 0603)  value=10n",
    );
    expect(q("parts where path ~ MCU/ and kind = lib").text.split("\n")[0]).toBe("3 parts");
  });

  it("filters nets by attribute and pin count", () => {
    expect(q("nets where voltage ~ 12V").text).toBe(
      "1 net\nPWR/VIN_RAW {voltage: 12V ±10%}: PWR/J1.TIP PWR/D1.A",
    );
    expect(q("nets where pins > 20").text).toMatch(/^1 net\nGND: /);
  });

  it("lists unconnected pins, including ones that may stay open", () => {
    const lines = q("unconnected").text.split("\n");
    expect(lines[0]).toBe("17 unconnected pins");
    expect(lines).toContain("  MCU/U4.PB0 (pin 12, bidir)");
  });

  it.each([
    ["part U9", "no part 'U9'"],
    ["part C1 C2", "usage: part REF"],
    ["net GN", "no net 'GN'"],
    ["parts having x", "expected 'where', found 'having x'"],
    ["parts where", "expected 'where', found 'where'"],
    ["parts where vin_max", "cannot parse condition 'vin_max'"],
    ["frob", "unknown query 'frob'"],
  ])("rejects %j", (expr, message) => {
    const r = q(expr);
    expect(r.ok).toBe(false);
    expect(r.text.split("\n")[0]).toBe(message);
  });

  it("resolves names without their instance path when unambiguous", () => {
    expect(q("part J2").text).toMatch(/^AFE\/J2 /);
    expect(q("net SENSE").text).toMatch(/^AFE\/SENSE /);
  });

  it("reports ambiguous names", () => {
    const location = { file: "x", line: 1, col: 1 };
    const part = (path: string) => ({
      path,
      spec: { kind: "generic" as const, fn: "res", args: ["1k"] },
      pins: [],
      location,
    });
    const twoR1: Netlist = { parts: [part("A/R1"), part("B/R1")], nets: [] };
    expect(runQuery(twoR1, "part R1")).toEqual({
      ok: false,
      text: "part 'R1' is ambiguous: A/R1, B/R1",
    });
  });
});

describe("overview and readBlock", () => {
  it("summarises the project in a few hundred tokens", () => {
    const text = overview(source, result);
    expect(text.split("\n").slice(0, 2)).toEqual([
      "project bench-sensor",
      "context: Benchtop sensor interface",
    ]);
    expect(text).toContain(
      "  interface AFE/J2: remote sensor on 2 m cable (0-3.3 V analog, sensor powered from +5V); hazards: ESD, miswiring to 12 V (accepted: on a bench tool; it may destroy D3, but R2 keeps it out of U3)",
    );
    expect(text).toContain("  power (circuit/power.ckt): 11 parts; ports +5V +3V3 GND");
    expect(text).toContain("parts: 30 (10 library, 20 generic; 9 of 9 records unverified)");
    expect(text).toContain("issues: 0 errors, 0 warnings");
    // Rough budget check: ~4 characters per token.
    expect(text.length / 4).toBeLessThan(800);
  });

  it("reads a block in full or as a summary", () => {
    const full = readBlock(source, result, "main", "full");
    expect(full.text.startsWith("# circuit/main.ckt\nblock main")).toBe(true);
    const summary = readBlock(source, result, "mcu", "summary").text.split("\n");
    expect(summary[1]).toBe("ports: +3V3 power_in, GND ground, AIN input");
    expect(summary).toContain("  R5 res(10k, 1%, 0603) @ RESET pull-up");
    expect(summary.at(-1)).toMatch(/^nets: /);
    expect(readBlock(source, result, "nope", "full")).toEqual({
      ok: false,
      text: "no block 'nope' (blocks: main, mcu, power, sensor_afe)",
    });
  });
});

describe("part search and get", () => {
  it("ranks id and MPN matches above summary matches", () => {
    const text = searchParts(result.library, "regulator").text;
    expect(text).toBe(
      "L7805CV: STMicroelectronics L7805CV, 5 V 1.5 A linear regulator, TO-220 [unverified]",
    );
    expect(searchParts(result.library, "tsw").text.split("\n")).toHaveLength(2);
    expect(searchParts(result.library, "op-amp missing").text).toBe(
      "no parts match 'op-amp missing'",
    );
  });

  it("reads records by tier", () => {
    const summary = describePart(result.library, "L7805CV", "summary").text;
    expect(summary).toContain("ratings: vin_max=35V iout_max=1.5A dropout=2V");
    expect(summary).toContain("requirements: 2 (tier pins)");
    expect(summary).not.toContain("pins:");
    const pins = describePart(result.library, "L7805CV", "pins").text;
    expect(pins).toContain("  1 IN power_in max 35V");
    expect(pins).toContain("  2 GND power_in (tab is GND)");
    expect(pins).toContain("requires: 0.33 uF on IN, close to the pin [checked]");
    expect(describePart(result.library, "MCP6002", "pins").text).toContain(
      "requires: tie unused amplifier halves off (e.g. follower with input at a defined level)",
    );
    expect(describePart(result.library, "L7805CV", "full").text).toMatch(
      /^# \.\.\/\.\.\/library\/L7805CV\.yaml\nid: L7805CV\n/,
    );
    expect(describePart(result.library, "NOPE", "full").ok).toBe(false);
  });
});
