import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findKicad } from "./kicad.js";
import { Workspace } from "./workspace.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));

// Round-trip and ERC need kicad-cli; those tests are skipped without it.
const kicad = await findKicad();

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "partstyle-export-"));
  await cp(repo("library"), path.join(tmp, "library"), { recursive: true });
  await cp(repo("examples/bench-sensor"), path.join(tmp, "examples/bench-sensor"), {
    recursive: true,
  });
  // Fixtures sit four levels below the repo, like their library path expects.
  await cp(repo("packages/engine/test-fixtures"), path.join(tmp, "packages/engine/test-fixtures"), {
    recursive: true,
  });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const open = (p: string) => new Workspace(path.join(tmp, p));
const read = (p: string) => readFile(path.join(tmp, p), "utf8");

async function snapshot(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const f of await readdir(path.join(tmp, dir))) files.set(f, await read(`${dir}/${f}`));
  return files;
}

describe("kicadExport", () => {
  it.skipIf(!kicad.cli)(
    "exports the example with a matching round trip and clean ERC",
    async () => {
      const r = await open("examples/bench-sensor").kicadExport();
      expect(r.ok).toBe(true);
      expect(r.text).toContain("round-trip: KiCad's netlist from the schematic matches the design");
      expect(r.text).toContain("KiCad ERC: 0 errors, 0 warnings");
      expect(r.text).not.toContain("bom.");
      // Every part type finds a stock KiCad symbol: by MPN, by kicad_symbol, or Device:*.
      expect(r.text).toContain("partstyle.kicad_sym (0 symbols)");
      expect(r.text).toContain(
        "KiCad symbols: Amplifier_Operational:MCP6002-xSN, Connector:Barrel_Jack_Switch, " +
          "Connector_Generic:Conn_01x03, Connector_Generic:Conn_02x03_Odd_Even, Device:C, " +
          "Device:D_TVS, Device:LED, Device:R, Diode:1N5819, MCU_Microchip_ATmega:ATmega328P-A, " +
          "Regulator_Linear:L7805, Regulator_Linear:MCP1700x-330xxTT",
      );
      expect(r.text).not.toContain("generated symbol");
      // kicad-cli adds its own bench-sensor.kicad_prl (local settings) when it runs ERC.
      expect(await readdir(path.join(tmp, "examples/bench-sensor/kicad"))).toEqual(
        expect.arrayContaining([
          "bench-sensor.kicad_pro",
          "bench-sensor.kicad_sch",
          "bench-sensor.net",
          "mcu.kicad_sch",
          "partstyle.kicad_sym",
          "power.kicad_sch",
          "sensor_afe.kicad_sch",
          "sym-lib-table",
        ]),
      );
    },
  );

  it.skipIf(!kicad.cli)(
    "handles a block used twice, with port names unlike net names",
    async () => {
      const ws = open("packages/engine/test-fixtures/multi");
      const r = await ws.kicadExport();
      expect(r.ok).toBe(true);
      expect(r.text).toContain("annotation: F2/R1 -> R3 (its refdes was taken)");
      expect(r.text).toContain("matches the design");
      expect(r.text).toContain("KiCad ERC: 0 errors, 0 warnings");
    },
  );

  it("is idempotent and keeps the user's .kicad_pro", async () => {
    const ws = open("examples/bench-sensor");
    await ws.kicadExport({ check: false });
    const pro = "examples/bench-sensor/kicad/bench-sensor.kicad_pro";
    await writeFile(path.join(tmp, pro), '{"edited": true}\n');
    const first = await snapshot("examples/bench-sensor/kicad");
    const again = await ws.kicadExport({ check: false });
    expect(again.text).not.toContain("created");
    expect(await snapshot("examples/bench-sensor/kicad")).toEqual(first);
    expect(await read(pro)).toBe('{"edited": true}\n');
  });

  it("keeps refdes across exports and removes only stale sheets it wrote", async () => {
    const ws = open("examples/bench-sensor");
    await ws.kicadExport({ check: false });
    const lock = "examples/bench-sensor/annotation.lock";
    await writeFile(
      path.join(tmp, lock),
      (await read(lock)).replace(/^PWR\/C1 +C1$/m, "PWR/C1 C99"),
    );
    const dir = path.join(tmp, "examples/bench-sensor/kicad");
    await writeFile(path.join(dir, "old.kicad_sch"), '(kicad_sch\n\t(generator "partstyle")\n)\n');
    await writeFile(path.join(dir, "mine.kicad_sch"), '(kicad_sch\n\t(generator "eeschema")\n)\n');

    const r = await ws.kicadExport({ check: false });
    expect(r.text).toContain("removed stale kicad/old.kicad_sch");
    const files = await readdir(dir);
    expect(files).toContain("mine.kicad_sch");
    expect(files).not.toContain("old.kicad_sch");
    expect(await read("examples/bench-sensor/kicad/power.kicad_sch")).toContain(
      '(reference "C99")',
    );
    expect(await read("examples/bench-sensor/kicad/bench-sensor.net")).toContain('(ref "C99")');
  });

  it("refuses a design with errors", async () => {
    const r = await open("packages/engine/test-fixtures/broken").kicadExport();
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/^cannot export with \d+ errors/);
  });
});

describe("bomExport", () => {
  it("writes a grouped bom.csv with every generic unresolved, and links for all", async () => {
    const ws = open("examples/bench-sensor");
    const r = await ws.bomExport();
    const lines = r.text.split("\n");
    expect(lines[0]).toMatch(
      /^wrote bom\.csv: \d+ lines for 30 parts \(10 assigned, 20 unresolved\)$/,
    );
    expect(lines[1]).toBe("unresolved:");
    expect(r.text).toContain("cap(330n, 50V, X7R, 0603) x1 (PWR/C1): lib:CL10B334KB8NNNC");
    expect(r.text).toContain("cap(10u, 16V, X7R, 0805) x1 (PWR/C3): no library part fits");

    const csv = (await read("examples/bench-sensor/bom.csv")).split("\n");
    expect(csv[0]).toBe(
      "Refs,Qty,Value,Spec,Manufacturer,MPN,Footprint,In inventory,lcsc,digikey,Notes",
    );
    const row = csv.find((l) => l.startsWith("C3,")) as string;
    expect(row).toContain("cap(10u, 16V, X7R, 0805)");
    expect(row).toContain("Capacitor_SMD:C_0805_2012Metric");
    expect(row).toContain("unresolved generic");
    // The viewer's own links, for a generic and for a library part.
    const { parts } = await ws.viewerModel();
    const search = (p: string) =>
      (parts[p]?.links ?? []).filter((l) => /LCSC|DigiKey/.test(l.label)).map((l) => l.url);
    expect(search("PWR/C3")).toHaveLength(2);
    for (const url of search("PWR/C3")) expect(row).toContain(url);
    const u1 = csv.find((l) => l.includes(",L7805CV,")) as string;
    for (const url of search("PWR/U1")) expect(u1).toContain(url);

    await expect(read("examples/bench-sensor/bom.lock")).rejects.toThrow();
  });
});
