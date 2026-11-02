# AI-First Schematic Editor — Design Document

Oct 28, 2026 · @Elliot

## Overview

The tool stores a circuit as compact, semantic text (parts, pins, nets, intent) instead of drawn geometry, so an AI can read and edit a large design cheaply while a human watches a live, auto-laid-out preview and approves changes. KiCad remains the destination for PCB layout.

**Problem.** The KiCad + Konnect workflow works, but it costs tokens in three places: the AI edits geometry (pin coordinates, wire segments, label positions) rather than connectivity; reading a schematic returns verbose S-expression detail the AI doesn't need; and a very large tool surface (\~250 tools) adds overhead and many small round-trips. KiCad's symbol-first model also treats the real part (manufacturer, MPN, ratings, datasheet requirements) as an afterthought attached to an abstract symbol.

**Goals**

- **AI-first editing** — the design is stored in a form an AI can read selectively and patch in small diffs; the human gets a live preview plus layout nudges and small connectivity edits.
- **Part-centric** — every component resolves to a real part (or a constrained generic that resolves at BOM time); distilled datasheet facts live in a local library so they are read once.
- **Environment context** — use case, operating environment and external connections are stored with the circuit and used in review.
- **KiCad interoperability** — import existing schematics; export schematic, symbols, footprint assignments and netlist.
- **Versioned** — checkpoints and parallel variants.

**Non-goals**

- Full automation of circuit design; the human stays in the loop.
- PCB layout. Output is a layout-ready schematic (correct footprints), a BOM, and layout notes (layer count, placement constraints).
- A full manual schematic-drawing editor competing with KiCad.

## Architecture principles

Five principles drive every later decision; when a design choice is unclear, these break the tie.

1. **Connectivity is the source of truth; geometry is derived.** The circuit is parts + pins + nets. Symbol positions and wires are computed by auto-layout and never stored. The human steers the layout with a few coarse hints stored inline on part lines (`[2 r90 flip]`: stage in the signal chain, rotation, mirroring); they cost a few tokens, mean nothing to the circuit, and the AI keeps them as they are.
2. **Plain-text files are the canonical store.** A project is a folder of small, line-oriented text files. This makes git the versioning engine, makes diffs readable by both human and AI, and lets an AI with file tools (e.g. Claude Code) work without any server at all.
3. **Progressive disclosure.** Every read has a cheap summary tier and a detailed tier. The AI starts from a project overview of a few hundred tokens and drills down only where it needs to.
4. **Parts carry knowledge.** Facts the AI would otherwise re-derive from a datasheet (pinout, ratings, required external components, gotchas) are captured once in the part record, with provenance and a human-verified flag.
5. **The human approves, the AI proposes.** AI edits apply immediately as changesets highlighted in the viewer; the human reverts what they disagree with and checkpoints what they approve. The human steers by pointing (selection, comments) and accepting, not by drawing.

## System components

One engine library sits under three thin interfaces, and everything it reads and writes is plain text on disk.

The MCP server, CLI and viewer are thin: they translate requests into engine calls, so a check run from chat gives the same result as one from the terminal or the viewer. The viewer and MCP server run in one local process and share a file watcher, so an AI edit shows in the preview as soon as it is written.

## Data model and file formats

A project is a folder of text files, split by who reads them: the AI reads circuit, parts and context; layout hints ride along in the circuit files.

```
my-board/
  project.toml            # name, variants, part-library paths, preferred distributors, settings
  context.md              # use case, environment, external interfaces
  circuit/
    main.ckt              # top level: instantiates blocks, joins ports
    power.ckt             # one file per functional block
    sensor_afe.ckt
  parts/                  # project-local part records (overrides global)
  parts.lock              # exact part-record versions/hashes used
  bom.lock                # how generic parts were resolved to MPNs
  notes/
    decisions.md          # design rationale, keyed to refdes/nets
    pcb.md                # layout notes for the KiCad stage
```

### Circuit files (.ckt)

A small line-oriented language: one statement per line, so a one-part change is a one-line diff. Chosen over plain YAML for compactness; a token comparison against YAML may follow later. Nets list pins by name or number; nothing has coordinates.

