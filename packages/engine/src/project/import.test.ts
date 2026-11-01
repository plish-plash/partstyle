import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findKicad } from "./kicad.js";
import { Workspace } from "./workspace.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));

// Import runs kicad-cli to resolve KiCad's connectivity; these tests are skipped without it.
const kicad = await findKicad(process.cwd(), {});

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "partstyle-import-"));
  await cp(repo("library"), path.join(tmp, "library"), { recursive: true });
  await cp(repo("examples/bench-sensor"), path.join(tmp, "examples/bench-sensor"), {
    recursive: true,
  });
  await cp(repo("packages/engine/test-fixtures"), path.join(tmp, "packages/engine/test-fixtures"), {
    recursive: true,
  });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const at = (p: string) => path.join(tmp, p);

describe("kicadImport", () => {
  it.skipIf(!kicad.cli)(
    "gives back the design it exported, with no circuit changes",
    async () => {
      for (const p of ["examples/bench-sensor", "packages/engine/test-fixtures/multi"]) {
        const ws = new Workspace(at(p));
        expect((await ws.kicadExport({ check: false })).ok).toBe(true);
        const refused = await ws.kicadImport(at(`${p}/kicad`));
        expect(refused.ok).toBe(false);
        expect(refused.text).toContain("import with replace");

        const r = await ws.kicadImport(at(`${p}/kicad`), { replace: true });
        expect(r.ok).toBe(true);
        expect(r.text).toContain(
          "round-trip: the imported design connects exactly what KiCad's netlist does",
        );
        expect(r.text).toContain("changes: none to the circuit");
        expect(r.text).toContain("now: 0 errors, 0 warnings");
      }
    },
    120_000,
  );

  it.skipIf(!kicad.cli)(
    "creates a project, then picks up a value changed in KiCad on re-import",
    async () => {
      const source = new Workspace(at("packages/engine/test-fixtures/multi"));
      await source.kicadExport({ check: false });
      const sheet = at("packages/engine/test-fixtures/multi/kicad/filter.kicad_sch");

      const ws = new Workspace(at("fresh"));
      const first = await ws.kicadImport(at("packages/engine/test-fixtures/multi/kicad"), {
        libraryPaths: [at("library")],
      });
      expect(first.ok).toBe(true);
      expect(first.text.split("\n")[0]).toMatch(/^created project multi in /);
      expect(first.text).toContain("KiCad multi: 3 sheets -> blocks main, filter x2; 6 parts");
      // Without an earlier annotation.lock, block parts take their first instance's refdes.
      expect(await readFile(at("fresh/circuit/filter.ckt"), "utf8")).toContain(
        "part R2 res(1k, 1%, 0603)",
      );

      const text = await readFile(sheet, "utf8");
      expect(text).toContain('(property "Value" "1k"');
      await writeFile(sheet, text.replace('(property "Value" "1k"', '(property "Value" "2k2"'));
      const again = await ws.kicadImport(at("packages/engine/test-fixtures/multi/kicad"));
      expect(again.ok).toBe(true);
      expect(again.text).toContain("changes: 1 statement (see diff)");
      expect(again.text).toContain("~ part R2 res(2k2, 1%, 0603)");
    },
    120_000,
  );
});
