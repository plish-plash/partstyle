# partstyle

AI-first schematic editor; see [DESIGN.md](DESIGN.md). Circuits are `.ckt` text
([grammar](docs/ckt-grammar.md)), parts are YAML records, and geometry is never part of the AI's view.

## Commands

- `pnpm build`: `tsc -b`, compiles packages to `dist/`
- `pnpm test`: Vitest. Tests import `@partstyle/engine` from source, so no build is needed
- `pnpm lint` / `pnpm format`: Biome check / autofix (also formats Markdown)
- `pnpm typecheck`: strict tsc over all sources including tests (`tsconfig.check.json`)
- `pnpm check`: lint + typecheck + test
- `pnpm partstyle -p examples/bench-sensor overview` (after a build); see
  [docs/cli.md](docs/cli.md), and keep it updated when commands change
- KiCad: `kicad-cli` is often not on PATH. On Windows look in
  `C:\Program Files\KiCad\<version>\bin\kicad-cli.exe` (10.0 on this machine) before concluding
  KiCad is missing, and have code that runs it check there too.

## Layout

- `packages/engine`: pure core in `src/index.ts` (no fs; must stay browser-safe for the viewer);
  node-only code is behind `src/node.ts` (`@partstyle/engine/node`).
  - Pipeline: `ckt/parser` → `parts/library` → `netlist/elaborate` (hierarchy flattening,
    union-find net joining) → `erc/rules` → waivers in `validate.ts`.
  - AI operations: `views.ts` (overview, read_block), `query.ts`, `patch.ts` (apply),
    `parts/search.ts`. `project/workspace.ts` wraps them over a folder, reloading per call.
- `packages/cli` and `packages/mcp`: thin shells over `Workspace`. Every MCP tool has a CLI
  command with identical output; add both together (see [docs/claude-code.md](docs/claude-code.md)).
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
- Write TS files with the editor tools, not bash heredocs (Git Bash on Windows mangles them).