```
block power  "12 V barrel input, local 5 V rail"

port +12V : power_out
port +5V  : power_out
port GND  : ground

part J1  lib:barrel_jack_2.1mm
part D1  lib:1N5819               @ reverse-polarity protection
part U1  lib:L7805CV
part C1  cap(330n, 50V, X7R, 0603) @ per U1 datasheet input cap
part C2  cap(100n, 16V, X7R, 0603)
part C3  cap(10u, 16V, X7R, 0805)

net VIN_RAW : J1.TIP D1.A                  {voltage: 12V ±10%}
net +12V    : D1.K U1.IN C1.1             -> port +12V
net +5V     : U1.OUT C2.1 C3.1            -> port +5V  {voltage: 5V}
net GND     : J1.SLEEVE U1.GND C1.2 C2.2 C3.2 -> port GND
```

- `@` attaches intent to a statement; it travels with the part through edits and is what makes review cheap later.
- `{…}` net attributes (voltage range, signal kind, max current, impedance) feed the part-aware checks.
- Generic parts like `cap(…)` are constraints, resolved to an MPN at BOM time and recorded in `bom.lock`.
- Hierarchy: `main.ckt` uses `use power as PWR` and joins `PWR.+5V` to other blocks' ports. Instance paths (`PWR/C1`) map to flat refdes on export via a stable annotation table.

### Part records

One YAML file per MPN in a global library, shared across projects. Records are tiered so a read can stop early: a one-line summary, the pin table, ratings, then requirements and notes.

```yaml
id: L7805CV
manufacturer: STMicroelectronics
mpn: L7805CV
summary: 5 V 1.5 A linear regulator, TO-220
package: TO-220-3
footprint: Package_TO_SOT_THT:TO-220-3_Vertical
pins:
  1: { name: IN, type: power_in }
  2: { name: GND, type: power_in, note: tab is GND }
  3: { name: OUT, type: power_out }
ratings:
  vin_max: 35V
  iout_max: 1.5A
requirements:
  - 0.33 uF on IN, 0.1 uF on OUT, close to pins
sourcing: { lcsc: null, digikey: null, lifecycle: active }
provenance:
  datasheet: { url: ..., sha256: ... }
  extracted_by: ai
  verified_by: human # or null until checked
```

- **Datasheet ingestion** is a workflow, not a feature of the engine: the AI reads the datasheet once with its own tools, writes the record, the engine validates the schema, and the human marks it verified in the viewer.
- **Symbols are generated** from the pin table (pins grouped by type and function), so there is no separate abstract symbol to keep in sync. A record may optionally map to a KiCad library symbol for export.
- **Footprint correctness** is checked at record creation: pad count and numbering in the referenced KiCad footprint must match the pin table.

**Sourcing.** Part records hold per-distributor data (LCSC/JLCPCB, Digi-Key, Mouser). Each user picks their preferred distributors in `project.toml`, and BOM resolution and stock checks use only those.

### Environment context (context.md)

Structured front matter for checks, free prose below for the AI and the human.

```yaml
use_case: Benchtop sensor interface
environment: { temp_c: [0, 50], indoor: true }
power: { source: 12 V wall adapter, connector: J1 }
assembly: { method: SMT service + hand-soldered THT, volume: 10 }
external_interfaces:
  - connector: J4
    connects_to: remote sensor on 2 m cable
    signal: 0-3.3 V analog
    hazards: [ESD, miswiring to 12 V]
```

External interfaces are first-class: each names a connector, what is on the other end, and its hazards, so review can ask "is J4 protected against what it will actually see?"

### Notes

`notes/decisions.md` records why choices were made ("R5/R6 set gain of 11"), referencing refdes and nets so the AI need not re-derive them. `notes/pcb.md` collects layout guidance (layer count, keep-outs, placement constraints) for the hand-off to KiCad.

## AI integration

Claude Code and chat clients such as Claude Desktop are equally supported AI surfaces. Claude Code can read and edit the plain-text files directly and call the CLI to validate, query, diff and export. An MCP server with about 20 coarse-grained tools serves every client, including those without file tools, and can be configured once for all projects; the CLI mirrors every MCP tool (including viewer state such as focus), so nothing is chat-only. Both go through the same engine, so validation results are identical.

### MCP tool surface

