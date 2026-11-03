import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { slashCommands } from "../prompts.js";
import { findKicad } from "./kicad.js";
import { rememberSharedLibrary } from "./settings.js";
import { projectClaudeMd } from "./skeleton.js";
import { partstyleVersion } from "./version.js";
import { readGrammarReference, Workspace } from "./workspace.js";

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
  await cp(repo("examples/bench-sensor"), project, { recursive: true });
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
        "  circuit/power.ckt:18:1 warning erc.unconnected-pin PWR/C13.2 (pin 2, passive) is not connected; connect it or waive it",
        "now: 0 errors, 1 warning (19 waived)",
      ].join("\n"),
    });
    expect(await read("circuit/power.ckt")).toContain("part C13 cap(47u, 25V) @ bulk\n");

    const fix = await ws.apply("in power\nnet GND += C13.2");
    expect(fix.text).toContain(
      "resolved:\n  erc.unconnected-pin PWR/C13.2 (pin 2, passive) is not connected",
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
      `mpn: ${id}`,
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
    "rejects a pin table that does not match the footprint pads",
    async () => {
      const twoPins = record("X3").replace("  3: {name: IN, type: power_in}\n", "");
      expect(await ws.partPut(twoPins)).toEqual({
        ok: false,
        text: "X3: pin table does not match Package_TO_SOT_SMD:SOT-23 (pads with no pin: 3); not written",
      });
      const missing = await ws.partPut(record("X4").replace("SMD:SOT-23", "SMD:SOT-99"));
      expect(missing.text).toContain("warning: X4: footprint Package_TO_SOT_SMD:SOT-99 is not in");
    },
  );

  it("rejects invalid records without writing", async () => {
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
    expect((await ws.validate()).text).toBe("bench-sensor: 0 errors, 0 warnings (19 waived)");
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
      "  notes/decisions.md",
      "  notes/pcb.md",
      "  CLAUDE.md",
      "  .claude/commands/design-review.md",
      "  .claude/commands/ingest-part.md",
      "  .claude/commands/prepare-handoff.md",
      "  .gitignore",
      "initialized a git repository for checkpoints",
      "next: fill in partstyle-project.yaml with the user, then add blocks (partstyle grammar shows how)",
    ]);
    expect(await readFile(path.join(dir, "partstyle-project.yaml"), "utf8")).toContain(
      `\npartstyle_version: "${partstyleVersion()}"\nname: "new-board"\n`,
    );
    expect(await fresh.validate()).toEqual({
      ok: true,
      text: "new-board: 0 errors, 0 warnings",
    });
    const overview = (await fresh.overview()).text;
    expect(overview).toContain("context: TODO one line");
    expect(overview).toContain("parts: 0 (0 library, 0 generic; 0 of 0 records unverified)");
    // The seed library is reachable from the new project.
    expect((await fresh.partSearch("L7805CV")).text).toMatch(/^L7805CV: /);
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

it("the grammar's example block validates clean against the seed library", async () => {
  const block = /```\n(block power[\s\S]*?)```/.exec(await readGrammarReference())?.[1] as string;
  const dir = path.join(tmp, "template-check");
  const fresh = new Workspace(dir, { stateDir });
  await fresh.init();
  await writeFile(path.join(dir, "circuit/power.ckt"), block);
  await writeFile(
    path.join(dir, "circuit/main.ckt"),
    "block main\nuse power as PWR\nnet +5V : PWR.+5V\nnet GND : PWR.GND\n",
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
