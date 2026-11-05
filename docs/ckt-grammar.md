# .ckt grammar reference

One statement per line. `#` starts a comment. Nothing has coordinates.

```
block NAME "description"                          # first statement; one block per file
port  NAME : KIND                                 # KIND: power_in power_out ground input output bidir passive
part  REF lib:ID           [[layout]] [@ intent]  # a record from the part library
part  REF FN(arg, ...)     [[layout]] [@ intent]  # generic, resolved to an MPN at BOM time
net   NAME : PINREF... [-> port NAME] [{key: value, ...}] [@ intent]
use   BLOCK as INST        [[layout]] [@ intent]  # instantiate another block
nc    REF.PIN                         [@ intent]  # a part pin left open on purpose
waive SUBJECT CODE "reason"                       # suppress a warning
```

- **Names** are any run of characters without whitespace or `: { } ( ) , [ ] " @ #`, so `+12V`
  and `VINA+` are fine. Refdes, net, port and instance names must not contain `.` or `/`.
- **PINREF** is `REF.PIN` or `INST.PORT`. `PIN` is a pin number (`C1.1`, `U4.22`) or a pin name
  (`U1.OUT`). A name shared by several pins (`U4.GND`) connects all of them.
- A pin may appear in only one net. List every pin of a net on its one line.
- **`-> port NAME`** exports the net as one of the block's declared ports. Each declared port
  must be bound to exactly one net. In the parent, `INST.PORT` joins that net to a parent net.
- **`@ intent`** runs to the end of the line. It records why a part or net is there.
- **Net attributes** are free text values: `{voltage: 12V ±10%, source: J1 through D1}`.
  `source` tells ERC that a rail with no `power_out` pin is supplied from elsewhere.
- **Generics**: `res`, `cap`, `ind` (pins 1, 2) take a value first; `led` (color) and `diode`
  (kind) have pins K (1), A (2). Further arguments, in any order, are recognized by form:
  voltage `16V`, current `1A`, power `0.1W`, tolerance `1%`, dielectric `X7R`/`C0G`, package
  `0603`/`SOD-123`. Values use SI prefixes: `330n`, `4k7`, `10uF`. A chip package (`0603`)
  gives the part a footprint even before it resolves to an MPN.
- **`nc`** says a pin stays open by design: `nc U2.GAIN1 @ open = gain 20`. A `*` in the pin
  (`nc U4.PB* @ spare GPIO`) covers the matching pins that are open. A pin named outright must not
  be on a net, and a power pin cannot be `nc`.
- **Waivers**: only warnings can be waived; errors are design faults that must be fixed. SUBJECT
  is a refdes, pinref or net, relative to the block, where `*` matches anything (`U4.PD*`), and
  CODE is the issue code. Waivers are the person's decision. Unused waivers are reported.

## Layout hints

`part R4 res(100k) [2 r90]`, `part J2 lib:X [1 flip]`, `use filter as F1 [3]`: how the human
arranged the drawing in the viewer. Each item is optional; whatever is left out is chosen
automatically. They change only the drawing, never the circuit.

- **Stage** (`1`, `2`, ...): position in the signal chain. A sheet is drawn as groups (a part with
  the passives that ride along with it: decoupling, shunts, series parts) placed left to right
  by stage, wrapping onto new rows. Groups with the same stage share a column: side by side
  while they fit its width, else stacked. A stage on a passive
  gives it a group of its own.
- **`r0` `r90` `r180` `r270`**: rotation of a two-terminal part (R, C, L, F, FB, D, LED).
- **`flip` / `noflip`**: mirror anything else left to right, or keep it as the library draws it.

Keep hints when editing a statement: `= part R4 res(220k)` without brackets keeps R4's hint, and
`[]` clears it. A diff reports layout-only edits as one line per block.

## Hierarchy

```
block main
use power as PWR
use mcu   as MCU
net +3V3 : PWR.+3V3 MCU.+3V3
net GND  : PWR.GND MCU.GND
```

Parts inside an instance get path names (`PWR/U1`), and so do nets that are not joined to a
parent net (`PWR/VIN_RAW`). The top block is always `main`, in `circuit/main.ckt`.

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
- Put an `@ intent` on every part and on nets whose purpose is not obvious.

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

