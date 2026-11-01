/**
 * Repeatable procedures for the AI, kept out of every conversation until needed. Served as MCP
 * prompts, printed by `partstyle prompt NAME`, and written into projects as Claude Code slash
 * commands, all from these definitions.
 */
export interface PromptArg {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptDef {
  /** MCP name (snake_case); the CLI and slash commands use the kebab-case form. */
  name: string;
  description: string;
  args: PromptArg[];
  render(args: Record<string, string | undefined>): string;
}

const designReview: PromptDef = {
  name: "design_review",
  description: "Structured review of the design against its context and part requirements",
  args: [{ name: "block", description: "Review only this block (default: all)", required: false }],
  render: ({
    block,
  }) => `Review ${block ? `block ${block} of ` : ""}this partstyle design. Report findings; do not change the circuit until the person agrees to each fix.

1. Gather: \`partstyle overview\`, \`partstyle validate\`, context.md, notes/decisions.md, then ${
    block ? `\`partstyle read-block ${block}\`` : "each block with `partstyle read-block`"
  }. For every library part, \`partstyle part get ID --tier pins\`.
2. Check, citing refdes and nets:
   - Each validate issue: its cause, and a fix or a waiver with a real reason.
   - Datasheet requirements not marked [checked]: is each one met, and how?
   - Each external interface in context.md: is every listed hazard handled at the connector
     (ESD, overvoltage, reverse polarity, shorts, cable length)? The engine checks ESD clamps,
     voltage hazards on signal pins and reverse-polarity parts; judge the rest.
   - Values against each \`@ intent\`: dividers, filter corners, gain, LED and pull-up currents.
   - Topology: decoupling, unused pins and amplifier halves, reset and boot pins, regulator
     stability (output capacitance and ESR), linear regulator dissipation, power sequencing,
     inputs that can float.
   - Parts: unverified or draft records, lifecycle, rating margins, temperature range and
     packages against context.md's environment and assembly method.
   - Manufacture and test: test points, programming and debug access, connector polarity.
3. Write the findings to notes/review.md, one line each, most severe first:
   \`- [critical|major|minor|note] SUBJECT: finding -> suggestion\`
4. Summarise for the person and ask which fixes to make.`,
};

const ingestPart: PromptDef = {
  name: "ingest_part",
  description: "Read a datasheet once and write its part record",
  args: [
    { name: "part", description: "Manufacturer part number", required: true },
    { name: "datasheet", description: "Datasheet URL or file", required: false },
  ],
  render: ({
    part,
    datasheet,
  }) => `Create the part record for ${part ?? "the part"}${datasheet ? ` from ${datasheet}` : ""}.

1. \`partstyle part search ${part ?? "MPN"}\`: if a record exists (or a KiCad import draft,
   extracted_by: kicad), complete it rather than adding another.
2. Read the datasheet once, then write the record (\`partstyle schema part\` has the schema):
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
3. \`partstyle part put\` it; fix any schema or footprint pad errors it reports.
4. Tell the person it awaits their verification in the viewer, and list anything the
   datasheet left ambiguous.`,
};

const prepareHandoff: PromptDef = {
  name: "prepare_handoff",
  description: "Resolve the BOM, write PCB notes and export to KiCad",
  args: [],
  render: () => `Prepare this design for PCB layout in KiCad.

1. \`partstyle validate\`: no errors. Explain each remaining warning to the person.
2. \`partstyle bom export\`: for each unresolved generic, propose a library record
   (ingest_part) or confirm it can stay generic for the assembler to choose.
3. Update notes/pcb.md, keyed to refdes: placement from datasheet requirements (decoupling
   close to its pins, regulator input and output caps), protection parts at their connectors
   (context.md's external interfaces), thermal relief for regulators, sensitive analog nets,
   suggested layer count and keep-outs.
4. \`partstyle kicad export\`: the netlist round trip and KiCad ERC must be clean.
5. Summarise for the person: open \`kicad/<name>.kicad_pro\`, run Tools > Update PCB from
   Schematic, then follow notes/pcb.md; list any open risks.`,
};

export const prompts: PromptDef[] = [designReview, ingestPart, prepareHandoff];

/** A prompt by MCP name or the CLI's kebab-case name. */
export const findPrompt = (name: string) => prompts.find((p) => p.name === name.replace(/-/g, "_"));

/** Claude Code slash command files (`.claude/commands/<name>.md`) for the prompts. */
export function slashCommands(): { file: string; text: string }[] {
  return prompts.map((p) => {
    const hint = p.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
    const args =
      p.args.length === 0
        ? ""
        : `\n\nArguments: $ARGUMENTS (${p.args.map((a) => `${a.name}: ${a.description.toLowerCase()}`).join("; ")})`;
    return {
      file: `.claude/commands/${p.name.replace(/_/g, "-")}.md`,
      text: `---\ndescription: ${p.description}\n${hint ? `argument-hint: ${hint}\n` : ""}---\n\n${p.render({})}${args}\n`,
    };
  });
}
