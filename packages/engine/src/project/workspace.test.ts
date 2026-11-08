import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { slashCommands } from "../prompts.js";
import { findKicad } from "./kicad.js";
import { rememberSharedLibrary } from "./settings.js";
import { projectClaudeMd } from "./skeleton.js";
import { partstyleVersion } from "./version.js";
import { readGuide, Workspace } from "./workspace.js";

// Tests that need KiCad installed are skipped without it.
const kicad = await findKicad();

const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));

// A copy of the example and library, so apply and part_put can write, with settings listing it.
let tmp: string;
let ws: Workspace;
let project: string;
let stateDir: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "partstyle-"));
  project = path.join(tmp, "examples/bench-sensor");
  // Without .partstyle/: local state left by running the example is not part of it.
  await cp(repo("examples/bench-sensor"), project, {
    recursive: true,
    filter: (src) => path.basename(src) !== ".partstyle",
  });
  await cp(repo("library"), path.join(tmp, "library"), { recursive: true });
  stateDir = path.join(tmp, "state");
  await mkdir(stateDir);
  await writeFile(path.join(stateDir, "settings.yaml"), "libraries: [../library]\n");
  ws = new Workspace(project, { stateDir });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const read = (file: string) => readFile(path.join(project, file), "utf8");

describe("Workspace.apply", () => {
  it("writes the edit and reports only the issues it changed", async () => {
    const r = await ws.apply("in power\n+ part C13 cap(47u, 25V) @ bulk\nnet +12V += C13.1");
    expect(r).toEqual({
      ok: true,
      text: [
        "applied 2 edits to circuit/power.ckt",
        "  power: + part C13 cap(47u, 25V) @ bulk",
        "  power: net +12V += C13.1",
        "new issues:",
        "  circuit/power.ckt:18:1 warning erc.unconnected-pin C13.2 (pin 2, passive) is not connected; connect it, or mark it nc if it is open on purpose",
        "now: 0 errors, 1 warning",
      ].join("\n"),
    });
    expect(await read("circuit/power.ckt")).toContain("part C13 cap(47u, 25V) @ bulk\n");

    const fix = await ws.apply("in power\nnet GND += C13.2");
    expect(fix.text).toContain(
      "resolved:\n  erc.unconnected-pin C13.2 (pin 2, passive) is not connected",
    );
    expect(fix.text).toMatch(/now: 0 errors, 0 warnings/);
  });

  it("writes nothing on a dry run or a rejected patch", async () => {
    const before = await read("circuit/power.ckt");
    expect((await ws.apply("in power\n- part D2", { dryRun: true })).text).toMatch(
      /^dry run, would apply 1 edit to circuit\/power\.ckt/,
    );
    expect(await ws.apply("in power\n- part D2\n- part D99")).toEqual({
      ok: false,
      text: "<patch>:3:1 error patch.error no part D99 in power; nothing was applied",
    });
    expect(await read("circuit/power.ckt")).toBe(before);
  });

  it("creates a new block file", async () => {
    const r = await ws.apply('in spare\n+ block spare "unused"');
    expect(r.text).toContain("elab.unused-block");
    expect(await read("circuit/spare.ckt")).toBe('block spare "unused"\n');
  });
});

