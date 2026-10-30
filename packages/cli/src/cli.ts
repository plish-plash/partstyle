import { parseArgs } from "node:util";
import { schemaCommand } from "./commands/schema.js";
import type { CommandResult } from "./commands/types.js";
import { validateCommand } from "./commands/validate.js";

const usage = `usage: partstyle <command> [options]

commands:
  validate [dir] [--json]   parse, connect and ERC-check the project in dir (default .)
  schema part               print the part-record JSON Schema`;

export async function run(argv: string[]): Promise<CommandResult> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    return { stdout: "", stderr: `${(e as Error).message}\n\n${usage}`, exitCode: 2 };
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;

  if (values.help || command === undefined) {
    return { stdout: usage, exitCode: command === undefined && !values.help ? 2 : 0 };
  }
  switch (command) {
    case "validate":
      return validateCommand(args[0] ?? ".", { json: values.json ?? false });
    case "schema":
      return schemaCommand(args[0]);
    default:
      return { stdout: "", stderr: `unknown command '${command}'\n\n${usage}`, exitCode: 2 };
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}
