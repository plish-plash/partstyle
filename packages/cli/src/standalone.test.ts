import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Workspace } from "@partstyle/engine/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The executable scripts/standalone.mjs builds for this machine (or PARTSTYLE_BINARY).
const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const os = process.platform === "win32" ? "windows" : process.platform;
const binary =
  process.env.PARTSTYLE_BINARY ??
  repo(
    `packages/cli/standalone/out/partstyle-${os}-${process.arch}${os === "windows" ? ".exe" : ""}`,
  );

// Skipped until built; when PARTSTYLE_BINARY is set (CI), a missing executable fails instead.
describe.skipIf(!process.env.PARTSTYLE_BINARY && !existsSync(binary))(
  "standalone executable",
  () => {
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
      const run = (args: string[]) => promisify(execFile)(binary, args, { windowsHide: true });
      expect((await run(["grammar"])).stdout).toBe(
        `${await readFile(repo("docs/ckt-grammar.md"), "utf8")}\n`,
      );
      expect((await run(["-p", project, "overview"])).stdout).toBe(
        `${(await new Workspace(project).overview()).text}\n`,
      );
    });

    it("serves MCP on stdio, with the viewer embedded", async () => {
      const transport = new StdioClientTransport({
        command: binary,
        args: ["mcp", "--project", project],
        stderr: "pipe",
      });
      let log = "";
      transport.stderr?.on("data", (chunk: Buffer) => {
        log += chunk.toString("utf8");
      });
      const client = new Client({ name: "test", version: "0" });
      await client.connect(transport);
      try {
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
        // ELK lays out the sheets under Bun too.
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
  },
);
