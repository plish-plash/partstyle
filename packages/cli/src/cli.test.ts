import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "./cli.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const example = repo("examples/bench-sensor");
const broken = repo("packages/engine/test-fixtures/broken");

describe("partstyle validate", () => {
  it("prints a summary and exits 0 for a clean design", async () => {
    const r = await run(["validate", example]);
    expect(r).toEqual({ stdout: "bench-sensor: 0 errors, 0 warnings (17 waived)", exitCode: 0 });
  });

  it("prints file:line:col issues and exits 1 on errors", async () => {
    const r = await run(["validate", broken]);
    expect(r.exitCode).toBe(1);
    const lines = r.stdout.split("\n");
    expect(lines).toContain(
      "circuit/main.ckt:13:1 error erc.output-conflict +5V: U1.OUT, U2.OUT all drive this net",
    );
    expect(lines.at(-1)).toMatch(/^broken: \d+ errors, \d+ warnings$/);
  });

  it("emits JSON with --json", async () => {
    const r = await run(["validate", broken, "--json"]);
    const out = JSON.parse(r.stdout);
    expect(out.errors).toBeGreaterThan(0);
    expect(out.issues[0]).toMatchObject({
      code: expect.any(String),
      location: { file: "circuit/main.ckt" },
    });
  });

  it("exits 2 when the directory is not a project", async () => {
    const r = await run(["validate", repo("library")]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/no project\.toml/);
  });
});

describe("partstyle", () => {
  it("prints the part-record JSON Schema", async () => {
    const r = await run(["schema", "part"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).required).toContain("pins");
  });

  it("rejects unknown commands and options with usage", async () => {
    expect((await run(["frob"])).exitCode).toBe(2);
    expect((await run(["validate", "--bogus"])).stderr).toMatch(/usage: partstyle/);
    expect((await run([])).exitCode).toBe(2);
    expect((await run(["--help"])).exitCode).toBe(0);
  });
});
