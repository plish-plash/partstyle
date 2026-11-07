# `partstyle` CLI reference

```
partstyle [-p DIR] <command> [args] [options]
```

Every command works on one project folder: `-p/--project DIR`, or the current directory.
`--variant NAME` makes it work on one of the project's [variants](#variant-list--create-name-description--diffadoptremove-name)
instead of the main circuit (`apply` takes it several times). Each command except `init`,
`guide` reads the project fresh, so edits made by hand or by another tool are
always picked up.

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
| `approvals.yaml`         | parts signed off (see `approve`), once there are any               |
| `notes/design.md`        | how the design works now, kept up to date                          |
| `notes/decisions.md`     | decisions made with the person; append-only (see `decision`)       |
| `notes/pcb.md`           | layout notes, written at hand-off                                  |
| `notes/firmware.md`      | what firmware needs to know, written at hand-off                   |
| `CLAUDE.md`              | instructions for Claude Code: workflow and procedures              |
| `.claude/commands/`      | Claude Code slash commands for the procedures (see `guide`)        |

Later commands add `annotation.lock` and `bom.lock` (commit both), `bom.csv`, and the
generated KiCad project in `kicad/`.

If `CLAUDE.md` already exists, the instructions go to `CLAUDE.partstyle.md`; add the line
`@CLAUDE.partstyle.md` to your `CLAUDE.md` to load them.

```sh
partstyle init boards/thermo --name thermo
```

### The project file

`partstyle-project.yaml` marks a folder as a Partstyle project. It is plain YAML:

| Key                     | Meaning                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `partstyle_version`     | the Partstyle version that created the project (written by `init`)                                                       |
| `name`                  | the project's name (required)                                                                                            |
| `description`           | one or two sentences; `overview` leads with it                                                                           |
| `environment`           | `temp_c: [min, max]` is checked against part records; other keys are notes                                               |
| `assembly`, others      | free-form context for people and design review                                                                           |
| `external_interfaces`   | per connector: `connector` (instance path), `connects_to`, `signal`, `hazards`                                           |
| `sourcing.distributors` | distributors to use, in order: `lcsc`, `digikey`, `mouser`. `bom export` prefers them, and the viewer links only to them |
| `checks.cap_derating`   | capacitor voltage derating factor (default 1.5)                                                                          |

`external_interfaces` lists every connection to the outside world, the power input included:
what the person says the board will face at each connector. Hazards are for the AI and design
review to handle; the engine does not check them. Each is plain text, or
`{hazard: TEXT, accepted: WHY}` once the person accepts the risk.

The top block is always `main`, in `circuit/main.ckt`. A project file that is not valid YAML or
has no `name` is a `project.config` error and nothing else is checked; malformed design context
is a `context.invalid` warning and only the context checks are skipped. An interface whose
connector is not in the design is a `context.unknown-connector` warning once its block has parts.

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
the ten most important issues: errors, then warnings, with unconnected pins last.

### `read-block BLOCK [--detail summary|full]`

`full` (default) prints the block's `.ckt` file. `summary` prints only ports, parts with intent,
instances, net names with pin counts, `nc` pins and the number of waivers.

### `query EXPR...`

Targeted lookups on the flattened netlist; words are joined, so quoting is optional except for
shell characters like `<` and `>`.

| Query                    | Answer                                      |
| ------------------------ | ------------------------------------------- |
| `part REF`               | the part, and each pin with its net         |
| `net NAME`               | the net's attributes, joined names and pins |
| `parts [where COND ...]` | matching parts, one per line                |
| `nets [where COND ...]`  | matching nets with their pins               |
| `unconnected`            | every pin on no net, marking `nc` ones      |
| `help`                   | the syntax summary                          |

COND is `FIELD OP VALUE`, joined with `and`. OP is `= != < <= > >=` or `~` (contains,
case-insensitive). Quantities compare numerically (`35V > 5V`, `4.7k < 10k`). A part or net
missing the field never matches. A field no part or net in the design could have, such as a
misspelt one, fails and lists the fields that exist.