describe("Workspace.partPut", () => {
  const record = (id: string) =>
    [
      `id: ${id}`,
      "manufacturer: ACME",
      `preferred_mpn: ${id}`,
      "summary: test regulator",
      "package: SOT-23",
      "footprint: Package_TO_SOT_SMD:SOT-23",
      "pins:",
      "  1: {name: GND, type: power_in}",
      "  2: {name: OUT, type: power_out}",
      "  3: {name: IN, type: power_in}",
      "provenance: {extracted_by: ai, verified_by: null}",
    ].join("\n");

  it("writes to the global library by default and to parts/ for project scope", async () => {
    const created = (await ws.partPut(record("X1"))).text.split("\n");
    expect(created[0]).toBe("created ../../library/X1.yaml (lib:X1)");
    expect(created.at(-1)).toBe("unverified until a human checks it");
    expect(await readFile(path.join(tmp, "library/X1.yaml"), "utf8")).toBe(`${record("X1")}\n`);
    expect((await ws.partPut(record("X1"))).text).toMatch(/^updated /);
    expect((await ws.partPut(record("X2"), "project")).text).toMatch(/^created parts\/X2\.yaml/);
    expect((await ws.partSearch("X2")).text).toMatch(/^X2: ACME X2/);
  });

  it.skipIf(!kicad.footprints)(
    "writes a record whose pins differ from the footprint, with a warning",
    async () => {
      const twoPins = record("X3").replace("  3: {name: IN, type: power_in}\n", "");
      const r = await ws.partPut(twoPins);
      expect(r.ok).toBe(true);
      expect(r.text).toContain(
        "warning: X3: pin table does not match Package_TO_SOT_SMD:SOT-23 (pads with no pin: 3)",
      );
      const missing = await ws.partPut(record("X4").replace("SMD:SOT-23", "SMD:SOT-99"));
      expect(missing.text).toContain("warning: X4: footprint Package_TO_SOT_SMD:SOT-99 is not in");
      // Both are warnings on the design while a part uses them.
      await ws.apply(
        "in power\n+ part U8 lib:X3\n+ part U9 lib:X4\nnet GND += U8.GND U9.GND\nnet +12V += U8.IN U9.IN\n",
      );
      const issues = (await ws.validate()).text;
      expect(issues).toMatch(/warning part\.footprint-pads .*X3/);
      expect(issues).toMatch(/warning part\.footprint-missing .*X4/);
    },
  );

  it.skipIf(!kicad.footprints)("does not expect mounting pads in the pin table", async () => {
    const shape = "Connector_JST:JST_SH_SM02B-SRSS-TB_1x02-1MP_P1.00mm_Horizontal";
    const yaml = [
      "id: X5",
      "summary: test header",
      `footprint: ${shape}`,
      "pins:",
      "  1: {name: A}",
      "  2: {name: B}",
    ].join("\n");
    expect((await ws.partPut(yaml)).text).not.toContain("does not match");
  });

  it("accepts a minimal record, keeps free-form sections and mentions them", async () => {
    const yaml = [
      "id: X6",
      "summary: test amp",
      "pins:",
      "  1: {name: A, vmax: VCC + 0.3V}",
      "timing: {tpd: 10ns}",
      "temp_c: cold",
    ].join("\n");
    const put = (await ws.partPut(yaml)).text;
    expect(put).toContain("warning: lib:X6: temp_c must be [min, max]");
    expect(put).toContain("note: pins.1.vmax 'VCC + 0.3V' is kept but not checked");
    expect(put).toContain("free-form sections, kept for tier full: timing");
    expect((await ws.partGet("X6", "summary")).text).toContain("more: timing (tier full)");
    expect((await ws.partGet("X6", "pins")).text).toContain("1 A passive max VCC + 0.3V");
    expect((await ws.partGet("X6", "full")).text).toContain("tpd: 10ns");
    expect((await ws.partSearch("tpd")).text).toMatch(/^X6: test amp/);
  });

  it("shows other keys on pins and requirements at tier pins", async () => {
    const yaml = [
      "id: X8",
      "summary: test",
      "pins:",
      "  1: {name: A, esd: 2kV, levels: {vil: 0.8V}}",
      "  2: {name: B}",
      "requirements:",
      "  - {text: bypass A, cap: {from: A, min: 100n}, source: table 3}",
      "  - {text: keep traces short, source: section 9}",
      "  - plain text",
    ].join("\n");
    await ws.partPut(yaml);
    const lines = (await ws.partGet("X8", "pins")).text.split("\n");
    expect(lines).toContain('  1 A passive esd=2kV levels={"vil":"0.8V"}');
    expect(lines).toContain("  2 B passive");
    expect(lines).toContain("requires: bypass A [checked] source=table 3");
    expect(lines).toContain("requires: keep traces short source=section 9");
    expect(lines).toContain("requires: plain text");
  });

  it("marks a record without provenance verified, keeping its comments", async () => {
    await ws.partPut("# hand note\nid: X7\nsummary: test\npins:\n  1: {name: A}\n");
    await ws.verifyPart("X7");
    const text = await readFile(path.join(tmp, "library/X7.yaml"), "utf8");
    expect(text).toContain("# hand note");
    expect((await ws.partGet("X7", "summary")).text).not.toContain("[unverified]");
  });

  it("makes a verified record unverified again when it is put, keeping comments", async () => {
    await ws.partPut(record("X9"));
    await ws.verifyPart("X9");
    const put = await ws.partPut(
      `# hand note\n${record("X9").replace("verified_by: null", "verified_by: human")}`,
    );
    expect(put.text.split("\n").at(-1)).toBe(
      "was verified; unverified again until a human rechecks it",
    );
    const text = await readFile(path.join(tmp, "library/X9.yaml"), "utf8");
    expect(text).toContain("# hand note");
    expect(text).toContain("verified_by: null");
    expect((await ws.partGet("X9", "summary")).text).toContain("[unverified]");
  });

  it("rejects only what the engine cannot use", async () => {
    const r = await ws.partPut(record("bad/id"));
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/^id: id may contain only/);
  });
});

