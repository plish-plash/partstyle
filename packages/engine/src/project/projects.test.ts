// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are the literal placeholders Claude Desktop passes
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultProjectsDir, projectsDirFrom } from "./projects.js";

describe("projectsDirFrom", () => {
  const warnings: string[] = [];
  const dir = (value: string | undefined) => projectsDirFrom(value, (m) => warnings.push(m));

  it("expands the folder variables Claude Desktop passes unexpanded", () => {
    expect(dir("${DOCUMENTS}/partstyle")).toBe(path.join(homedir(), "Documents", "partstyle"));
    expect(dir("${HOME}/designs")).toBe(path.join(homedir(), "designs"));
    expect(warnings).toEqual([]);
  });

  it("falls back to the default folder when empty or left unsubstituted", () => {
    expect(dir(undefined)).toBe(defaultProjectsDir());
    expect(dir("  ")).toBe(defaultProjectsDir());
    expect(dir("${user_config.projects_dir}")).toBe(defaultProjectsDir());
    expect(warnings).toEqual([
      `ignoring --projects-dir \${user_config.projects_dir} (unknown variable); using ${defaultProjectsDir()}`,
    ]);
  });

  it("keeps a plain folder", () => {
    const folder = path.join(homedir(), "elsewhere");
    expect(dir(folder)).toBe(folder);
  });
});
