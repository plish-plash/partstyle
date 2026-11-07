# Partstyle

AI-first schematic editor; see [docs/design.md](docs/design.md). Circuits are `.ckt` text
([grammar](docs/ckt-grammar.md)), parts are YAML records that cache their datasheet
([format](docs/part-records.md)), and geometry is never part of the AI's view.

## Commands

- `pnpm build`: `tsc -b` to `dist/`, then the viewer with Vite (`packages/viewer/dist`)
- `pnpm test`: Vitest. Tests import `@partstyle/engine` from source, so no build is needed
  (the one test serving the built viewer page is skipped until it is built)
- `pnpm lint` / `pnpm format`: Biome check / autofix (also formats Markdown; `.svelte` files are
  excluded because Biome cannot see template usage)
- `pnpm typecheck`: strict tsc over all sources including tests (`tsconfig.check.json`), then
  `svelte-check` for the viewer (which uses its own TypeScript 6; svelte-check does not support 7)
- `pnpm partstyle -p examples/bench-sensor view`, then open the printed URL; for UI work run
  `pnpm --filter @partstyle/viewer dev` (Vite, proxies `/api` to a viewer on port 7766)
- `pnpm check`: lint + typecheck + test
- `pnpm standalone [TARGET...]` (after a build): Bun-compiled single executable in
  `packages/cli/standalone/out/` with the grammar and viewer embedded (`scripts/standalone.mjs`;
  Bun is at `~/.bun/bin/bun.exe` here, so pass `BUN=` if it is not on PATH). The smoke test
  `packages/cli/src/standalone.test.ts` runs only when the native executable exists. CI
  (`.github/workflows/ci.yml`) and tag releases (`release.yml`) build and smoke-test these
  with `PARTSTYLE_BINARY` set, which makes a missing executable fail rather than skip.
- `pnpm mcpb` (after a build, needs Bun): the Claude Desktop extension
  `packages/cli/standalone/out/partstyle.mcpb`, the same entry bundled for Node, with the
  manifest template `packages/cli/mcpb/manifest.json` (tools filled in from the server). Building
  it runs the bundle under the current Node first; `node scripts/standalone.mjs --check-mcpb`
  repeats that (the manifest promises Node >= 22, the oldest Node CI checks it under). The smoke test also runs the bundle.
