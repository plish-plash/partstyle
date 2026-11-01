---
description: Read a datasheet once and write its part record
argument-hint: <part> [datasheet]
---

Create the part record for the part.

1. `partstyle part search MPN`: if a record exists (or a KiCad import draft,
   extracted_by: kicad), complete it rather than adding another.
2. Read the datasheet once, then write the record (`partstyle schema part` has the schema):
   - Identity: manufacturer, the exact orderable MPN, id (the MPN with / as _), a one-line
     summary with key ratings and package, package, and a KiCad footprint (Library:Footprint
     from KiCad's standard libraries) whose pads match the pin table. Set kicad_symbol when
     KiCad has the symbol under another name.
   - pins: every pad by number, with the datasheet name (~ for active low, e.g. ~RESET) and
     type: power_in, power_out, input, output, bidir, tristate, passive, open_collector,
     open_emitter or nc. Include exposed pads. Give supply and input pins vmax: their absolute
     maximum relative to ground.
   - ratings: the limits a designer checks (vin_max, iout_max, ...) and temp_c: [min, max],
     the operating range of this grade.
   - requirements: each external part or condition the datasheet asks for, as text; add a
     check where it fits: cap {from, to, min, each}, res {from, to, min, max} or tie {from, to}.
   - notes: gotchas a designer would otherwise miss.
   - provenance: datasheet url, extracted_by: ai, verified_by: null.
3. `partstyle part put` it; fix any schema or footprint pad errors it reports.
4. Tell the person it awaits their verification in the viewer, and list anything the
   datasheet left ambiguous.

Arguments: $ARGUMENTS (part: manufacturer part number; datasheet: datasheet url or file)
