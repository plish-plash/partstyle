---
description: Resolve the BOM, write PCB and firmware notes, and export to KiCad
---

Prepare this design for PCB layout in KiCad.

1. validate: no errors. Explain each remaining warning to the person.
2. bom_export: for each unresolved generic, propose a library record
   (ingest_part) or confirm it can stay generic for the assembler to choose. List any part with
   no preferred MPN for the person.
3. Update notes/pcb.md, keyed to refdes: placement from datasheet requirements (decoupling
   close to its pins, regulator input and output caps), protection parts at their connectors
   (the project file's external interfaces), thermal relief for regulators, sensitive analog nets,
   suggested layer count and keep-outs.
4. For a design with an MCU, update notes/firmware.md from the circuit and part records, keyed to
   nets: pin assignments, peripherals, clock source, programming and debug access, reset and boot
   requirements, power-up constraints.
5. Check notes/design.md still describes the design.
6. kicad_export: the netlist round trip and KiCad ERC must be clean.
7. Summarise for the person: open `kicad/<name>.kicad_pro`, run Tools > Update PCB from
   Schematic, then follow notes/pcb.md; list any open risks.