it("fails cleanly outside a project", async () => {
  expect(await new Workspace(tmp, { stateDir }).overview()).toEqual({
    ok: false,
    text: `no partstyle-project.yaml in ${tmp} (create a project with: partstyle init)`,
  });
});

describe("settings", () => {
  it("are read on every call, so a new library applies without reopening", async () => {
    await writeFile(path.join(stateDir, "settings.yaml"), "libraries: []\n");
    expect((await ws.validate()).text).toContain("elab.unknown-part");
    await writeFile(path.join(stateDir, "settings.yaml"), "libraries: [../library]\n");
    expect((await ws.validate()).text).toBe("bench-sensor: 0 errors, 0 warnings");
  });

  it("report a broken settings file instead of ignoring it", async () => {
    await writeFile(path.join(stateDir, "settings.yaml"), "libraries: nope\n");
    expect((await ws.overview()).text).toMatch(/settings\.yaml: libraries: /);
  });

  it("put the remembered shared library first, the latest server's replacing the last", async () => {
    await rememberSharedLibrary(stateDir, path.join(tmp, "old"));
    await rememberSharedLibrary(stateDir, path.join(tmp, "library"));
    expect((await ws.settings()).libraries).toEqual([path.join(tmp, "library")]);
    await writeFile(path.join(stateDir, "settings.yaml"), "libraries: [../mine, ../library]\n");
    expect((await ws.settings()).libraries).toEqual([
      path.join(tmp, "library"),
      path.join(tmp, "mine"),
    ]);
    // A server's own shared library wins over the remembered one.
    const served = new Workspace(project, { stateDir, sharedLibrary: path.join(tmp, "served") });
    expect((await served.settings()).libraries[0]).toBe(path.join(tmp, "served"));
  });
});

describe("Workspace.writeDoc", () => {
  it("refuses a project file that would not load", async () => {
    const before = await read("partstyle-project.yaml");
    const r = await ws.writeDoc("partstyle-project.yaml", "description: no name\n");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(
      /^not written: partstyle-project\.yaml:1:1 error project\.config name: /,
    );
    expect(await read("partstyle-project.yaml")).toBe(before);
  });
});

