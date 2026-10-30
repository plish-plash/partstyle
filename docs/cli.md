# partstyle CLI reference

```
partstyle [-p DIR] <command> [args] [options]
```

Every command works on one project folder: `-p/--project DIR`, or the current directory.
Each command except `init`, `grammar` and `schema` reads the project fresh, so edits made by
hand or by another tool are always picked up.

Every MCP tool has a matching command with identical output (see
[claude-code.md](claude-code.md)). Output is terse text meant for both people and AI.

**Exit codes:** `0` success; `1` the command failed (unknown block, rejected patch, validation
errors); `2` usage error, or not a project folder for `validate`.

## Setup

```sh
pnpm install && pnpm build        # in the partstyle repository
pnpm add -g ./packages/cli        # puts `partstyle` on PATH, linked to this checkout
```

The global install links to the checkout, so later `pnpm build` runs update it. Without it, run
`node <repo>/packages/cli/dist/main.js`, or `pnpm partstyle ...` from the repository root.

## Projects

### `init [DIR] [--name NAME] [--library PATH]...`

Creates a project skeleton in DIR (default: `-p` or the current directory), creating the folder
if needed. Fails if DIR already has a `project.toml`. Existing files are never overwritten.

| File                 | Contents                                                                    |
| -------------------- | --------------------------------------------------------------------------- |
| `project.toml`       | name, `top = "main"`, library paths, preferred distributors                 |
| `context.md`         | front matter to fill in: use case, environment, power, assembly, interfaces |
| `circuit/main.ckt`   | an empty top block                                                          |
| `notes/decisions.md` | design rationale, keyed to refdes and nets                                  |
| `notes/pcb.md`       | layout notes for the KiCad hand-off                                         |
| `CLAUDE.md`          | instructions for Claude Code: workflow, conventions, an example block       |

If `CLAUDE.md` already exists, the instructions go to `CLAUDE.partstyle.md`; add the line
`@CLAUDE.partstyle.md` to your `CLAUDE.md` to load them.

`--library` adds a global part-library folder (repeatable), given relative to the current
directory. It is stored relative to the project when at most two levels up (`../library`),
otherwise as an absolute path. Without one, `part put` writes to the project's `parts/` folder.
To use the seed library: `--library <repo>/library`.

```sh
partstyle init boards/thermo --name thermo --library ~/parts
```

## Reading

### `overview`

The cheap first read (a few hundred tokens): blocks with part counts, ports and uses, context
from `context.md`, part totals, issue counts and the first ten issues.

### `read-block BLOCK [--detail summary|full]`

`full` (default) prints the block's `.ckt` file. `summary` prints only ports, parts with intent,
instances and net names with pin counts.

### `query EXPR...`

Targeted lookups on the flattened netlist; words are joined, so quoting is optional except for
shell characters like `<` and `>`.

| Query                    | Answer                                      |
| ------------------------ | ------------------------------------------- |
| `part REF`               | the part, and each pin with its net         |
| `net NAME`               | the net's attributes, joined names and pins |
| `parts [where COND ...]` | matching parts, one per line                |
| `nets [where COND ...]`  | matching nets with their pins               |
| `unconnected`            | every pin on no net, including waived ones  |
| `help`                   | the syntax summary                          |

COND is `FIELD OP VALUE`, joined with `and`. OP is `= != < <= > >=` or `~` (contains,
case-insensitive). Quantities compare numerically (`35V > 5V`, `4k7 < 10k`). A part or net
missing the field never matches.

- Part fields: `path id mpn manufacturer package footprint kind fn value verified intent` and
  every rating in the part record (`vin_max`, `iout_max`, ...).
- Net fields: `name pins` (pin count) and every net attribute (`voltage`, `source`, ...).
- REF and NAME may omit the instance path when unambiguous (`U1` for `PWR/U1`).

```sh
partstyle query part U1
partstyle query "parts where vin_max < 15V"
partstyle query "parts where fn = cap and value = 100n"
partstyle query "nets where pins = 1"
```

### `validate [DIR] [--json]`

Parses, connects and checks the project. Prints one line per unwaived issue,
`file:line:col severity code message`, then a summary. Exits 1 if there are errors. `--json`
prints `{errors, warnings, waived, issues}`. Issue codes are listed in
[ckt-grammar.md](ckt-grammar.md#issue-codes).

## Editing

### `apply [FILE|-] [--dry-run]`

Applies a patch from FILE, or from stdin when FILE is `-` or omitted. Patches are all-or-nothing:
if any line fails, nothing is written and the error names the line. The reply lists the edits
and only the issues they added or resolved. `--dry-run` reports the same without writing. The
patch language is in [ckt-grammar.md](ckt-grammar.md#patches-apply).

```sh
partstyle apply --dry-run <<'EOF'
in power
+ part C13 cap(47u, 25V) @ bulk on the 12 V rail
net +12V += C13.1
net GND += C13.2
EOF
```

You can also edit `.ckt` files directly with any editor, then run `validate`.

## Parts

### `part search QUERY...`

Searches the part library; every word must appear in the id, MPN, manufacturer, summary or
package. Id and MPN matches rank first.

### `part get ID [--tier summary|pins|full]`

Reads a record at the lowest tier that answers the question: `summary` (identity, package,
ratings), `pins` (plus the pin table, requirements and notes) or `full` (the YAML file).

### `part put [FILE|-] [--scope global|project]`

Validates a YAML part record against the schema and writes it as `<id>.yaml`: to the first
global library path when one is configured (`global`, the default), otherwise to `parts/`
(`project`). Project records override global records with the same id. Leave
`provenance.verified_by: null`; a human marks records verified.

## Reference

| Command       | Prints                                                            |
| ------------- | ----------------------------------------------------------------- |
| `grammar`     | the `.ckt` and patch reference ([ckt-grammar.md](ckt-grammar.md)) |
| `schema part` | the part-record JSON Schema                                       |
| `--help`      | the command summary                                               |