- Part fields: `path id preferred_mpn manufacturer package footprint kind fn value verified
  approved intent` and every rating in the part record (`vin_max`, or `vout.max` for a nested one).
  `verified` is `yes` or `no`, and only library parts have it. `approved` is `yes`, `no` or
  `changed`, so `approved != yes` finds everything still to sign off. Both also take `true` and
  `false`, for `yes` and `no`.
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
`file:line:col severity code message`, then a summary. Exits 1 if there are errors, which cannot
be waived. `--json` prints `{errors, warnings, waived, issues}`. Issue codes are listed in
[issues.md](issues.md).

Besides structural ERC, every validate (and so every `apply`) runs:

- **Pin limits.** A pin with `vmax` in its part record is checked against its net's voltage:
  the `voltage` attribute (`5V`, `12V ±10%`, `0-3.3V`), else 0 V for ground nets, else what a
  rail's name says (`+3V3` is 3.3 V). A net with none of these is not checked.
- **Capacitor polarity.** A polarized capacitor whose `+` net is entirely below its `-` net, when
  both voltages are known, is an error.
- **Capacitor ratings.** A capacitor with a voltage (a generic's argument, or its record's
  `generic` field) is an error when the voltage across it exceeds the rating, and a warning when
  the rating is under `checks.cap_derating` (default 1.5) times that voltage.
- **Datasheet requirements** that carry a check in the part record: `cap` (at least one
  capacitor of at least `min` from the pin to ground or `to`, or one per pin with `each`), `res`
  (a resistor within `min`..`max`) and `tie` (the pin on the same net as `to`). `to` is a pin of
  the part or a net name. Text-only requirements are left for design review.
- **Temperature.** Records with `temp_c` must cover the project file's `environment.temp_c`.

Broader design questions (protection, hazards, packages against the assembly method) are for the
AI and the `design_review` prompt, not the engine.

Overview counts records not yet verified by a person; validate does not repeat it.

## Editing

### `doc read FILE` / `doc write FILE [SRC|-]`

Reads or replaces a project document: `partstyle-project.yaml` or a Markdown file under
`notes/`, by its path in the project (other paths are refused). `write` takes the text from SRC
or stdin and creates folders under `notes/` as needed. A project file that would not load (not
YAML, or no `name`) is refused and nothing is written; otherwise the issues it now has are listed
(or `partstyle-project.yaml: no issues`). These exist for MCP clients without file tools
(`read_doc`, `write_doc`); from a shell, editing the files directly is the same.

`notes/decisions.md` is append-only, so `doc write` refuses it. A description over about 200
characters or several lines long gets a note that the design overview belongs in
`notes/design.md`.

### `approve all|REF...|where COND` / `unapprove ...`

Signs off parts, or takes that back. Parts are named by refdes, or by `query` conditions
(`approve where fn = res`). This is mainly the person's job in the viewer, where each sign-off
records them; from here it records the AI. An approval is per placed part in `approvals.yaml` and
covers the part's spec and the net on each pin, not its layout or intent. If either changes the
part shows as changed since approved, and reverting the change restores the approval. A variant
uses main's approvals until it makes its own.

### `decision TEXT...`

Adds a line with the date and time to the end of `notes/decisions.md`: a decision made with the
person, and why.
Line breaks in the text become spaces. Earlier entries are never touched. It is `add_decision` in
MCP.

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

Searches the part library; every word must appear somewhere in the record. Id and preferred MPN
matches rank first, then manufacturer, summary and package.

### `part get ID [--tier summary|pins|full]`

Reads a record at the lowest tier that answers the question: `summary` (identity, package,
ratings), `pins` (plus the pin table, requirements and notes, with any other keys they have) or
`full` (the YAML file). The first two end with `more: ...` when the record has free-form sections.

### `part put [FILE|-] [--scope global|project]`

Writes a YAML part record as `<id>.yaml`: to the first global library path when one is configured
(`global`, the default), otherwise to `parts/` (`project`). Project records override global
records with the same id. Leave `provenance.verified_by: null`; a human marks records verified.

