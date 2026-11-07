import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateProject } from "../validate.js";
import { loadProject, ProjectLoadError } from "./load.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const seed = [repo("library")];

describe("loadProject", () => {
  it("loads the example design, which validates clean", async () => {
    const source = await loadProject(repo("examples/bench-sensor"), seed);
    expect(source.circuits.map((c) => c.file)).toEqual([
      "circuit/main.ckt",
      "circuit/mcu.ckt",
      "circuit/power.ckt",
      "circuit/sensor_afe.ckt",
    ]);
    expect(
      source.parts.every((p) => p.layer === "global" && p.file.startsWith("../../library/")),
    ).toBe(true);
    expect(source.project.file).toBe("partstyle-project.yaml");

    const result = validateProject(source);
    expect(result.issues).toEqual([]);
    expect(result.netlist?.parts).toHaveLength(30);
  });

  it("reports one problem per check in the broken fixture", async () => {
    const result = validateProject(
      await loadProject(repo("packages/engine/test-fixtures/broken"), seed),
    );
    expect([...new Set(result.issues.map((i) => i.code))].sort()).toEqual([
      "elab.bad-generic",
      "elab.duplicate-ref",
      "elab.nc-connected",
      "elab.pin-multiple-nets",
      "elab.unknown-part",
      "elab.unknown-pin",
      "erc.output-conflict",
      "erc.power-out-on-ground",
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

  it("fails clearly without a project file", async () => {
    await expect(loadProject(repo("library"), [])).rejects.toThrow(ProjectLoadError);
  });
});
