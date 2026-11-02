import { slashCommands } from "../prompts.js";
import type { TextFile } from "./source.js";

export interface SkeletonOptions {
  name: string;
  /** Global part-library folders, relative to the project root, with forward slashes. */
  libraryPaths: string[];
}

const tomlString = (s: string) => JSON.stringify(s);

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

1. Run \`partstyle grammar\` and follow it exactly.
2. Fill in \`context.md\` with the user: use case, environment, power source, assembly and every
   external interface with its hazards. Checks and design review use it.
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
- If \`overview\` says \`review mode: accept\`, edit only through \`partstyle apply\`: each patch
  waits as a pending change (P1, P2, ...) until the person accepts it in the viewer.
- To try an alternative (say an LDO against a buck stage), \`partstyle variant create NAME\`
  makes a parallel copy under \`.partstyle/variants/NAME\`; edit it with \`partstyle -p\` that
  folder and compare with \`variant diff NAME\`. The person adopts or removes it.

## Editing

Edit \`circuit/*.ckt\` directly, or send a batched patch with \`partstyle apply\` (stdin), which
reports only the issues your edit added or resolved. Run \`partstyle validate\` after direct edits
and fix or explain every issue.

- Use generics for passives: \`res(10k, 1%, 0603)\`, \`cap(100n, 16V, X7R, 0603)\`, \`led(red, 0603)\`.
  Use \`lib:ID\` for everything else. Find records with \`partstyle part search\`; add missing ones
  with \`partstyle part put\` (\`partstyle schema part\` prints the schema), taking pinouts from the
  datasheet. Leave \`verified_by: null\`: only a human verifies a record.
- A design imported from KiCad (\`partstyle kicad import\`) has draft records for symbols the
  library lacked, each a \`part.draft\` warning: identify the part with the person, then complete
  the record from its datasheet (or switch the parts to an existing record or a generic).
- Put an \`@ intent\` on every part and on nets whose purpose is not obvious.
- Record design rationale in \`notes/decisions.md\` and layout constraints in \`notes/pcb.md\`.
- Waive an issue only with a real reason in the waiver.

## Procedures

For these, follow the procedure exactly: \`/design-review [block]\`, \`/ingest-part <mpn>
[datasheet]\` and \`/prepare-handoff\` in Claude Code, or print it with \`partstyle prompt NAME\`.
Use ingest-part whenever you add a part record.

## Hand-off to KiCad

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

${conventions}`;
}

/** Naming, ports, ratings and a worked block: the same for CLI and MCP clients. */
const conventions = `## Conventions

- Refdes prefixes: R, C, L, D (diodes and LEDs), Q, U (ICs), J (connectors), Y (crystals),
  F (fuses), SW, TP. Unique within a block.
- Net names: rails as \`+3V3\`, \`+5V\`, \`+12V\`, \`GND\`; signals in UPPER_SNAKE_CASE.
- Each block declares a port for everything crossing its boundary: \`ground\` for GND,
  \`power_out\` for rails it supplies, \`power_in\` for rails it consumes, and
  \`input\`/\`output\`/\`bidir\`/\`passive\` for signals.
- Add \`{voltage: ...}\` to rails and to signals with a known range (\`5V\`, \`12V ±10%\`,
  \`0-3.3V\`); a rail named like \`+3V3\` is assumed to be that voltage. Checks compare it with
  pin limits (\`vmax\`) and capacitor ratings. A rail fed from a connector or through a passive
  part (fuse, diode) has no \`power_out\` pin, so add \`{source: ...}\`.
- Give passives a voltage or power rating where it matters: \`cap(10u, 25V, X5R, 0805)\`.

## Example block

\`\`\`
block power "12 V barrel input, 5 V linear rail"

port +5V : power_out
port GND : ground

part J1 lib:barrel_jack_2.1mm       @ 12 V wall adapter input
part D1 lib:1N5819                  @ reverse-polarity protection
part U1 lib:L7805CV
part C1 cap(330n, 50V, X7R, 0603)   @ per U1 datasheet input cap
part C2 cap(100n, 16V, X7R, 0603)   @ per U1 datasheet output cap

net VIN_RAW : J1.TIP D1.A           {voltage: 12V ±10%}
net +12V    : D1.K U1.IN C1.1       {voltage: 11.5V, source: J1 through D1}
net +5V     : U1.OUT C2.1           -> port +5V {voltage: 5V}
net GND     : J1.SLEEVE J1.SWITCH U1.GND C1.2 C2.2 -> port GND
\`\`\`

and in \`main.ckt\`: \`use power as PWR\`, then \`net +5V : PWR.+5V MCU.+5V\`.
`;

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

${start}## Workflow

1. Call grammar before writing .ckt text or patches, and follow it exactly.
2. New project: fill in context.md with the person (read_doc, write_doc): use case,
   environment, power source, assembly and every external interface with its hazards. Then
   plan one block per functional area; apply creates each ('+ block NAME' first) and main
   joins them with 'use'.
3. Read cheap first: overview, read_block (detail=summary, then full), query, part_get.
4. Edit with apply: batched and atomic, it reports only the issues the edit added or
   resolved. Fix or explain every issue; waive one only with a real reason.
5. "this", "here", "the selected part": call focus. Answer open comments; the person resolves
   them in the viewer.
6. Start each turn with diff since=last: it shows the person's reverts and edits. Don't redo a
   change they reverted; ask. checkpoint only when asked. If overview says review mode:
   accept, each patch waits for the person to accept it.
7. Generics for passives: res(10k, 1%, 0603), cap(100n, 16V, X7R, 0603), led(red, 0603);
   lib:ID for everything else. part_search first; add a missing record with part_put,
   following the ingest_part prompt (pinouts from the datasheet, verified_by null).
8. Put an @ intent on every part and on nets whose purpose is not obvious. Record rationale in
   notes/decisions.md and layout constraints in notes/pcb.md.
9. Hand-off: bom_export, then kicad_export. Never edit the kicad/ output: change the design
   and export again.

${conventions}`;
}

/** Files for a new, empty project that validates clean. */
export function projectSkeleton({ name, libraryPaths }: SkeletonOptions): TextFile[] {
  return [
    {
      file: "project.toml",
      text: `name = ${tomlString(name)}
top = "main"

[library]
# Global part-library folders shared across projects, relative to this file.
paths = [${libraryPaths.map(tomlString).join(", ")}]

[sourcing]
# Preferred distributors for BOM resolution: "lcsc", "digikey", "mouser".
distributors = []

[review]
# auto: the AI's edits land at once, as changesets you can revert in the viewer.
# accept: each patch the AI applies waits for you to accept it.
mode = "auto"

[checks]
# A capacitor's rated voltage should be at least this many times the voltage across it.
cap_derating = 1.5
`,
    },
    {
      file: "context.md",
      text: `---
# YAML for the checks; prose for people goes below the closing ---.
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
---

TODO: what the board does, who uses it and where, and anything a reviewer should know.
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
