import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changedFiles, initRepo } from "./git.js";
import { Workspace } from "./workspace.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
/** The git CLI, only to check that what isomorphic-git writes is a repository git reads. */
const gitCli = async (cwd: string, args: string[]) =>
  (await promisify(execFile)("git", args, { cwd, windowsHide: true })).stdout;
const hasGit = await gitCli(tmpdir(), ["--version"]).then(
  () => true,
  () => false,
);

describe("versioning", () => {
  let tmp: string;
  let project: string;
  let ws: Workspace;
  const power = () => path.join(project, "circuit", "power.ckt");
  const edit = async (from: string, to: string) => {
    const text = await readFile(power(), "utf8");
    if (!text.includes(from)) throw new Error(`'${from}' not in power.ckt`);
    await writeFile(power(), text.replace(from, to), "utf8");
  };

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "partstyle-git-"));
    project = path.join(tmp, "examples", "bench-sensor");
    await cp(repo("examples/bench-sensor"), project, { recursive: true });
    await cp(repo("library"), path.join(tmp, "library"), { recursive: true });
    await rm(path.join(project, ".partstyle"), { recursive: true, force: true });
    await writeFile(path.join(project, ".gitignore"), ".partstyle/\nkicad/\n", "utf8");
    await initRepo(tmp);
    ws = new Workspace(project);
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("checkpoints the project folder only", async () => {
    const r = await ws.checkpoint("initial design");
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^checkpoint [0-9a-f]{7} "initial design"/);
    // The library beside the project is not part of it.
    expect(await changedFiles(path.join(tmp, "library"))).toContain("L7805CV.yaml");
    expect((await ws.overview()).text).toMatch(/\nchanges: none(\n|$)/);
    expect((await ws.checkpoint("again")).text).toMatch(/^nothing to checkpoint/);
  });

  it("logs direct edits and patches as changesets, and diffs them", async () => {
    await edit("part C2  cap(100n, 16V, X7R, 0603)", "part C2  cap(220n, 16V, X7R, 0603)");
    await ws.apply("in power\n+ part TP1 lib:testpoint @ probe +5V\n");
    const changes = (await ws.changes()).text;
    expect(changes).toMatch(/^C1 edit /m);
    expect(changes).toContain("C1.1 power: ~ part C2 cap(220n, 16V, X7R, 0603)");
    expect(changes).toMatch(/^C2 apply /m);
    expect(changes).toContain("C2.1 power: + part TP1 lib:testpoint @ probe +5V");

    const diff = (await ws.diff()).text;
    expect(diff).toMatch(/^since checkpoint [0-9a-f]{7} "initial design"/);
    expect(diff).toContain("  ~ part C2 cap(220n");
    expect(diff).toContain("  + part TP1 lib:testpoint @ probe +5V");
    expect((await ws.diff("last")).text).toBe("no circuit changes since the last diff");
  });

  it("merges quick successive edits into one changeset", async () => {
    await edit("part C3  cap(10u", "part C3  cap(22u");
    await ws.validate();
    await edit("part C4  cap(1u", "part C4  cap(2u2");
    await ws.validate();
    const changes = (await ws.changes()).text;
    expect(changes).toMatch(/^C3 edit /m);
    expect(changes).toContain("C3.2 power: ~ part C4");
    expect(changes).not.toMatch(/^C4 /m);
  });

  it("reverts a statement or a whole changeset, as a changeset of its own", async () => {
    const one = await ws.revert("C3.1");
    expect(one.text).toMatch(/^reverted C3.1: 1 statement \(as C4\)/);
    expect(await readFile(power(), "utf8")).toContain("cap(10u, 16V");
    expect(await readFile(power(), "utf8")).toContain("cap(2u2");

    expect((await ws.revert("C2")).ok).toBe(true);
    expect(await readFile(power(), "utf8")).not.toContain("TP1");
    // Reverting C3 again finds C3.1 already undone and says so.
    const again = await ws.revert("C3");
    expect(again.text).toContain("not reverted: power: part C3 has changed since");
    expect(await readFile(power(), "utf8")).toContain("cap(1u, 16V");
  });

  it("holds patches for approval in accept mode", async () => {
    await ws.checkpoint("tweaks");
    await ws.setReviewMode("accept");
    const held = await ws.apply("in power\n+ part R90 res(10k, 1%, 0603)\n");
    expect(held.text).toMatch(/^held as P1 for review; would apply 1 edit/);
    expect(await readFile(power(), "utf8")).not.toContain("R90");
    expect((await ws.overview()).text).toContain("pending review: P1");

    const preview = await ws.viewerModel({ preview: "P1" });
    expect(preview.preview?.changed).toEqual([
      { block: "power", kind: "part", key: "R90", op: "+" },
    ]);
    expect(preview.parts["PWR/R90"]).toBeDefined();

    expect((await ws.pendingAccept("P1")).ok).toBe(true);
    expect(await readFile(power(), "utf8")).toContain("R90");
    expect((await ws.changes()).text).toMatch(/^C1 accept .*\(accepted P1\)/m);
    await ws.apply("in power\n+ part TP3 lib:testpoint\n");
    expect((await ws.pendingReject("P2")).text).toBe("rejected P2");
    expect(await readFile(power(), "utf8")).not.toContain("TP3");
  });

  describe("variants", () => {
    const own = (v: string, f: string) => path.join(project, "variants", v, f);
    const has = (f: string) =>
      readFile(f, "utf8").then(
        () => true,
        () => false,
      );

    it("share main's blocks until they change one", async () => {
      await ws.setReviewMode("auto");
      await ws.checkpoint("with R90");
      expect((await ws.variant("create", "buck", "buck regulator")).text).toMatch(
        /^created variant buck \(variants\/buck\): the same as main/,
      );
      expect((await ws.variant("create", "main")).ok).toBe(false);
      expect((await ws.overview()).text).toContain('  buck "buck regulator": same as main');

      const buck = ws.forVariant("buck");
      const r = await ws.applyTo("in power\n+ part R91 res(1k, 1%, 0603)\n", ["buck"]);
      expect(r.text).toMatch(/^applied 1 edit to variants\/buck\/circuit\/power\.ckt/);
      expect(await readFile(power(), "utf8")).not.toContain("R91");
      expect(await readFile(own("buck", "variant.yaml"), "utf8")).toMatch(/circuit\/power\.ckt: /);

      // An edit to a block buck takes from main reaches it.
      await ws.apply("in mcu\n+ part R85 res(10k, 1%, 0603)\n");
      expect((await buck.query("part R85")).text).toMatch(/^MCU\/R85 /);
      expect((await buck.overview()).text).toMatch(/^project bench-sensor, variant buck\n/);

      // Main moving on in a block buck has its own copy of is flagged.
      await ws.apply("in power\n+ part R86 res(10k, 1%, 0603)\n");
      expect((await ws.variant("list")).text).toBe(
        'buck "buck regulator": own power; main changed power since',
      );
      const diff = (await ws.variant("diff", "buck")).text;
      expect(diff).toContain("+ part R91 res(1k, 1%, 0603)");
      expect(diff).toMatch(/- part R86\b/);
      expect(diff).toContain("main changed circuit/power.ckt since the variant copied it");
    });

    it("apply to main and variants at once, all or nothing", async () => {
      const both = await ws.applyTo("in mcu\n+ part R87 res(10k, 1%, 0603)\n", ["main", "buck"]);
      expect(both.text).toMatch(/^main:\n {2}applied 1 edit to circuit\/mcu\.ckt/);
      expect(both.text).toContain("buck:\n  takes the edited blocks from main");
      expect(await has(own("buck", "circuit/mcu.ckt"))).toBe(false);

      const power2 = "in power\n+ part R88 res(10k, 1%, 0603)\n";
      const twice = await ws.applyTo(power2, ["main", "buck"]);
      expect(twice.text).toContain("buck:\n  applied 1 edit to variants/buck/circuit/power.ckt");

      // R86 is only main's: removing it fails in buck, so main is not touched either.
      const bad = await ws.applyTo("in power\n- part R86\n", ["buck"]);
      expect(bad.ok).toBe(false);
      const split = await ws.applyTo("in power\n- part R91\n", ["main", "buck"]);
      expect(split.ok).toBe(false);
      expect(split.text).toMatch(
        /^the patch does not apply everywhere; nothing was applied\nmain:/,
      );
      expect(await readFile(own("buck", "circuit/power.ckt"), "utf8")).toContain("R91");
    });

    it("override main's project file key by key", async () => {
      const buck = ws.forVariant("buck");
      const doc = "partstyle-project.yaml";
      expect((await buck.readDoc(doc)).text).toMatch(/^# Variant buck: overrides of the main/);
      const wrote = await buck.writeDoc(doc, "environment:\n  temp_c: [-55, 50]\n");
      expect(wrote.text).toMatch(/^wrote variants\/buck\/partstyle-project\.yaml \(2 lines\)/);
      expect((await buck.validate()).text).toContain("context.temperature");
      expect((await ws.validate()).text).not.toContain("context.temperature");
      // Merged: buck keeps main's other environment keys.
      expect((await buck.overview()).text).toContain(
        '  environment: {"temp_c":[-55,50],"indoor":true}',
      );
      await buck.writeDoc(doc, "environment:\n  temp_c: [-55, 50]\n  indoor: null\n");
      expect((await buck.overview()).text).toContain('  environment: {"temp_c":[-55,50]}');
      expect((await buck.writeDoc(doc, "environment: [\n")).text).toMatch(/^not written: /);
      expect((await ws.variant("list")).text).toContain("own project file, power");
    });

    it("keep their own history, pending changes and exports", async () => {
      const buck = ws.forVariant("buck");
      await ws.setFocus({ selection: ["PWR/R91"], variant: "buck" });
      expect((await ws.focus()).text).toMatch(
        /^viewing variant buck .*\nselected in the viewer:\n {2}PWR\/R91 /,
      );

      const changes = (await buck.changes()).text;
      expect(changes).toMatch(/^C1 apply /m);
      expect((await buck.revert("C2")).ok).toBe(true);
      expect(await readFile(own("buck", "circuit/power.ckt"), "utf8")).not.toContain("R88");
      expect(await readFile(power(), "utf8")).toContain("R88");

      await ws.setReviewMode("accept");
      const held = await ws.applyTo("in power\n+ part R89 res(10k, 1%, 0603)\n", ["buck"]);
      const id = /held as (P\d+)/.exec(held.text)?.[1] as string;
      expect((await ws.versionState()).pending).toEqual([]);
      expect((await buck.versionState()).pending.map((p) => p.id)).toEqual([id]);
      expect((await ws.pendingAccept(id)).ok).toBe(true);
      expect(await readFile(own("buck", "circuit/power.ckt"), "utf8")).toContain("R89");
      expect(await readFile(power(), "utf8")).not.toContain("R89");
      await ws.setReviewMode("auto");

      expect((await buck.bomExport()).text).toMatch(/^wrote variants\/buck\/bom\.csv: /);
      expect(await has(own("buck", "bom.lock"))).toBe(true);
    });

    it("drop a block identical to main's, and adopt and remove whole", async () => {
      await ws.variant("create", "tmp");
      const tmpV = ws.forVariant("tmp");
      await ws.applyTo("in mcu\n+ part R95 res(1k)\n", ["tmp"]);
      expect(await has(own("tmp", "circuit/mcu.ckt"))).toBe(true);
      await ws.applyTo("in mcu\n- part R95\n", ["tmp"]);
      expect(await has(own("tmp", "circuit/mcu.ckt"))).toBe(false);
      expect(await readFile(own("tmp", "variant.yaml"), "utf8")).not.toContain("base");
      expect((await tmpV.validate()).text).toBe((await ws.validate()).text);

      await ws.applyTo("in mcu\n+ part R96 res(2k)\n", ["tmp"]);
      await tmpV.writeDoc("partstyle-project.yaml", "description: adopted\n");
      const adopted = await ws.variant("adopt", "tmp");
      expect(adopted.text).toMatch(
        /^adopted variant tmp as C\d+: circuit\/mcu\.ckt, partstyle-project\.yaml/,
      );
      expect(await readFile(path.join(project, "circuit/mcu.ckt"), "utf8")).toContain("R96");
      const projectFile = await readFile(path.join(project, "partstyle-project.yaml"), "utf8");
      expect(projectFile).toContain("description: adopted");
      // Main's comments survive the merge.
      expect(projectFile).toMatch(/^# A Partstyle project/);
      expect((await ws.variant("list")).text).toContain("tmp: same as main");

      expect((await ws.variant("remove", "tmp")).text).toBe("removed variant tmp");
      expect(await has(own("tmp", "variant.yaml"))).toBe(false);
      expect((await tmpV.overview()).text).toBe("no variant 'tmp' (see variant list)");

      // Variants are project files: a checkpoint commits them with main.
      await ws.checkpoint("variants");
      expect(await changedFiles(project)).toEqual([]);
    });
  });

  it.skipIf(!hasGit)("writes a repository the git CLI reads", async () => {
    expect(await gitCli(tmp, ["fsck", "--strict"])).toBe("");
    expect(await gitCli(tmp, ["log", "--format=%s"])).toBe(
      "variants\nwith R90\ntweaks\ninitial design\n",
    );
    // Checkpoints stage what they commit.
    expect(await gitCli(tmp, ["status", "--porcelain", "--", "examples"])).toBe("");
    expect(await gitCli(tmp, ["ls-tree", "--name-only", "HEAD"])).toBe("examples\n");
    expect(
      await gitCli(tmp, ["ls-tree", "--name-only", "HEAD", "examples/bench-sensor/variants/"]),
    ).toBe("examples/bench-sensor/variants/buck\n");
  });
});
