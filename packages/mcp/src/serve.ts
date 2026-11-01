import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Workspace } from "@partstyle/engine/node";
import { startViewer } from "@partstyle/server";
import { createServer } from "./server.js";

export { createServer } from "./server.js";

/**
 * Runs the MCP server on stdio until the client disconnects: `partstyle-mcp ARGS` and
 * `partstyle mcp ARGS`.
 */
export async function serveMcp(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string", short: "p" },
      "viewer-port": { type: "string" },
      "no-viewer": { type: "boolean" },
    },
  });

  const ws = new Workspace(values.project ?? process.cwd());

  // The viewer runs in the same process (DESIGN.md), so an AI edit shows as soon as it is
  // written. It is optional: the MCP tools work without it. stdout belongs to MCP, so log to
  // stderr.
  const viewer = values["no-viewer"]
    ? undefined
    : await startViewer(
        ws,
        values["viewer-port"] === undefined ? {} : { port: Number(values["viewer-port"]) },
      ).catch((e: unknown) => {
        process.stderr.write(`partstyle viewer not started: ${(e as Error).message}\n`);
        return undefined;
      });
  if (viewer) process.stderr.write(`partstyle viewer: ${viewer.url}\n`);

  const server = createServer(ws);
  await server.connect(new StdioServerTransport());

  const shutdown = () => {
    void (viewer?.close() ?? Promise.resolve()).then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
}
