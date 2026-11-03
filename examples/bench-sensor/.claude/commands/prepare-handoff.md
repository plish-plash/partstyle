---
description: Resolve the BOM, write PCB notes and export to KiCad
---

Prepare this design for PCB layout in KiCad.

1. `partstyle validate`: no errors. Explain each remaining warning to the person.
2. `partstyle bom export`: for each unresolved generic, propose a library record
   (ingest_part) or confirm it can stay generic for the assembler to choose.
3. Update notes/pcb.md, keyed to refdes: placement from datasheet requirements (decoupling
   close to its pins, regulator input and output caps), protection parts at their connectors
   (the project file's external interfaces), thermal relief for regulators, sensitive analog nets,
   suggested layer count and keep-outs.
4. `partstyle kicad export`: the netlist round trip and KiCad ERC must be clean.
5. Summarise for the person: open `kicad/<name>.kicad_pro`, run Tools > Update PCB from
   Schematic, then follow notes/pcb.md; list any open risks.
