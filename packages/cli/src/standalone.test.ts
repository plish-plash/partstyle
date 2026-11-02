import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { Workspace } from "@partstyle/engine/node";
import { partstyleVersion } from "@partstyle/mcp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// What scripts/standalone.mjs builds: the executable for this machine and the Claude Desktop
// extension's Node bundle, each tested once built. PARTSTYLE_BINARY names one to test instead
// (CI), and then a missing file fails rather than skips.
const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const os = process.platform === "win32" ? "windows" : process.platform;
const builds = (
  process.env.PARTSTYLE_BINARY
    ? [process.env.PARTSTYLE_BINARY]
    : [
        `packages/cli/standalone/out/partstyle-${os}-${process.arch}${os === "windows" ? ".exe" : ""}`,
        "packages/cli/standalone/out/mcpb/server/index.mjs",
      ]
        .map(repo)
        .filter((f) => existsSync(f))
).map((file) => ({
  file,
  // A JavaScript bundle runs under this Node, as Claude Desktop runs it under its own.
  command: /\.m?js$/.test(file) ? process.execPath : file,
  prefix: /\.m?js$/.test(file) ? [file] : [],
}));

/** The version the builds embed: package.json's, as the source reports it. */
const stamped = partstyleVersion();

// Vitest fails a file that defines no tests, as describe.each([]) would before anything is built.
if (builds.length === 0) it.skip("standalone builds (none built: pnpm standalone, pnpm mcpb)");

describe.each(builds)("standalone build $file", ({ command, prefix }) => {
  let tmp: string;
  let project: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "partstyle-bin-"));
    // The example's library path is ../../library.
    project = path.join(tmp, "examples", "bench-sensor");
    await cp(repo("examples/bench-sensor"), project, { recursive: true });
    await cp(repo("library"), path.join(tmp, "library"), { recursive: true });
    await rm(path.join(project, ".partstyle"), { recursive: true, force: true });
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("runs CLI commands, with the grammar embedded", async () => {
    const run = (args: string[]) =>
      promisify(execFile)(command, [...prefix, ...args], { windowsHide: true });
    expect((await run(["--version"])).stdout).toBe(`partstyle ${stamped}\n`);
    expect((await run(["grammar"])).stdout).toBe(
      `${await readFile(repo("docs/ckt-grammar.md"), "utf8")}\n`,
    );
    expect((await run(["-p", project, "overview"])).stdout).toBe(
      `${(await new Workspace(project).overview()).text}\n`,
    );
  });

  it("serves MCP on stdio, with the viewer embedded", async () => {
    const transport = new StdioClientTransport({
      command,
      args: [...prefix, "mcp", "--project", project],
      stderr: "pipe",
    });
    let log = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      log += chunk.toString("utf8");
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.version).toBe(stamped);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("overview");
      const r = await client.callTool({ name: "validate" });
      expect(r.isError).toBeFalsy();
      const grammar = await client.readResource({ uri: "partstyle://grammar" });
      expect(JSON.stringify(grammar.contents)).toContain("patch");

      // The viewer starts before the MCP connection, so its URL is already logged.
      const url = /partstyle viewer: (\S+)/.exec(log)?.[1];
      expect(url).toBeDefined();
      const page = await fetch(url as string);
      expect(page.status).toBe(200);
      const script = /src="\/?([^"]+\.js)"/.exec(await page.text())?.[1];
      const asset = await fetch(new URL(script as string, url));
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("javascript");
      // The sheets lay out under Bun too.
      const model = (await (await fetch(new URL("api/model", url))).json()) as {
        issues: { code: string }[];
        sheets: unknown[];
      };
      expect(model.issues.map((i) => i.code)).not.toContain("layout.failed");
      expect(model.sheets.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("serves many projects, the viewer following the open one", async () => {
    const transport = new StdioClientTransport({
      command,
      args: [...prefix, "mcp", "--projects-dir", path.join(tmp, "examples"), "--viewer-port", "0"],
      // Keep the recently opened list out of this user's ~/.partstyle.
      env: { ...getDefaultEnvironment(), PARTSTYLE_STATE_DIR: path.join(tmp, "state") },
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]?.text ??
      "";
    const project = async (url: string) =>
      ((await (await fetch(new URL("api/model", url))).json()) as { project: string }).project;
    try {
      const created = await call("init_project", { name: "fresh" });
      const url = /^viewer: (\S+)\?project=fresh$/m.exec(created)?.[1] as string;
      expect(url).toBeDefined();
      expect(await project(url)).toBe("fresh");
      expect(await call("open_project", { project: "bench-sensor" })).toContain(
        `viewer: ${url}?project=bench-sensor`,
      );
      expect(await project(url)).toBe("bench-sensor");
      expect(await call("list_projects")).toMatch(/^ {2}bench-sensor \(open\)$/m);
    } finally {
      await client.close();
    }
  });
});
