import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Workspace } from "@partstyle/engine/node";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./server.js";

const example = fileURLToPath(new URL("../../../examples/bench-sensor", import.meta.url));
const ws = new Workspace(example);

let client: Client;
beforeAll(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(ws).connect(serverSide);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as { type: string; text: string }[];
  return { text: content.map((c) => c.text).join(""), isError: r.isError === true };
}

describe("MCP server", () => {
  it("exposes a small tool surface", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "apply",
      "bom_export",
      "checkpoint",
      "diff",
      "focus",
      "init_project",
      "kicad_export",
      "kicad_import",
      "overview",
      "part_get",
      "part_put",
      "part_search",
      "query",
      "read_block",
      "validate",
      "variant",
    ]);
    // Tool definitions are paid on every turn; keep them short (DESIGN.md plans ~16 tools).
    expect(JSON.stringify(tools).length / 4).toBeLessThan(1750);
  });

  it("returns exactly what the CLI's workspace returns", async () => {
    expect((await call("overview")).text).toBe((await ws.overview()).text);
    expect((await call("validate")).text).toBe((await ws.validate()).text);
    expect((await call("read_block", { block: "power", detail: "summary" })).text).toBe(
      (await ws.readBlock("power", "summary")).text,
    );
    expect((await call("query", { expr: "part U1" })).text).toBe((await ws.query("part U1")).text);
    expect((await call("part_get", { id: "L7805CV", tier: "pins" })).text).toBe(
      (await ws.partGet("L7805CV", "pins")).text,
    );
  });

  it("flags failures as tool errors", async () => {
    expect(await call("query", { expr: "part U99" })).toEqual({
      text: "no part 'U99'",
      isError: true,
    });
    const dry = await call("apply", { patch: "in power\n- part D2", dry_run: true });
    expect(dry.isError).toBe(false);
    expect(dry.text).toMatch(/^dry run/);
  });

  it("creates a project in the server's folder", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "partstyle-mcp-"));
    try {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await createServer(new Workspace(tmp)).connect(serverSide);
      const c = new Client({ name: "test", version: "0" });
      await c.connect(clientSide);
      const missing = await c.callTool({ name: "overview", arguments: {} });
      expect(missing.isError).toBe(true);
      const r = await c.callTool({ name: "init_project", arguments: { name: "chat-board" } });
      expect((r.content as { text: string }[])[0]?.text).toMatch(/^created project chat-board/);
      const v = await c.callTool({ name: "validate", arguments: {} });
      expect((v.content as { text: string }[])[0]?.text).toBe("chat-board: 0 errors, 0 warnings");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("serves the grammar reference as a resource", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(["partstyle://grammar"]);
    const r = await client.readResource({ uri: "partstyle://grammar" });
    expect((r.contents[0] as { text: string }).text).toMatch(/^# \.ckt grammar reference/);
  });
});
