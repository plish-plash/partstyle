# partstyle

AI-first schematic editor; see [DESIGN.md](DESIGN.md). Circuits are `.ckt` text
([grammar](docs/ckt-grammar.md)), parts are YAML records, and geometry is never part of the AI's view.

## Commands

- `pnpm build`: `tsc -b`, compiles packages to `dist/`
- `pnpm test`: Vitest. Tests import `@partstyle/engine` from source, so no build is needed
- `pnpm lint` / `pnpm format`: Biome check / autofix
- `pnpm typecheck`: strict tsc over all sources including tests (`tsconfig.check.json`)
- `pnpm check`: lint + typecheck + test
- `node packages/cli/dist/main.js validate examples/bench-sensor [--json]`

## Layout

- `packages/engine`: pure core in `src/index.ts` (no fs; must stay browser-safe for the viewer);
  the node-only loader is `src/node.ts` (`@partstyle/engine/node`).
  Pipeline: `ckt/parser` → `parts/library` → `netlist/elaborate` (hierarchy flattening,
  union-find net joining) → `erc/rules` → waivers in `validate.ts`.
- `packages/cli`: thin `partstyle` CLI; commands return `{stdout, exitCode}` for tests.
- `library/`: seed global part records. `examples/bench-sensor/`: 30-part reference design.
  `packages/engine/test-fixtures/broken/`: one fault per check.

## Conventions

- Issues carry a stable `code`, a `file:line:col` location and flat-path `subjects`; waivers
  match subjects. Add new codes to the table in `docs/ckt-grammar.md`.
- TS is strict with `exactOptionalPropertyTypes`; spread optional fields
  (`...(x !== undefined && { x })`) instead of assigning `undefined`.
