import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { findPrompt } from "@partstyle/engine";
import { Projects, readGuide, Workspace } from "@partstyle/engine/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./server.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const example = repo("examples/bench-sensor");
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
      "add_decision",
      "apply",
      "approve",
      "bom_export",
      "diff",
      "focus",
      "guide",
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
    // Tool definitions are paid on every turn; keep them short. (guide, read_doc and
    // write_doc serve clients without file tools, such as Claude Desktop; the `variant`
    // parameters let one call work on any version of the design.)
    expect(JSON.stringify(tools).length / 4).toBeLessThan(2325);
  });

  it("sends the workflow as instructions", () => {
    const text = client.getInstructions() ?? "";
    expect(text).toContain("Start each turn with diff");
    expect(text).toContain("add_decision");
    expect(text).not.toContain("open_project");
    expect(text.toLowerCase()).not.toContain("checkpoint");
    expect(text.length / 4).toBeLessThan(600);
  });

  it("reads and writes the project file and notes", async () => {
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
      expect(await text("read_doc", { file: "partstyle-project.yaml" })).toMatch(
        /^(#.*\n)+partstyle_version: "[^"]+"\nname: "docs"\ndescription: TODO/,
      );
      expect(await text("write_doc", { file: "notes/power.md", text: "# Power\n" })).toBe(
        "wrote notes/power.md (1 line)",
      );
      expect(await text("read_doc", { file: "notes/nope.md" })).toBe(
        "no notes/nope.md; docs: partstyle-project.yaml, notes/decisions.md, notes/design.md, notes/firmware.md, notes/pcb.md, notes/power.md",
      );
      expect(await text("write_doc", { file: "../escape.md", text: "x" })).toMatch(
        /^docs are partstyle-project.yaml and notes\/\*.md/,
      );
      expect(
        await text("write_doc", {
          file: "partstyle-project.yaml",
          text: "name: docs\nexternal_interfaces: nope\n",
        }),
      ).toMatch(
        /^wrote partstyle-project.yaml \(2 lines\)\npartstyle-project.yaml:1:1 warning context.invalid /,
      );
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
    expect(prompts.map((p) => p.name)).toEqual(["design_review", "ingest_part", "handoff"]);
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

  it("serves references and procedures from guide, with the CLI's text", async () => {
    expect((await call("guide", {})).text).toBe((await readGuide()).text);
    for (const topic of ["ckt", "parts", "issues", "design-review", "ingest-part", "handoff"]) {
      expect((await call("guide", { topic })).text).toBe((await readGuide(topic)).text);
    }
    expect((await call("guide", { topic: "ckt" })).text).toMatch(/^# \.ckt grammar reference/);
    expect((await call("guide", { topic: "nope" })).isError).toBe(true);
  });

  it("records decisions, and catches up from the previous diff by default", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "partstyle-mcp-"));
    try {
      await cp(example, tmp, { recursive: true });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await createServer(new Workspace(tmp)).connect(serverSide);
      const local = new Client({ name: "test", version: "0" });
      await local.connect(clientSide);
      const text = async (name: string, args: Record<string, unknown>) => {
        const r = await local.callTool({ name, arguments: args });
        return ((r.content as { text: string }[])[0] as { text: string }).text;
      };
      expect(await text("add_decision", { text: "Keep the LDO" })).toMatch(/: Keep the LDO$/);
      expect(await text("write_doc", { file: "notes/decisions.md", text: "x" })).toContain(
        "append-only",
      );
      await text("diff", {});
      expect(await text("diff", {})).toMatch(/^no circuit changes since/);
      await local.close();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("MCP server for many projects", () => {
  let tmp: string;
  let projects: Projects;
  let opened: string[];

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "partstyle-global-"));
    projects = new Projects(path.join(tmp, "designs"), path.join(tmp, "state"));
    // As `partstyle mcp` does on start.
    await projects.ensureLibrary();
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function connect(roots: string[] = [], home = projects) {
    opened = [];
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer(undefined, {
      projects: home,
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

  it("uses the shared library for parts before any project is open", async () => {
    const shelf = new Projects(path.join(tmp, "shelf"), path.join(tmp, "shelf-state"));
    await shelf.ensureLibrary();
    // The user's own libraries come after the shared one, which is where new records go.
    await writeFile(
      path.join(tmp, "shelf-state", "settings.yaml"),
      `libraries: [${JSON.stringify(path.join(tmp, "mine"))}]\n`,
    );
    const { text } = await connect([], shelf);
    expect(await text("part_search", { q: "regulator" })).toEqual({
      text: `no part records in the libraries yet (unzip partstyle-library.zip in ${shelf.dir}, or add records with part_put)`,
      isError: false,
    });
    await cp(repo("library"), shelf.libraryDir, { recursive: true });
    expect((await text("part_search", { q: "7805" })).text).toMatch(/^L7805CV: STMicro/);
    const record = await text("part_get", { id: "L7805CV", tier: "full" });
    expect(record.text).toMatch(/^# library\/L7805CV\.yaml\n/);
    expect((await text("part_get", { id: "nope" })).isError).toBe(true);

    // New records go to the shared library too; there are no project parts/ yet.
    const yaml = (await readFile(repo("library/1N5819.yaml"), "utf8")).replace(
      "id: 1N5819",
      "id: TEST-D1",
    );
    const put = await text("part_put", { record: yaml });
    expect(put.text).toMatch(/^created library\/TEST-D1\.yaml \(lib:TEST-D1\)\n/);
    expect(put.text).toContain("unverified until a human checks it");
    expect(await readFile(path.join(shelf.libraryDir, "TEST-D1.yaml"), "utf8")).toBe(yaml);
    expect((await text("part_put", { record: yaml })).text).toMatch(/^updated library\/TEST-D1/);
    expect((await text("part_search", { q: "TEST-D1" })).text).toMatch(/^TEST-D1: onsemi/);
    expect((await text("part_put", { record: "id: x" })).isError).toBe(true);
    expect((await text("part_put", { record: yaml, scope: "project" })).text).toMatch(
      /^no project open, so no project parts\/ to write to/,
    );
  });

  it("needs a project opened first, and says how", async () => {
    const { c, text } = await connect();
    expect(c.getInstructions()).toContain("open_project NAME");
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["list_projects", "open_project"]),
    );
    expect(JSON.stringify(tools).length / 4).toBeLessThan(2560);
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
      `\nopened psu (${root})\nviewer: http://127.0.0.1:7766/?project=psu\n\nproject psu\n`,
    );
    expect(opened).toEqual([root]);
    expect(await readFile(path.join(root, "partstyle-project.yaml"), "utf8")).toContain(
      'name: "psu"',
    );
    expect((await text("validate")).text).toBe("psu: 0 errors, 0 warnings");
    // Records written from the project go to the shared library listed in the settings.
    const yaml = (await readFile(repo("library/1N5819.yaml"), "utf8")).replace(
      "id: 1N5819",
      "id: TEST-D2",
    );
    expect((await text("part_put", { record: yaml })).text).toMatch(
      /^created \.\.\/library\/TEST-D2\.yaml/,
    );
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
    expect(await readdir(path.join(tmp, "designs", "library"))).toEqual(["TEST-D2.yaml"]);
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
    expect((await text("overview")).text).toMatch(/^project amp\n/);
  });
});
