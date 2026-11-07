# Schematic layout

Partstyle draws every sheet automatically: the viewer shows it, and `kicad export` writes the
same drawing to KiCad. No geometry is stored. The layout is decided deterministically from the
circuit, so the same design always draws the same way, and there is nothing to arrange by hand.

The engine is the `@partstyle/layout` package in [layout/](../layout), which has a visual tester
for working on its rules. `packages/engine/src/drawing/adapter.ts` translates between it and the
rest of Partstyle.

## How a sheet is laid out

Every part is one of a few things, decided from how it connects:

- **Anchors** are ICs, connectors, transistors and child sheets. Their pins never move: an anchor
  is only ever placed, and a one-sided connector mirrored to face the circuit.
- **Hangers** run from a wire to a rail: a single shunt, or a chain such as a resistor and LED.
- **Series parts** run between two wires.
- **Decoupling** runs between two rails, with no signal wire at all.

Anchors are placed in columns along the signal flow, judged by which side their pins are on, then
by pin type and port direction. Each anchor pin then gets a row, a horizontal run carrying
everything on that net: hangers above or below the wire, series parts in line, and a port label
or the next anchor's pin at the end.

Rows are spaced to fit what hangs from them, and hangers step along so that each sits past the
rows it spans, which is what keeps fan-outs from crossing. Matching hangers on neighbouring rows
line up on stems of different lengths. A grid router connects whatever the rows do not.

- **Two-terminal parts** (R, C, L, F, FB, D, LED, Y refdes with two pins) are turned: a shunt
  hangs below its wire to ground and stands above it to a rail; a series part lies in the signal
  path.
- **Feedback parts**, with both ends on one anchor, stack above it. A part joining two neighbouring
  pins of one anchor, such as a crystal, bridges their rows.
- **Decoupling** is placed last, in the nearest empty space to the part sharing its supply rail,
  so it never pushes anything aside.
- **Groups** that share only rails are drawn separately, then packed in rows, largest first.
- The sheet goes on the smallest paper that holds it, A4 first. A long chain does not wrap.

## How nets are drawn

- **Power nets** (any net with power pins or a `ground`/`power_in`/`power_out` port) use KiCad
  power symbols from its `power` library: `power:GND`, `power:+5V` and so on when one is named
  after the net, otherwise `power:GND` (ground) or `power:VCC` with the net name as its value.
  They connect globally, so their ports get no sheet pins. The name is the bare net name, or the
  instance-qualified one (`PWR_+12V`) when two nets share a bare name. If a block used more than
  once would need different power names per instance, that net is drawn as a signal.
- **Power symbols point the conventional way:** rails up, ground down, and rails below ground
  down unless they sit on a part's top pin. A symbol sits directly on the pin where it can.
- **Power pins on the side of a part** run a short stub, then straight up or down to a symbol just
  past the part, crossing other pin wires if they must. Pins of one rail on one side share a wire
  and a symbol.
- **Rails that current runs along**, such as a regulator's input and output, are drawn as wires
  with their parts hanging from them.
- **Other nets** are wires. A net becomes labels instead when its wires would cross three or more
  others, wander far out of their way, or cannot be routed at all.
- **Labels** sit straight out from a side pin, or on a short step then sideways just past the part
  for a top or bottom pin. On a piece with wires of its own, a label hangs off the wire on a short
  stub so that the wire stays straight.
- **Ports** that are not power nets become sheet pins on the parent's sheet symbol. In the child
  sheet, the row ends in a hierarchical label, right beside the part where it fits.
- **Junction dots** mark every point where three or more things meet: pins, wires, power symbols
  and labels each count.
- **Unconnected pins** get no-connect flags.
- **PWR_FLAG** (`power:PWR_FLAG`) is added to every net drawn with power symbols or feeding
  `power_in` pins that has no `power_out` pin, i.e. power from outside the design (a
  `{source: ...}` rail, ground). It sits in free space beside one of the net's symbols, in a sheet
  where the net reaches real part pins.

## Text

A part lying down has its reference over its value above it, or below it if that is taken. A part
standing up has them to its right, or to its left. A large IC has them in the middle of its body.
Other ICs, connectors and child sheets have them over the top left corner. KiCad's font is wider
than the viewer's, so text may sit slightly differently in the KiCad export.

## Preferences

The Layout tab in the viewer's sidebar adjusts the spacing and the wire routing weights, and which
side decoupling prefers. These apply to the whole design, and the KiCad export follows them.
They are saved in the project file, leaving out anything still at its default:

```yaml
layout:
  label-fallback:
    detourLimit: 16
  decoupling-near-pin:
    side: below
```

A variant's project file can override them like any other setting. Rules themselves cannot be
turned off here: the full set of rules is only for tuning the engine, in the tester.

## Checks

Every sheet's connectivity is re-derived from its geometry and compared with the design; a
difference is a `layout.connectivity` error, which is a layout bug, not a design problem. The
viewer reports it among the issues. `kicad export` also has KiCad itself re-derive the netlist
from the written schematic (see [`kicad export`](cli.md#kicad-export---no-check)).