Only a record without a usable `id`, `summary` or `pins`, or with an unknown pin type, is refused.
Everything else is written and reported: a field the engine can't use is a `warning:` line (and a
`part.format` warning while a design uses the record), and free-form sections are listed, which
also shows up a misspelt field. When KiCad's footprint libraries are found, a footprint that is
not in them or whose pads differ from the pin table is a `warning:` line too. Pads named `MP` are
mounting points and need no pin.

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

Each sheet is drawn as the viewer shows it, with wires, labels and KiCad power symbols. The rules
are in [layout.md](layout.md).

Power symbol definitions are copied from KiCad's installed `power.kicad_sym` so they match the
library exactly; without KiCad, built-in look-alikes with the same names are used.

**Part symbols** also come from KiCad's stock libraries when a suitable one exists:

1. Generics use `Device:R`, `Device:C`, `Device:L`, `Device:LED`, and `Device:D` (or
   `D_Schottky`, `D_Zener`, `D_TVS` for `diode(schottky|zener|tvs)`).
2. A part record's `kicad_symbol: Lib:Name` is used when set. Use it for parts KiCad does not
   name, such as connectors (`Connector_Generic:Conn_01x03`) and transistors (`Device:Q_NPN`).
3. Otherwise the libraries are searched by the record's id and preferred MPN: an exact name, a
   KiCad wildcard name (`MCP6002-xSN` for `MCP6002-I/SN`, `MCP1700x-330xxTT` for
   `MCP1700T-3302E/TT`), the longest name that is a prefix of the MPN followed by a letter
   (`L7805` for `L7805CV`), or the shortest name the id is a prefix of.

When a candidate's pin names pair up one to one with the record's but its numbers differ, as on
`Device:Q_NPN` (numbered `B C E`) or a pinout-specific symbol for another pinout, a copy
renumbered to the record's pads goes into `partstyle.kicad_sym`, and the export reports it.
Otherwise a candidate is used only if its pin numbers match the record exactly. It must also have no
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

The command fails (exit 1) on a round-trip mismatch or KiCad ERC errors. Only pins open by design
get a no-connect flag (see [issues.md](issues.md)),
so KiCad's ERC also reports a pin left open by mistake; the files are still written.
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
  `nc REF.PIN @ no-connect flag in KiCad`, unless they may stay open anyway.
- **Parts** are matched in order: Partstyle's own Spec field (a design exported from here), the
  MPN field (also "Manufacturer Part Number" and similar), the LCSC field, then plain R, C, L
  and coloured LED symbols become generics (`res(10k, 1%, 0603)`) when the value parses and the
  footprint is Partstyle's standard chip footprint, then the value as an MPN or record id. A
  library record must have every pin number of the KiCad symbol.
- **Everything else** becomes a draft record per distinct symbol, value, footprint and MPN, built
  from KiCad's pin table (`~{RESET}` becomes `~RESET`), with `provenance.extracted_by: kicad`
  and footprint pads the symbol lacks as `nc` pins, other than `MP` pads. Each draft in use is a `part.draft` warning, the unresolved-parts
  worklist: identify the part, complete the record from its datasheet and set `extracted_by`,
  or switch the parts to another record.

Afterwards the imported design is validated and its connectivity compared with KiCad's netlist;
a mismatch is reported as an import bug. Symbols without pins (mounting holes, logos) are
skipped.

**Re-importing** (after editing in KiCad) replaces `circuit/` as one changeset, revertible like
any other, and reports the semantic diff. It keeps what KiCad cannot hold: part and net intents,
net attributes, port kinds, `nc` statements (other than the ones import wrote), waivers and block
descriptions, and the local refdes, net and port
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
`part.footprint-pads` and `part.footprint-missing` warnings for the library parts in use.

## Viewer and review

### `view [--port N]`

