import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildLibrary, parsePartRecord } from "./library.js";

const record = (id: string, summary = "test part") => `
id: ${id}
manufacturer: ACME
preferred_mpn: ${id}
summary: ${summary}
package: SOT-23
footprint: Package_TO_SOT_SMD:SOT-23
pins:
  1: {name: IN, type: power_in}
  2: {name: OUT, type: power_out}
provenance:
  extracted_by: ai
  verified_by: null
`;

describe("parsePartRecord", () => {
  it("accepts a valid record with numeric pin keys", () => {
    const { record: r, issues } = parsePartRecord(record("X1"), "x.yaml");
    expect(issues).toEqual([]);
    expect(r?.pins["1"]).toEqual({ name: "IN", type: "power_in" });
  });

  it("needs only an id, a summary and pins", () => {
    const { record: r, issues } = parsePartRecord(
      "id: X1\nsummary: test\npins:\n  1: {name: A}\n",
      "x.yaml",
    );
    expect(issues).toEqual([]);
    expect(r).toMatchObject({
      manufacturer: "",
      footprint: "",
      pins: { 1: { name: "A", type: "passive" } },
      provenance: { extracted_by: "ai", verified_by: null },
    });
    expect(r).not.toHaveProperty("preferred_mpn");
  });

  it("refuses what the engine cannot work without, as warnings naming the path", () => {
    const text = record("X1")
      .replace("power_out", "sideways")
      .replace(/summary: .*\n/, "");
    const { record: r, issues } = parsePartRecord(text, "x.yaml");
    expect(r).toBeUndefined();
    expect(issues.every((i) => i.severity === "warning" && i.code === "part.schema")).toBe(true);
    expect(issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^summary: /),
        expect.stringMatching(/^pins\.2\.type: /),
      ]),
    );
  });

  it("keeps sections it does not know, and nested ratings", () => {
    const text = `${record("X1")}ratings: {vout: {min: 1V, max: 5V}}\ntiming: {tpd: 10ns}\n`;
    const { record: r, issues } = parsePartRecord(text, "x.yaml");
    expect(issues).toEqual([]);
    expect(r?.extras).toEqual(["timing"]);
    expect(r?.ratings).toEqual({ vout: { min: "1V", max: "5V" } });
  });

  it("leaves out fields it cannot use and warns, keeping the rest of the record", () => {
    const text = `${record("X1")}temp_c: cold
generic: nonsense
requirements:
  - text: needs a cap
    cap: { from: IN, min: lots }
  - {nothing: here}
pins2: x
`;
    const { record: r, issues } = parsePartRecord(text, "x.yaml");
    expect(r?.temp_c).toBeUndefined();
    expect(r?.generic).toBeUndefined();
    expect(r?.requirements).toEqual(["needs a cap"]);
    expect(issues.map((i) => i.code)).toEqual(Array(4).fill("part.format"));
    expect(issues[0]?.message).toMatch(/^lib:X1: temp_c must be/);
  });

  it("keeps a limit relative to another pin as text, and reads a plain number as volts", () => {
    const text = record("X1")
      .replace("{name: IN, type: power_in}", "{name: IN, type: power_in, vmax: VDD + 0.3V}")
      .replace("{name: OUT, type: power_out}", "{name: OUT, type: power_out, vmax: 6}");
    const { record: r, issues, notes } = parsePartRecord(text, "x.yaml");
    expect(issues).toEqual([]);
    expect(notes).toEqual(["pins.1.vmax 'VDD + 0.3V' is kept but not checked: not a voltage"]);
    expect(r?.pins["1"]?.vmax).toBe("VDD + 0.3V");
    expect(r?.pins["2"]?.vmax).toBe("6V");
  });

  it("accepts a datasheet given as a URL, and never reads another word as verified", () => {
    const text = `${record("X1").replace(/provenance:[\s\S]*$/, "")}provenance:
  datasheet: https://example.com/x.pdf
  extracted_by: claude
  verified_by: me
`;
    expect(parsePartRecord(text, "x.yaml").record?.provenance).toEqual({
      datasheet: { url: "https://example.com/x.pdf" },
      extracted_by: "ai",
      verified_by: null,
    });
  });

  it("takes the format reference's example without a complaint", async () => {
    const doc = await readFile(
      new URL("../../../../docs/part-records.md", import.meta.url),
      "utf8",
    );
    const example = /```yaml\n([\s\S]*?)```/.exec(doc)?.[1] as string;
    const { record: r, issues, notes } = parsePartRecord(example, "x.yaml");
    expect(issues).toEqual([]);
    expect(notes).toEqual([]);
    expect(r?.extras).toEqual(["output_power", "application_circuits", "thermal"]);
    expect(r?.requirements?.filter((q) => typeof q !== "string")).toHaveLength(1);
  });

  it("reports invalid YAML", () => {
    const { issues } = parsePartRecord("id: [unclosed", "x.yaml");
    expect(issues[0]?.code).toBe("part.yaml");
  });
});

describe("buildLibrary", () => {
  it("lets project records override global ones regardless of order", () => {
    const { library, issues } = buildLibrary([
      { file: "parts/X1.yaml", text: record("X1", "project"), layer: "project" },
      { file: "lib/X1.yaml", text: record("X1", "global"), layer: "global" },
    ]);
    expect(issues).toEqual([]);
    expect(library.get("X1")?.record.summary).toBe("project");
  });

  it("warns on duplicate ids within one layer", () => {
    const { issues } = buildLibrary([
      { file: "lib/a.yaml", text: record("X1"), layer: "global" },
      { file: "lib/b.yaml", text: record("X1"), layer: "global" },
    ]);
    expect(issues.map((i) => [i.code, i.location?.file])).toEqual([
      ["part.duplicate-id", "lib/b.yaml"],
    ]);
  });

  it("holds format warnings back for the designs that use the record", () => {
    const { library, issues } = buildLibrary([
      { file: "lib/X1.yaml", text: `${record("X1")}temp_c: cold\n`, layer: "global" },
    ]);
    expect(issues).toEqual([]);
    expect(library.get("X1")?.warnings?.map((i) => i.code)).toEqual(["part.format"]);
  });
});
