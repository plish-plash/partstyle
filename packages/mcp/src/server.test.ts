import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { findPrompt } from "@partstyle/engine";
import { Projects, readGrammarReference, Workspace } from "@partstyle/engine/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
      "grammar",
      "init_project",
      "kicad_export",
      "kicad_import",
      "overview",
      "part_get",
      "part_put",
      "part_search",
      "query",
      "read_block",
      "read_doc",
      "validate",
      "variant",
      "write_doc",
    ]);
    // Tool definitions are paid on every turn; keep them short. (grammar, read_doc and
    // write_doc serve clients without file tools, such as Claude Desktop.)
    expect(JSON.stringify(tools).length / 4).toBeLessThan(2100);
  });

  it("sends the workflow as instructions", () => {
    const text = client.getInstructions() ?? "";
    expect(text).toContain("diff since=last");
    expect(text).not.toContain("open_project");
    expect(text.length / 4).toBeLessThan(1000);
  });

  it("reads and writes context.md and notes", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "partstyle-mcp-"));
    try {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const w = new Workspace(tmp);
      await w.init({ name: "docs" });
      await createServer(w).connect(serverSide);
      const c = new Client({ name: "test", version: "0" });
      await c.connect(clientSide);
      const text = async (name: string, args: Record<string, unknown>) =>
        ((await c.callTool({ name, arguments: args })).content as { text: string }[])[0]?.text;
      expect(await text("read_doc", { file: "context.md" })).toMatch(/^---\nuse_case: TODO/);
      expect(await text("write_doc", { file: "notes/power.md", text: "# Power\n" })).toBe(
        "wrote notes/power.md (1 line)",
      );
      expect(await text("read_doc", { file: "notes/nope.md" })).toBe(
        "no notes/nope.md; docs: context.md, notes/decisions.md, notes/pcb.md, notes/power.md",
      );
      expect(await text("write_doc", { file: "../escape.md", text: "x" })).toMatch(
        /^docs are context.md and notes\/\*.md/,
      );
      expect(
        await text("write_doc", { file: "context.md", text: "---\nnot: [valid\n---\n" }),
      ).toMatch(/^wrote context.md \(3 lines\)\ncontext.md:1:1 warning context.invalid /);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
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

  it("serves the procedures as prompts, with the CLI's text", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["design_review", "ingest_part", "prepare_handoff"]);
    const r = await client.getPrompt({ name: "ingest_part", arguments: { part: "TPS7A02" } });
    const text = (r.messages[0]?.content as { text: string } | undefined)?.text;
    expect(text).toBe(findPrompt("ingest-part")?.render({ part: "TPS7A02" }));
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

  it("serves the grammar reference as a resource and a tool", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(["partstyle://grammar"]);
    const r = await client.readResource({ uri: "partstyle://grammar" });
    expect((r.contents[0] as { text: string }).text).toMatch(/^# \.ckt grammar reference/);
    expect((await call("grammar")).text).toBe(await readGrammarReference());
  });
});

describe("MCP server for many projects", () => {
  let tmp: string;
  let projects: Projects;
  let opened: string[];

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "partstyle-global-"));
    projects = new Projects(path.join(tmp, "designs"), path.join(tmp, "state"));
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function connect(roots: string[] = []) {
    opened = [];
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer(undefined, {
      projects,
      onOpen: async (w) => {
        opened.push(w.root);
        return "http://127.0.0.1:7766/";
      },
    }).connect(serverSide);
    const c = new Client({ name: "test", version: "0" }, { capabilities: { roots: {} } });
    c.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: roots.map((r) => ({ uri: pathToFileURL(r).href })),
    }));
    await c.connect(clientSide);
    const text = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await c.callTool({ name, arguments: args });
      return {
        text: (r.content as { text: string }[])[0]?.text ?? "",
        isError: r.isError === true,
      };
    };
    return { c, text };
  }

  it("needs a project opened first, and says how", async () => {
    const { c, text } = await connect();
    expect(c.getInstructions()).toContain("open_project NAME");
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["list_projects", "open_project"]),
    );
    expect(JSON.stringify(tools).length / 4).toBeLessThan(2300);
    expect(await text("overview")).toEqual({
      text: "no project open: list_projects shows them; open_project NAME opens one, init_project NAME creates one",
      isError: true,
    });
    expect((await text("list_projects")).text).toBe(
      `no projects in ${path.join(tmp, "designs")} yet`,
    );
  });

  it("creates projects in its folder, with the shared library, and opens them", async () => {
    const { text } = await connect();
    const r = await text("init_project", { name: "psu" });
    const root = path.join(tmp, "designs", "psu");
    expect(r.text).toMatch(/^created project psu in /);
    expect(r.text).toContain(
      `\nopened psu (${root})\nviewer: http://127.0.0.1:7766/?project=psu\n\nproject psu (top: main)`,
    );
    expect(opened).toEqual([root]);
    expect(await readFile(path.join(root, "project.toml"), "utf8")).toContain(
      'paths = ["../library"]',
    );
    expect((await text("validate")).text).toBe("psu: 0 errors, 0 warnings");
    // Not in the shared library, nor inside it (nor Library where case is ignored).
    const caseless = process.platform === "win32" || process.platform === "darwin";
    for (const args of [
      { name: "library" },
      { name: "x", path: "library/x" },
      ...(caseless ? [{ name: "Library" }] : []),
    ]) {
      const refused = await text("init_project", args);
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(
        /is the shared part library .* or inside it: choose another name$/,
      );
    }
    expect(await readdir(path.join(tmp, "designs", "library"))).toEqual([]);
    await text("init_project", { name: "amp", path: path.join(tmp, "elsewhere", "amp") });
    expect((await text("list_projects")).text).toBe(
      [
        `projects in ${path.join(tmp, "designs")}:`,
        "  psu",
        "opened recently, elsewhere:",
        `  ${path.join(tmp, "elsewhere", "amp")} (open)`,
      ].join("\n"),
    );
  });

  it("opens projects by name or path, and the client's root folder by itself", async () => {
    const { text } = await connect([path.join(tmp, "designs", "psu")]);
    // The root is a project, so it is open without asking.
    expect((await text("validate")).text).toBe("psu: 0 errors, 0 warnings");
    expect((await text("open_project", { project: "nope" })).text).toMatch(/^no project at /);
    expect((await text("open_project", { project: "../elsewhere/amp" })).text).toMatch(
      /^opened amp /,
    );
    expect(opened.map((p) => path.basename(p))).toEqual(["psu", "amp"]);
    expect((await text("overview")).text).toMatch(/^project amp /);
  });
});
