#!/usr/bin/env node
import { text } from "node:stream/consumers";
import { serveMcp } from "@partstyle/mcp";
import { run } from "./cli.js";

const argv = process.argv.slice(2);
if (argv[0] === "mcp") {
  // The MCP server owns stdin and stdout until the client disconnects.
  await serveMcp(argv.slice(1));
} else {
  const result = await run(argv, { readStdin: () => text(process.stdin) });
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;

  // Long-running commands keep the process alive until interrupted.
  const { close } = result;
  if (close) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void close().then(() => process.exit(0));
      });
    }
  }
}
