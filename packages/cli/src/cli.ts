import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  countIssues,
  findPrompt,
  formatValidation,
  type PromptDef,
  partRecordJsonSchema,
  prompts,
  queryUsage,
  type TextResult,
  type ValidationResult,
} from "@partstyle/engine";
import { ProjectLoadError, readGrammarReference, Workspace } from "@partstyle/engine/node";
import { startViewer } from "@partstyle/server";

export interface CommandResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
  /** Set by long-running commands (`view`): stops them. */
  close?: () => Promise<void>;
}

export interface CliIO {
  readStdin(): Promise<string>;
}

const usage = `usage: partstyle [-p DIR] <command>

Every command mirrors an MCP tool and gives the same output.

commands:
  init [DIR] [--name NAME] [--library PATH]...
                                           create a project skeleton (DIR defaults to -p or .)
  overview                                 project summary: blocks, parts, issues, context
  read-block BLOCK [--detail summary|full] a block's .ckt text, or ports + parts only
  query EXPR...                            targeted lookup; 'partstyle query help' for syntax
  validate [DIR] [--json]                  parse, connect and ERC-check (exit 1 on errors)
  apply [FILE|-] [--dry-run]               apply a .ckt patch from FILE or stdin
  part search QUERY...                     search the part library
  part get ID [--tier summary|pins|full]   read a part record
  part put [FILE|-] [--scope global|project]  add or update a part record
  kicad export [--no-check]                write kicad/ and verify it with kicad-cli
  kicad import PATH [--replace] [--library PATH]...
                                           import a KiCad project (creates the project if needed)
  bom export                               resolve generics, write bom.lock and bom.csv
  view [--port N]                          serve the live viewer on 127.0.0.1 until Ctrl-C
  mcp [--project DIR] [--viewer-port N] [--no-viewer]
                                           run the MCP server on stdio (first argument only)
  focus                                    what is selected in the viewer, and open comments
  diff [--since checkpoint|last|ID]        circuit changes, statement by statement
  changes                                  changesets since the checkpoint, and pending patches
  revert C3|C3.2                           undo a changeset or one of its statements
  checkpoint MESSAGE...                    commit the project folder (the person's approval)
  checkpoints                              recent checkpoints
  pending accept|reject ID                 decide a patch held in accept mode
  variant list|create|diff|adopt|remove [NAME]
                                           parallel versions on git branches
  prompt [NAME [ARGS...]]                  list or print a procedure (design-review, ingest-part,
                                           prepare-handoff)
  grammar                                  print the .ckt and patch reference
  schema part                              print the part-record JSON Schema

options:
  -p, --project DIR   project folder (default: current directory)

Full reference: docs/cli.md in the partstyle repository.`;

const usageError = (message: string): CommandResult => ({
  stdout: "",
  stderr: `${message}\n\n${usage}`,
  exitCode: 2,
});

function fromText(r: TextResult): CommandResult {
  return r.ok ? { stdout: r.text, exitCode: 0 } : { stdout: "", stderr: r.text, exitCode: 1 };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string", short: "p" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "no-check": { type: "boolean" },
      replace: { type: "boolean" },
      detail: { type: "string" },
      tier: { type: "string" },
      scope: { type: "string" },
      name: { type: "string" },
      library: { type: "string", multiple: true },
      port: { type: "string" },
      since: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.find((a) => a === value);
}

async function readInput(arg: string | undefined, io: CliIO): Promise<string> {
  return arg === undefined || arg === "-" ? io.readStdin() : readFile(arg, "utf8");
}