| Tool                                              | Purpose                                                                                                | Typical response size |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------- |
| `overview`                                        | Blocks, part counts, open issues, context summary, changes since the last checkpoint                   | \~300–800 tokens      |
| `read_block(block, detail)`                       | A block's .ckt text; `detail=summary` gives ports + part list only                                     | scales with block     |
| `query(expr)`                                     | Targeted lookups: "nets on U3", "where is +5V used", "parts with vin\_max < 15V"                       | small                 |
| `apply(patch)`                                    | Batched edits in the .ckt language (add/remove/modify statements); returns only new or resolved issues | small                 |
| `validate(scope)`                                 | ERC + part + context checks; terse, issues only                                                        | small                 |
| `part_search(q)` / `part_get(id, tier)`           | Local library; tier = summary, pins, full                                                              | small–medium          |
| `part_put(record)`                                | Create or update a part record (schema-validated, footprint pad check)                                 | small                 |
| `context_get` / `context_update`                  | Environment and interfaces                                                                             | small                 |
| `focus()`                                         | What the human has selected or commented on in the viewer                                              | small                 |
| `checkpoint(msg)` / `diff(since)` / `variant(op)` | Versioning, with semantic diffs                                                                        | small                 |
| `render(block)`                                   | PNG of a block, only when visual judgement is needed                                                   | image                 |
| `kicad_import` / `kicad_export` / `bom_export`    | Interop and outputs                                                                                    | small                 |

Deliberately absent: anything with coordinates, wires, or label placement.

### Token-efficiency strategies

- **No geometry in the AI's view.** The largest saving: the AI never reads or writes positions, wires or junctions.
- **Compact notation.** A net is one line listing its pins, versus dozens of S-expression wire and label objects in a `.kicad_sch`.
- **Summary-first reads.** `overview` and `detail=summary` let the AI decide what to open; part records are read at the lowest tier that answers the question.
- **Batched writes, delta results.** One `apply` call carries a whole edit; it returns only issues that changed, not the whole design.
- **Deltas instead of re-reads.** `diff(since)` tells the AI what the human changed between turns (viewer edits, file edits, reverts; layout-only edits folded into one line per block), so it doesn't reload the project.
- **Distilled parts.** Datasheets are read once at ingestion; afterwards the AI reads a few hundred tokens of record instead of a PDF.
- **Small tool list.** \~16 tools keep the per-turn tool-definition cost low.
- **Images on demand only.** Renders are expensive; the AI asks for one when it genuinely needs a visual check.

### Workflow prompts

The MCP server also exposes a few prompts that encode repeatable procedures: `ingest_part` (datasheet to record), `design_review` (structured review against context and part requirements), and `prepare_handoff` (BOM resolution + PCB notes). These keep procedure out of every conversation's context until needed.

## Human in the loop: the viewer

The viewer is where the human sees, points and decides; it is a read-mostly window onto the files, not a drawing tool.

**What it shows**

- A live schematic per block, auto-laid-out from the .ckt files and re-rendered on every file change.
- Generated symbols showing real part identity (MPN, value, key rating) rather than a bare abstract glyph.
- Changes since the last checkpoint highlighted (added green, removed red, modified amber), with the AI's `@` intent notes inline.
- Validation issues pinned to the parts and nets they concern.
- Part cards: record summary, verification status, datasheet link.

**What the human can do**

- **Point.** Click a part, pin or net to select it; `focus()` hands the selection to the AI, so "why is this here?" needs no refdes typed.
- **Comment.** Attach a note to a part or net; the AI sees open comments via `focus()` and `overview`.
- **Review.** Revert a changeset, whole or per statement; checkpoint when satisfied.
- **Arrange the layout.** Move a group a stage earlier or later in the signal chain, rotate a two-terminal part, mirror anything else. Stored as hints on the part's .ckt line; there is no fine-grained dragging: coarse controls over a deterministic layout should be enough.
- **Verify parts.** Mark an AI-extracted part record as checked against its datasheet.
- **Edit connectivity.** Rename a net, swap or re-value a part, connect or disconnect a pin from the UI; each becomes an ordinary .ckt edit the AI sees in its next diff. Any text editor works too.

**Review loop**

1. The AI calls `apply`; the engine applies it to the working copy, validates it and logs it as a changeset.
2. The viewer highlights everything changed since the last checkpoint, with any new issues.
3. The human reverts any changeset or statement they disagree with, edits it, or comments back.
4. When a step looks right, the human checkpoints it; the checkpoint is the approval.

