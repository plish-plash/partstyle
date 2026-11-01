import { execFile } from "node:child_process";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect((await ws.overview()).text).toMatch(
      /changes since checkpoint [0-9a-f]{7} "initial design": none/,
    );
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
    await appendFile(path.join(project, "project.toml"), '\n[review]\nmode = "accept"\n');
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

  it("creates, compares, adopts and removes variants", async () => {
    await ws.checkpoint("with R90");
    const created = await ws.variant("create", "ldo");
    expect(created.text).toMatch(
      /^created variant ldo at \.partstyle\/variants\/ldo\/examples\/bench-sensor/,
    );
    const variant = new Workspace(
      path.join(project, ".partstyle", "variants", "ldo", "examples", "bench-sensor"),
    );
    const vPower = path.join(variant.root, "circuit", "power.ckt");
    const text = await readFile(vPower, "utf8");
    expect(text).toContain("part R90 res(10k");
    await writeFile(vPower, text.replace("part R90 res(10k", "part R90 res(22k"));
    expect((await ws.variant("list")).text).toMatch(/^ldo: 1 statements differ from main/);
    expect((await ws.variant("diff", "ldo")).text).toContain("~ part R90 res(22k");

    const adopted = await ws.variant("adopt", "ldo");
    expect(adopted.text).toMatch(/^adopted variant ldo as C1: circuit\/power.ckt/);
    expect(await readFile(power(), "utf8")).toContain("res(22k");
    // The main project's checkpoint never sweeps the variant's copy in.
    expect((await changedFiles(project)).join(" ")).not.toContain("variants");

    // A checkpoint in the variant commits to its branch, not the main line.
    await writeFile(vPower, text.replace("part R90 res(10k", "part R90 res(47k"));
    expect((await variant.checkpoint("try 47k")).ok).toBe(true);
    expect((await variant.checkpoints()).text).toMatch(/^[0-9a-f]{7} \S+ \S+ try 47k\n/);
    expect((await ws.checkpoints()).text).not.toContain("try 47k");

    expect((await ws.variant("remove", "ldo")).ok).toBe(true);
    expect((await ws.variant("list")).text).toMatch(/^no variants/);
  });

  it.skipIf(!hasGit)("writes a repository the git CLI reads", async () => {
    // (The removed variant's checkpoint is left dangling, as after git branch -D.)
    expect(await gitCli(tmp, ["fsck", "--strict", "--no-dangling"])).toBe("");
    expect(await gitCli(tmp, ["log", "--format=%s"])).toBe("with R90\ntweaks\ninitial design\n");
    // Checkpoints stage what they commit; the adopted, not yet checkpointed edit shows.
    expect(await gitCli(tmp, ["status", "--porcelain", "--", "examples"])).toBe(
      " M examples/bench-sensor/circuit/power.ckt\n",
    );
    expect(await gitCli(tmp, ["ls-tree", "--name-only", "HEAD"])).toBe("examples\n");
    expect(await gitCli(tmp, ["branch", "--list", "variant/*"])).toBe("");
  });
});
