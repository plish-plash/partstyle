/**
 * Cases captured from real Partstyle projects (`pnpm layout-report --case` at the repo root).
 * They live in `layout/captured/`, which is gitignored: they come from people's own designs.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES, type TestCase } from "@partstyle/layout-cases";

export const CAPTURED_DIR = fileURLToPath(new URL("../../../captured/", import.meta.url));

export function capturedCases(): TestCase[] {
  if (!existsSync(CAPTURED_DIR)) return [];
  return readdirSync(CAPTURED_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(CAPTURED_DIR, f), "utf8")) as TestCase);
}

/** The built-in cases, then the captured ones. */
export const allCases = (): TestCase[] => [...CASES, ...capturedCases()];