describe("layout preferences", () => {
  const file = "partstyle-project.yaml";

  it("saves only what differs from the default, keeping the file's comments", async () => {
    await writeFile(path.join(project, file), `# keep me\n${await read(file)}`);
    const before = await read(file);
    expect((await ws.setLayoutPreference("label-fallback", "detourLimit", 16)).ok).toBe(true);
    expect(await read(file)).toContain("# keep me");
    expect(await read(file)).toContain("detourLimit: 16");
    expect((await ws.viewerModel()).layout.values).toEqual({
      "label-fallback": { detourLimit: 16 },
    });
    expect((await ws.setLayoutPreference("label-fallback", "detourLimit", 20)).ok).toBe(true);
    expect(await read(file)).toBe(before);
  });

  it("has nothing to do when a value is set to what already applies", async () => {
    const before = await read(file);
    expect((await ws.setLayoutPreference("decoupling-near-pin", "side", "above")).ok).toBe(true);
    expect(await read(file)).toBe(before);
  });

  it("refuses rule switches, passes and values out of range", async () => {
    const before = await read(file);
    for (const [rule, key, value] of [
      ["route-costs", "ripupPasses", 2],
      ["chain-rows", "endStyle", "inline"],
      ["label-fallback", "detourLimit", 1000],
    ] as const) {
      expect((await ws.setLayoutPreference(rule, key, value)).ok).toBe(false);
    }
    expect(await read(file)).toBe(before);
    const hand = `${before}layout:\n  route-costs:\n    ripupPasses: 2\n`;
    const written = await ws.writeDoc(file, hand);
    expect(written.text).toMatch(/not written: .*layout\.route-costs\.ripupPasses/);
  });

  it("resets to the defaults", async () => {
    const before = await read(file);
    await ws.setLayoutPreference("decoupling-near-pin", "side", "below");
    expect((await ws.resetLayoutPreferences()).ok).toBe(true);
    expect(await read(file)).toBe(before);
    expect((await ws.resetLayoutPreferences()).text).toContain("no layout preferences");
  });

  it("overrides main's on a variant, and falls back to them", async () => {
    await ws.setLayoutPreference("pack-groups", "gap", 8);
    await ws.variant("create", "alt");
    const alt = await ws.variantWorkspace("alt");
    if (!alt) throw new Error("no variant");
    await alt.setLayoutPreference("pack-groups", "aspect", 2);
    const both = { "pack-groups": { gap: 8, aspect: 2 } };
    expect((await alt.viewerModel()).layout.values).toEqual(both);
    expect((await ws.viewerModel()).layout.values).toEqual({ "pack-groups": { gap: 8 } });
    // Main's value, set on the variant, stops being an override; the default then is one.
    await alt.setLayoutPreference("pack-groups", "gap", 5);
    expect((await alt.viewerModel()).layout.values["pack-groups"]?.gap).toBe(5);
    await alt.setLayoutPreference("pack-groups", "gap", 8);
    await alt.resetLayoutPreferences();
    expect((await alt.viewerModel()).layout.values).toEqual({ "pack-groups": { gap: 8 } });
  });
});

describe("review mode", () => {
  it("is the person's switch, kept in .partstyle/", async () => {
    expect(await ws.reviewMode()).toBe("auto");
    await ws.setReviewMode("accept");
    expect(await read(".partstyle/review.json")).toBe('{"mode":"accept"}\n');
    const r = await ws.apply("in power\n+ part C13 cap(47u, 25V) @ bulk");
    expect(r.text).toMatch(/held as P1 for review/);
    expect((await ws.overview()).text).toContain("review mode: accept");
  });
});

