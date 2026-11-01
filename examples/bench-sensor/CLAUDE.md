# Circuit project: bench-sensor

This is a partstyle schematic project. The circuit is stored as connectivity (parts, pins, nets
and intent) in `circuit/*.ckt`. Never add coordinates, wires or label positions; the schematic
drawing is generated.

Commands below are the `partstyle` CLI; the partstyle MCP server has a tool for each.

## Before the first edit

1. Run `partstyle grammar` and follow it exactly.
2. Fill in `context.md` with the user: use case, environment, power source, assembly and every
   external interface with its hazards. Checks and design review use it.
3. Plan one block per functional area (power, mcu, sensor input, ...), each in its own
   `circuit/<block>.ckt`, instantiated and joined in `circuit/main.ckt` with `use`.

## Reading

Start cheap and drill down:

1. `partstyle overview`: blocks, part counts, issues, context
2. `partstyle read-block BLOCK --detail summary`, then `read-block BLOCK` for the full text
3. `partstyle query "part U1"`, `query "net +5V"`, `query "parts where vin_max < 15V"`
4. `partstyle part get ID` (tiers: summary, pins, full); prefer this to re-reading datasheets

## The person and the viewer

The person watches the design in the live viewer (`partstyle view`) as you edit it. They point
and comment there rather than typing refdes:

- When they say "this", "here" or "the selected part", run `partstyle focus`: it lists what
  they have selected and their open comments.
- Answer open comments; the person resolves them in the viewer.

## Review and versions

The person reviews your edits in the viewer as changesets (each `apply`, or each burst of
direct edits) and can revert any of them, whole or statement by statement. A checkpoint (a git
commit of the project) is their approval.

- Start each turn with `partstyle diff --since last`: what changed since you last looked,
  including the person's reverts and edits. Don't redo a change they reverted; ask instead.
- `partstyle diff` lists everything since the last checkpoint. Make a checkpoint
  (`partstyle checkpoint "message"`) only when the person asks for one.
- If `overview` says `review mode: accept`, edit only through `partstyle apply`: each patch
  waits as a pending change (P1, P2, ...) until the person accepts it in the viewer.
- To try an alternative (say an LDO against a buck stage), `partstyle variant create NAME`
  makes a parallel copy under `.partstyle/variants/NAME`; edit it with `partstyle -p` that
  folder and compare with `variant diff NAME`. The person adopts or removes it.

## Editing

Edit `circuit/*.ckt` directly, or send a batched patch with `partstyle apply` (stdin), which
reports only the issues your edit added or resolved. Run `partstyle validate` after direct edits
and fix or explain every issue.

- Use generics for passives: `res(10k, 1%, 0603)`, `cap(100n, 16V, X7R, 0603)`, `led(red, 0603)`.
  Use `lib:ID` for everything else. Find records with `partstyle part search`; add missing ones
  with `partstyle part put` (`partstyle schema part` prints the schema), taking pinouts from the
  datasheet. Leave `verified_by: null`: only a human verifies a record.
- A design imported from KiCad (`partstyle kicad import`) has draft records for symbols the
  library lacked, each a `part.draft` warning: identify the part with the person, then complete
  the record from its datasheet (or switch the parts to an existing record or a generic).
- Put an `@ intent` on every part and on nets whose purpose is not obvious.
- Record design rationale in `notes/decisions.md` and layout constraints in `notes/pcb.md`.
- Waive an issue only with a real reason in the waiver.

## Procedures

For these, follow the procedure exactly: `/design-review [block]`, `/ingest-part <mpn>
[datasheet]` and `/prepare-handoff` in Claude Code, or print it with `partstyle prompt NAME`.
Use ingest-part whenever you add a part record.

## Hand-off to KiCad

- `partstyle bom export` resolves generics to library parts and writes `bom.csv`. A generic
  stays unresolved until a library record's `generic:` field satisfies it, e.g.
  `generic: cap(100n, 50V, X7R, 10%, 0603)` on a concrete 100 nF part.
- `partstyle kicad export` writes `kicad/` and checks it with kicad-cli (netlist round trip and
  KiCad ERC). It draws parts with KiCad's own symbols, found by MPN; when it reports a
  generated symbol for a part KiCad has under another name (connectors, generic modules), set
  `kicad_symbol: Library:Symbol` in the part record. Never edit `kicad/*.kicad_sch`: change the .ckt files and export again. PCB layout
  happens in KiCad, and re-export never touches the PCB.
- Keep `annotation.lock` and `bom.lock` under version control: they hold refdes and part
  choices stable across exports.

## Conventions

- Refdes prefixes: R, C, L, D (diodes and LEDs), Q, U (ICs), J (connectors), Y (crystals),
  F (fuses), SW, TP. Unique within a block.
- Net names: rails as `+3V3`, `+5V`, `+12V`, `GND`; signals in UPPER_SNAKE_CASE.
- Each block declares a port for everything crossing its boundary: `ground` for GND,
  `power_out` for rails it supplies, `power_in` for rails it consumes, and
  `input`/`output`/`bidir`/`passive` for signals.
- Add `{voltage: ...}` to rails and to signals with a known range (`5V`, `12V ±10%`,
  `0-3.3V`); a rail named like `+3V3` is assumed to be that voltage. Checks compare it with
  pin limits (`vmax`) and capacitor ratings. A rail fed from a connector or through a passive
  part (fuse, diode) has no `power_out` pin, so add `{source: ...}`.
- Give passives a voltage or power rating where it matters: `cap(10u, 25V, X5R, 0805)`.

## Example block

```
block power "12 V barrel input, 5 V linear rail"

port +5V : power_out
port GND : ground

part J1 lib:barrel_jack_2.1mm       @ 12 V wall adapter input
part D1 lib:1N5819                  @ reverse-polarity protection
part U1 lib:L7805CV
part C1 cap(330n, 50V, X7R, 0603)   @ per U1 datasheet input cap
part C2 cap(100n, 16V, X7R, 0603)   @ per U1 datasheet output cap

net VIN_RAW : J1.TIP D1.A           {voltage: 12V ±10%}
net +12V    : D1.K U1.IN C1.1       {voltage: 11.5V, source: J1 through D1}
net +5V     : U1.OUT C2.1           -> port +5V {voltage: 5V}
net GND     : J1.SLEEVE J1.SWITCH U1.GND C1.2 C2.2 -> port GND
```

and in `main.ckt`: `use power as PWR`, then `net +5V : PWR.+5V MCU.+5V`.
