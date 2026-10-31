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

Later commands add `annotation.lock` and `bom.lock` (commit both), `bom.csv`, and the
generated KiCad project in `kicad/`.

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

When KiCad's footprint libraries are found, the record's footprint is checked first: if its
numbered pads differ from the pin table, the record is rejected (a wrong pinout is a board
respin); if the footprint is not in the libraries, it is written with a warning.

A record for a concrete passive can carry `generic: cap(100n, 50V, X7R, 10%, 0603)`, the
generic it satisfies, so `bom export` and `kicad export` can resolve generics to it.

## Outputs

### `bom export`

Resolves every generic part to a library record whose `generic` field meets each constraint:
same value, voltage/current/power at least as high, tolerance at least as tight, same
dielectric and package when given. Among matches it prefers parts stocked by the preferred
distributors in `project.toml` (`[sourcing] distributors`, in order), then the lowest voltage
rating, then id. Writes:

- `bom.lock`: how each generic resolved. A choice is kept until the part's spec changes or the
  record stops fitting; delete a line to re-resolve it.
- `bom.csv`: one row per distinct part with references, quantity, value, spec, manufacturer,
  MPN, footprint, a part-number column per preferred distributor, and notes (unresolved
  generics, unverified records).

Unresolved generics are reported as `bom.unresolved` warnings and keep a footprint derived from
their package when it is a chip size (`0603` → `R_0603_1608Metric`).

### `kicad export [--no-check]`

Writes a KiCad 10 project to `kicad/` and updates `annotation.lock` and `bom.lock`. Refuses
while the design has validation errors.

| File                  | Contents                                                  |
| --------------------- | --------------------------------------------------------- |
| `<name>.kicad_sch`    | top block; each `use` is a hierarchical sheet             |
| `<block>.kicad_sch`   | one sheet per block, shared by all its instances          |
| `partstyle.kicad_sym` | symbols generated for parts with no usable KiCad symbol   |
| `sym-lib-table`       | registers `partstyle.kicad_sym` for the project           |
| `<name>.net`          | KiCad netlist, the most robust hand-off to the PCB editor |
| `<name>.kicad_pro`    | written only if missing, so KiCad's own settings survive  |

Pins connect through symbols and labels on their endpoints rather than drawn wires:

- **Power nets** (any net with power pins or a `ground`/`power_in`/`power_out` port) use KiCad
  power symbols from its `power` library: `power:GND`, `power:+5V` and so on when one is named
  after the net, otherwise `power:GND` (ground) or `power:VCC` with the net name as its value.
  They connect globally, so their ports get no sheet pins. The name is the bare net name, or
  the instance-qualified one (`PWR_+12V`) when two nets share a bare name. If a block used more
  than once would need different power names per instance, that net falls back to labels.
- **Other nets** use local labels; ports become hierarchical labels and sheet pins.
- **Unconnected pins** get no-connect flags.
- **PWR_FLAG** (`power:PWR_FLAG`) is added to every net drawn with power symbols or feeding
  `power_in` pins that has no `power_out` pin, i.e. power from outside the design (a
  `{source: ...}` rail, ground). It sits in a sheet where the net reaches real part pins.

Power symbol definitions are copied from KiCad's installed `power.kicad_sym` so they match the
library exactly; without KiCad, built-in look-alikes with the same names are used.

**Part symbols** also come from KiCad's stock libraries when a suitable one exists:

1. Generics use `Device:R`, `Device:C`, `Device:L`, `Device:LED`, and `Device:D` (or
   `D_Schottky`, `D_Zener`, `D_TVS` for `diode(schottky|zener|tvs)`).
2. A part record's `kicad_symbol: Lib:Name` is used when set. Use it for parts KiCad does not
   name by MPN, such as connectors (`Connector_Generic:Conn_01x03`).
3. Otherwise the libraries are searched by the record's id and MPN: an exact name, a KiCad
   wildcard name (`MCP6002-xSN` for `MCP6002-I/SN`, `MCP1700x-330xxTT` for
   `MCP1700T-3302E/TT`), or the longest name that is a prefix of the MPN followed by a letter
   (`L7805` for `L7805CV`).

A candidate is used only if its pin numbers match the record exactly. It must also have no
hidden power inputs, which KiCad would connect globally by name. Any hidden pins must sit under
a visible pin on the same net. Derived symbols are flattened and multi-unit symbols place every
unit (a dual op-amp becomes U3A, U3B and its power unit U3C). Otherwise a symbol is generated
from the pin table into `partstyle.kicad_sym`. The export lists which KiCad symbols it used and
why any part got a generated one. A `kicad_symbol` that cannot be used is a
`kicad.symbol-fallback` warning.

Placement is a simple grid until the viewer's auto-layout (M3). Symbols carry MPN,
Manufacturer, Spec and distributor fields, so KiCad's own BOM tools work too.

Refdes come from `annotation.lock`, which maps instance paths to flat references. A new part
keeps its local refdes when free; a clash (two blocks both with `C1`) takes the next free
number. Edit the lock to renumber. UUIDs are derived from names, so re-exporting the same
design produces identical files and "Update PCB from Schematic" keeps placement. The PCB file is
never written; stale sheets are removed only if partstyle wrote them.

Unless `--no-check` is given and when kicad-cli is found, the export is then verified:

1. **Round trip:** `kicad-cli sch export netlist` re-derives the netlist from the written
   schematic, and it must match the design net for net. A mismatch is an exporter bug.
2. **ERC:** `kicad-cli sch erc` runs on the schematic; violations are listed.

The command fails (exit 1) on a round-trip mismatch, KiCad ERC errors or footprint pad errors.
Next step: open `kicad/<name>.kicad_pro`, then in the PCB editor run Tools > Update PCB from
Schematic.

### Finding KiCad

`kicad-cli` and the stock footprint and symbol libraries are located in this order:
`[kicad] cli`, `[kicad] footprints` and `[kicad] symbols` in `project.toml` (relative to the
project); the `KICAD_CLI`, `KICAD10_FOOTPRINT_DIR` / `KICAD9_FOOTPRINT_DIR` and
`KICAD10_SYMBOL_DIR` / `KICAD9_SYMBOL_DIR` environment variables; `PATH`; then the usual install
location (`C:\Program Files\KiCad\<version>\bin` on Windows, the highest version;
`/Applications/KiCad` on macOS; `/usr/bin` on Linux), with the libraries beside it. Without
KiCad, exports still work but skip the checks and use look-alike power symbols, and footprint
checks are skipped everywhere.

When the footprint libraries are found, `validate`, `overview` and `apply` also report
`part.footprint-pads` (error) and `part.footprint-missing` (warning) for the library parts in use.

## Reference

| Command       | Prints                                                            |
| ------------- | ----------------------------------------------------------------- |
| `grammar`     | the `.ckt` and patch reference ([ckt-grammar.md](ckt-grammar.md)) |
| `schema part` | the part-record JSON Schema                                       |
| `--help`      | the command summary                                               |
