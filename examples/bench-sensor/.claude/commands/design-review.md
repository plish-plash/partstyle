---
description: Structured review of the design against its context and part requirements
argument-hint: [block]
---

Review this partstyle design. Report findings; do not change the circuit until the person agrees to each fix.

1. Gather: `partstyle overview`, `partstyle validate`, context.md, notes/decisions.md, then each block with `partstyle read-block`. For every library part, `partstyle part get ID --tier pins`.
2. Check, citing refdes and nets:
   - Each validate issue: its cause, and a fix or a waiver with a real reason.
   - Datasheet requirements not marked [checked]: is each one met, and how?
   - Each external interface in context.md: is every listed hazard handled at the connector
     (ESD, overvoltage, reverse polarity, shorts, cable length)? The engine checks ESD clamps,
     voltage hazards on signal pins and reverse-polarity parts; judge the rest.
   - Values against each `@ intent`: dividers, filter corners, gain, LED and pull-up currents.
   - Topology: decoupling, unused pins and amplifier halves, reset and boot pins, regulator
     stability (output capacitance and ESR), linear regulator dissipation, power sequencing,
     inputs that can float.
   - Parts: unverified or draft records, lifecycle, rating margins, temperature range and
     packages against context.md's environment and assembly method.
   - Manufacture and test: test points, programming and debug access, connector polarity.
3. Write the findings to notes/review.md, one line each, most severe first:
   `- [critical|major|minor|note] SUBJECT: finding -> suggestion`
4. Summarise for the person and ask which fixes to make.

Arguments: $ARGUMENTS (block: review only this block (default: all))