export async function run(argv: string[], io: CliIO): Promise<CommandResult> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    return usageError((e as Error).message);
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;
  if (values.help) return { stdout: usage, exitCode: 0 };
  if (command === undefined) return usageError("missing command");

  const ws = new Workspace(values.project ?? ".");
  switch (command) {
    case "init": {
      if (args.length > 1) return usageError("usage: init [DIR] [--name NAME] [--library PATH]...");
      const target = args[0] === undefined ? ws : new Workspace(args[0]);
      return fromText(
        await target.init({
          // Library paths on the command line are relative to the current directory.
          libraryPaths: (values.library ?? []).map((p) => path.resolve(p)),
          ...(values.name !== undefined && { name: values.name }),
        }),
      );
    }

    case "overview":
      return fromText(await ws.overview());

    case "read-block": {
      const detail = oneOf(values.detail ?? "full", ["summary", "full"] as const);
      if (args.length !== 1 || !detail)
        return usageError("usage: read-block BLOCK [--detail summary|full]");
      return fromText(await ws.readBlock(args[0] as string, detail));
    }

    case "query":
      if (args.length === 0 || args[0] === "help") return { stdout: queryUsage, exitCode: 0 };
      return fromText(await ws.query(args.join(" ")));

    case "validate": {
      if (args.length > 1) return usageError("usage: validate [DIR] [--json]");
      const target = args[0] === undefined ? ws : new Workspace(args[0]);
      let result: ValidationResult;
      try {
        result = await target.validateResult();
      } catch (e) {
        if (e instanceof ProjectLoadError) return { stdout: "", stderr: e.message, exitCode: 2 };
        throw e;
      }
      const { errors, warnings } = countIssues(result);
      const stdout = values.json
        ? JSON.stringify(
            { errors, warnings, waived: result.waived, issues: result.issues },
            null,
            2,
          )
        : formatValidation(result, path.basename(target.root));
      return { stdout, exitCode: errors > 0 ? 1 : 0 };
    }

    case "apply": {
      if (args.length > 1) return usageError("usage: apply [FILE|-] [--dry-run]");
      const patch = await readInput(args[0], io);
      return fromText(await ws.apply(patch, { dryRun: values["dry-run"] ?? false }));
    }

    case "part": {
      const [sub, ...rest] = args;
      if (sub === "search" && rest.length > 0) return fromText(await ws.partSearch(rest.join(" ")));
      if (sub === "get" && rest.length === 1) {
        const tier = oneOf(values.tier ?? "summary", ["summary", "pins", "full"] as const);
        if (!tier) return usageError("--tier must be summary, pins or full");
        return fromText(await ws.partGet(rest[0] as string, tier));
      }
      if (sub === "put" && rest.length <= 1) {
        const scope = oneOf(values.scope, ["global", "project"] as const);
        if (values.scope !== undefined && !scope)
          return usageError("--scope must be global or project");
        return fromText(await ws.partPut(await readInput(rest[0], io), scope));
      }
      return usageError("usage: part search QUERY | part get ID | part put [FILE|-]");
    }

    case "kicad":
      if (args[0] === "export" && args.length === 1) {
        return fromText(await ws.kicadExport({ check: !values["no-check"] }));
      }
      if (args[0] === "import" && args.length === 2) {
        return fromText(
          await ws.kicadImport(path.resolve(args[1] as string), {
            replace: values.replace ?? false,
            libraryPaths: (values.library ?? []).map((p) => path.resolve(p)),
          }),
        );
      }
      return usageError(
        "usage: kicad export [--no-check] | kicad import PATH [--replace] [--library PATH]...",
      );

    case "bom":
      if (args[0] !== "export" || args.length > 1) return usageError("usage: bom export");
      return fromText(await ws.bomExport());

    case "view": {
      if (args.length > 0) return usageError("usage: view [--port N]");
      const port = values.port === undefined ? undefined : Number(values.port);
      // 0 picks any free port.
      if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536)) {
        return usageError("--port must be a port number");
      }
      try {
        const probe = await ws.overview(); // fail early, with the usual message, outside a project
        if (!probe.ok) return { stdout: "", stderr: probe.text, exitCode: 1 };
        const viewer = await startViewer(ws, port === undefined ? {} : { port });
        return {
          stdout: `viewer for ${ws.root} at ${viewer.url} (Ctrl-C to stop)`,
          exitCode: 0,
          close: viewer.close,
        };
      } catch (e) {
        return { stdout: "", stderr: (e as Error).message, exitCode: 1 };
      }
    }

    case "focus":
      return fromText(await ws.focus());

    case "diff":
      if (args.length > 0) return usageError("usage: diff [--since checkpoint|last|ID]");
      return fromText(await ws.diff(values.since ?? "checkpoint"));

    case "changes":
      if (args.length > 0) return usageError("usage: changes");
      return fromText(await ws.changes());

    case "revert":
      if (args.length !== 1) return usageError("usage: revert C3|C3.2");
      return fromText(await ws.revert(args[0] as string));

    case "checkpoint":
      if (args.length === 0) return usageError("usage: checkpoint MESSAGE...");
      return fromText(await ws.checkpoint(args.join(" ")));

    case "checkpoints":
      return fromText(await ws.checkpoints());

    case "pending": {
      const [op, id] = args;
      if ((op !== "accept" && op !== "reject") || id === undefined || args.length > 2) {
        return usageError("usage: pending accept|reject ID");
      }
      return fromText(await (op === "accept" ? ws.pendingAccept(id) : ws.pendingReject(id)));
    }

    case "variant": {
      const op = oneOf(args[0], ["list", "create", "diff", "adopt", "remove"] as const);
      if (!op || args.length > 2 || (op !== "list" && args.length !== 2)) {
        return usageError("usage: variant list | variant create|diff|adopt|remove NAME");
      }
      return fromText(await ws.variant(op, args[1]));
    }

    case "prompt": {
      const [name, ...rest] = args;
      const synopsis = (p: PromptDef) =>
        [
          p.name.replace(/_/g, "-"),
          ...p.args.map((a) => (a.required ? a.name.toUpperCase() : `[${a.name.toUpperCase()}]`)),
        ].join(" ");
      if (name === undefined) {
        return {
          stdout: prompts.map((p) => `${synopsis(p)}: ${p.description}`).join("\n"),
          exitCode: 0,
        };
      }
      const p = findPrompt(name);
      if (!p) return usageError(`unknown prompt '${name}' (partstyle prompt lists them)`);
      const required = p.args.filter((a) => a.required).length;
      if (rest.length < required || rest.length > p.args.length) {
        return usageError(`usage: prompt ${synopsis(p)}`);
      }
      return {
        stdout: p.render(Object.fromEntries(p.args.map((a, i) => [a.name, rest[i]]))),
        exitCode: 0,
      };
    }

    case "grammar":
      return { stdout: await readGrammarReference(), exitCode: 0 };

    case "schema":
      if (args[0] !== "part") return usageError("usage: schema part");
      return { stdout: JSON.stringify(partRecordJsonSchema(), null, 2), exitCode: 0 };

    default:
      return usageError(`unknown command '${command}'`);
  }
}
