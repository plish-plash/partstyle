---
description: Read a datasheet once and write its part record
argument-hint: <part> [datasheet]
---

Create the part record for the part.

1. part_search MPN: if a record exists (or a KiCad import draft,
   extracted_by: kicad), complete it rather than adding another.
2. guide parts has the format and a worked example. Read the datasheet once, then
   write the record so that nobody needs the datasheet again: everything a designer could want,
   in sections of your own where no field fits.
   - Identity: the part's name without ordering codes as the id, a one-line summary with key
     ratings and package, the orderable part as preferred_mpn, package and a KiCad footprint.
     Set kicad_symbol for discretes and anything else KiCad doesn't name. A passive, LED or diode
     also gets generic, what it offers (`cap(100n, 50V, X7R, 10%, 0603)`): it then draws like that
     generic, and the BOM offers it as a candidate.
   - pins: every pad by number, with the datasheet name and type. Give supply and input pins
     vmax, and unused where the datasheet says a pin may float or must be connected.
   - ratings, temp_c, requirements (with a check where one fits), notes, and characteristics,
     tables, timing, thermal data and application circuits as sections of your own.
   - provenance: datasheet url, extracted_by: ai, verified_by: null.
3. part_put it. It reports what the engine couldn't use and any pad mismatch with the
   footprint: fix what is your mistake, and tell the person about the rest.
4. Tell the person it awaits their verification in the viewer, and list anything the
   datasheet left ambiguous.

Arguments: $ARGUMENTS (part: manufacturer part number; datasheet: datasheet url or file)
