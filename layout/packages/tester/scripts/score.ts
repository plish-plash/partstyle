/**
 * Prints the score of every test case. `--json` gives machine-readable output, `--issues` lists
 * what each metric found, `--rules '<json>'` applies rule overrides, `--shuffle <seed>` uses a
 * shuffled declaration order, and `--orders <n>` reports how n shuffles change each case.
 */

import {
  fingerprint,
  layoutBlock,
  type Metrics,
  measure,
  type RuleOverrides,
} from "@partstyle/layout";
import { CASES, shuffleInput } from "@partstyle/layout-cases";

const args = process.argv.slice(2);
const rulesAt = args.indexOf("--rules");
const overrides: RuleOverrides = rulesAt >= 0 ? JSON.parse(args[rulesAt + 1] as string) : {};
const numberAfter = (flag: string) => {
  const at = args.indexOf(flag);
  return at >= 0 ? Number(args[at + 1]) : undefined;
};
const seed = numberAfter("--shuffle") ?? 0;
const orders = numberAfter("--orders");
const values = new Set(
  ["--rules", "--shuffle", "--orders"].map((f) => args.indexOf(f) + 1).filter((i) => i > 0),
);
const filter = args.find((a, i) => !a.startsWith("--") && !values.has(i));

if (orders !== undefined) {
  console.log(
    `${"case".padEnd(26)} layouts  broken  crossings  bends      wire     width    height`,
  );
  const range = (list: number[]) => `${Math.min(...list)}-${Math.max(...list)}`.padStart(9);
  for (const c of CASES.filter((x) => !filter || x.id.includes(filter))) {
    const seen = new Set<string>();
    const all: Metrics[] = [];
    let broken = 0;
    for (let s = 0; s <= orders; s++) {
      const input = shuffleInput(c.input, s);
      const r = layoutBlock(input, overrides);
      seen.add(fingerprint(r));
      const { metrics } = measure(input, r);
      all.push(metrics);
      if (metrics.hardFailures > 0) broken++;
    }
    const pick = (k: keyof Metrics) => range(all.map((m) => m[k]));
    console.log(
      `${c.id.padEnd(26)} ${String(seen.size).padStart(7)} ${String(broken).padStart(7)}` +
        `${pick("crossings")} ${pick("bends")} ${pick("wireLength")} ${pick("width")} ${pick("height")}`,
    );
  }
  process.exit(0);
}

const columns: [string, keyof Metrics][] = [
  ["hard", "hardFailures"],
  ["cross", "crossings"],
  ["rail", "railCrossings"],
  ["pwire", "powerWire"],
  ["bends", "bends"],
  ["wire", "wireLength"],
  ["str%", "straightPercent"],
  ["lbl", "labels"],
  ["back", "signalBackwards"],
  ["pwr", "powerWrongWay"],
  ["shunt", "shuntMisplaced"],
  ["w", "width"],
  ["h", "height"],
];

const rows = CASES.filter((c) => !filter || c.id.includes(filter)).map((c) => {
  const start = performance.now();
  const input = shuffleInput(c.input, seed);
  const result = layoutBlock(input, overrides);
  const ms = performance.now() - start;
  return { id: c.id, ms, ...measure(input, result) };
});

if (args.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const idWidth = Math.max(...rows.map((r) => r.id.length));
  console.log(`${"case".padEnd(idWidth)} ${columns.map(([h]) => h.padStart(5)).join(" ")}    ms`);
  for (const r of rows) {
    const cells = columns.map(([, key]) => String(r.metrics[key]).padStart(5));
    console.log(`${r.id.padEnd(idWidth)} ${cells.join(" ")} ${r.ms.toFixed(0).padStart(5)}`);
    if (args.includes("--issues")) for (const i of r.issues) console.log(`    ${i.message}`);
  }
  const hard = rows.reduce((s, r) => s + r.metrics.hardFailures, 0);
  const crossings = rows.reduce((s, r) => s + r.metrics.crossings, 0);
  console.log(`\n${rows.length} cases, ${hard} hard failures, ${crossings} crossings`);
}
