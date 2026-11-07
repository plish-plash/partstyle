#!/usr/bin/env node
// Checks that every package under packages/ and layout/packages/ has the same version, a semantic version (the
// Claude Desktop extension manifest requires one), and, given a tag, that the tag is that
// version with a v in front. Prints the version. The release workflow runs it on the tag.
//
//   node scripts/check-version.mjs [TAG]
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const versions = new Map();
for (const root of ["packages", "layout/packages"]) {
  const packages = fileURLToPath(new URL(`../${root}`, import.meta.url));
  for (const name of readdirSync(packages)) {
    const file = path.join(packages, name, "package.json");
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    versions.set(`${root}/${name}/package.json`, pkg.version);
  }
}

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const distinct = [...new Set(versions.values())];
if (distinct.length !== 1) {
  fail(
    `the packages disagree on the version; bump them together:\n${[...versions]
      .map(([f, v]) => `  ${f}: ${v}`)
      .join("\n")}`,
  );
}
const version = distinct[0];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  fail(`the package version '${version}' is not a semantic version (X.Y.Z or X.Y.Z-suffix)`);
}
const tag = process.argv[2];
if (tag !== undefined && tag !== `v${version}`) {
  fail(
    `tag ${tag} does not match the package version ${version}: bump packages/*/package.json to ` +
      `${tag.replace(/^v/, "")} and tag that commit, or tag it v${version}`,
  );
}
console.log(version);
