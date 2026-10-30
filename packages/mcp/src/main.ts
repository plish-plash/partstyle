#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Workspace } from "@partstyle/engine/node";
import { createServer } from "./server.js";

const { values } = parseArgs({
  options: { project: { type: "string", short: "p" } },
});

const server = createServer(new Workspace(values.project ?? process.cwd()));
await server.connect(new StdioServerTransport());