Auto-apply is the default. A per-project setting switches to accept-before-apply for high-stakes work, where AI changes wait as pending changesets.

## Versioning

Git is the storage engine; the app gives it schematic vocabulary so the user never needs git commands.

| User concept | Git mechanism                        | Notes                                                                          |
| ------------ | ------------------------------------ | ------------------------------------------------------------------------------ |
| Checkpoint   | Commit                               | Message written by the human or proposed by the AI                             |
| Changeset    | Working-copy edits, logged per apply | One per AI `apply` call; applied at once, revertible until the next checkpoint |
| Variant      | Branch, with a working copy          | Parallel versions (e.g. "LDO" vs "buck" power stage) viewable side by side     |
| Compare      | Semantic diff between any two refs   | Reports parts added/removed/changed and net membership changes, not text lines |

The semantic diff is computed by the engine from the parsed models, so a reordered file shows as no change, and a layout-only change is marked as such.

The global part library is versioned separately; `parts.lock` pins each project to the exact record versions it used, so a later library correction does not silently change an old design.

## Validation and design review

Checks split by who can do them: the engine runs deterministic checks on every change; the AI does judgement-based review on request, using the same data.

| Layer          | Run by                         | Examples                                                                                                                                                                  |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structural ERC | Engine, every `apply`          | Unconnected required pins, output-to-output conflicts, power pins with no source, single-pin nets, undriven inputs                                                        |
| Part-aware     | Engine, every `apply`          | Net voltage vs part ratings (incl. capacitor derating), unverified part records, footprint/pin-table mismatch, datasheet `requirements` not yet satisfied                 |
| Context-aware  | Engine, on `validate`          | External interfaces without protection matching their listed hazards, parts outside the stated temperature range, assembly-method conflicts (e.g. BGA with hand assembly) |
| Design review  | AI, via `design_review` prompt | Topology sanity, values against stated intent, missing decoupling, stability, test points, manufacturability                                                              |

Datasheet requirements are checked as reminders rather than proofs: "U1 requires 0.33 µF on IN — C1 on net +12V, confirm placement in pcb.md". The engine can verify presence and value; proximity is passed to the PCB notes.

Issues can be waived with a reason (`waive U3.NC2 "unused, per datasheet leave floating"`), stored in the .ckt file so the waiver is reviewed and versioned like any other change.

## KiCad interoperability

