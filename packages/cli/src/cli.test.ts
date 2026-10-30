import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
      stdout: "bench-sensor: 0 errors, 0 warnings (17 waived)",
      exitCode: 0,
    });
    expect((await cli(["-p", example, "validate"])).exitCode).toBe(0);
  });

  it("prints file:line:col issues and exits 1 on errors", async () => {
    const r = await cli(["validate", broken]);
    expect(r.exitCode).toBe(1);
    const lines = r.stdout.split("\n");
    expect(lines).toContain(
      "circuit/main.ckt:13:1 error erc.output-conflict +5V: U1.OUT, U2.OUT all drive this net",
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
    expect(r.stderr).toMatch(/no project\.toml/);
  });
});

describe("partstyle read commands", () => {
  const inExample = (args: string[]) => cli(["-p", example, ...args]);

  it("overview", async () => {
    const r = await inExample(["overview"]);
    expect(r.stdout).toMatch(/^project bench-sensor \(top: main\)\n/);
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
      "1 part\nPWR/U2  lib:MCP1700T-3302E_TT  vin_max=6V",
    );
    expect((await inExample(["query", "help"])).stdout).toMatch(/^queries:/);
  });

  it("part search and get", async () => {
    expect((await inExample(["part", "search", "op-amp"])).stdout).toMatch(/^MCP6002-I_SN: /);
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
});

describe("partstyle init", () => {
  it("creates a project that validates, resolving --library against the cwd", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "partstyle-cli-"));
    try {
      const dir = path.join(tmp, "board");
      const r = await cli(["init", dir, "--name", "My Board", "--library", repo("library")]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/^created project My Board in /);
      const toml = await readFile(path.join(dir, "project.toml"), "utf8");
      expect(toml).toContain('name = "My Board"');
      // The repo's library is far from a temp dir, so it is stored absolute.
      expect(toml).toContain(`paths = ["${repo("library").split(path.sep).join("/")}"]`);
      expect(await cli(["validate", dir])).toEqual({
        stdout: "My Board: 0 errors, 0 warnings",
        exitCode: 0,
      });
      expect((await cli(["-p", dir, "init"])).exitCode).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("partstyle", () => {
  it("prints the grammar and the part-record JSON Schema", async () => {
    expect((await cli(["grammar"])).stdout).toMatch(/^# \.ckt grammar reference/);
    const r = await cli(["schema", "part"]);
    expect(JSON.parse(r.stdout).required).toContain("pins");
  });

  it("rejects unknown commands and options with usage", async () => {
    expect((await cli(["frob"])).exitCode).toBe(2);
    expect((await cli(["validate", "--bogus"])).stderr).toMatch(/usage: partstyle/);
    expect((await cli([])).exitCode).toBe(2);
    expect((await cli(["--help"])).exitCode).toBe(0);
  });
});
