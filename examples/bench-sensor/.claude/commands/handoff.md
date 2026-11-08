---
description: Assign real parts, write PCB and firmware notes, and export to KiCad
---

Prepare this design for PCB layout in KiCad.

1. validate: no errors. Explain each remaining warning to the person, and list any part not yet
   approved (query parts where approved != yes).
2. bom_export lists each generic not yet replaced with a real part. For each, propose a part to
   the person: a listed candidate or a part_search result, parts in inventory first, or a new
   record (ingest_part) if none fits. Apply the ones they agree to with
   `= part REF lib:ID [layout] @ intent`, keeping the line's layout and intent, since = replaces
   the whole statement. A generic stays only if they confirm it (the assembler chooses). Then
   bom_export again, and list any part with no preferred MPN for the person. Add the parts
   chosen to the design record (record_change).
3. Write notes/pcb.md (or update it), keyed to refdes: placement from datasheet requirements (decoupling
   close to its pins, regulator input and output caps), protection parts at their connectors
   (the project file's external interfaces), thermal relief for regulators, sensitive analog nets,
   suggested layer count and keep-outs.
4. For a design with an MCU, write notes/firmware.md (or update it) from the circuit and part records, keyed to
   nets: pin assignments, peripherals, clock source, programming and debug access, reset and boot
   requirements, power-up constraints.
5. Check notes/design.md describes the design as it is now (write it if there is none).
6. kicad_export: the netlist round trip and KiCad ERC must be clean.
7. Summarise for the person: open `kicad/<name>.kicad_pro`, run Tools > Update PCB from
   Schematic, then follow notes/pcb.md; list any open risks.
