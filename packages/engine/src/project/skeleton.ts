import { slashCommands } from "../prompts.js";
import { PROJECT_FILE } from "./config.js";
import type { TextFile } from "./source.js";

/**
 * A project's CLAUDE.md. It teaches the conventions an AI would otherwise copy from an example
 * project, so a fresh project needs nothing else to get started.
 */
export function projectClaudeMd(name: string): string {
  return `# Circuit project: ${name}

This is a Partstyle schematic project. The circuit is stored as connectivity (parts, pins, nets
and intent) in \`circuit/*.ckt\`. Never add coordinates, wires or label positions; the schematic
drawing is generated. Bracketed layout hints on part lines (\`[2 r90 flip]\`) are the person's
arrangement from the viewer: keep them as they are when editing a part.

Commands below are the \`partstyle\` CLI; the Partstyle MCP server has a tool for each.

## Before the first edit

1. Run \`partstyle grammar\` and follow it exactly; it includes the naming conventions and an
   example block.
2. Fill in \`${PROJECT_FILE}\` with the user: use case, environment, power source, assembly,
   external interfaces and the hazards the user names for them. Checks and design review use it.
   It also holds the project's name and settings (distributors, capacitor derating).
3. Plan one block per functional area (power, mcu, sensor input, ...), each in its own
   \`circuit/<block>.ckt\`, instantiated and joined in \`circuit/main.ckt\` with \`use\`.

## Reading

Start cheap and drill down:

1. \`partstyle overview\`: blocks, part counts, issues, context
2. \`partstyle read-block BLOCK --detail summary\`, then \`read-block BLOCK\` for the full text
3. \`partstyle query "part U1"\`, \`query "net +5V"\`, \`query "parts where vin_max < 15V"\`
4. \`partstyle part get ID\` (tiers: summary, pins, full); prefer this to re-reading datasheets

## The person and the viewer

The person watches the design in the live viewer (\`partstyle view\`) as you edit it. They point
and comment there rather than typing refdes:

- When they say "this", "here" or "the selected part", run \`partstyle focus\`: it lists what
  they have selected and their open comments.
- Answer open comments; the person resolves them in the viewer.

## Review and versions

The person reviews your edits in the viewer as changesets (each \`apply\`, or each burst of
direct edits) and can revert any of them, whole or statement by statement. A checkpoint (a git
commit of the project) is their approval.

- Start each turn with \`partstyle diff --since last\`: what changed since you last looked,
  including the person's reverts and edits. Don't redo a change they reverted; ask instead.
- \`partstyle diff\` lists everything since the last checkpoint. Make a checkpoint
  (\`partstyle checkpoint "message"\`) only when the person asks for one.
- If \`overview\` says \`review mode: accept\` (the person's switch in the viewer), edit only
  through \`partstyle apply\`: each patch waits as a pending change (P1, P2, ...) until the person
  accepts it in the viewer.
- To try an alternative (say an LDO against a buck stage), \`partstyle variant create NAME\`
  makes a parallel copy under \`.partstyle/variants/NAME\`; edit it with \`partstyle -p\` that
  folder and compare with \`variant diff NAME\`. The person adopts or removes it.

## Editing

Edit \`circuit/*.ckt\` directly, or send a batched patch with \`partstyle apply\` (stdin), which
reports only the issues your edit added or resolved. Run \`partstyle validate\` after direct edits.

Do what the person asked. Fix errors your own edit caused; anything else that changes the design
(protection, extra parts, waivers, fixes for warnings) is the person's call: raise it with a
suggested fix.

- Use generics for passives: \`res(10k, 1%, 0603)\`, \`cap(100n, 16V, X7R, 0603)\`, \`led(red, 0603)\`.
  Use \`lib:ID\` for everything else. Find records with \`partstyle part search\`; add missing ones
  with \`partstyle part put\` (\`partstyle schema part\` prints the schema), only for parts you know
  exist (from memory or a datasheet), never an MPN extrapolated from a series. Leave
  \`verified_by: null\`: only a human verifies a record.
- A design imported from KiCad (\`partstyle kicad import\`) has draft records for symbols the
  library lacked, each a \`part.draft\` warning: identify the part with the person, then complete
  the record from its datasheet (or switch the parts to an existing record or a generic).
- Record design rationale in \`notes/decisions.md\` and layout constraints in \`notes/pcb.md\`.

## Procedures

For these, follow the procedure exactly: \`/design-review [block]\`, \`/ingest-part <mpn>
[datasheet]\` and \`/prepare-handoff\` in Claude Code, or print it with \`partstyle prompt NAME\`.
Use ingest-part whenever you add a part record.

## Hand-off to KiCad

Export only when the person asks.

- \`partstyle bom export\` resolves generics to library parts and writes \`bom.csv\`. A generic
  stays unresolved until a library record's \`generic:\` field satisfies it, e.g.
  \`generic: cap(100n, 50V, X7R, 10%, 0603)\` on a concrete 100 nF part.
- \`partstyle kicad export\` writes \`kicad/\` and checks it with kicad-cli (netlist round trip and
  KiCad ERC). It draws parts with KiCad's own symbols, found by MPN; when it reports a
  generated symbol for a part KiCad has under another name (connectors, generic modules), set
  \`kicad_symbol: Library:Symbol\` in the part record. Never edit \`kicad/*.kicad_sch\`: change the .ckt files and export again. PCB layout
  happens in KiCad, and re-export never touches the PCB.
- Keep \`annotation.lock\` and \`bom.lock\` under version control: they hold refdes and part
  choices stable across exports.
`;
}