describe("Workspace.init", () => {
  it("creates a skeleton that validates clean", async () => {
    const dir = path.join(tmp, "new-board");
    const fresh = new Workspace(dir, { stateDir });
    const r = await fresh.init();
    expect(r.text.split("\n")).toEqual([
      `created project new-board in ${dir}`,
      "  partstyle-project.yaml",
      "  circuit/main.ckt",
      "  CLAUDE.md",
      "  .claude/commands/design-review.md",
      "  .claude/commands/ingest-part.md",
      "  .claude/commands/handoff.md",
      "  .gitignore",
      "next: fill in partstyle-project.yaml with the user, then add blocks (guide ckt shows how)",
    ]);
    expect(await readFile(path.join(dir, "partstyle-project.yaml"), "utf8")).toContain(
      `\npartstyle_version: "${partstyleVersion()}"\nname: "new-board"\n`,
    );
    expect(await fresh.validate()).toEqual({
      ok: true,
      text: "new-board: 0 errors, 0 warnings",
    });
    const overview = (await fresh.overview()).text;
    expect(overview).toContain("context: TODO one or two sentences");
    expect(overview).toContain("parts: 0 (0 library, 0 generic; 0 of 0 records unverified)");
    // The seed library is reachable from the new project.
    expect((await fresh.partSearch("SS14")).text).toMatch(/^SS14: /);
  });

  it("refuses an existing project", async () => {
    expect(await ws.init()).toEqual({
      ok: false,
      text: `${project} already has a partstyle-project.yaml`,
    });
  });

  it("keeps existing files and writes the AI instructions alongside CLAUDE.md", async () => {
    const dir = path.join(tmp, "existing");
    await mkdir(dir);
    await writeFile(path.join(dir, "CLAUDE.md"), "# mine\n");
    await writeFile(path.join(stateDir, "settings.yaml"), "");
    const r = await new Workspace(dir, { stateDir }).init({ name: "x" });
    expect(r.text).toContain("  CLAUDE.partstyle.md");
    expect(r.text).toContain("kept existing CLAUDE.md");
    expect(r.text).toContain("add the line '@CLAUDE.partstyle.md' to CLAUDE.md");
    expect(r.text).toContain("note: no part libraries listed in ");
    expect(await readFile(path.join(dir, "CLAUDE.md"), "utf8")).toBe("# mine\n");
    expect(await readFile(path.join(dir, "CLAUDE.partstyle.md"), "utf8")).toMatch(
      /^# Circuit project: x\n/,
    );
  });
});

describe("polarized capacitors and board footprints", () => {
  const fresh = async (name: string, main: string) => {
    const dir = path.join(tmp, name);
    const w = new Workspace(dir, { stateDir });
    await w.init();
    await writeFile(path.join(dir, "circuit/main.ckt"), `block main "t"\n${main}`);
    return { w, dir };
  };
  const design = `part C1 cap(100u, 25V, polarized)
part TP1 fp(TestPoint:TestPoint_Pad_D1.5mm)
part JP1 fp(Jumper:SolderJumper-2_P1.3mm_Open_RoundedPad1.0x1.5mm, 2)
part R1 res(1k, 1%, 0603)
net +5V : C1.+ JP1.1 {source: bench}
net SW : JP1.2 R1.1 TP1.1
net GND : C1.- R1.2 {source: bench}
`;

  it("connects them by the pin names and numbers the grammar gives", async () => {
    const { w } = await fresh("fp-names", design);
    expect((await w.validate()).text).toBe("fp-names: 0 errors, 0 warnings");
    expect((await w.query("part C1")).text).toMatch(/1 \+ passive -> \+5V\n {2}2 - passive -> GND/);
    expect((await w.query("part JP1")).text).toContain("2 2 passive -> SW");
  });

  it("keeps footprints out of the BOM and the distributor links", async () => {
    const { w, dir } = await fresh("fp-bom", design);
    expect((await w.bomExport()).ok).toBe(true);
    const csv = await readFile(path.join(dir, "bom.csv"), "utf8");
    expect(csv).toContain("polarized");
    expect(csv).not.toContain("TestPoint");
    expect(csv).not.toContain("SolderJumper");
    const { parts } = await w.viewerModel();
    expect(parts.TP1?.links).toEqual([]);
    expect(parts.TP1?.value).toBe("TestPoint");
    expect(parts.TP1?.bom.status).toBe("board");
    expect(parts.C1?.links.length).toBe(3);
  });

  it.skipIf(!kicad.cli)("exports to KiCad with KiCad's own symbols", async () => {
    const { w, dir } = await fresh("fp-kicad", design);
    const out = await w.kicadExport();
    expect(out.text).toContain(
      "netlist check: KiCad's netlist from the schematic matches the design",
    );
    expect(out.text).toContain("Device:C_Polarized");
    expect(out.text).toContain("Connector:TestPoint");
    expect(out.text).toContain("Jumper:SolderJumper_2_Open");
    const sch = await readFile(path.join(dir, "kicad/fp-kicad.kicad_sch"), "utf8");
    expect(sch).toMatch(/lib_id "Connector:TestPoint"\)[\s\S]*?\(in_bom no\)/);
  });
});

