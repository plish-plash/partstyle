import { readFileSync } from "node:fs";

let version: string | undefined;

/** Stamps a release build's version (its entry calls this), overriding package.json's. */
export function embedVersion(v: string): void {
  version = v;
}

/**
 * Partstyle's version: what `partstyle --version` prints, the MCP server reports and `init`
 * records in the project file.
 */
export function partstyleVersion(): string {
  version ??= (
    JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
    }
  ).version;
  return version;
}