/**
 * The MCP server's instructions: the project CLAUDE.md's workflow in tool terms, for clients
 * that have only the tools (Claude Desktop) and never read a project's CLAUDE.md. `global`:
 * the server works on several projects, opened by name.
 */
export function mcpInstructions(global: boolean): string {
  const start = global
    ? `Work on one project at a time: list_projects, then open_project NAME, or init_project NAME
for a new one. open_project returns the overview and the viewer URL: give the URL to the
person, who watches the drawing update and points at things there.

`
    : "";
  return `Partstyle is a schematic editor for AI. A design is connectivity (parts, pins, nets and
intent) in .ckt text; the drawing is generated, so never think in coordinates or wires.
Bracketed layout hints on part lines ([2 r90 flip]) are the person's arrangement: keep them.
A project's CLAUDE.md is these instructions in CLI terms for Claude Code: don't read it.

${start}## Workflow

1. Call grammar before writing .ckt text or patches, and follow it exactly; it includes the
   naming conventions and an example block.
2. New project: fill in ${PROJECT_FILE} with the person (read_doc, write_doc): use case,
   environment, power source, assembly, external interfaces and the hazards the person names
   for them. It also holds the name and settings (distributors, cap derating). Then plan one
   block per functional area, joined in main with 'use'.
3. Read cheap first: overview, read_block (detail=summary, then full), query, part_get.
4. Do what the person asked. Fix errors your own edit caused; anything else that changes the
   design (protection, extra parts, waivers, fixes for warnings) is the person's call: raise
   it with a suggested fix.
5. "this", "here", "the selected part": call focus. Answer open comments; the person resolves
   them in the viewer.
6. Start each turn with diff since=last: it shows the person's reverts and edits. Don't redo a
   change they reverted; ask.
7. Generics for passives: res(10k, 1%, 0603), cap(100n, 16V, X7R, 0603), led(red, 0603);
   lib:ID for everything else, part_search first. Add records only for parts you know exist
   (from memory or a datasheet), never an MPN extrapolated from a series.
8. Record rationale in notes/decisions.md and layout constraints in notes/pcb.md.
9. checkpoint, bom_export and kicad_export only when the person asks. Never edit the kicad/
   output: change the design and export again.
`;
}

/** Files for a new, empty project that validates clean, made by Partstyle `version`. */
export function projectSkeleton(name: string, version: string): TextFile[] {
  return [
    {
      file: PROJECT_FILE,
      text: `# A Partstyle project: its name, design context and settings. Checks and design review
# read the context; the description is plain paragraphs for people.
partstyle_version: ${JSON.stringify(version)}
name: ${JSON.stringify(name)}
description: |
  TODO: what the board does, who uses it and where, and anything a reviewer should know.

use_case: TODO one line, e.g. benchtop sensor interface
environment:
  temp_c: [0, 50]
  indoor: true
power:
  source: TODO e.g. 12 V wall adapter
  connector: TODO e.g. PWR/J1
assembly:
  method: TODO e.g. SMT service + hand-soldered THT
  volume: 1
external_interfaces: []
# Each connector to the outside world, for example:
#  - connector: PWR/J1
#    connects_to: 12 V wall adapter
#    signal: 12 V DC
#    hazards:
#      - reverse polarity
#      - ESD

sourcing:
  # Preferred distributors for BOM resolution: lcsc, digikey, mouser.
  distributors: []
checks:
  # A capacitor's rated voltage should be at least this many times the voltage across it.
  cap_derating: 1.5
`,
    },
    {
      file: "circuit/main.ckt",
      text: `block main "TODO: what this board does, in one line"

# The top level instantiates one block per functional area and joins their ports, e.g.
#   use power as PWR
#   use mcu   as MCU
#   net +3V3 : PWR.+3V3 MCU.+3V3
#   net GND  : PWR.GND MCU.GND
`,
    },
    {
      file: "notes/decisions.md",
      text: `# Design decisions

Why choices were made, keyed to refdes and nets (e.g. "R5/R6 set the gain to 11").
`,
    },
    {
      file: "notes/pcb.md",
      text: `# PCB notes

Layout guidance for the KiCad hand-off: layer count, keep-outs, placement constraints.
`,
    },
    { file: "CLAUDE.md", text: projectClaudeMd(name) },
    ...slashCommands(),
    {
      file: ".gitignore",
      text: `# Local viewer state and KiCad's per-user files. Commit everything else, including
# annotation.lock, bom.lock and comments.yaml.
.partstyle/
kicad/*.kicad_prl
kicad/*-backups/
`,
    },
  ];
}