## Patches (`apply`)

A patch is a batch of edits, one per line, applied all-or-nothing:

```
in power                          # block to edit; optional if the project has one block
+ part C13 cap(47u, 25V) @ bulk   # add a statement (error if the key exists)
= part U2 lib:MCP1700-3302   # replace the statement with the same kind and key
- part D2                         # remove; also drops D2's pins from nets (part|net|port|use|nc|waive)
net +12V += C13.1 C13.2           # connect pins to an existing net
net GND  -= C3.2                  # disconnect pins
rename part C13 C20               # also rewrites pinrefs, nc and waivers (part|use|net)
in sensor_ref                     # a new block: its first edit must be
+ block sensor_ref "2.5 V ref"    #   '+ block NAME', creating circuit/NAME.ckt
```

Keys: part REF, net NAME, port NAME, use INST, nc REF.PIN, waive SUBJECT. Edited lines are rewritten in
canonical spacing; untouched lines keep their formatting. The reply lists the edits and only
the issues they added or resolved. Use `dry_run` to preview.

## Issue codes

An error is a design fault that must be fixed: it cannot be waived, and it blocks export. A
warning asks for a fix or the person's decision.

| Code                                                             | Severity                           | Meaning                                                                |
| ---------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| `parse.syntax`, `parse.missing-block`                            | error                              | malformed statement                                                    |
| `elab.unknown-part/-pin/-ref/-port/-block/-top`                  | error                              | name does not resolve                                                  |
| `elab.duplicate-ref/-net/-port/-block`, `elab.port-bound-twice`  | error                              | declared twice                                                         |
| `elab.pin-multiple-nets`                                         | error                              | pin on two nets (a short)                                              |
| `elab.nc-connected`                                              | error                              | pin named by `nc` is on a net                                          |
| `elab.unbound-port`, `elab.bad-generic`, `elab.recursive-use`    | error                              |                                                                        |
| `erc.unconnected-pin`                                            | error for `power_in`, else warning | pin on no net that must not be open (below)                            |
| `erc.output-conflict`                                            | error                              | outputs of two parts on one net                                        |
| `erc.unsourced-power`                                            | error                              | `power_in` pins, no `power_out`, no `source`, no ground port           |
| `erc.single-pin-net`, `erc.undriven-input`, `erc.unused-port`    | warning                            |                                                                        |
| `elab.unused-block`, `elab.attr-conflict`, `waive.unused`        | warning                            |                                                                        |
| `patch.error`                                                    | error                              | patch rejected; nothing was applied                                    |
| `layout.connectivity`, `layout.failed`                           | error                              | auto-layout bug: the drawing does not match the design                 |
| `layout.bad-hint`                                                | warning                            | a rotation on a part that only flips, or a flip on one that turns      |
| `part.footprint-pads`                                            | warning                            | record's pins and footprint pads differ (`MP` pads aside)              |
| `part.footprint-missing`, `bom.unresolved`, `kicad.no-footprint` | warning                            | KiCad has no such footprint; no part fits a generic; no footprint      |
| `part.format`                                                    | warning                            | a record in use has a field the engine cannot read                     |
| `part.schema`, `part.yaml`                                       | warning                            | a library file is unusable; a design using it gets `elab.unknown-part` |
| `kicad.symbol-fallback`                                          | warning                            | a record's `kicad_symbol` does not fit; a symbol was generated         |
| `part.draft`                                                     | warning                            | a KiCad import draft record is in use; complete or replace it          |
| `part.overvoltage`                                               | error                              | a pin's `vmax` is below its net's voltage                              |
| `part.cap-voltage`                                               | error over rating, else warning    | capacitor rated below the voltage across it, or under derating         |
| `part.requirement`                                               | warning                            | a datasheet requirement with a check is not met                        |
| `context.temperature`                                            | warning                            | part outside context's temperature range                               |
| `context.unknown-connector`, `context.invalid`                   | warning                            | interface names no part; the design context is malformed               |
| `project.config`                                                 | error                              | project file is not YAML or has no `name`; nothing else is checked     |
