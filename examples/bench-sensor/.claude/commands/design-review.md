---
description: Structured review of the design against its context and part requirements
argument-hint: [block]
---

Review this Partstyle design. Report findings; do not change the circuit until the person agrees to each fix.

1. Gather: overview, validate, partstyle-project.yaml, notes/design.md, notes/design-record.md, then each block with read_block. For every library part, part_get with tier pins. A choice in notes/design-record.md is
   not a finding unless something has changed since.
2. Check, citing refdes and nets:
   - Each validate issue: its cause and a fix. Errors must be fixed; a warning may instead get a
     waiver with a real reason, if the person agrees.
   - Datasheet requirements not marked [checked]: is each one met, and how?
   - Each external interface in the project file: is every listed hazard handled at the connector
     (ESD, overvoltage, reverse polarity, shorts, fusing, cable length)? The engine does not check
     hazards, so this review is the only check. A hazard marked accepted is the person's decision;
     note it and move on. Flag any connection to the outside world the project file leaves out.
   - Values against each `@ intent`: dividers, filter corners, gain, LED and pull-up currents.
   - Topology: decoupling, unused pins and amplifier halves, reset and boot pins, regulator
     stability (output capacitance and ESR), linear regulator dissipation, power sequencing,
     inputs that can float.
   - Parts: unverified or draft records, lifecycle, rating margins, temperature range and
     packages against the project file's environment and assembly method.
   - Manufacture and test: test points, programming and debug access, connector polarity.
   - BOM consolidation: fewer distinct parts to buy. The same value at different voltages,
     tolerances, dielectrics or packages where the better part serves all of them; close values
     where the exact one doesn't matter (pull-ups, LED resistors, decoupling); two parts doing one
     job. Prefer parts in inventory (query parts where in_inventory = yes) and parts already in the
     design. A suggestion must keep every rating and the `@ intent` it replaces.
3. Write the findings to notes/review.md, one line each, most severe first:
   `- [critical|major|minor|note] SUBJECT: finding -> suggestion`
4. Summarise for the person and ask which fixes to make.

Arguments: $ARGUMENTS (block: review only this block (default: all))
