import { PROJECT_FILE } from "./project/config.js";

/**
 * Repeatable procedures for the AI, kept out of every conversation until needed. Read with guide,
 * offered in clients' menus as MCP prompts, and written into projects as Claude Code slash
 * commands, all from these definitions. They name MCP tools, which have CLI equivalents.
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
  }) => `Review ${block ? `block ${block} of ` : ""}this Partstyle design. Report findings; do not change the circuit until the person agrees to each fix.

1. Gather: overview, validate, ${PROJECT_FILE}, notes/design.md, notes/decisions.md, then ${
    block ? `read_block ${block}` : "each block with read_block"
  }. For every library part, part_get with tier pins. A choice recorded in notes/decisions.md is
   not a finding unless something has changed since.
2. Check, citing refdes and nets:
   - Each validate issue: its cause and a fix. Errors must be fixed; a warning may instead get a
     waiver with a real reason, if the person agrees.
   - Datasheet requirements not marked [checked]: is each one met, and how?
   - Each external interface in the project file: is every listed hazard handled at the connector
     (ESD, overvoltage, reverse polarity, shorts, fusing, cable length)? The engine does not check
     hazards, so this review is the only check. A hazard marked accepted is the person's decision;
     note it and move on. Flag any connection to the outside world the project file leaves out.
   - Values against each \`@ intent\`: dividers, filter corners, gain, LED and pull-up currents.
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
     design. A suggestion must keep every rating and the \`@ intent\` it replaces.
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

1. part_search ${part ?? "MPN"}: if a record exists (or a KiCad import draft,
   extracted_by: kicad), complete it rather than adding another.
2. guide parts has the format and a worked example. Read the datasheet once, then
   write the record so that nobody needs the datasheet again: everything a designer could want,
   in sections of your own where no field fits.
   - Identity: the part's name without ordering codes as the id, a one-line summary with key
     ratings and package, the orderable part as preferred_mpn, package and a KiCad footprint.
     Set kicad_symbol for discretes and anything else KiCad doesn't name. A passive, LED or diode
     also gets generic, what it offers (\`cap(100n, 50V, X7R, 10%, 0603)\`): it then draws like that
     generic, and the BOM offers it as a candidate.
   - pins: every pad by number, with the datasheet name and type. Give supply and input pins
     vmax, and unused where the datasheet says a pin may float or must be connected.
   - ratings, temp_c, requirements (with a check where one fits), notes, and characteristics,
     tables, timing, thermal data and application circuits as sections of your own.
   - provenance: datasheet url, extracted_by: ai, verified_by: null.
3. part_put it. It reports what the engine couldn't use and any pad mismatch with the
   footprint: fix what is your mistake, and tell the person about the rest.
4. Tell the person it awaits their verification in the viewer, and list anything the
   datasheet left ambiguous.`,
};

const handoff: PromptDef = {
  name: "handoff",
  description: "Assign real parts, write PCB and firmware notes, and export to KiCad",
  args: [],
  render: () => `Prepare this design for PCB layout in KiCad.

1. validate: no errors. Explain each remaining warning to the person, and list any part not yet
   approved (query parts where approved != yes).
2. bom_export lists each generic not yet replaced with a real part. For each, propose a part to
   the person: a listed candidate or a part_search result, parts in inventory first, or a new
   record (ingest_part) if none fits. Apply the ones they agree to with
   \`= part REF lib:ID [layout] @ intent\`, keeping the line's layout and intent, since = replaces
   the whole statement. A generic stays only if they confirm it (the assembler chooses). Then
   bom_export again, and list any part with no preferred MPN for the person.
3. Update notes/pcb.md, keyed to refdes: placement from datasheet requirements (decoupling
   close to its pins, regulator input and output caps), protection parts at their connectors
   (the project file's external interfaces), thermal relief for regulators, sensitive analog nets,
   suggested layer count and keep-outs.
4. For a design with an MCU, update notes/firmware.md from the circuit and part records, keyed to
   nets: pin assignments, peripherals, clock source, programming and debug access, reset and boot
   requirements, power-up constraints.
5. Check notes/design.md still describes the design.
6. kicad_export: the netlist round trip and KiCad ERC must be clean.
7. Summarise for the person: open \`kicad/<name>.kicad_pro\`, run Tools > Update PCB from
   Schematic, then follow notes/pcb.md; list any open risks.`,
};

export const prompts: PromptDef[] = [designReview, ingestPart, handoff];

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