Serves the live viewer for the project at `http://127.0.0.1:7766/` (or the next free port;
`--port 0` picks any) until Ctrl-C. The MCP server starts the same viewer automatically. The
page shows each sheet laid out as described in [layout.md](layout.md), and updates within a
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
- **Variant:** an alternative version of the design that shares every block it doesn't change
  (see [`variant`](#variant-list--create-name-description--diffadoptremove-name)). It is a
  folder of project files, so a checkpoint covers main and every variant.

The viewer's Changes tab shows all of this: changes since the checkpoint are highlighted on the
sheets (added green, modified amber), and each changeset or single statement can be reverted,
pending patches previewed, accepted or rejected, checkpoints made and variants created, adopted
or removed. The header's switcher picks which version of the design is shown.

### `diff [--since checkpoint|last|ID]`

Circuit changes statement by statement, grouped by block. `checkpoint` (default) compares with
the last checkpoint and also lists other changed files (context, part records, notes); `last`
compares with the previous `diff` call, which is how the AI catches up on the person's reverts
and edits at the start of a turn; an ID compares with that checkpoint. The MCP tool defaults to
`last`.

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

### `variant list | create NAME [DESCRIPTION...] | diff|adopt|remove NAME`

A variant explores an alternative to the same core circuit: another regulator in one block, or
what has to change for a hotter environment. It holds only what differs from main:

```
variants/buck/
  variant.yaml             # description; main's hash of each block when the variant copied it
  circuit/power.ckt        # replaces main's power block; every other block is main's
  partstyle-project.yaml   # optional: only the keys it overrides
```

- **Blocks.** The variant's design is main's `circuit/` with its own block files in place of
  main's of the same name. Editing a block the variant takes from main copies it in first; a
  block edited back to main's text is removed again, so the variant follows main for it. Main's
  blocks that the variant no longer uses are not warned about.
- **Project file.** The variant's file is merged over main's: mappings merge key by key, lists
  and single values replace main's, `null` removes a key. So `environment: {temp_c: [0, 85]}`
  changes only the temperature range; `doc read`/`doc write partstyle-project.yaml` in a variant
  read and write these overrides.
- **Working on variants.** `--variant NAME` makes any command work on that variant. `apply`
  takes `--variant` several times (`main` is the main circuit) and applies the patch to each,
  all or nothing. With `main` among them, a variant gets only the edits to blocks of its own:
  main's edit already reaches the rest. Changesets, pending patches, `diff --since last` and
  the export outputs (`bom.csv`, the locks, `kicad/`) are the variant's own, under
  `variants/NAME/`; the locks fall back to main's, so shared parts keep their refdes. KiCad
  import works on main only.
- **Shared.** Parts, notes, comments and checkpoints.

| Op                          | Does                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `list`                      | each variant: description, its own blocks and project file, and blocks main changed since the variant copied them                        |
| `create NAME [DESCRIPTION]` | an empty variant, the same as main                                                                                                       |
| `diff NAME`                 | main → variant, statement by statement, and where main moved on                                                                          |
| `adopt NAME`                | makes the variant's blocks and overrides main's (one changeset; comments in main's project file are kept); the variant then matches main |
| `remove NAME`               | deletes the variant's folder                                                                                                             |

The MCP `variant` tool offers only `list`, `create` and `diff`: adopting and removing are the
person's decisions.

## Reference

| Command       | Prints                                                    |
| ------------- | --------------------------------------------------------- |
| `guide`       | the topics below                                          |
| `guide TOPIC` | a reference or procedure (below)                          |
| `--help`      | the command summary                                       |
| `--version`   | `partstyle VERSION`: a release's version, or the source's |

| Reference topic | Contents                                                           |
| --------------- | ------------------------------------------------------------------ |
| `ckt`           | the `.ckt` language and patches ([ckt-grammar.md](ckt-grammar.md)) |
| `parts`         | the part record format ([part-records.md](part-records.md))        |
| `issues`        | every issue code ([issues.md](issues.md))                          |

The procedures are for the AI to follow. They are also the MCP server's prompts, and `init` writes
them as Claude Code slash commands in `.claude/commands/`:

| Procedure       | Slash command    | What the AI does                                                      |
| --------------- | ---------------- | --------------------------------------------------------------------- |
| `design-review` | `/design-review` | reviews against context and datasheets; findings to notes/review.md   |
| `ingest-part`   | `/ingest-part`   | reads the datasheet once and writes the record (or completes a draft) |
| `handoff`       | `/handoff`       | BOM, notes/pcb.md, notes/firmware.md, KiCad export                    |
