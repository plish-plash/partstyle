# Using partstyle with Claude Code and MCP clients

## Claude Code (primary)

Claude Code edits the `.ckt` files with its own file tools and calls the CLI to read, query,
validate and patch. First put `partstyle` on your PATH: the standalone executable or a build
from source ([install.md](install.md)).

Start each design with `partstyle init` (or ask Claude to). It writes a project `CLAUDE.md`
with the workflow, naming conventions and a worked example block, so Claude needs no example
project to copy from. See the [CLI reference](cli.md) for every command.

Run `partstyle view` in a second terminal and open the URL it prints to watch the design as
Claude edits it. Select parts or nets there and refer to them as "this"; Claude reads your
selection and comments with `partstyle focus`.

## MCP (chat clients, or Claude Code without shell access)

The server speaks stdio and serves one project folder, which need not exist yet:
`init_project` creates the project there.

```json
{
  "mcpServers": {
    "partstyle": {
      "command": "node",
      "args": ["<repo>/packages/mcp/dist/main.js", "--project", "<path to design>"]
    }
  }
}
```

For Claude Code: `claude mcp add partstyle -- node <repo>/packages/mcp/dist/main.js --project .`

`partstyle mcp --project <path>` runs the same server, so with `partstyle` on PATH, or the
[standalone executable](install.md#standalone-executable) on a machine without Node, use
`"command": "partstyle", "args": ["mcp", "--project", "<path to design>"]` instead.

The MCP server also starts the viewer in the same process (its URL goes to the client's log,
and `focus` reports it). Pass `--viewer-port N` to pick the port or `--no-viewer` to skip it.

Each tool calls the same `Workspace` method as the matching CLI command, so output is
identical.

| MCP tool                                                                          | CLI                                                                              |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `init_project(name, library_paths)`                                               | `partstyle init [DIR] --name --library`                                          |
| `overview`                                                                        | `partstyle overview`                                                             |
| `read_block(block, detail)`                                                       | `partstyle read-block BLOCK --detail ...`                                        |
| `query(expr)`                                                                     | `partstyle query EXPR`                                                           |
| `apply(patch, dry_run)`                                                           | `partstyle apply [FILE\|-] [--dry-run]`                                          |
| `validate`                                                                        | `partstyle validate [--json]`                                                    |
| `part_search(q)`                                                                  | `partstyle part search Q`                                                        |
| `part_get(id, tier)`                                                              | `partstyle part get ID --tier ...`                                               |
| `part_put(record, scope)`                                                         | `partstyle part put [FILE\|-] --scope ...`                                       |
| `kicad_export(check)`                                                             | `partstyle kicad export [--no-check]`                                            |
| `kicad_import(path)`                                                              | `partstyle kicad import PATH` (`--replace` is CLI only)                          |
| `bom_export`                                                                      | `partstyle bom export`                                                           |
| `focus`                                                                           | `partstyle focus`                                                                |
| `diff(since)`                                                                     | `partstyle diff [--since ...]`                                                   |
| `checkpoint(message)`                                                             | `partstyle checkpoint MESSAGE`                                                   |
| `variant(op, name)`                                                               | `partstyle variant list\|create\|diff NAME`                                      |
| (person only: viewer and CLI)                                                     | `partstyle changes`, `revert`, `pending`, `variant adopt\|remove`, `checkpoints` |
| (viewer, started with the server)                                                 | `partstyle view [--port N]`                                                      |
| resource `partstyle://grammar`                                                    | `partstyle grammar`                                                              |
| prompts `design_review(block)`, `ingest_part(part, datasheet)`, `prepare_handoff` | `partstyle prompt NAME [ARGS...]`, and `/design-review` etc. in Claude Code      |

`init_project` creates the project in the server's `--project` folder; `library_paths` are
relative to that folder.
