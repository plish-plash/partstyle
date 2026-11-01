import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateProject } from "../validate.js";
import { loadProject, ProjectLoadError } from "./load.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));

describe("loadProject", () => {
  it("loads the example design, which validates clean", async () => {
    const source = await loadProject(repo("examples/bench-sensor"));
    expect(source.circuits.map((c) => c.file)).toEqual([
      "circuit/main.ckt",
      "circuit/mcu.ckt",
      "circuit/power.ckt",
      "circuit/sensor_afe.ckt",
    ]);
    expect(
      source.parts.every((p) => p.layer === "global" && p.file.startsWith("../../library/")),
    ).toBe(true);

    const result = validateProject(source);
    expect(result.issues).toEqual([]);
    expect(result.netlist?.parts).toHaveLength(30);
  });

  it("reports one problem per check in the broken fixture", async () => {
    const result = validateProject(await loadProject(repo("packages/engine/test-fixtures/broken")));
    expect([...new Set(result.issues.map((i) => i.code))].sort()).toEqual([
      "elab.bad-generic",
      "elab.unknown-part",
      "elab.unknown-pin",
      "erc.output-conflict",
      "erc.single-pin-net",
      "erc.unconnected-pin",
      "erc.undriven-input",
      "erc.unsourced-power",
      "parse.syntax",
      "part.cap-voltage",
      "part.overvoltage",
      "part.requirement",
    ]);
  });

  it("fails clearly without project.toml", async () => {
    await expect(loadProject(repo("library"))).rejects.toThrow(ProjectLoadError);
  });
});
