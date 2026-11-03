# `partstyle` CLI reference

```
partstyle [-p DIR] <command> [args] [options]
```

Every command works on one project folder: `-p/--project DIR`, or the current directory.
Each command except `init`, `grammar` and `schema` reads the project fresh, so edits made by
hand or by another tool are always picked up.

Every MCP tool has a matching command with identical output (see
[claude-code.md](claude-code.md)). Output is terse text meant for both people and AI.

**Exit codes:** `0` success; `1` the command failed (unknown block, rejected patch, validation
errors); `2` usage error, a FILE argument that cannot be read, or not a project folder for
`validate`.

To install Partstyle, see [INSTALL.md](../INSTALL.md).

## Projects

### `init [DIR] [--name NAME]`

Creates a project skeleton in DIR (default: `-p` or the current directory), creating the folder
if needed. Fails if DIR already has a `partstyle-project.yaml`. Existing files are never
overwritten.

| File                     | Contents                                                           |
| ------------------------ | ------------------------------------------------------------------ |
| `partstyle-project.yaml` | name, description, design context to fill in, settings (see below) |
| `circuit/main.ckt`       | an empty top block                                                 |
| `notes/decisions.md`     | design rationale, keyed to refdes and nets                         |
| `notes/pcb.md`           | layout notes for the KiCad hand-off                                |
| `CLAUDE.md`              | instructions for Claude Code: workflow and procedures              |
| `.claude/commands/`      | Claude Code slash commands for the procedures (see `prompt`)       |

Later commands add `annotation.lock` and `bom.lock` (commit both), `bom.csv`, and the
generated KiCad project in `kicad/`.

If `CLAUDE.md` already exists, the instructions go to `CLAUDE.partstyle.md`; add the line
`@CLAUDE.partstyle.md` to your `CLAUDE.md` to load them.

```sh
partstyle init boards/thermo --name thermo
```

### The project file

`partstyle-project.yaml` marks a folder as a Partstyle project. It is plain YAML:

| Key                     | Meaning                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `partstyle_version`     | the Partstyle version that created the project (written by `init`)             |
| `name`                  | the project's name (required)                                                  |
| `description`           | plain paragraphs for people, usually a `\|` block                              |
| `use_case`              | one line; `overview` leads with it                                             |
| `environment`           | `temp_c: [min, max]` is checked against part records; other keys are notes     |
| `power`, others         | free-form context for people and design review                                 |
| `assembly`              | `method` (hand soldering, SMT service, ...) is checked against packages        |
| `external_interfaces`   | per connector: `connector` (instance path), `connects_to`, `signal`, `hazards` |
| `sourcing.distributors` | preferred distributors for `bom export`: `lcsc`, `digikey`, `mouser`           |
| `checks.cap_derating`   | capacitor voltage derating factor (default 1.5)                                |

The top block is always `main`, in `circuit/main.ckt`. A project file that is not valid YAML or
has no `name` is a `project.config` error and nothing else is checked; malformed design context
is a `context.invalid` warning and only the context checks are skipped.

### Settings

Settings for every project live in `settings.yaml` in the state folder (`~/.partstyle`, or
`PARTSTYLE_STATE_DIR`), which also holds the MCP server's recently opened list. Each command
reads it fresh, so a change applies to the next command. Paths may be absolute or relative to the
state folder.

```yaml
libraries: # your part-library folders
  - C:/Users/me/parts
kicad: # overrides for Finding KiCad (below); normally not needed
  cli: C:/Program Files/KiCad/10.0/bin/kicad-cli.exe
```

The MCP server in global mode puts its projects folder's `library/` before these for every
project it opens, and remembers it (`shared-library.json` in the state folder) so commands use it
first too; a server started on another projects folder replaces it. `part put` writes to the
first library, or to the project's `parts/` folder when there are none.

## Reading

### `overview`

The cheap first read (a few hundred tokens): blocks with part counts, ports and uses, the design
context and settings from the project file (not its description), part totals, issue counts and
the first ten issues.

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

Besides structural ERC, every validate (and so every `apply`) runs:

- **Pin limits.** A pin with `vmax` in its part record is checked against its net's voltage:
  the `voltage` attribute (`5V`, `12V ±10%`, `0-3.3V`), else 0 V for ground nets, else what a
  rail's name says (`+3V3` is 3.3 V). A net with none of these is not checked.
