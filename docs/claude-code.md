# Using Partstyle with Claude Code, Claude Desktop and other MCP clients

Partstyle works with Claude Code, where Claude also has file and shell tools, and with Claude
Desktop or any other MCP client, where it works through the Partstyle MCP server alone.

Install Partstyle first ([INSTALL.md](../INSTALL.md)): the Claude Desktop extension, or the
standalone executable or a build from source for everything else. Putting the `partstyle`
command on your PATH is optional. MCP clients can be given its full path, and PATH matters only
for running `partstyle` commands from a shell, as with the CLI in Claude Code.

## Claude Code

Claude Code can use Partstyle two ways, alone or together:

- **CLI:** Claude edits the `.ckt` files with its own file tools and runs `partstyle` commands
  (on PATH) to read, query, validate and patch. Start each design with `partstyle init` (or ask
  Claude to). It writes a project `CLAUDE.md` with the workflow, naming conventions and a worked
  example block, so Claude needs no example project to copy from. See the
  [CLI reference](cli.md) for every command. Run `partstyle view` in a second terminal and open
  the URL it prints to watch the design as Claude edits it.
- **MCP server:** register it once for all projects with
  `claude mcp add -s user partstyle -- <path to partstyle> mcp`. It starts the viewer itself.
  When Claude Code reports its working folder as an MCP root and that folder is a project, the
  server opens it by itself; otherwise Claude calls `open_project` with the folder's path.

Either way, select parts or nets in the viewer and refer to them as "this"; Claude reads your
selection and comments with `focus`.

## Claude Desktop

Claude Desktop has no file or shell tools, so it works only through the MCP server, in global
mode. The easy way to install it is the extension, `partstyle.mcpb`: open it, choose Install,
and set the projects folder if you want one other than `Documents/partstyle` (see
[INSTALL.md](../INSTALL.md#claude-desktop-extension)).

Alternatively, with the standalone executable, add the server by hand in Settings → Developer →
Edit Config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "partstyle": {
      "command": "C:\\Users\\you\\bin\\partstyle.exe",
      "args": ["mcp"]
    }
  }
}
```

Use the full path to the executable (Claude Desktop may not see your shell's PATH), and add
`"--projects-dir", "<folder>"` to keep projects somewhere other than `~/Documents/partstyle`.
Restart Claude Desktop afterwards.

Then, in a chat:

- "Start a Partstyle project for a 12 V bench supply": Claude calls `init_project`, fills in
  `partstyle-project.yaml` with you (`write_doc`), then designs block by block with `apply`.
- "Open bench-sensor" or "what Partstyle projects do I have?": `open_project`, `list_projects`.
- Open the viewer URL Claude gives you. Select parts or nets there and say "this"; Claude calls
  `focus`. Revert changes, accept pending patches and checkpoint in the viewer's Changes tab.
- The procedures are in the prompt menu: design review, ingest part, prepare hand-off.
- A Claude Desktop project per design, with an instruction like "use the Partstyle project
  bench-sensor", keeps its chats together.

`kicad_export` and `kicad_import` need KiCad installed on the same machine.

## MCP server

`partstyle mcp` speaks MCP over stdio. It runs in one of two modes.

**Global (recommended):** configure it once and work on any number of projects. New projects
go in a projects folder, `~/Documents/partstyle` unless `--projects-dir` says otherwise, and
share a part library in its `library/` subfolder (put a downloaded seed library there). Every
project the server opens uses that library first, then your own libraries from
`~/.partstyle/settings.yaml` (see [Settings](cli.md#settings)); new records go to it. The server
remembers it in `~/.partstyle/shared-library.json` so the CLI does the same, and projects
elsewhere open by path and are remembered in `~/.partstyle/recent.json` (`PARTSTYLE_STATE_DIR`
moves all three).

**One project:** `partstyle mcp --project <path>` serves just that folder, which need not
exist yet: `init_project` creates the project there.

The server sends the workflow (the project `CLAUDE.md`'s, in tool terms) as MCP instructions,
so clients that never read a `CLAUDE.md` follow it too.

### The viewer

The server runs the viewer in the same process. In global mode it starts with the first
project opened, and `open_project` and `init_project` return its URL
(`http://127.0.0.1:7766/?project=NAME`) for Claude to pass on. Opening another project moves
the viewer to it, and open pages reload onto it. A page opened for one project that now shows
another says so in its header. Pass `--viewer-port N` to pick the port or `--no-viewer` to skip
it.

