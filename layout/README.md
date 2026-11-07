# Layout

Automatic layout for a single block of an electrical schematic, plus a visual tester for judging
the results and adjusting the rules. It is part of Partstyle, and this folder is where the rules get worked out.

## Running the tester

```sh
pnpm install
pnpm dev
```

Then open <http://localhost:5173>.

| Area      | What it does                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Left list | All test cases. A square red dot means a broken drawing; round dots show your verdict. An orange mark means the case changed.                  |
| Case view | One schematic. Scroll to zoom, drag to pan, double-click to fit. Hover a wire to highlight its net; click a part to see which rules placed it. |
| All cases | Every case at once, with changed cases outlined, to see what a rule change touches.                                                            |
| Compare   | The current layout beside a reference, with score differences.                                                                                 |
| Rules     | Every rule with its parameters. Changes apply instantly and are kept in the URL.                                                               |

**Shuffle order** lays out every case again with its parts and nets declared in a different order;
each press is a new, repeatable shuffle. Compare to **As declared** to see what it changed.

Use **Compare to** to pick the reference: the layouts before the last code change, the default
rules, or a baseline you saved. Keys: `j`/`k` change case; `1`, `2`, `3` change view.

Code changes appear without a page reload, and your case and rule settings stay as they were.

## Giving feedback

Mark a case good, needs work or bad, and add a note. Each one goes to `feedback/notes.json`, with
the rule settings and scores at that moment; the exact layout goes to `feedback/snapshots/`.

When a note has been addressed, it is cleared and the case shows **Ready to review** with what
changed, on a blue dot. Marking a case good clears its note, and **Clear** does the same by hand.
Cleared notes stay in `feedback/history.jsonl`. The `feedback/` folder is gitignored, so everyone
makes their own judgements. An orange ring on a dot means the layout has changed
since you judged it. Saved
presets go to `presets/` and baselines to `baselines/`. All of them are plain JSON.

## Commands

| Command            | Purpose                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`         | Start the tester                                                                                                                               |
| `pnpm score`       | Print every case's scores. Add a case name to filter, `--issues` to list problems, `--json` for data, or `--rules '<json>'` to apply overrides |
| `pnpm notes`       | List open feedback; `pnpm notes resolve <case> "<text>"` clears an addressed note                                                              |
| `pnpm dump <case>` | Draw a case as text in the terminal                                                                                                            |
| `pnpm test`        | Check every case under every rule setting                                                                                                      |
| `pnpm check`       | Lint, typecheck and test                                                                                                                       |

## Layout

```
packages/layout   the package: pure, deterministic, no dependencies, safe in a browser
packages/cases    test circuits and the builder they are written with
packages/tester   the Vite and Svelte tester
```

`layoutBlock(input, rules?)` takes parts with fixed pin positions and returns placed parts, wires,
junctions, power symbols and labels. Coordinates are integer grid units with y down; one unit is
2.54 mm. `measure(input, result)` scores a layout and re-derives its connectivity from the drawing.

### How a block is laid out

1. **Classify:** ICs and connectors become anchors. Anything from a wire to a rail becomes a
   hanger, including whole chains such as resistor + LED + ground. The rest forms series chains.
2. **Flow:** anchors vote on left-to-right order from pin type and pin side, giving columns.
3. **Order:** columns are sorted to reduce crossings. IC pins never move.
4. **Rows:** each pin gets a row carrying everything on its net: hangers above or below the wire,
   series parts in line, and a port label or the next anchor's pin at the end.
5. **Place:** rows are spaced around their hanging parts. Hangers step along so each sits past the
   rows it spans, which is what keeps fan-outs from crossing.
6. **Power:** rails and grounds get local symbols, pointing up and down. Rail pins on the side
   of a part run straight past it to a symbol just above or below; these wires may cross pin
   wires, which is not counted against the layout.
7. **Route:** rows are drawn directly; a grid router connects whatever is left.
8. **Clean up:** wires are merged, junctions added and text placed.

To add a rule, add it to `RULES` in [rules.ts](packages/layout/src/rules.ts) and read it in a pass.
The tester builds its controls from that list. To add a test circuit, add it to
[cases.ts](packages/cases/src/cases.ts).