- **Capacitor ratings.** A capacitor with a voltage (a generic's argument, or its record's
  `generic` field) is an error when the voltage across it exceeds the rating, and a warning when
  the rating is under `checks.cap_derating` (default 1.5) times that voltage.
- **Datasheet requirements** that carry a check in the part record: `cap` (at least one
  capacitor of at least `min` from the pin to ground or `to`, or one per pin with `each`), `res`
  (a resistor within `min`..`max`) and `tie` (the pin on the same net as `to`). `to` is a pin of
  the part or a net name. Text-only requirements are left for design review.
- **Design context** in the project file, for each external interface's connector (its
  instance path):
  - `ESD` in its hazards: every signal net on the connector (not power or ground) needs an
    ESD/TVS part (`diode(tvs)`, or a record whose summary says ESD or TVS) to ground.
  - a hazard naming a voltage (`miswiring to 12 V`): no part pin with a lower `vmax`, and no
    capacitor rated lower, may sit directly on those signal nets.
  - `reverse polarity`: a diode or FET on one of the connector's non-ground nets.
  - Records with `temp_c` must cover `environment.temp_c`, and with a hand-only
    `assembly.method` (no service or reflow) fine-pitch packages (QFN, BGA, 0201, ...) are
    flagged.

Overview counts records not yet verified by a person; validate does not repeat it.

## Editing

### `doc read FILE` / `doc write FILE [SRC|-]`

Reads or replaces a project document: `partstyle-project.yaml` or a Markdown file under
`notes/`, by its path in the project (other paths are refused). `write` takes the text from SRC
or stdin and creates folders under `notes/` as needed. A project file that would not load (not
YAML, or no `name`) is refused and nothing is written; otherwise the issues it now has are listed
(or `partstyle-project.yaml: no issues`). These exist for MCP clients without file tools
(`read_doc`, `write_doc`); from a shell, editing the files directly is the same.

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

Fields the checks read (see `validate`): `vmax` on a pin (its absolute maximum relative to
ground), `temp_c: [min, max]`, and requirements with a check:

```yaml
pins:
  1: { name: IN, type: power_in, vmax: 35V }
temp_c: [0, 125]
requirements:
  - text: 0.33 uF on IN, close to the pin
    cap: { from: IN, min: 330n }
  - text: 4.7k-10k pull-up on SDA
    res: { from: SDA, to: VDD, min: 4.7k, max: 10k }
  - keep the feedback trace short # text only: for design review
```

## Outputs

### `bom export`

Resolves every generic part to a library record whose `generic` field meets each constraint:
same value, voltage/current/power at least as high, tolerance at least as tight, same
dielectric and package when given. Among matches it prefers parts stocked by the preferred
distributors in the project file (`sourcing.distributors`, in order), then the lowest voltage
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

Each sheet is laid out automatically, in one deterministic pass — the same layout the viewer
shows. Parts are drawn in **groups**: a part (or child sheet) with the passives that ride along
with it. Groups are placed left to right by **stage** along the signal flow, groups of one
stage stacked, and the stages wrap onto new rows when the paper is full. Layout hints on part
and `use` lines (`[2 r90 flip]`, see the grammar) fix a group's stage or a part's rotation or
mirroring; the viewer writes them. How a net is drawn depends on what it connects:

- **Small nets** (2–6 connections in a sheet: pins, sheet pins and its hierarchical label)
  whose groups sit in consecutive stages of one row are routed as orthogonal wires on the
  2.54 mm pin grid, with junction dots where three wires meet or two meet at a pin. Ones
  reaching further get a
  local label (or hierarchical label, for a port) on each piece, and so do ones whose wire
  would cross three or more others, or run more than 20 mm further than the distance between
  its ends between two groups (wrapping around a part; a feedback loop around its own part is
  fine), or that cannot be routed at all.
- **Adjacent pins** of one part on the same net (three GND pins in a row) are tied with a short
  wire along their ends and share one label or power symbol.
- **Larger nets** use local labels at each pin; ports of such nets get hierarchical labels.
  A port net that reaches only one pin in a sheet has its hierarchical label right on that pin.
- **A label never shares a pin with a wire.** It sits on the pin only when nothing is wired
  there. When the pin's wire runs along the part (adjacent pins tied together), the label goes
  out on a short stub; when a wire leaves the pin outward (a part in line), a short stub tees
  off it just past the pin, with a junction dot, and the label hangs at its end: above the
  wire, or below it, or on a longer stub, whichever is clearest. A stub never ends on another
  net's wire or runs into a pin where any other choice exists (that would look like a
  connection); crossing a wire, or text crowding a part, is the lesser evil. At the end of
  a row of hung parts, the label sits on the end of the row's wire.
