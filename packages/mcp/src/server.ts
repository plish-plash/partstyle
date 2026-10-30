import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queryUsage, type TextResult } from "@partstyle/engine";
import { readGrammarReference, type Workspace } from "@partstyle/engine/node";
import { z } from "zod";

const reply = (r: TextResult) => ({
  content: [{ type: "text" as const, text: r.text }],
  ...(!r.ok && { isError: true }),
});

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

/**
 * MCP tools over one project. Each tool is a thin wrapper on a Workspace method, the same one
 * the CLI calls, so results are identical across chat and terminal.
 */
export function createServer(ws: Workspace, version = "0.0.0"): McpServer {
  const server = new McpServer({ name: "partstyle", version });

  server.registerResource(
    "grammar",
    "partstyle://grammar",
    {
      title: ".ckt grammar and patch reference",
      description: "Read before writing .ckt text or apply patches",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: await readGrammarReference() }],
    }),
  );

  server.registerTool(
    "init_project",
    {
      description:
        "Create a new project skeleton (project.toml, context.md, circuit/main.ckt, notes/, CLAUDE.md) in this server's project folder. Fails if a project exists.",
      inputSchema: {
        name: z.string().optional().describe("Defaults to the folder name"),
        library_paths: z
          .array(z.string())
          .optional()
          .describe("Global part-library folders, absolute or relative to the project"),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ name, library_paths }) =>
      reply(
        await ws.init({
          ...(name !== undefined && { name }),
          ...(library_paths !== undefined && { libraryPaths: library_paths }),
        }),
      ),
  );

  server.registerTool(
    "overview",
    {
      description:
        "Start here. Project summary: blocks with part counts and ports, environment context, issue counts and the first issues.",
      annotations: readOnly,
    },
    async () => reply(await ws.overview()),
  );

  server.registerTool(
    "read_block",
    {
      description:
        "A block's .ckt source (detail=full, default), or only its ports, parts and net names (detail=summary).",
      inputSchema: {
        block: z.string().describe("Block name, e.g. power"),
        detail: z.enum(["summary", "full"]).optional(),
      },
      annotations: readOnly,
    },
    async ({ block, detail }) => reply(await ws.readBlock(block, detail ?? "full")),
  );

  server.registerTool(
    "query",
    {
      description:
        "Targeted lookup on the flattened netlist: 'part U3', 'net +5V', 'parts where vin_max < 15V', 'nets where pins = 1', 'unconnected'. Send 'help' for syntax.",
      inputSchema: { expr: z.string() },
      annotations: readOnly,
    },
    async ({ expr }) =>
      reply(expr.trim() === "help" ? { ok: true, text: queryUsage } : await ws.query(expr)),
  );

  server.registerTool(
    "apply",
    {
      description:
        "Apply a batched edit in the .ckt patch language (see resource partstyle://grammar): 'in BLOCK', '+ STATEMENT', '= STATEMENT', '- part REF', 'net NAME += REF.PIN', 'rename part OLD NEW'. Atomic. Returns the edits plus only the issues they added or resolved.",
      inputSchema: {
        patch: z.string(),
        dry_run: z.boolean().optional().describe("Report the effect without writing files"),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ patch, dry_run }) => reply(await ws.apply(patch, { dryRun: dry_run ?? false })),
  );

  server.registerTool(
    "validate",
    {
      description:
        "Run all checks; lists each unwaived issue as file:line:col severity code message.",
      annotations: readOnly,
    },
    async () => reply(await ws.validate()),
  );

  server.registerTool(
    "part_search",
    {
      description: "Search the part library by id, MPN, manufacturer, summary or package words.",
      inputSchema: { q: z.string() },
      annotations: readOnly,
    },
    async ({ q }) => reply(await ws.partSearch(q)),
  );

  server.registerTool(
    "part_get",
    {
      description:
        "Read a part record. tier=summary (default): identity and ratings; pins: plus pin table, requirements and notes; full: the YAML.",
      inputSchema: { id: z.string(), tier: z.enum(["summary", "pins", "full"]).optional() },
      annotations: readOnly,
    },
    async ({ id, tier }) => reply(await ws.partGet(id, tier ?? "summary")),
  );

  server.registerTool(
    "part_put",
    {
      description:
        "Create or update a part record (YAML, validated against the schema; run 'partstyle schema part' for it). Leave provenance.verified_by null: only a human verifies.",
      inputSchema: {
        record: z.string().describe("The full YAML record"),
        scope: z
          .enum(["global", "project"])
          .optional()
          .describe("global library (default when configured) or this project's parts/"),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ record, scope }) => reply(await ws.partPut(record, scope)),
  );

  return server;
}
