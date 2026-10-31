import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findKicad } from "./kicad.js";
import { projectClaudeMd } from "./skeleton.js";
import { Workspace } from "./workspace.js";

// Tests that need KiCad installed are skipped without it.
const kicad = await findKicad(process.cwd(), {});

const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));

// A copy of the example and library, so apply and part_put can write.
let tmp: string;
let ws: Workspace;
let project: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "partstyle-"));
  project = path.join(tmp, "examples/bench-sensor");
  await cp(repo("examples/bench-sensor"), project, { recursive: true });
  await cp(repo("library"), path.join(tmp, "library"), { recursive: true });
  ws = new Workspace(project);
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
        "now: 0 errors, 1 warning (17 waived)",
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
  expect(await new Workspace(tmp).overview()).toEqual({
    ok: false,
    text: `no project.toml in ${tmp} (create a project with: partstyle init)`,
  });
});

describe("Workspace.init", () => {
  it("creates a skeleton that validates clean", async () => {
    const dir = path.join(tmp, "new-board");
    const fresh = new Workspace(dir);
    const r = await fresh.init({ libraryPaths: [path.join(tmp, "library")] });
    expect(r.text.split("\n")).toEqual([
      `created project new-board in ${dir}`,
      "  project.toml",
      "  context.md",
      "  circuit/main.ckt",
      "  notes/decisions.md",
      "  notes/pcb.md",
      "  CLAUDE.md",
      "  .gitignore",
      "initialized a git repository for checkpoints",
      "next: fill in context.md with the user, then add blocks (partstyle grammar shows how)",
    ]);
    expect(await readFile(path.join(dir, "project.toml"), "utf8")).toContain(
      'paths = ["../library"]',
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
    expect(await ws.init()).toEqual({ ok: false, text: `${project} already has a project.toml` });
  });

  it("keeps existing files and writes the AI instructions alongside CLAUDE.md", async () => {
    const dir = path.join(tmp, "existing");
    await mkdir(dir);
    await writeFile(path.join(dir, "CLAUDE.md"), "# mine\n");
    const r = await new Workspace(dir).init({ name: "x" });
    expect(r.text).toContain("  CLAUDE.partstyle.md");
    expect(r.text).toContain("kept existing CLAUDE.md");
    expect(r.text).toContain("add the line '@CLAUDE.partstyle.md' to CLAUDE.md");
    expect(r.text).toContain("note: no global part library; part_put will write to parts/");
    expect(await readFile(path.join(dir, "CLAUDE.md"), "utf8")).toBe("# mine\n");
    expect(await readFile(path.join(dir, "CLAUDE.partstyle.md"), "utf8")).toMatch(
      /^# Circuit project: x\n/,
    );
  });

  it("stores a far-away library path as absolute", async () => {
    const dir = path.join(tmp, "a/b/c/d");
    await new Workspace(dir).init({ libraryPaths: [path.join(tmp, "library")] });
    const toml = await readFile(path.join(dir, "project.toml"), "utf8");
    expect(toml).toContain(
      `paths = [${JSON.stringify(path.join(tmp, "library").split(path.sep).join("/"))}]`,
    );
  });

  it("notes library paths that do not exist", async () => {
    const r = await new Workspace(path.join(tmp, "b")).init({ libraryPaths: ["../nowhere"] });
    expect(r.text).toContain("note: library path ../nowhere does not exist yet");
  });
});

it("the CLAUDE.md template's example block validates clean against the seed library", async () => {
  const block = /```\n(block power[\s\S]*?)```/.exec(projectClaudeMd("x"))?.[1] as string;
  const dir = path.join(tmp, "template-check");
  const fresh = new Workspace(dir);
  await fresh.init({ libraryPaths: [path.join(tmp, "library")] });
  await writeFile(path.join(dir, "circuit/power.ckt"), block);
  await writeFile(
    path.join(dir, "circuit/main.ckt"),
    "block main\nuse power as PWR\nnet +5V : PWR.+5V\nnet GND : PWR.GND\n",
  );
  expect((await fresh.validate()).text).toBe("template-check: 0 errors, 0 warnings");
});

it("keeps the example project's CLAUDE.md in sync with the init template", async () => {
  expect(await readFile(repo("examples/bench-sensor/CLAUDE.md"), "utf8")).toBe(
    projectClaudeMd("bench-sensor"),
  );
});
