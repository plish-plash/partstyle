# Layout

Automatic layout of single schematic blocks, developed against a visual tester. Partstyle's
`packages/engine` uses it through `@partstyle/layout`; `drawing/adapter.ts` there is the only
place the two meet. See `README.md` for the structure and pipeline.

Run these commands from this folder. A session started here does not load Partstyle's root
`CLAUDE.md` (`claudeMdExcludes` in `.claude/settings.local.json`). Work that spans the adapter
or the rest of Partstyle runs from the repo root instead.

## Working loop

The user judges layouts visually in the tester (`pnpm dev`, which they run); do not attempt visual
review yourself. Check your work with numbers and report them. Before saying something moved,
measure that exact thing, such as a part's position or a net's wire length. A changed score proves
nothing: an overall number can improve while the part in the note stays where it was.

Crossings are partly a matter of taste. A crossing can look better than the alternative, so a
higher count is not a defect by itself: point it out for the user to judge rather than adding
rules to reduce it.

Feedback in `feedback/` is gitignored: each person judges the layouts for themselves.

1. Run `pnpm notes` when asked to check the feedback. `feedback/notes.json` has the full entries,
   with rule overrides, scores and any shuffle; `feedback/snapshots/<case>.json` is the exact
   layout judged. Apply the rule overrides the user settled on to the defaults when they ask.
2. Change the rules. Use `pnpm score <case> --issues` and `pnpm dump <case>` to see the effect.
3. Run `pnpm test`, then give before and after scores from `pnpm score`.
4. For each note addressed, run `pnpm notes resolve <case> "<what changed>"`. That clears the note
   and verdict, shows the user what to review, and keeps the old note in `feedback/history.jsonl`.
   Only resolve what was actually addressed. `pnpm notes tidy` clears notes on cases marked good.

Hot reload keeps the previous layouts, so the user can compare without doing anything.

## Rules of the code

- `packages/layout` stays pure, synchronous, deterministic and dependency-free, with no Node APIs.
  Partstyle's viewer runs its layout in the browser.
- IC pin positions never change. The engine only places, rotates two-terminal parts, and mirrors
  connectors.
- Every behaviour the user might want to adjust is a rule in `packages/layout/src/rules.ts`, with
  a plain-language description. The tester generates its controls from that list.
- `layoutBlock` must produce no hard failures for any rule setting or declaration order;
  `pnpm test` enforces this for every case. `pnpm score --orders 20` shows how much order matters.
  Add a test circuit to `packages/cases/src/cases.ts` when a new failure shape appears.
- `LayoutResult` deliberately resembles Partstyle's `SheetLayout`, so the later adapter stays thin.
  It uses grid units; Partstyle uses millimetres.
- This package stays generic. Assume symbol pins are on the grid, and keep anything specific to
  KiCad or Partstyle in the adapter. It must import nothing from Partstyle.
- Tooling matches Partstyle: pnpm, TypeScript with NodeNext `.js` imports, strict options
  including `exactOptionalPropertyTypes`, Vitest, Biome, Svelte 5 and Vite.