- **Power nets** (any net with power pins or a `ground`/`power_in`/`power_out` port) use KiCad
  power symbols from its `power` library: `power:GND`, `power:+5V` and so on when one is named
  after the net, otherwise `power:GND` (ground) or `power:VCC` with the net name as its value.
  They connect globally, so their ports get no sheet pins. The name is the bare net name, or
  the instance-qualified one (`PWR_+12V`) when two nets share a bare name. If a block used more
  than once would need different power names per instance, that net falls back to labels.
- **Power symbols point the conventional way**: rails up, ground down. At a pin on a symbol's
  side, a short stub carries the symbol clear of the part, unless another connected pin is in
  its way, when it points straight out of the pin instead.
- **Ports** that are not power nets become sheet pins on the parent's sheet symbol.
- **Unconnected pins** get no-connect flags.
- **PWR_FLAG** (`power:PWR_FLAG`) is added to every net drawn with power symbols or feeding
  `power_in` pins that has no `power_out` pin, i.e. power from outside the design (a
  `{source: ...}` rail, ground). It sits in a sheet where the net reaches real part pins.

Without hints, parts are placed to read like a hand-drawn schematic:

- **Stages** follow the signal: between two groups sharing signal nets, outputs and inputs
  vote two each for which comes first, and pins on the right or left of a part with pins on
  both sides (an IC) one each. Supply nets carry power from a regulator's output to what it
  feeds. Groups connected to nothing come last.
- **Two-terminal parts** (R, C, L, F, FB, D, LED refdes) are turned: a part to ground stands
  with ground at the bottom, one between a rail and a signal stands with the rail on top, and
  anything else lies in the signal path, facing the pin it hangs from (a free diode anode
  first).
- **Shunt parts** (two-terminal parts from a signal net to ground or a rail: filter caps,
  pull-downs, clamps) hang under the net's wire (or stand over it, for a rail) beyond the pin
  that drives it. **Series parts** continue in line beyond the pin (clear of the bodies hung
  before them; their text hangs below the wire), and what hangs off their far end follows.
  Where no pin has room (crowded neighbouring pins), the part forms a group of its own.
- **Decoupling parts** (two-terminal parts on power nets only) are drawn in a row under the IC
  or connector they serve (beside it, on its left, when that side has no pins: an op-amp's
  supply unit): the nearest one declared before or after them that shares a rail. Declare a
  capacitor next to its IC to keep them together.
- **Connectors and other one-sided parts are mirrored** to face the circuit: a source whose
  pins point left, or a sink whose pins point right.
- **Reference and value text** keep the KiCad symbol's own placement when the part is drawn as
  its library has it. Otherwise (a generated symbol, a mirrored or turned part, any
  two-terminal part) they sit just right of an upright part, reference over value, or centred
  over the part, the value directly on it and the reference above. KiCad's font is wider than
  the viewer's, so text beside a turned part may sit slightly further out in the export.
- **Groups line up with what they connect to:** each is lowered (or the row before it is) so
  its first connection to a group already placed in the row runs straight, or drops into a pin
  pointing up (rises into one pointing down) instead of hooking back over it.
- The sheet goes on the smallest paper that holds it (A4 first), and generated symbols put a
  part's supply pins on top and grounds at the bottom (a regulator keeps its input on the
  left, in line with its output).

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

Symbols carry MPN, Manufacturer, Spec and distributor fields, so KiCad's own BOM tools work
too. Before writing, the layout's connectivity is re-derived from its geometry and compared with
the design; a difference is reported as a `layout.connectivity` error (a layout bug).

Refdes come from `annotation.lock`, which maps instance paths to flat references. A new part
keeps its local refdes when free; a clash (two blocks both with `C1`) takes the next free
number. Edit the lock to renumber. UUIDs are derived from names, so re-exporting the same
design produces identical files and "Update PCB from Schematic" keeps placement. The PCB file is
never written; stale sheets are removed only if Partstyle wrote them.

Unless `--no-check` is given and when kicad-cli is found, the export is then verified:

1. **Round trip:** `kicad-cli sch export netlist` re-derives the netlist from the written
   schematic, and it must match the design net for net. A mismatch is an exporter bug.
2. **ERC:** `kicad-cli sch erc` runs on the schematic; violations are listed.

