import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { run } from "./cli.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const example = repo("examples/bench-sensor");
const broken = repo("packages/engine/test-fixtures/broken");

const io = (stdin = "") => ({ readStdin: async () => stdin });
const cli = (args: string[], stdin?: string) => run(args, io(stdin));

describe("partstyle validate", () => {
  it("prints a summary and exits 0 for a clean design", async () => {
    expect(await cli(["validate", example])).toEqual({
      stdout: "bench-sensor: 0 errors, 0 warnings",
      exitCode: 0,
    });
    expect((await cli(["-p", example, "validate"])).exitCode).toBe(0);
  });

  it("prints file:line:col issues and exits 1 on errors", async () => {
    const r = await cli(["validate", broken]);
    expect(r.exitCode).toBe(1);
    const lines = r.stdout.split("\n");
    expect(lines).toContain(
      "circuit/main.ckt:14:1 error erc.output-conflict +5V: U1.OUT, U2.OUT all drive this net",
    );
    expect(lines.at(-1)).toMatch(/^broken: \d+ errors, \d+ warnings$/);
  });

  it("emits JSON with --json", async () => {
    const r = await cli(["validate", broken, "--json"]);
    const out = JSON.parse(r.stdout);
    expect(out.errors).toBeGreaterThan(0);
    expect(out.issues[0]).toMatchObject({
      code: expect.any(String),
      location: { file: "circuit/main.ckt" },
    });
  });

  it("exits 2 when the directory is not a project", async () => {
    const r = await cli(["validate", repo("library")]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/no partstyle-project\.yaml/);
  });
});

describe("partstyle read commands", () => {
  const inExample = (args: string[]) => cli(["-p", example, ...args]);

  it("overview", async () => {
    const r = await inExample(["overview"]);
    expect(r.stdout).toMatch(/^project bench-sensor\ncontext: Bench interface that reads/);
  });

  it("read-block", async () => {
    expect((await inExample(["read-block", "main"])).stdout).toMatch(/^# circuit\/main\.ckt\n/);
    expect((await inExample(["read-block", "main", "--detail", "summary"])).stdout).toMatch(
      /^block main /,
    );
    expect((await inExample(["read-block", "nope"])).exitCode).toBe(1);
    expect((await inExample(["read-block", "main", "--detail", "huge"])).exitCode).toBe(2);
  });

  it("query joins its arguments", async () => {
    expect((await inExample(["query", "parts", "where", "vin_max", "<", "15V"])).stdout).toBe(
      "1 part\nPWR/U2  lib:MCP1700-3302  vin_max=6V",
    );
    expect((await inExample(["query", "help"])).stdout).toMatch(/^queries:/);
  });

  it("part search and get", async () => {
    expect((await inExample(["part", "search", "op-amp"])).stdout).toMatch(/^MCP6002: /);
    expect((await inExample(["part", "get", "L7805CV", "--tier", "pins"])).stdout).toContain(
      "  3 OUT power_out",
    );
    expect((await inExample(["part", "get", "L7805CV", "--tier", "all"])).exitCode).toBe(2);
  });

  it("apply reads the patch from stdin", async () => {
    const r = await cli(["-p", example, "apply", "--dry-run"], "in power\n- part D2");
    expect(r.stdout).toMatch(/^dry run, would apply 1 edit to circuit\/power\.ckt/);
    const bad = await cli(["-p", example, "apply"], "in power\n- part D99");
    expect(bad).toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/no part D99/) });
  });

  it("reports a patch, document or part file it cannot read", async () => {
    const missing = path.join(example, "no-such.patch");
    expect(await inExample(["apply", missing])).toEqual({
      stdout: "",
      stderr: `cannot read ${missing}: no such file`,
      exitCode: 2,
    });
    expect((await inExample(["apply", example])).stderr).toBe(
      `cannot read ${example}: it is a folder`,
    );
    expect((await inExample(["doc", "write", "notes/x.md", missing])).exitCode).toBe(2);
    expect((await inExample(["part", "put", missing])).exitCode).toBe(2);
  });
});

