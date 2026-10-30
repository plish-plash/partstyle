#!/usr/bin/env node
import { text } from "node:stream/consumers";
import { run } from "./cli.js";

const result = await run(process.argv.slice(2), { readStdin: () => text(process.stdin) });
if (result.stdout) process.stdout.write(`${result.stdout}\n`);
if (result.stderr) process.stderr.write(`${result.stderr}\n`);
process.exitCode = result.exitCode;