describe("approvals", () => {
  const fresh = async (name: string) => {
    const dir = path.join(tmp, name);
    const w = new Workspace(dir, { stateDir });
    await w.init();
    const main =
      'block main "t"\npart R1 res(1k)\npart R2 res(2k)\npart C1 cap(1u)\nnet A : R1.1 R2.1 C1.1\nnet B : R1.2 R2.2 C1.2\n';
    await writeFile(path.join(dir, "circuit/main.ckt"), main);
    return { w, dir };
  };
  const q = async (w: Workspace, expr: string) => (await w.query(expr)).text;

  it("approves by refdes or condition, and shows it in query and overview", async () => {
    const { w, dir } = await fresh("sign-off");
    expect((await w.approve("where fn = res", { by: "ai" })).text).toBe("approved 2 parts: R1 R2");
    expect(await q(w, "parts where approved = yes")).toMatch(/^2 parts\n/);
    expect(await q(w, "parts where approved = no")).toMatch(/^1 part\nC1 /);
    expect((await w.overview()).text).toContain("approved: 2 of 3 parts\n");
    const file = await readFile(path.join(dir, "approvals.yaml"), "utf8");
    expect(file).toContain("snapshot: ");
    expect(file).toContain("by: ai");
    await w.approve("C1", { by: "person" });
    expect(await readFile(path.join(dir, "approvals.yaml"), "utf8")).toContain("by: person");
    expect((await w.approve("R1 C1", { by: "ai", undo: true })).text).toBe(
      "unapproved 2 parts: R1 C1",
    );
    expect(await q(w, "parts where approved = yes")).toMatch(/^1 part\nR2 /);
  });

  it("marks a part changed when its spec or nets change, and restores it on revert", async () => {
    const { w, dir } = await fresh("sign-off-changed");
    await w.approve("all", { by: "person" });
    const main = path.join(dir, "circuit/main.ckt");
    const text = await readFile(main, "utf8");
    await writeFile(main, text.replace("res(1k)", "res(1.1k)"));
    expect(await q(w, "parts where approved = changed")).toMatch(/^1 part\nR1 /);
    expect((await w.overview()).text).toContain("approved: 2 of 3 parts, 1 changed since");
    await writeFile(main, text);
    expect(await q(w, "parts where approved != yes")).toBe("no matching parts");
    await writeFile(
      main,
      text.replace("part C1 cap(1u) ", "part C1 cap(1u)").replace("R2.2 C1.2", "R2.2"),
    );
    expect(await q(w, "parts where approved = changed")).toMatch(/^1 part\nC1 /);
  });

  it("ignores intent, and doesn't touch a part already approved", async () => {
    const { w, dir } = await fresh("sign-off-layout");
    await w.approve("R1", { by: "person" });
    const main = path.join(dir, "circuit/main.ckt");
    await writeFile(main, (await readFile(main, "utf8")).replace("res(1k)", "res(1k) @ pull-up"));
    expect(await q(w, "parts where approved = yes")).toMatch(/^1 part\nR1 /);
    await w.approve("all", { by: "ai" });
    expect(await readFile(path.join(dir, "approvals.yaml"), "utf8")).toMatch(
      /R1:\n[\s\S]*?by: person/,
    );
  });

  it("gives the viewer each part's approval and lookup links", async () => {
    const { w } = await fresh("sign-off-viewer");
    await w.approve("R1", { by: "person" });
    const { parts } = await w.viewerModel();
    expect(parts.R1?.approval).toMatchObject({ status: "approved", by: "person" });
    expect(parts.R2?.approval).toBeUndefined();
    expect(parts.R2?.links.map((l) => l.label)).toEqual(["LCSC", "DigiKey", "Mouser"]);
    expect(parts.R2?.links[0]?.url).toBe("https://www.lcsc.com/search?q=resistor%202k");
  });

  it("links a library part's datasheet and distributor part numbers, by MPN otherwise", async () => {
    const { w, dir } = await fresh("sign-off-links");
    const record = [
      "id: X9",
      "summary: test",
      "preferred_mpn: X9-A/B",
      "pins:",
      "  1: {name: A}",
      "  2: {name: B}",
      "ratings: {vout: {max: 5V}}",
      "sourcing: {lcsc: C123}",
      "provenance: {datasheet: 'https://example.com/x9.pdf'}",
    ].join("\n");
    await w.partPut(record, "project");
    const main = path.join(dir, "circuit/main.ckt");
    await writeFile(main, 'block main "t"\npart U1 lib:X9\nnet A : U1.A U1.B\n');
    const u1 = (await w.viewerModel()).parts.U1;
    expect(u1?.links).toEqual([
      { label: "Datasheet", url: "https://example.com/x9.pdf" },
      { label: "LCSC", url: "https://www.lcsc.com/search?q=C123" },
      { label: "DigiKey", url: "https://www.digikey.com/en/products/result?keywords=X9-A%2FB" },
      { label: "Mouser", url: "https://www.mouser.com/c/?q=X9-A%2FB" },
    ]);
    expect(u1?.record?.ratings.vout).toBe('{"max":"5V"}');
    await w.partPut(record.replace("https://example.com/x9.pdf", "javascript:alert(1)"), "project");
    const links = (await w.viewerModel()).parts.U1?.links;
    expect(links?.[0]?.label).toBe("Find datasheet");
    expect(JSON.stringify(links)).not.toContain("javascript:");
  });

  it("gives a variant main's approvals until it makes its own", async () => {
    const { w, dir } = await fresh("sign-off-variant");
    await w.approve("R1", { by: "person" });
    await w.variant("create", "alt");
    const alt = await w.variantWorkspace("alt");
    expect(await q(alt as Workspace, "parts where approved = yes")).toMatch(/^1 part\nR1 /);
    await alt?.approve("R2", { by: "person" });
    expect(await q(alt as Workspace, "parts where approved = yes")).toMatch(/^2 parts\n/);
    expect(await q(w, "parts where approved = yes")).toMatch(/^1 part\nR1 /);
    expect(await readFile(path.join(dir, "variants/alt/approvals.yaml"), "utf8")).toContain("R2:");
  });

  it("links only the project's distributors, in its order", async () => {
    const { w, dir } = await fresh("sign-off-distributors");
    const file = path.join(dir, "partstyle-project.yaml");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace("[lcsc, digikey, mouser]", "[mouser, lcsc]"));
    const labels = async () => (await w.viewerModel()).parts.R2?.links.map((l) => l.label);
    expect(await labels()).toEqual(["Mouser", "LCSC"]);
    await writeFile(file, text.replace("[lcsc, digikey, mouser]", "[]"));
    expect(await labels()).toEqual([]);
  });

  it("reports what it can't select", async () => {
    const { w } = await fresh("sign-off-bad");
    expect((await w.approve("R9", { by: "ai" })).text).toBe("no part 'R9'");
    expect((await w.approve("where fn = xtal", { by: "ai" })).text).toBe("no matching parts");
    expect((await w.approve("where colour = red", { by: "ai" })).ok).toBe(false);
  });
});