The command fails (exit 1) on a round-trip mismatch, KiCad ERC errors or footprint pad errors.
Next step: open `kicad/<name>.kicad_pro`, then in the PCB editor run Tools > Update PCB from
Schematic.

### `kicad import PATH [--replace]`

Imports a KiCad project: a `.kicad_pro`, its root `.kicad_sch`, or a folder holding one project.
KiCad itself resolves the connectivity, so kicad-cli is required. It runs on a temporary copy of
the schematics; the KiCad files are never written. Without a `partstyle-project.yaml` the project
is created first (as `init` would); then:

| Written                 | Contents                                                   |
| ----------------------- | ---------------------------------------------------------- |
| `circuit/<block>.ckt`   | one block per sheet file; the root sheet is `main`         |
| `parts/<id>.yaml`       | draft records for symbols that match no library record     |
| `annotation.lock`       | each instance's KiCad refdes, so a later export keeps them |
| `notes/kicad-import.md` | nets that had no name, and the schematic's text notes      |

How KiCad maps onto blocks:

- **Sheets** become blocks; a sheet used twice is one block used twice. Nets that cross a sheet
  boundary become ports, named by the sheet's hierarchical (or global) labels. Port kinds are
  inferred: `ground` from the name, `power_out`/`power_in` from pin types or a rail name
  (`+5V`, `VCC`), otherwise from signal directions.
- **Net names** come from labels and power symbols. A net KiCad named automatically
  (`Net-(R1-Pad2)`) is named after a pin, `N_R1_2`, and listed for renaming.
- **PWR_FLAG** on a net becomes `{source: KiCad PWR_FLAG}`.
- **No-connect flags**: pins KiCad's ERC accepts as unconnected get
  `waive REF.PIN erc.unconnected-pin "no-connect flag in KiCad"`.
- **Parts** are matched in order: Partstyle's own Spec field (a design exported from here), the
  MPN field (also "Manufacturer Part Number" and similar), the LCSC field, then plain R, C, L
  and coloured LED symbols become generics (`res(10k, 1%, 0603)`) when the value parses and the
  footprint is Partstyle's standard chip footprint, then the value as an MPN or record id. A
  library record must have every pin number of the KiCad symbol.
- **Everything else** becomes a draft record per distinct symbol, value, footprint and MPN, built
  from KiCad's pin table (`~{RESET}` becomes `~RESET`), with `provenance.extracted_by: kicad`
  and footprint pads the symbol lacks as `nc` pins. Drafts may leave manufacturer, MPN, package
  and footprint empty. Each draft in use is a `part.draft` warning, the unresolved-parts
  worklist: identify the part, complete the record from its datasheet and set `extracted_by`,
  or switch the parts to another record.

Afterwards the imported design is validated and its connectivity compared with KiCad's netlist;
a mismatch is reported as an import bug. Symbols without pins (mounting holes, logos) are
skipped.

**Re-importing** (after editing in KiCad) replaces `circuit/` as one changeset, revertible like
any other, and reports the semantic diff. It keeps what KiCad cannot hold: part and net intents,
net attributes, port kinds, waivers and block descriptions, and the local refdes, net and port
names the design had (matched by `annotation.lock` and by pins). Drafts are remade; records
someone completed are left alone. A project with a design that was not imported needs
`--replace`. Exporting and re-importing an unchanged design gives no circuit changes; a value
changed in KiCad updates the generic's value.

### Finding KiCad

