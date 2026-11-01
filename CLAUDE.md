# partstyle

AI-first schematic editor; see [DESIGN.md](DESIGN.md). Circuits are `.ckt` text
([grammar](docs/ckt-grammar.md)), parts are YAML records, and geometry is never part of the AI's view.

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
  `packages/cli/src/standalone.test.ts` runs only when the native executable exists. Bun
  defines a global `self`, which `drawing/layout.ts` hides while constructing ELK. CI
  (`.github/workflows/ci.yml`) and tag releases (`release.yml`) build and smoke-test these
  with `PARTSTYLE_BINARY` set, which makes a missing executable fail rather than skip.
- `pnpm partstyle -p examples/bench-sensor overview` (after a build); see
  [docs/cli.md](docs/cli.md), and keep it updated when commands change. cli.md is a man page:
  command syntax and behaviour only. Installing, building, the standalone executable, CI and
  releases go in [docs/install.md](docs/install.md); MCP client setup in docs/claude-code.md.
- KiCad: `kicad-cli` is often not on PATH. On Windows look in
  `C:\Program Files\KiCad\<version>\bin\kicad-cli.exe` (10.0 on this machine) before concluding
  KiCad is missing (`project/kicad.ts` `findKicad` checks there). Tests that need kicad-cli
  use `it.skipIf` and are skipped without it. To eyeball a generated schematic, run
  `kicad-cli sch export svg` and screenshot the SVG with headless Edge (no PDF renderer here).
  To screenshot the viewer, use `--virtual-time-budget=8000` and the `?live=0` URL (the live
  event stream otherwise keeps headless Edge waiting forever); write `.partstyle/focus.json`
  first to choose the sheet and selection.

## Layout

- `packages/engine`: pure core in `src/index.ts` (no fs; must stay browser-safe for the viewer);
  node-only code is behind `src/node.ts` (`@partstyle/engine/node`).
  - Pipeline: `ckt/parser` → `parts/library` → `netlist/elaborate` (hierarchy flattening,
    union-find net joining) → `erc/rules`, `checks/parts` (pin `vmax`, capacitor derating,
    requirement checks) and `checks/context` (context.md hazards, temperature, assembly;
    `checks/nets` has net voltages) → waivers in `validate.ts`.
  - Procedures: `prompts.ts` (design_review, ingest_part, prepare_handoff) feeds the MCP
    prompts, `partstyle prompt` and the `.claude/commands/` files `init` writes.
  - AI operations: `views.ts` (overview, read_block), `query.ts`, `patch.ts` (apply),
    `parts/search.ts`. `project/workspace.ts` wraps them over a folder, reloading per call.
- `packages/cli` and `packages/mcp`: thin shells over `Workspace` (`partstyle mcp` runs
  `serveMcp` from `packages/mcp/src/serve.ts`). Every MCP tool has a CLI
  command with identical output; add both together (see [docs/claude-code.md](docs/claude-code.md)).
  - KiCad hand-off: `bom.ts` (generic → MPN resolution, bom.lock), `kicad/` (S-expressions,
    annotation, schematic and netlist writers; pure). Symbols: `kicad/libsym.ts` matches and
    vets KiCad library symbols (flattening, units, pin compatibility), `kicad/power.ts` power
    symbols, `kicad/symbols.ts` generated fallbacks. `project/kicad.ts` (node) finds kicad-cli
    and the stock libraries, indexes symbol names, checks footprint pads and parses ERC.
  - Drawing (shared by the viewer and KiCad export, pure): `drawing/plan.ts` decides per net
    power symbol / wire / label; `drawing/orient.ts` turns two-terminal parts; `drawing/layout.ts`
    places and routes each sheet with ELK (decoupling and shunt parts ride beside a host part
    inside its ELK node; flips and mirrors are tried as extra layouts and kept if they shorten
    the wiring; connected components are packed onto the smallest paper) and snaps it to 1.27 mm
    grid (`gridRoute` keeps segments orthogonal); `drawing/wires.ts`
    splits, merges and adds junctions; `drawing/connectivity.ts` proves the geometry matches the
    netlist; `drawing/prepare.ts` is the entry point. `kicad/schematic.ts` only serializes it.
  - KiCad import: `kicad/import.ts` (pure: netlist reading, sheets → blocks and ports, part
    matching, draft records, re-import carry-over) and `project/kicad-import.ts` (node: runs
    kicad-cli on a temporary copy, with PWR_FLAGs exposed and ERC for no-connect flags).
    Workspace `kicadImport` writes the files and checks the result against KiCad's netlist.
  - Review: `review.ts` (comments.yaml, .partstyle/focus.json, `focus` text) and
    `viewer-model.ts` (the JSON the viewer renders).
  - Versions: `versions/diff.ts` (semantic statement diff, pure) and `versions/revert.ts`
    (revert plans as patches). Node side: `project/git.ts` (isomorphic-git; no git CLI
    needed; comparisons hash working files against commit trees), `project/history.ts`
    (changeset log in .partstyle/history.json, recorded on every `Workspace` load),
    `project/pending.ts` (accept mode) and `project/variants.ts` (working copies under
    .partstyle/variants/, marked by `.partstyle-variant.json`, each committing to its own
    branch). Only the test checking the result with the git CLI uses `skipIf`.
- `packages/server`: local HTTP server for the viewer (model API, SSE live reload, focus,
  comments, verify); 127.0.0.1 only, Host-header and custom-header checks. Started by
  `partstyle view` and by the MCP server.
- `packages/viewer`: Svelte 5 + Vite app rendering `ViewerModel` as SVG (KiCad colours).
- `project/skeleton.ts`: files `init` creates, including the project CLAUDE.md template.
  `examples/bench-sensor/CLAUDE.md` is generated from it (a test keeps them in sync).
- `library/`: seed global part records. `examples/bench-sensor/`: 30-part reference design.
  `packages/engine/test-fixtures/broken/`: one fault per check.

## Conventions

- Issues carry a stable `code`, a `file:line:col` location and flat-path `subjects`; waivers
  match subjects. Add new codes to the table in `docs/ckt-grammar.md`.
- AI-facing output is terse text, budgeted in tokens (tests assert rough limits). Prefer one
  line per item and omit defaults (e.g. pin type `passive`).
- TS is strict with `exactOptionalPropertyTypes`; spread optional fields
  (`...(x !== undefined && { x })`) instead of assigning `undefined`.
- Prefer the built-in tools over shell commands: Read (not cat/head/sed -n), Grep and Glob
  (not grep/find), Edit and Write (not sed -i, heredocs or scripts that rewrite files). Shell
  edits have repeatedly failed here: sed patterns miss lines after Biome reformats them, and Git
  Bash on Windows mangles heredocs containing TypeScript. Keep the shell for running things
  (pnpm, node, git, kicad-cli).
