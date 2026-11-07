# Circuit project: bench-sensor

This is a Partstyle schematic project. The circuit is stored as connectivity (parts, pins, nets
and intent) in `circuit/*.ckt`. Never add coordinates, wires or label positions; the schematic
drawing is generated.

Commands below are the `partstyle` CLI; the Partstyle MCP server has a tool for each.

## Before the first edit

1. Run `partstyle guide ckt` and follow it exactly; it includes the naming conventions and an
   example block.
2. Fill in `partstyle-project.yaml` with the user: a description of one or two sentences, environment,
   assembly, and every external interface (each connection to the outside world, the power input
   included) with the hazards the user names for it. It also holds the project's name and
   settings (distributors, capacitor derating).
3. Plan one block per functional area (power, mcu, sensor input, ...), each in its own
   `circuit/<block>.ckt`, instantiated and joined in `circuit/main.ckt` with `use`.

## Reading

Start cheap and drill down:

1. `partstyle overview`: blocks, part counts, issues, context
2. `partstyle read-block BLOCK --detail summary`, then `read-block BLOCK` for the full text
3. `partstyle query "part U1"`, `query "net +5V"`, `query "parts where vin_max < 15V"`
4. `partstyle part get ID` (tiers: summary, pins, full): a record caches its datasheet, so read
   this instead

## The person and the viewer

The person watches the design in the live viewer (`partstyle view`) as you edit it. They point
and comment there rather than typing refdes:

- When they say "this", "here" or "the selected part", run `partstyle focus`: it lists what
  they have selected and their open comments.
- Answer open comments; the person resolves them in the viewer.

## Review and versions

The person reviews your edits in the viewer as changesets (each `apply`, or each burst of
direct edits) and can revert any of them, whole or statement by statement. They sign off
parts one at a time as they check them, and a part changed since shows as such.

- Start each turn with `partstyle diff --since last`: what changed since you last looked,
  including the person's reverts and edits. Don't redo a change they reverted; ask instead.
- Approve parts for the person only when they ask: `partstyle approve where fn = res`, or `all`
  or refdes. `partstyle query "parts where approved = changed"` lists what needs another look.
- If `overview` says `review mode: accept` (the person's switch in the viewer), edit only
  through `partstyle apply`: each patch waits as a pending change (P1, P2, ...) until the person
  accepts it in the viewer.
- To explore an alternative (say a buck stage instead of the LDO), `partstyle variant create
  NAME "what it explores"`. A variant shares every block it doesn't change, so edits to main
  reach it. Pass `--variant NAME` to any command; `apply` takes `--variant` several times
  (`main` is the main circuit) to change several versions at once. A variant's own blocks are in
  `variants/NAME/circuit/`, and its `partstyle-project.yaml` holds only overrides of main's. Compare
  with `variant diff NAME`; the person adopts or removes it.

## Editing

Edit `circuit/*.ckt` directly, or send a batched patch with `partstyle apply` (stdin), which
reports only the issues your edit added or resolved. Run `partstyle validate` after direct edits.

Do what the person asked. Fix errors your own edit caused; anything else that changes the design
(protection, extra parts, waivers, fixes for warnings) is the person's call: raise it with a
suggested fix.

- Errors are design faults: fix them. They cannot be waived, and one that looks wrong is a
  Partstyle bug to raise with the person. Warnings need a fix or the person's decision.
- Mark a pin left open on purpose with `nc U2.GAIN* @ open = gain 20`, not a waiver.
- The engine does not check an interface's hazards: handle them in the design. If the person
  accepts one, record it in the project file as `{hazard: ESD, accepted: why}`.
- Use generics for passives: `res(4.7k, 1%, 0603)`, `cap(100n, 16V, X7R, 0603)`, `led(red, 0603)`.
  Use `lib:ID` for everything else. Find records with `partstyle part search`; add missing ones
  with `partstyle part put` (`partstyle guide parts` has the format), only for parts you know
  exist (from memory or a datasheet), never an MPN extrapolated from a series. A record caches
  the datasheet: put everything in it, in sections of your own where no field fits. Leave
  `verified_by: null`: only a human verifies a record.
- A design imported from KiCad (`partstyle kicad import`) has draft records for symbols the
  library lacked, each a `part.draft` warning: identify the part with the person, then complete
  the record from its datasheet (or switch the parts to an existing record or a generic).

## Project knowledge

Keep each thing in its place; the project file's description stays a short summary.

- `notes/design.md`: how the design works now, by block. Write it once the design takes shape,
  and rewrite it when its structure or approach changes.
- `notes/decisions.md`: append-only. Whenever the person chooses between options, accepts a risk
  or overrules a suggestion, add it with `partstyle decision "what, and why"`. Don't edit the
  file.
- `notes/pcb.md` and `notes/firmware.md`: written at hand-off, not as you go.

## Procedures

For these, follow the procedure exactly: `/design-review [block]`, `/ingest-part <mpn>
[datasheet]` and `/handoff` in Claude Code, or print it with `partstyle guide NAME`. They name
MCP tools; each has a command here (`part_get` is `partstyle part get`). Use ingest-part whenever
you add a part record.

## Hand-off to KiCad

Export only when the person asks.

- `partstyle bom export` resolves generics to library parts and writes `bom.csv`. A generic
  stays unresolved until a library record's `generic:` field satisfies it, e.g.
  `generic: cap(100n, 50V, X7R, 10%, 0603)` on a concrete 100 nF part.
- `partstyle kicad export` writes `kicad/` and checks it with kicad-cli (netlist round trip and
  KiCad ERC). It draws parts with KiCad's own symbols, found by MPN; when it reports a
  generated symbol for a part KiCad has under another name (connectors, transistors, generic
  modules), set `kicad_symbol: Library:Symbol` in the part record. Never edit `kicad/*.kicad_sch`: change the .ckt files and export again. PCB layout
  happens in KiCad, and re-export never touches the PCB.
- Keep `annotation.lock` and `bom.lock` under version control: they hold refdes and part
  choices stable across exports.
