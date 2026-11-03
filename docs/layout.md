# Schematic layout

Partstyle draws every sheet automatically: the viewer shows it, and `kicad export` writes the
same drawing to KiCad. No geometry is stored. The layout is decided in one deterministic pass
from the circuit and a few layout hints, so the same design always draws the same way.

## Groups, stages and rows

Parts are drawn in **groups**: a part (or child sheet) with the passives that ride along with
it (decoupling, shunts and series parts, below). Groups are placed left to right by **stage**
along the signal flow, and the stages wrap onto new rows when the paper is full. A stage is as
wide as its widest group; its groups go side by side while they fit that width, and stack below
when not (LED chains under a regulator sit in a row rather than a tall column).

Nets between groups in consecutive stages of one row are drawn as wires; nets that reach
further are labelled (see [How nets are drawn](#how-nets-are-drawn)).

## Steering the layout

Layout hints on `part` and `use` lines fix what would otherwise be chosen automatically: a
group's stage, a two-terminal part's rotation, or whether anything else is mirrored
(`[2 r90 flip]`; the syntax is in [ckt-grammar.md](ckt-grammar.md#layout-hints)). They change
only the drawing, never the circuit.

The viewer writes them: select a part or sheet and use its Layout section (see
[`view`](cli.md#view---port-n)); while a part is selected, each stage's number shows at the top
of its column. The stage buttons move the selected part's whole group, even
when the part rides in another's; the first stage edit on a sheet writes every group's current
stage, so the others stay where they are. A stage written by hand on a passive gives it a group
of its own.

## Default placement

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
- **Groups line up with what they connect to:** each is lowered (or the row before it is) so
  one of its wires to a group already placed in the row runs straight, or drops into a pin
  pointing up (rises into one pointing down) instead of hooking back over it. It follows a
  group in the stage just before where it can, then a wire signal flows along (into its left
  side), then whichever needs the smallest move, and never moves more than 25 mm for it.
- The sheet goes on the smallest paper that holds it (A4 first), and generated symbols put a
  part's supply pins on top and grounds at the bottom (a regulator keeps its input on the
  left, in line with its output).

## How nets are drawn

- **Small nets** (2–6 connections in a sheet: pins, sheet pins and its hierarchical label)
  whose groups sit in consecutive stages of one row are routed as orthogonal wires on the
  2.54 mm pin grid, with junction dots where three wires meet or two meet at a pin. Ones
  reaching further get a local label (or hierarchical label, for a port) on each piece, and so
  do ones whose wire would cross three or more others, or run more than 20 mm further than the
  distance between its ends between two groups (wrapping around a part; a feedback loop around
  its own part is fine), or that cannot be routed at all.
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
  connection); crossing a wire, or text crowding a part, is the lesser evil. At the end of a
  row of hung parts, the label sits on the end of the row's wire.
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

## Text

Reference and value text keep the KiCad symbol's own placement when the part is drawn as its
library has it. Otherwise (a generated symbol, a mirrored or turned part, any two-terminal
part) they sit just right of an upright part, reference over value; beside the rightmost pin on
top of a part with pins there, reference over value, left-aligned; or else centred over the
part, the value directly on it and the reference above. KiCad's font is wider than the viewer's, so
text beside a turned part may sit slightly further out in the KiCad export.

## Checks

Every sheet's connectivity is re-derived from its geometry and compared with the design; a
difference is a `layout.connectivity` error, which is a layout bug, not a design problem. The
viewer reports it among the issues. `kicad export` also has KiCad itself re-derive the netlist
from the written schematic (see [`kicad export`](cli.md#kicad-export---no-check)).
