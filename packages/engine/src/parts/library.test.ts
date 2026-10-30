import { describe, expect, it } from "vitest";
import { buildLibrary, parsePartRecord } from "./library.js";
import { partRecordJsonSchema } from "./schema.js";

const record = (id: string, summary = "test part") => `
id: ${id}
manufacturer: ACME
mpn: ${id}
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

  it("reports schema problems with their path", () => {
    const text = record("X1").replace("power_out", "sideways").replace("manufacturer: ACME\n", "");
    const { record: r, issues } = parsePartRecord(text, "x.yaml");
    expect(r).toBeUndefined();
    expect(issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^manufacturer: /),
        expect.stringMatching(/^pins\.2\.type: /),
      ]),
    );
  });

  it("rejects unknown keys so typos surface", () => {
    const { issues } = parsePartRecord(`${record("X1")}ratngs: {}\n`, "x.yaml");
    expect(issues[0]?.message).toMatch(/ratngs/);
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
});

it("exports a JSON Schema for the part record", () => {
  const schema = partRecordJsonSchema() as { properties: Record<string, unknown> };
  expect(Object.keys(schema.properties)).toEqual(
    expect.arrayContaining(["id", "pins", "provenance"]),
  );
});