describe("notes", () => {
  const fresh = async (name: string) => {
    const dir = path.join(tmp, name);
    const w = new Workspace(dir, { stateDir });
    await w.init();
    return { w, dir };
  };

  it("starts with no notes, and creates the design record with its first entry", async () => {
    const { w, dir } = await fresh("record");
    expect(await readdir(dir)).not.toContain("notes");
    expect((await w.recordChange("Use an LDO:\n  quieter than a buck")).text).toMatch(
      /^added to notes\/design-record\.md: - \d{4}-\d\d-\d\d \d\d:\d\d: Use an LDO: quieter than a buck$/,
    );
    await w.recordChange("Second");
    const text = (await w.readDoc("notes/design-record.md")).text;
    expect(text).toMatch(
      /^# Design record\n\n[^\n]*Append-only[^\n]*\n\n- \S+ \S+: Use an LDO: quieter than a buck\n- \S+ \S+: Second\n$/,
    );
    const refused = await w.writeDoc("notes/design-record.md", "gone");
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("record_change");
    expect(await readFile(path.join(dir, "notes/design-record.md"), "utf8")).toBe(text);
    expect((await w.recordChange("  ")).ok).toBe(false);
  });

  it("points a long description at the design notes", async () => {
    const { w } = await fresh("description");
    const note = "note: keep description short; the design overview goes in notes/design.md";
    const short = await w.writeDoc(
      "partstyle-project.yaml",
      "name: x\ndescription: A sensor board",
    );
    expect(short.text).not.toContain(note);
    const two = "name: x\ndescription: |\n  First paragraph.\n\n  Second paragraph.\n";
    expect((await w.writeDoc("partstyle-project.yaml", two)).text).toContain(note);
    const long = `name: x\ndescription: ${"word ".repeat(50)}\n`;
    expect((await w.writeDoc("partstyle-project.yaml", long)).text).toContain(note);
  });

  it("shows notes in the overview, flagging an unwritten design overview", async () => {
    const { w } = await fresh("overview-notes");
    expect((await w.overview()).text).toContain(
      "notes: design.md (not written yet), design-record.md (0)\n",
    );
    await w.writeDoc("notes/design.md", "# Design\n\nA board.\n");
    await w.recordChange("One");
    await w.writeDoc("notes/review.md", "- [note] x");
    expect((await w.overview()).text).toContain(
      "notes: design.md, design-record.md (1), review.md\n",
    );
  });

  it("keeps checkpoints out of the overview", async () => {
    const { w } = await fresh("quiet");
    const text = (await w.overview()).text;
    expect(text).toContain("changes: none");
    expect(text.toLowerCase()).not.toContain("checkpoint");
  });
});

it("the grammar's example block validates clean against the seed library", async () => {
  const grammar = (await readGuide("ckt")).text;
  const block = /```\n(block power[\s\S]*?)```/.exec(grammar)?.[1] as string;
  const dir = path.join(tmp, "template-check");
  const fresh = new Workspace(dir, { stateDir });
  await fresh.init();
  await writeFile(path.join(dir, "circuit/power.ckt"), block);
  await writeFile(
    path.join(dir, "circuit/main.ckt"),
    "block main\nuse power as PWR\nnet +3V3 : PWR.+3V3\nnet GND : PWR.GND\n",
  );
  expect((await fresh.validate()).text).toBe("template-check: 0 errors, 0 warnings");
});

it("keeps the example project's CLAUDE.md and slash commands in sync with the init template", async () => {
  expect(await readFile(repo("examples/bench-sensor/CLAUDE.md"), "utf8")).toBe(
    projectClaudeMd("bench-sensor"),
  );
  for (const c of slashCommands()) {
    expect(await readFile(repo(`examples/bench-sensor/${c.file}`), "utf8")).toBe(c.text);
  }
});
