import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpInstructions, prompts, queryUsage, type TextResult } from "@partstyle/engine";
import { type Projects, readGrammarReference, Workspace } from "@partstyle/engine/node";
import { z } from "zod";

const reply = (r: TextResult) => ({
  content: [{ type: "text" as const, text: r.text }],
  ...(!r.ok && { isError: true }),
});

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

const isProject = (dir: string) =>
  stat(path.join(dir, "project.toml")).then(
    (s) => s.isFile(),
    () => false,
  );

export interface ServerOptions {
  /**
   * Global mode: the projects this server can open by name. Without it the server works on the
   * one workspace it is given.
   */
  projects?: Projects;
  /** Called when a project opens in global mode (to show it in the viewer); returns its URL. */
  onOpen?: (ws: Workspace) => Promise<string | undefined>;
  version?: string;
}

/**
 * MCP tools over a project. Each tool is a thin wrapper on a Workspace method, the same one the
 * CLI calls, so results are identical across chat and terminal. In global mode the project is
 * chosen with open_project or init_project, or is the client's root folder when that is one.
 */
export function createServer(fixed: Workspace | undefined, opts: ServerOptions = {}): McpServer {
  const { projects } = opts;
  const server = new McpServer(
    { name: "partstyle", version: opts.version ?? "0.0.0" },
    { instructions: mcpInstructions(projects !== undefined) },
  );

  let ws = fixed;
  let triedRoots = false;

  const open = async (root: string): Promise<string | undefined> => {
    ws = new Workspace(root);
    await projects?.remember(ws.root);
    return opts.onOpen?.(ws);
  };

  /** The open project; in global mode, the client's root folder if it is a project. */
  const current = async (): Promise<Workspace | undefined> => {
    if (ws || !projects || triedRoots) return ws;
    triedRoots = true;
    if (!server.server.getClientCapabilities()?.roots) return ws;
    const { roots } = await server.server.listRoots().catch(() => ({ roots: [] }));
    for (const r of roots) {
      if (!r.uri.startsWith("file:")) continue;
      const dir = fileURLToPath(r.uri);
      if (await isProject(dir)) {
        await open(dir);
        break;
      }
    }
    return ws;
  };

  /** Runs a tool against the open project, or says how to open one. */
  const run = async (f: (w: Workspace) => Promise<TextResult>) => {
    const w = await current();
    return reply(
      w
        ? await f(w)
        : {
            ok: false,
            text: "no project open: list_projects shows them; open_project NAME opens one, init_project NAME creates one",
          },
    );
  };

  /** Opens a project and reports it: where it is, the viewer, and its overview. */
  const opened = async (root: string, before: string[] = []): Promise<TextResult> => {
    const url = await open(root);
    const w = ws as Workspace;
    const overview = await w.overview();
    const name = await w.name();
    return {
      ok: true,
      text: [
        ...before,
        `opened ${name} (${w.root})`,
        ...(url ? [`viewer: ${url}?project=${encodeURIComponent(name)}`] : []),
        "",
        overview.text,
      ].join("\n"),
    };
  };

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
    "grammar",
    {
      description:
        "The .ckt grammar and patch reference. Read it before writing .ckt text or patches.",
      annotations: readOnly,
    },
    async () => reply({ ok: true, text: await readGrammarReference() }),
  );

  if (projects) {
    server.registerTool(
      "list_projects",
      {
        description: `Projects in ${projects.dir}, and ones opened recently elsewhere.`,
        annotations: readOnly,
      },
      async () => reply(await projects.list((await current())?.root)),
    );

    server.registerTool(
      "open_project",
      {
        description:
          "Work on a project from now on: a name from list_projects, or a folder path. Returns its overview and viewer URL.",
        inputSchema: { project: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async ({ project }) => {
        const root = projects.resolve(project);
        if (!(await isProject(root))) {
          return reply({
            ok: false,
            text: `no project at ${root} (list_projects shows them; init_project creates one)`,
          });
        }
        return reply(await opened(root));
      },
    );

    server.registerTool(
      "init_project",
      {
        description: `Create a project (project.toml, context.md, circuit/, notes/) and open it. In ${projects.dir} unless path is given.`,
        inputSchema: {
          name: z.string().describe("Project and folder name"),
          path: z.string().optional().describe("Folder for it instead"),
          library_paths: z
            .array(z.string())
            .optional()
            .describe("Part-library folders (default: the shared library/)"),
        },
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ name, path: folder, library_paths }) => {
        const target = new Workspace(projects.resolve(folder ?? name));
        if (library_paths === undefined) await projects.ensureLibrary();
        const created = await target.init({
          name,
          libraryPaths: library_paths ?? [projects.libraryDir],
        });
        if (!created.ok) return reply(created);
        return reply(await opened(target.root, [created.text]));
      },
    );
  } else {
    server.registerTool(
      "init_project",
      {
        description:
          "Create a project skeleton (project.toml, context.md, circuit/, notes/, CLAUDE.md) in this server's folder. Fails if one exists.",
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
        run((w) =>
          w.init({
            ...(name !== undefined && { name }),
            ...(library_paths !== undefined && { libraryPaths: library_paths }),
          }),
        ),
    );
  }

  server.registerTool(
    "overview",
    {
      description:
        "Start here. Project summary: blocks with part counts and ports, environment context, issue counts and the first issues.",
      annotations: readOnly,
    },
    async () => run((w) => w.overview()),
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
    async ({ block, detail }) => run((w) => w.readBlock(block, detail ?? "full")),
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
      expr.trim() === "help" ? reply({ ok: true, text: queryUsage }) : run((w) => w.query(expr)),
  );

  server.registerTool(
    "apply",
    {
      description:
        "Apply a batched edit in the .ckt patch language (see grammar): 'in BLOCK', '+ STATEMENT', '= STATEMENT', '- part REF', 'net NAME += REF.PIN', 'rename part OLD NEW'. Atomic. Returns the edits plus only the issues they added or resolved.",
      inputSchema: {
        patch: z.string(),
        dry_run: z.boolean().optional().describe("Report the effect without writing files"),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ patch, dry_run }) => run((w) => w.apply(patch, { dryRun: dry_run ?? false })),
  );

  server.registerTool(
    "validate",
    {
      description:
        "Run all checks; lists each unwaived issue as file:line:col severity code message.",
      annotations: readOnly,
    },
    async () => run((w) => w.validate()),
  );

  server.registerTool(
    "read_doc",
    {
      description: "Read context.md or a notes/*.md file.",
      inputSchema: { file: z.string() },
      annotations: readOnly,
    },
    async ({ file }) => run((w) => w.readDoc(file)),
  );

  server.registerTool(
    "write_doc",
    {
      description:
        "Replace context.md or a notes/*.md file with text; for context.md, reports its issues.",
      inputSchema: { file: z.string(), text: z.string() },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ file, text }) => run((w) => w.writeDoc(file, text)),
  );

  server.registerTool(
    "part_search",
    {
      description: "Search the part library by id, MPN, manufacturer, summary or package words.",
      inputSchema: { q: z.string() },
      annotations: readOnly,
    },
    async ({ q }) => run((w) => w.partSearch(q)),
  );

  server.registerTool(
    "part_get",
    {
      description:
        "Read a part record. tier=summary (default): identity and ratings; pins: plus pin table, requirements and notes; full: the YAML.",
      inputSchema: { id: z.string(), tier: z.enum(["summary", "pins", "full"]).optional() },
      annotations: readOnly,
    },
    async ({ id, tier }) => run((w) => w.partGet(id, tier ?? "summary")),
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
    async ({ record, scope }) => run((w) => w.partPut(record, scope)),
  );

  server.registerTool(
    "kicad_export",
    {
      description:
        "Write kicad/ (schematic, symbols, netlist; never the PCB) and verify it with kicad-cli (netlist round-trip, ERC). Needs a design without errors.",
      inputSchema: {
        check: z.boolean().optional().describe("Run kicad-cli checks (default true)"),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ check }) => run((w) => w.kicadExport({ check: check ?? true })),
  );

  server.registerTool(
    "kicad_import",
    {
      description: projects
        ? "Import a KiCad project (.kicad_pro, .kicad_sch or folder) as new_project, or re-import into the open one (replaces circuit/, keeping intents and attributes). Unmatched symbols become drafts."
        : "Import a KiCad project (.kicad_pro, .kicad_sch or folder, relative to the project). Re-import replaces circuit/, keeping intents and attributes; unmatched symbols become drafts.",
      inputSchema: {
        path: z.string(),
        ...(projects && {
          new_project: z.string().optional().describe("Name of a new project to import into"),
        }),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ path: source, new_project }) => {
      if (projects && typeof new_project === "string") {
        const target = new Workspace(projects.resolve(new_project));
        if (await isProject(target.root)) {
          return reply({ ok: false, text: `${target.root} is already a project` });
        }
        await projects.ensureLibrary();
        const imported = await target.kicadImport(path.resolve(projects.dir, source), {
          libraryPaths: [projects.libraryDir],
        });
        return reply(imported.ok ? await opened(target.root, [imported.text]) : imported);
      }
      return run((w) => w.kicadImport(path.resolve(w.root, source)));
    },
  );

  server.registerTool(
    "bom_export",
    {
      description:
        "Resolve generic parts to library MPNs (preferring the project's distributors), update bom.lock and write bom.csv.",
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async () => run((w) => w.bomExport()),
  );

  server.registerTool(
    "focus",
    {
      description:
        "What the person has selected in the viewer (parts, pins, nets, sheets) and their open review comments. Call when they say 'this', 'here' or ask about the selection.",
      annotations: readOnly,
    },
    async () => run((w) => w.focus()),
  );

  server.registerTool(
    "diff",
    {
      description:
        "Circuit changes by statement since: checkpoint (default; not yet approved), last (your previous diff; use at the start of a turn), or a checkpoint id.",
      inputSchema: { since: z.string().optional() },
      annotations: readOnly,
    },
    async ({ since }) => run((w) => w.diff(since ?? "checkpoint")),
  );

  server.registerTool(
    "checkpoint",
    {
      description: "Commit the project as a checkpoint (the person's approval). Only when asked.",
      inputSchema: { message: z.string() },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ message }) => run((w) => w.checkpoint(message)),
  );

  server.registerTool(
    "variant",
    {
      description:
        "Parallel design versions on git branches: list, create NAME (from the last checkpoint; edit it in .partstyle/variants/NAME), diff NAME.",
      inputSchema: { op: z.enum(["list", "create", "diff"]), name: z.string().optional() },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ op, name }) => run((w) => w.variant(op, name)),
  );

  // Procedures, fetched only when needed (the CLI prints the same text: partstyle prompt NAME).
  for (const p of prompts) {
    const argsSchema = Object.fromEntries(
      p.args.map((a) => [
        a.name,
        a.required
          ? z.string().describe(a.description)
          : z.string().optional().describe(a.description),
      ]),
    );
    server.registerPrompt(p.name, { description: p.description, argsSchema }, (args) => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: p.render(args as Record<string, string>) },
        },
      ],
    }));
  }

  return server;
}