`kicad-cli` and the stock footprint and symbol libraries are located in this order:
`kicad.cli`, `kicad.footprints` and `kicad.symbols` in the [settings](#settings); the `KICAD_CLI`, `KICAD10_FOOTPRINT_DIR` / `KICAD9_FOOTPRINT_DIR` and
`KICAD10_SYMBOL_DIR` / `KICAD9_SYMBOL_DIR` environment variables; `PATH`; then the usual install
location (`C:\Program Files\KiCad\<version>\bin` on Windows, the highest version;
`/Applications/KiCad` on macOS; `/usr/bin` on Linux), with the libraries beside it. Without
KiCad, exports still work but skip the checks and use look-alike power symbols, and footprint
checks are skipped everywhere.

When the footprint libraries are found, `validate`, `overview` and `apply` also report
`part.footprint-pads` (error) and `part.footprint-missing` (warning) for the library parts in use.

## Viewer and review

### `view [--port N]`

Serves the live viewer for the project at `http://127.0.0.1:7766/` (or the next free port;
`--port 0` picks any) until Ctrl-C. The MCP server starts the same viewer automatically. The
page shows each sheet with the auto-layout described under `kicad export`, and updates within a
moment of any change to the project's files or its part libraries.

- **Navigate:** sheet buttons in the header, or double-click a sheet. Scroll to zoom, drag to
  pan.
- **Point:** click a part, pin, wire, label or sheet to select it; shift-click adds to the
  selection. The selection is what `focus` reports to the AI.
- **Inspect:** the side panel shows the part card (record, verification, datasheet, ratings,
  requirements, pins and their nets), the net card, and issues pinned to what they concern.
  Issues and comments also appear as markers on the sheet.
- **Comment:** attach a comment to the selected item; resolve it when done.
- **Verify:** "Mark verified" sets `verified_by: human` in an AI-extracted part record.
- **Arrange:** with a part or sheet selected, the Layout section moves its group a stage
  earlier or later (`[` / `]`), rotates a two-terminal part (`R`), flips it (`F`: mirrors a
  part, turns a two-terminal one half way), or returns it to automatic placement. Each edit
  writes a layout hint into the .ckt and is logged as a change; the first stage edit on a
  sheet also writes every group's current stage, so the rest stay put. Stage numbers show over
  the groups while a part of the sheet is selected.

The server listens on 127.0.0.1 only, refuses requests addressed to other host names, and accepts
writes only from its own page. Add `?live=0` to the URL for a static snapshot without the update
stream (for example, for screenshots).

### `focus`

What the person has selected in the viewer, described like `query` output, plus open comments
and the viewer's URL. The AI calls this when someone says "this" or "here".

```
selected in the viewer (viewing sheet MCU):
  MCU/U4 lib:ATMEGA328P-AU 8-bit AVR MCU, 32 KB flash, 2 KB SRAM, 1.8-5.5 V, TQFP-32 [unverified]
  pin MCU/U4.RESET (pin 29, input) on net MCU/RESET
open comments (1):
  c1 on MCU/R5: Is 10k strong enough for a reset line on a 2 m cable?
viewer: http://127.0.0.1:7766/
```

Review state lives in two files: `comments.yaml` (versioned with the design) and
`.partstyle/focus.json` (local, git-ignored). `overview` lists open comments too.

## MCP server

### `mcp [--project DIR | --projects-dir DIR] [--viewer-port N] [--no-viewer]`

Runs the MCP server on stdio until the client disconnects, with the viewer (as `view`, logging
its URL to stderr) in the same process. Must be the first argument: `-p` does not apply.

- `--project DIR`: serves that folder only.
- Otherwise, global mode: serves any project, opened by name with `open_project`. New projects
  go in `--projects-dir` (default `~/Documents/partstyle`), using its `library/` subfolder as
  their part library. `${HOME}`, `${DOCUMENTS}`, `${DESKTOP}` and `${DOWNLOADS}` in it are
  expanded; an empty value or any other `${...}` means the default. The viewer starts with the first project opened and follows later ones.
- `--viewer-port N` picks the viewer's port (0: any free port); `--no-viewer` skips it.

See [claude-code.md](claude-code.md) for the tools and client setup.

### `projects [--dir DIR]`

Lists the projects in DIR (default `~/Documents/partstyle`), then projects the MCP server has
opened elsewhere, most recent first (kept in `~/.partstyle/recent.json`, or in the folder
`PARTSTYLE_STATE_DIR` names).

```
projects in C:\Users\you\Documents\partstyle:
  bench-sensor
  psu
opened recently, elsewhere:
  D:\work\amp
```

## Versions

Git is the storage engine; these commands give it schematic vocabulary. Partstyle reads and
writes the repository itself, so git need not be installed, and the result is an ordinary
repository the git CLI can also drive. The project may be its own repository or a
folder inside a larger one (`init` creates a repository when it is in neither); checkpoints
commit only the project folder. The commit author is `user.name` and `user.email` from the
repository's or the global git config, else `Partstyle`. Git worktrees (a `.git` file pointing
at another repository's worktree list) are not supported.

- **Changeset:** one unit of change since the last checkpoint. Each `apply` is one; direct file
  edits become one per burst (edits less than a minute apart merge, roughly one turn of the
  AI's work). Changesets are recorded whenever any command or the viewer runs, compare
  statements rather than text (formatting, comments and pin order don't count), and live in
  `.partstyle/history.json`.
- **Checkpoint:** a commit of the project folder, the person's approval of the changes so far.
  It starts a new changeset log.
- **Variant:** a parallel version on its own branch, with a working copy of that branch under
  `.partstyle/variants/NAME` (git-ignored). The copy is a plain folder marked by
  `.partstyle-variant.json`; Partstyle's checkpoints there commit to the variant's branch (the
  git CLI run inside it sees the main repository instead).

The viewer's Changes tab shows all of this: changes since the checkpoint are highlighted on the
sheets (added green, modified amber), and each changeset or single statement can be reverted,
pending patches previewed, accepted or rejected, checkpoints made and variants opened, adopted
or removed.

### `diff [--since checkpoint|last|ID]`

Circuit changes statement by statement, grouped by block. `checkpoint` (default) compares with
the last checkpoint and also lists other changed files (context, part records, notes); `last`
compares with the previous `diff` call, which is how the AI catches up on the person's reverts
and edits at the start of a turn; an ID compares with that checkpoint.

```
since checkpoint 9aeabc8 "initial bench-sensor design" (2026-10-31 11:31):
power:
  ~ part C2 cap(220n, 16V, X7R, 0603) (was cap(100n, 16V, X7R, 0603))
sensor_afe:
  + part R9 res(1M, 1%, 0603) @ bleed SENSE to ground when the cable is unplugged
  ~ net SENSE +R9.1
```

A block added or removed as a whole is one line: `+ block mcu (circuit/mcu.ckt: 12 parts, 9 nets)`.

### `changes`

The changesets since the checkpoint with numbered statements (`C2.1`), and any pending patches.

### `revert C3|C3.2`

Undoes a changeset or one of its statements. A statement changed again since is left alone and
reported, so a revert never discards later work. The revert is itself a changeset.

### `checkpoint MESSAGE...` / `checkpoints`

`checkpoint` commits the project folder (everything git does not ignore) with the message.
`checkpoints` lists the last 20.

### Accept-before-apply: `pending accept|reject ID`

When the person ticks "Approve each AI edit before it lands" in the viewer's Changes panel (accept mode,
stored in `.partstyle/review.json` for this copy of the project), `apply` does not write: it
holds the patch as a pending change (`P1`, `P2`, ...) and reports what it would do. The person
previews it in the viewer and accepts it (then it applies, as a changeset) or rejects it. Direct
file edits still land immediately; the project's CLAUDE.md tells the AI to edit only through
`apply` in this mode. The AI cannot change the mode.

### `variant list|create|diff|adopt|remove [NAME]`

| Op            | Does                                                                               |
| ------------- | ---------------------------------------------------------------------------------- |
| `list`        | variants and how many statements each differs from the main line                   |
| `create NAME` | a new branch from the last checkpoint, copied out under `.partstyle/variants/NAME` |
| `diff NAME`   | main line → variant, statement by statement                                        |
| `adopt NAME`  | copies the variant's design files over the main line's, as one changeset           |
| `remove NAME` | deletes the working copy and its branch                                            |

Work on a variant like any project: `partstyle -p .partstyle/variants/NAME/<project path> ...`,
including its own checkpoints. The viewer opens it with `?variant=NAME`. Uncheckpointed changes
on the main line are not carried into a new variant. The MCP `variant` tool offers only `list`,
`create` and `diff`: adopting and removing are the person's decisions.

## Reference

| Command                 | Prints                                                            |
| ----------------------- | ----------------------------------------------------------------- |
| `prompt`                | the procedures, with their arguments                              |
| `prompt NAME [ARGS...]` | a procedure for the AI to follow (below)                          |
| `grammar`               | the `.ckt` and patch reference ([ckt-grammar.md](ckt-grammar.md)) |
| `schema part`           | the part-record JSON Schema                                       |
| `--help`                | the command summary                                               |
| `--version`             | `partstyle VERSION`: a release's version, or the source's         |

The procedures are the MCP server's prompts, printed for clients without prompt support. `init`
also writes them as Claude Code slash commands in `.claude/commands/`:

| Procedure                      | Slash command      | What the AI does                                                      |
| ------------------------------ | ------------------ | --------------------------------------------------------------------- |
| `design-review [BLOCK]`        | `/design-review`   | reviews against context and datasheets; findings to notes/review.md   |
| `ingest-part PART [DATASHEET]` | `/ingest-part`     | reads the datasheet once and writes the record (or completes a draft) |
| `prepare-handoff`              | `/prepare-handoff` | BOM, notes/pcb.md, KiCad export                                       |