Interop works through files and `kicad-cli`, not KiCad's live API: KiCad 10's IPC API exposes schematic types but no schematic editing commands yet, so tools that edit schematics write `.kicad_sch` files directly ([KiCad Buddy notes](https://pypi.org/project/kicad-buddy/)).

### Export (primary path)

1. **Netlist to PCB.** Emit a KiCad S-expression netlist with refdes, values, footprints and MPN fields. This is enough to start layout in the PCB editor, and is the most robust hand-off.
2. **Schematic for humans.** Emit a `.kicad_sch` per block (hierarchical sheets for `use` instances), using the viewer's layout positions. Connections are made with net labels on pin endpoints rather than routed wires, which is reliable to generate and readable enough. [SchemaSeed](https://pypi.org/project/schemaseed/) is prior art for this approach, including a round-trip check that re-derives the netlist from the written file.
3. **Symbols and fields.** Emit a project symbol library generated from part records (or reference a mapped KiCad library symbol), with Manufacturer, MPN, Datasheet and supplier fields filled so KiCad's BOM tools also work.
4. **Verification.** After export, run `kicad-cli sch export netlist` on the written schematic and compare it with the source netlist; then run `kicad-cli sch erc`. Any difference is an exporter bug.

### Import

1. Run `kicad-cli sch export netlist --format kicadsexpr` ([option list](https://docs.kicad.org/doxygen/command__sch__export__netlist_8cpp_source.html)) so KiCad itself resolves connectivity (wires, junctions, labels, power symbols, hierarchy). This avoids reimplementing KiCad's connectivity rules.
2. Parse the `.kicad_sch` files only for what the netlist lacks: sheet structure, symbol positions (could seed layout hints) and text notes.
3. Map each symbol to a part record by its MPN field; symbols without one become an "unresolved parts" worklist for the AI and human to resolve.
4. Net names are kept; auto-generated names (`Net-(R1-Pad2)`) are flagged for renaming.

### Round-trip limits

Round trips are lossy by design: graphical detail (wire routing, drawn boxes, text placement) does not survive import, and KiCad edits made after export must be re-imported, not merged. The recommended flow is one-way: design here, export, lay out in KiCad. For a fix discovered during layout, change it here and re-export the netlist; KiCad's "update PCB from netlist" preserves placement.

## Technology stack

Decision: TypeScript end to end, one local process that serves MCP, the CLI and the viewer from a single engine. The viewer must be web tech anyway, and one language avoids maintaining two parsers.

| Component                                   | Choice                                                     | Why                                                                    |
| ------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| Engine (parser, connectivity, checks, diff) | TypeScript library                                         | Shared by every interface; runs in Node and, if useful, in the browser |
| .ckt parser                                 | Hand-written or Lezer/Chevrotain grammar                   | Good error messages with line numbers matter more than speed           |
| Part records                                | YAML + JSON Schema                                         | Schema doubles as the AI's spec for writing records                    |
| MCP server                                  | Official MCP TypeScript SDK, stdio                         | Works with Claude Desktop/Code; same process as viewer                 |
| Viewer                                      | Local web app (Vite + Svelte or React), SVG rendering      | Opens in any browser; can be wrapped in Tauri later                    |
| Auto-layout                                 | Own: groups by signal stage, grid-packed, grid maze router | Deterministic single pass, steerable by stored hints; no retry layouts |
| Versioning                                  | git via isomorphic-git (no git install needed)             | Real git repo the user can also drive directly                         |
| KiCad I/O                                   | Own S-expression reader/writer + `kicad-cli` subprocess    | No Python dependency; KiCad does connectivity on import                |

Python was considered for its KiCad tooling (kiutils, SKiDL) but rejected to keep one language across engine and viewer. Rust is unnecessary for designs of this size.

## Milestones

Each milestone ends with something usable on a real design; the order front-loads the token savings and defers the viewer polish.

1. **M0 — Format + engine.** .ckt grammar, part-record schema, parser, connectivity, structural ERC, CLI `validate`. _Exit:_ a hand-written 30-part design validates with useful errors.
2. **M1 — Claude Code workflow + MCP server.** `overview`, `read_block`, `query`, `apply`, `validate` and part tools, as CLI commands and MCP tools, plus a short grammar reference for CLAUDE.md. _Exit:_ Claude Code builds and edits a design end to end through files and the CLI, with the same operations available over MCP; token use measured against the same task in KiCad + Konnect.
3. **M2 — KiCad export + BOM.** Netlist, generated symbols, `.kicad_sch` with labels, round-trip check, BOM with generic resolution against preferred distributors. _Exit:_ an exported design opens in KiCad, passes ERC, and updates a PCB.
4. **M3 — Viewer.** Auto-layout, live reload, issue pins, part cards, selection → `focus()`. _Exit:_ the human can follow and steer a session without opening files.
5. **M4 — Review + versioning.** Changeset highlighting and revert, checkpoints, variants, semantic diff, optional accept-before-apply mode.
6. **M5 — KiCad import.** Netlist-based import, MPN mapping, unresolved-parts worklist.
7. **M6 — Part-aware and context checks.** Ratings vs net attributes, datasheet requirements, external-interface hazards; `design_review` and `ingest_part` prompts.

## Risks

- **Auto-layout readability.** Generated schematics can be hard to read for analog circuits where convention matters (feedback loops, signal flow left to right). Mitigation: conventional defaults (signal left to right, rails up, ground down, passives grouped with what they serve) plus layout hints in .ckt (stage, rotation, flip) that the human sets in the viewer.
- **AI-extracted part records can be wrong.** A wrong pinout is a board respin. Mitigation: verified flag, footprint pad check, and treating unverified records as a validation warning.
- **KiCad format drift.** `.kicad_sch` changes between major versions. Mitigation: target one KiCad version, keep the netlist path as the robust fallback, and verify every export with `kicad-cli`.
- **DSL adoption cost.** A new language needs a spec the AI can learn cheaply. Mitigation: a one-page grammar reference exposed as an MCP resource, kept under \~1k tokens.
