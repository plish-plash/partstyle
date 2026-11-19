/** Prints a case as a character grid, for debugging the engine from a terminal. */

import { layoutBlock } from "@partstyle/layout";
import { allCases } from "./captured.js";
import { textGrid } from "./grid.js";

const id = process.argv[2] as string;
const c = allCases().find((x) => x.id === id);
if (!c) throw new Error(`no case ${id}`);
const r = layoutBlock(c.input, process.argv[3] ? JSON.parse(process.argv[3]) : {});
console.log(textGrid(r));
console.log(r.unrouted);
