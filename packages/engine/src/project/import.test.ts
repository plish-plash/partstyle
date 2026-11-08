import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findKicad } from "./kicad.js";
import { Workspace } from "./workspace.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));

// Import runs kicad-cli to resolve KiCad's connectivity; these tests are skipped without it.
const kicad = await findKicad();

/** Copies leave out .partstyle/: local state left by running a project is not part of it. */
const noState = (src: string) => path.basename(src) !== ".partstyle";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "partstyle-import-"));
  await cp(repo("examples/bench-sensor"), path.join(tmp, "examples/bench-sensor"), {
    recursive: true,
    filter: noState,
  });
  await cp(repo("packages/engine/test-fixtures"), path.join(tmp, "packages/engine/test-fixtures"), {
    recursive: true,
    filter: noState,
  });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const at = (p: string) => path.join(tmp, p);

describe("kicadImport", () => {
  it.skipIf(!kicad.cli)(
    "creates a project with KiCad's connectivity and refdes, copies of a reused sheet included",
    async () => {
      await new Workspace(at("packages/engine/test-fixtures/multi")).kicadExport({ check: false });
      const ws = new Workspace(at("fresh"));
      const r = await ws.kicadImport(at("packages/engine/test-fixtures/multi/kicad"));
      expect(r.ok).toBe(true);
      expect(r.text.split("\n")[0]).toMatch(/^created project multi in /);
      expect(r.text).toContain("KiCad multi: 3 sheets -> blocks main, filter x2; 6 parts");
      expect(r.text).toContain(
        "netlist check: the imported design connects exactly what KiCad's netlist does",
      );
      // The fixture's header record is its own, not the seed library's, so it comes back a draft.
      expect(r.text).toContain("MPN TSW-103-07-G-S is not in the library");
      expect(r.text).toContain("now: 0 errors, 1 warning");
      // The block has its first copy's refdes; the second copy keeps its KiCad ones. Export
      // carries no Partstyle spec, so a generic comes back from its value and footprint.
      expect(await readFile(at("fresh/circuit/filter.ckt"), "utf8")).toContain(
        "part R1 res(1k, 0603)",
      );
      expect(await readFile(at("fresh/annotation.lock"), "utf8")).toContain("F2/R1 R3\n");
      expect((await ws.query("part R3")).text).toMatch(/^R3 \[copy F2: R1 in filter\]/);
    },
    120_000,
  );

  it.skipIf(!kicad.cli)(
    "only adds blocks to a project with a design, reporting refdes that clash",
    async () => {
      await new Workspace(at("examples/bench-sensor")).kicadExport({ check: false });
      const ws = new Workspace(at("packages/engine/test-fixtures/multi"));
      const main = await readFile(
        at("packages/engine/test-fixtures/multi/circuit/main.ckt"),
        "utf8",
      );

      const r = await ws.kicadImport(at("examples/bench-sensor/kicad"));
      expect(r.ok).toBe(true);
      expect(r.text).toContain("netlist check: the imported design connects exactly");
      expect(r.text).toMatch(/refdes clashes with the project \(\d+\): rename the imported parts/);
      expect(r.text).toContain("elab.duplicate-ref");
      expect(r.text).toContain("next: join bench-sensor, power, sensor_afe, mcu into the design");
      const files = await readdir(at("packages/engine/test-fixtures/multi/circuit"));
      expect(files.sort()).toEqual([
        "bench-sensor.ckt",
        "filter.ckt",
        "main.ckt",
        "mcu.ckt",
        "power.ckt",
        "sensor_afe.ckt",
      ]);
      // main is the project's own: never touched.
      expect(
        await readFile(at("packages/engine/test-fixtures/multi/circuit/main.ckt"), "utf8"),
      ).toBe(main);
    },
    120_000,
  );

  it.skipIf(!kicad.cli)(
    "imports chosen sheets, under names the project does not have",
    async () => {
      await new Workspace(at("packages/engine/test-fixtures/multi")).kicadExport({ check: false });
      const ws = new Workspace(at("packages/engine/test-fixtures/multi"));
      const r = await ws.kicadImport(at("packages/engine/test-fixtures/multi/kicad"), {
        sheets: ["F1"],
      });
      expect(r.ok).toBe(true);
      expect(r.text).toContain("KiCad multi: 1 sheet -> blocks filter_2; 2 parts");
      expect(r.text).toContain("netlist check: skipped, as only some sheets were imported");
      // The copy of the project's own block clashes with it, for the AI to sort out.
      expect(r.text).toContain("refdes clashes with the project (2)");
      const bad = await ws.kicadImport(at("packages/engine/test-fixtures/multi/kicad"), {
        sheets: ["NOPE"],
      });
      expect(bad).toEqual({ ok: false, text: "no sheet 'NOPE' (sheets: F1, F2)" });
    },
    120_000,
  );
});