Each client starts its own server process (Claude Desktop one, each Claude Code session one),
so each has its own viewer on the next free port. Two processes may have the same project open;
`focus` then reports whichever viewer started last.

### Other clients

Any MCP client that runs stdio servers works the same way: command `partstyle` (or its full
path), arguments `["mcp"]` (global) or `["mcp", "--project", "<path to design>"]`. Without the
executable, `node <repo>/packages/mcp/dist/main.js` takes the same arguments.

## Tools

Each tool calls the same `Workspace` method as the matching CLI command, so output is
identical.

| MCP tool                                                                          | CLI                                                                              |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `list_projects` (global mode)                                                     | `partstyle projects [--dir DIR]`                                                 |
| `open_project(project)` (global mode)                                             | `partstyle -p DIR ...`                                                           |
| `init_project(name, path)`                                                        | `partstyle init [DIR] --name NAME`                                               |
| `overview`                                                                        | `partstyle overview`                                                             |
| `read_block(block, detail)`                                                       | `partstyle read-block BLOCK --detail ...`                                        |
| `query(expr)`                                                                     | `partstyle query EXPR`                                                           |
| `apply(patch, dry_run)`                                                           | `partstyle apply [FILE\|-] [--dry-run]`                                          |
| `validate`                                                                        | `partstyle validate [--json]`                                                    |
| `read_doc(file)`, `write_doc(file, text)`                                         | `partstyle doc read FILE`, `partstyle doc write FILE [SRC\|-]`                   |
| `part_search(q)`                                                                  | `partstyle part search Q`                                                        |
| `part_get(id, tier)`                                                              | `partstyle part get ID --tier ...`                                               |
| `part_put(record, scope)`                                                         | `partstyle part put [FILE\|-] --scope ...`                                       |
| `kicad_export(check)`                                                             | `partstyle kicad export [--no-check]`                                            |
| `kicad_import(path, new_project)`                                                 | `partstyle kicad import PATH` (`--replace` is CLI only)                          |
| `bom_export`                                                                      | `partstyle bom export`                                                           |
| `focus`                                                                           | `partstyle focus`                                                                |
| `diff(since)`                                                                     | `partstyle diff [--since ...]`                                                   |
| `checkpoint(message)`                                                             | `partstyle checkpoint MESSAGE`                                                   |
| `variant(op, name)`                                                               | `partstyle variant list\|create\|diff NAME`                                      |
| `grammar`, and resource `partstyle://grammar`                                     | `partstyle grammar`                                                              |
| (person only: viewer and CLI)                                                     | `partstyle changes`, `revert`, `pending`, `variant adopt\|remove`, `checkpoints` |
| (viewer, started with the server)                                                 | `partstyle view [--port N]`                                                      |
| prompts `design_review(block)`, `ingest_part(part, datasheet)`, `prepare_handoff` | `partstyle prompt NAME [ARGS...]`, and `/design-review` etc. in Claude Code      |

Until a project is open in global mode, the project tools answer with how to open one, except
`part_search`, `part_get` and `part_put`, which work on the libraries in the settings (the first
is where records go), so Claude can check and add parts before creating a project. (`part_put`
with `scope: project` still needs an open project.)

`init_project`: in global mode it creates `<projects dir>/NAME` (or the folder `path`, absolute
or relative to the projects folder), then opens it. The library folder itself, and anything
inside it, is refused (also for `kicad_import`'s `new_project`). With `--project` it creates the
project in that folder.

`kicad_import`: `path` is relative to the open project, or with `new_project` (global mode) to
the projects folder, importing into a new project of that name, which then opens.

`read_doc` and `write_doc` cover `partstyle-project.yaml` and Markdown files under `notes/`;
writing the project file reports its issues, and a project file that would not load is refused.
Grammar and documents are tools as well as files because clients like Claude Desktop cannot read
files or resources by themselves. Settings (`~/.partstyle/settings.yaml`) and the review mode
(the viewer's switch) are the person's, so no tool writes them.
