# [Partstyle](https://github.com/plish-plash/partstyle)

An AI-first schematic editor. You design a circuit by talking to Claude; Claude edits a compact
text description of it; you watch a live, automatically drawn schematic and approve or revert
each change. When the design is ready, Partstyle hands it to KiCad for PCB layout.

## Why

Schematic tools store drawings: symbol positions, wire segments, label coordinates. An AI
editing that format spends most of its effort on geometry, and reading a design back costs far
more than the circuit itself. Partstyle stores only what the circuit _is_ — parts, pins, nets
and the intent behind them — and draws the schematic itself. The result:

- **Cheap to read and edit.** A project overview is a few hundred tokens; Claude drills into a
  block, a part or a net only when it needs to, and edits with small patches.
- **Real parts, not abstract symbols.** Every component is a real part record (manufacturer,
  MPN, pinout, ratings, datasheet requirements) or a generic like `res(10k, 1%, 0603)` that is
  resolved to a real part when the BOM is built. Datasheet facts are captured once, with a flag
  for whether a human has verified them.
- **Checked against reality.** Besides electrical rules, designs are checked against part
  ratings (pin voltages, capacitor derating, required external parts, temperature range), and
  Claude designs and reviews against the hazards you name at each connector.
- **You stay in charge.** Claude's edits land as changesets you can revert, whole or statement
  by statement; a checkpoint (a git commit) is your approval. You point at things in the viewer
  instead of typing reference designators.

## What a design looks like

A project is a folder of plain text. Each functional block is a `.ckt` file:

```
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
```

There are no coordinates or wires anywhere: the viewer and the KiCad export lay out each sheet
automatically. The full language is in the [.ckt grammar](docs/ckt-grammar.md), and
[`examples/bench-sensor`](examples/bench-sensor) is a complete 30-part reference design.

## Getting started

Partstyle works equally well from Claude Desktop and Claude Code (and from other MCP clients).
Downloads are on the [releases page](https://github.com/plish-plash/partstyle/releases);
[INSTALL.md](INSTALL.md) has the details.

- **Claude Desktop:** download `partstyle.mcpb` from the releases page and open it to install
  the extension. Nothing else is needed. Then ask Claude to "start a Partstyle project for…".
- **Claude Code:** download the standalone `partstyle` executable (or build from source) and
  put it on your PATH. Claude can then use the `partstyle` CLI directly, the MCP server, or
  both.
- **Part library (optional):** `partstyle-library.zip` on the releases page has starter part
  records; unzip it into your projects folder (`Documents/partstyle` by default).
- **KiCad (optional):** needed only to export to or import from KiCad.

How each client is set up, and the full list of MCP tools, is in
[docs/claude-code.md](docs/claude-code.md).

## A typical session

1. **Start a project.** Ask Claude to create one. It writes the skeleton
   (`partstyle-project.yaml`, `circuit/main.ckt`, `notes/`) and gives you a link to the viewer,
   a local web page that redraws as the design changes.
2. **Describe the board.** Claude fills in `partstyle-project.yaml` with you: what the board does, where it
   runs, how it's powered and assembled, and every external connection with its hazards (ESD,
   reverse polarity, ...). Claude designs and reviews against this.
3. **Design block by block.** Claude plans one block per functional area (power, MCU, sensor
   input, ...), picks parts from the library or adds records from datasheets, and applies
   patches. Each patch reports only the issues it added or resolved.
4. **Review as you go.** In the viewer, click a part, pin or net and say "this"; Claude sees
   your selection. Leave comments on things. The Changes tab shows each changeset: revert what
   you disagree with, or switch to accept mode so every patch waits for your approval.
5. **Checkpoint.** When you're happy, make a checkpoint. Try alternatives (say, an LDO against a
   buck converter) as variants and adopt the one you prefer.
6. **Hand off.** Export a BOM, which resolves generic parts to real MPNs from your preferred
   distributors, and the KiCad project: schematic using KiCad's own symbols, netlist, and
   footprint assignments, checked with KiCad's ERC. PCB layout happens in KiCad; re-exporting
   never touches the PCB.

Existing KiCad designs can be imported too: each sheet becomes a block, and symbols the library
lacks become draft part records to complete.

## Documentation

| Document                                     | For                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------- |
| [INSTALL.md](INSTALL.md)                     | Installing the extension, the executable or a source build; releases |
| [docs/claude-code.md](docs/claude-code.md)   | Using Partstyle from Claude Code, Claude Desktop and MCP clients     |
| [docs/cli.md](docs/cli.md)                   | Reference for every `partstyle` command                              |
| [docs/ckt-grammar.md](docs/ckt-grammar.md)   | The `.ckt` language, patches, and every issue code                   |
| [docs/part-records.md](docs/part-records.md) | The part record format                                               |
| [docs/layout.md](docs/layout.md)             | How sheets are laid out, and how to steer the layout                 |
| [docs/design.md](docs/design.md)             | Design rationale and architecture                                    |

## Development

Partstyle is a TypeScript monorepo (Node 22+, pnpm): the engine, the CLI, the MCP server, the
viewer's local HTTP server and the Svelte viewer.

```sh
pnpm install
pnpm build      # TypeScript and the viewer
pnpm check      # lint, typecheck and tests
pnpm partstyle -p examples/bench-sensor view    # open the example in the viewer
```

[INSTALL.md](INSTALL.md) covers building the standalone executable and the Claude Desktop
extension, and the CI and release workflows. [CLAUDE.md](CLAUDE.md) is the map of the codebase
and its conventions.

## License

Partstyle is licensed under the [Apache License 2.0](LICENSE). The seed part records in
[`library/`](library) are dedicated to the public domain under [CC0 1.0](library/LICENSE), so
you can copy them into your own libraries without conditions. Release files bundle third-party
packages; their licenses are listed in `THIRD_PARTY_NOTICES.txt`, attached to each release.