- The example and the fixtures get their parts from the libraries in `~/.partstyle/settings.yaml`
  (list this repo's `library/` there for the CLI); tests use `vitest.setup.ts`, which points
  `PARTSTYLE_STATE_DIR` at a temporary copy, so they never touch the repo's records.
- `pnpm partstyle -p examples/bench-sensor overview` (after a build); see
  [docs/cli.md](docs/cli.md), and keep it updated when commands change. cli.md is a man page:
  command syntax and behaviour only; the layout rules (shared by the viewer and the KiCad
  export) are in [docs/layout.md](docs/layout.md), kept updated when the drawing code changes. Installing, building, the standalone executable, CI and
  releases go in [INSTALL.md](INSTALL.md); MCP client setup in docs/claude-code.md.
- KiCad: `kicad-cli` is often not on PATH. On Windows look in
  `C:\Program Files\KiCad\<version>\bin\kicad-cli.exe` (10.0 on this machine) before concluding
  KiCad is missing (`project/kicad.ts` `findKicad` checks there). Tests that need kicad-cli
  use `it.skipIf` and are skipped without it. To eyeball a generated schematic, run
  `kicad-cli sch export svg` and screenshot the SVG with headless Edge (no PDF renderer here).
  To screenshot the viewer, use `--virtual-time-budget=8000` and the `?live=0` URL (the live
  event stream otherwise keeps headless Edge waiting forever); write `.partstyle/focus.json`
  first to choose the sheet and selection.

## Layout

- `layout/`: the layout engine (`@partstyle/layout`), its test circuits and a visual tester, with
  its own [CLAUDE.md](layout/CLAUDE.md) for tuning the rules. The engine is generic and imports
  nothing from Partstyle: anything specific to Partstyle or KiCad goes in `drawing/adapter.ts`.

- `packages/engine`: pure core in `src/index.ts` (no fs; must stay browser-safe for the viewer);
  node-only code is behind `src/node.ts` (`@partstyle/engine/node`).
  - Part records: `parts/schema.ts` `readPartRecord` refuses only what the engine needs (id,
    summary, pins); a field it can't use is dropped from `PartRecord` with a `part.format`
    warning but stays in the YAML, and unknown sections are kept. Keep this lenient: a record
    must never lose datasheet information to validation.
  - Pipeline: `ckt/parser` → `parts/library` → `netlist/elaborate` (hierarchy flattening,
    union-find net joining) → `erc/rules`, `checks/parts` (pin `vmax`, capacitor derating,
    requirement checks) and `checks/context` (temperature range, interfaces naming real
    connectors; `checks/nets` has net voltages) → waivers in `validate.ts` (warnings only).
  - Configuration: `project/config.ts` (`partstyle-project.yaml`: name, description, design
    context, `sourcing`, `checks`; the top block is always `main`), `project/settings.ts` (node:
    the user's `settings.yaml` with libraries and KiCad overrides, read fresh per call). The
    review mode is `.partstyle/review.json`, set only from the viewer.
  - Procedures: `prompts.ts` (design_review, ingest_part, handoff) feeds `guide`, the MCP
    prompts and the `.claude/commands/` files `init` writes. `readGuide` in `workspace.ts` serves
    them with the references in `docs/` (ckt-grammar, part-records, issues). What every chat must
    know goes in `mcpInstructions`; everything else goes in a guide.
  - AI operations: `views.ts` (overview, read_block), `query.ts`, `patch.ts` (apply),
    `parts/search.ts`. `project/workspace.ts` wraps them over a folder, reloading per call.
- `packages/cli` and `packages/mcp`: thin shells over `Workspace` (`partstyle mcp` runs
  `serveMcp` from `packages/mcp/src/serve.ts`). Without `--project` the MCP server is in global
  mode: `project/projects.ts` (`Projects`: projects folder, shared `library/` used before the
  user's libraries and remembered for the CLI on start, recent list in `~/.partstyle` or
  `PARTSTYLE_STATE_DIR`),
  `list_projects`/`open_project`, and the viewer's `switchTo`. Its instructions are
  `mcpInstructions` in `project/skeleton.ts`, sharing the conventions with the project
  CLAUDE.md template; keep the two workflows in step. Every MCP tool has a CLI
  command with identical output; add both together (see [docs/claude-code.md](docs/claude-code.md)).
  - KiCad hand-off: `bom.ts` (generic → MPN resolution, bom.lock), `kicad/` (S-expressions,
    annotation, schematic and netlist writers; pure). Symbols: `kicad/libsym.ts` matches and
    vets KiCad library symbols (flattening, units, pin compatibility, `adaptedSymbol`'s copies
    renumbered by pin name), `kicad/power.ts` power
    symbols, `kicad/symbols.ts` generated fallbacks. `project/kicad.ts` (node) finds kicad-cli
    and the stock libraries, indexes symbol names, checks footprint pads and parses ERC.
  - Drawing (shared by the viewer and KiCad export, pure and deterministic): `drawing/plan.ts`
    decides which nets get power symbols and where PWR_FLAGs go; `drawing/adapter.ts` translates
    each block to `@partstyle/layout` and back; `drawing/connectivity.ts` proves the geometry
    matches the netlist; `drawing/prepare.ts` is the entry point.
    `kicad/schematic.ts` only serializes it.
  - KiCad import: `kicad/import.ts` (pure: netlist reading, sheets → blocks and ports, part
    matching, draft records, re-import carry-over) and `project/kicad-import.ts` (node: runs
    kicad-cli on a temporary copy, with PWR_FLAGs exposed and ERC for no-connect flags).
    Workspace `kicadImport` writes the files and checks the result against KiCad's netlist.
  - Review: `review.ts` (comments.yaml, .partstyle/focus.json, `focus` text), `approvals.ts`
    (approvals.yaml: sign-offs per part, each a snapshot of its spec and nets, so a change shows)
    and `viewer-model.ts` (the JSON the viewer renders, with each part's lookup links).
  - Versions: `versions/diff.ts` (semantic statement diff, pure) and `versions/revert.ts`
    (revert plans as patches). Node side: `project/git.ts` (isomorphic-git; no git CLI
    needed; comparisons hash working files against commit trees), `project/history.ts`
    (changeset log in .partstyle/history.json, recorded on every `Workspace` load),
    `project/pending.ts` (accept mode) and `project/variants.ts` (variants as overlays in
    `variants/NAME/`: their own block files and project-file overrides over main's). A
    `Workspace` with `variant` set (`forVariant`) loads the overlaid design, writes blocks
    copy-on-write through `writeCircuit`, and keeps its own history, pending and export outputs;
    `applyTo` applies one patch to several. Only the test checking the result with the git CLI
    uses `skipIf`.
- `packages/server`: local HTTP server for the viewer (model API, SSE live reload, focus,
  comments, verify); 127.0.0.1 only, Host-header and custom-header checks. Started by
  `partstyle view` and by the MCP server.
- `packages/viewer`: Svelte 5 + Vite app rendering `ViewerModel` as SVG (KiCad colours).
- `project/skeleton.ts`: files `init` creates, including the project CLAUDE.md template.
  `examples/bench-sensor/CLAUDE.md` is generated from it (a test keeps them in sync).
- `library/`: seed global part records. `examples/bench-sensor/`: 30-part reference design.
  `packages/engine/test-fixtures/broken/`: one fault per check.

## Conventions

- Naming: the tool is "Partstyle" in docs, manifests, generated text and UI; lowercase
  `partstyle` only for the executable/CLI and literal identifiers (package names, file and
  folder names, `partstyle://` URIs, the MCP server key, KiCad's generator and library names).

- Issues carry a stable `code`, a `file:line:col` location and flat-path `subjects`; waivers
  match subjects. Add new codes to the table in `docs/issues.md`.
- An issue is a hint for the AI to retry, a design fault, or something for the person to decide,
  never a normal step of designing. Errors must be fixed and cannot be waived, so only report one
  the engine can be sure of. Engine checks stay to ERC-style connectivity and numeric datasheet
  limits; broad design judgement (protection, hazards) belongs to the AI and `design_review`.
- AI-facing output is terse text, budgeted in tokens (tests assert rough limits). Prefer one
  line per item and omit defaults (e.g. pin type `passive`).
- TS is strict with `exactOptionalPropertyTypes`; spread optional fields
  (`...(x !== undefined && { x })`) instead of assigning `undefined`.
- Prefer the built-in tools over shell commands: Read (not cat/head/sed -n), Grep and Glob
  (not grep/find), Edit and Write (not sed -i, heredocs or scripts that rewrite files). Shell
  edits have repeatedly failed here: sed patterns miss lines after Biome reformats them, and Git
  Bash on Windows mangles heredocs containing TypeScript. Keep the shell for running things
  (pnpm, node, git, kicad-cli).
