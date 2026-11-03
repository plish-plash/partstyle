import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Projects, partstyleVersion, projectsDirFrom, Workspace } from "@partstyle/engine/node";
import { startViewer, type ViewerServer } from "@partstyle/server";
import { createServer } from "./server.js";

export { embedVersion, partstyleVersion } from "@partstyle/engine/node";
export { createServer, type ServerOptions } from "./server.js";

/**
 * Runs the MCP server on stdio until the client disconnects: `partstyle-mcp ARGS` and
 * `partstyle mcp ARGS`. With --project it serves that folder; without, any project in
 * --projects-dir (or elsewhere, by path), opened by name.
 */
export async function serveMcp(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string", short: "p" },
      "projects-dir": { type: "string" },
      "viewer-port": { type: "string" },
      "no-viewer": { type: "boolean" },
    },
  });
  const port = values["viewer-port"] === undefined ? {} : { port: Number(values["viewer-port"]) };

  // The viewer runs in the same process (docs/design.md), so an AI edit shows as soon as it is
  // written. It is optional: the MCP tools work without it. stdout belongs to MCP, so log to
  // stderr. In global mode it starts with the first project opened and follows later ones.
  let viewer: ViewerServer | undefined;
  const show = async (ws: Workspace): Promise<string | undefined> => {
    if (values["no-viewer"]) return undefined;
    if (viewer) {
      await viewer.switchTo(ws);
      return viewer.url;
    }
    viewer = await startViewer(ws, port).catch((e: unknown) => {
      process.stderr.write(`partstyle viewer not started: ${(e as Error).message}\n`);
      return undefined;
    });
    if (viewer) process.stderr.write(`partstyle viewer: ${viewer.url}\n`);
    return viewer?.url;
  };

  let server: ReturnType<typeof createServer>;
  if (values.project !== undefined) {
    const ws = new Workspace(values.project);
    await show(ws);
    server = createServer(ws, { version: partstyleVersion() });
  } else {
    const dir = projectsDirFrom(values["projects-dir"], (m) => process.stderr.write(`${m}\n`));
    const projects = new Projects(dir);
    // Projects opened here use the projects folder's shared library first; remembering it lets
    // the CLI on the same projects do the same.
    await projects.ensureLibrary().catch((e: unknown) => {
      process.stderr.write(`partstyle: shared library not set up: ${(e as Error).message}\n`);
    });
    server = createServer(undefined, { projects, onOpen: show, version: partstyleVersion() });
  }
  await server.connect(new StdioServerTransport());

  const shutdown = () => {
    void (viewer?.close() ?? Promise.resolve()).then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
}