describe("partstyle init", () => {
  it("creates a project that validates and uses the libraries in the settings", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "partstyle-cli-"));
    try {
      const dir = path.join(tmp, "board");
      const r = await cli(["init", dir, "--name", "My Board"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/^created project My Board in /);
      expect(await readFile(path.join(dir, "partstyle-project.yaml"), "utf8")).toContain(
        'name: "My Board"',
      );
      expect((await cli(["-p", dir, "part", "search", "7805"])).stdout).toMatch(/^L7805CV: /);
      expect(await cli(["validate", dir])).toEqual({
        stdout: "My Board: 0 errors, 0 warnings",
        exitCode: 0,
      });
      expect((await cli(["-p", dir, "init"])).exitCode).toBe(1);

      // (Projects opened recently elsewhere may follow, from this user's MCP sessions.)
      expect((await cli(["projects", "--dir", tmp])).stdout).toMatch(
        new RegExp(`^projects in ${tmp.replace(/[\\.]/g, "\\$&")}:\n {2}board(\n|$)`),
      );
      expect(await cli(["-p", dir, "doc", "write", "notes/power.md"], "# Power")).toEqual({
        stdout: "wrote notes/power.md (1 line)",
        exitCode: 0,
      });
      expect((await cli(["-p", dir, "doc", "read", "notes/power.md"])).stdout).toBe("# Power\n");
      expect((await cli(["-p", dir, "doc", "read", "partstyle-project.yaml"])).exitCode).toBe(0);
      expect((await cli(["-p", dir, "doc", "read", "CLAUDE.md"])).exitCode).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("partstyle view and focus", () => {
  it("serves the viewer until closed, and focus reports its URL", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "partstyle-cli-view-"));
    try {
      const dir = path.join(tmp, "board");
      await cli(["init", dir, "--name", "board"]);
      const r = await cli(["-p", dir, "view", "--port", "0"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/^viewer for .* at http:\/\/127\.0\.0\.1:\d+\/ \(Ctrl-C to stop\)$/);
      const focus = await cli(["-p", dir, "focus"]);
      expect(focus.stdout).toMatch(
        /^nothing selected in the viewer\nno open comments\nviewer: http/,
      );
      await r.close?.();
      expect((await cli(["-p", dir, "focus"])).stdout).not.toContain("viewer:");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a bad port and a folder that is not a project", async () => {
    expect((await cli(["view", "--port", "x"])).exitCode).toBe(2);
    expect((await cli(["-p", repo("library"), "view"])).exitCode).toBe(1);
  });
});

describe("partstyle", () => {
  it("prints its version, from package.json", async () => {
    const { version } = JSON.parse(await readFile(repo("packages/mcp/package.json"), "utf8"));
    expect(await cli(["--version"])).toEqual({ stdout: `partstyle ${version}`, exitCode: 0 });
  });

  it("has one semantic version across the packages (as releases check against the tag)", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      repo("scripts/check-version.mjs"),
    ]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints references and procedures from guide", async () => {
    expect((await cli(["guide"])).stdout.split("\n").map((l) => l.split(":")[0])).toEqual([
      "ckt",
      "parts",
      "issues",
      "design-review",
      "ingest-part",
      "handoff",
    ]);
    expect((await cli(["guide", "ckt"])).stdout).toMatch(/^# \.ckt grammar reference/);
    expect((await cli(["guide", "parts"])).stdout).toMatch(/^# Part record format/);
    expect((await cli(["guide", "issues"])).stdout).toMatch(/^# Issue codes/);
    expect((await cli(["guide", "handoff"])).stdout).toContain("notes/firmware.md");
    const unknown = await cli(["guide", "nope"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stdout).toMatch(/^no guide topic 'nope'; topics:\nckt: /);
  });

  it("rejects unknown commands and options with usage", async () => {
    expect((await cli(["frob"])).exitCode).toBe(2);
    expect((await cli(["validate", "--bogus"])).stderr).toMatch(/usage: partstyle/);
    expect((await cli([])).exitCode).toBe(2);
    expect((await cli(["--help"])).exitCode).toBe(0);
  });
});

describe("partstyle review commands", () => {
  it("check their arguments", async () => {
    for (const args of [
      ["revert"],
      ["checkpoint"],
      ["pending", "keep", "P1"],
      ["variant", "rename", "x"],
      ["variant", "create"],
      ["diff", "extra"],
    ]) {
      expect((await cli(["-p", example, ...args])).stderr).toMatch(/^usage: /);
    }
    expect((await cli(["-p", example, "revert", "nonsense"])).stderr).toMatch(/^usage: revert C3/);
  });

  it("diff and changes work without git, from the start of the change log", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "partstyle-cli-"));
    try {
      const dir = path.join(tmp, "board");
      await cli(["init", dir]);
      await rm(path.join(dir, ".git"), { recursive: true, force: true });
      expect((await cli(["-p", dir, "diff"])).stdout).toMatch(
        /^no circuit changes since the start of the change log/,
      );
      expect((await cli(["-p", dir, "changes"])).stdout).toContain("no changesets");
      expect((await cli(["-p", dir, "checkpoint", "x"])).stderr).toMatch(
        /^not in a git repository/,
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
