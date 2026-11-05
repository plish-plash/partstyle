# Installing and building Partstyle

For Claude Desktop alone, install the extension. For the `partstyle` command (Claude Code, other
MCP clients, or a terminal), use the standalone executable (no Node, git or checkout needed) or
a build from source; both include `partstyle mcp`, the MCP server. To connect it to a client,
see [docs/claude-code.md](docs/claude-code.md). Commands are described in the
[CLI reference](docs/cli.md).

KiCad is optional and always separate: `kicad export` and `kicad import` need kicad-cli (see
[Finding KiCad](docs/cli.md#finding-kicad)).

## Claude Desktop extension

Download `partstyle.mcpb` from the GitHub releases page and double-click it, or drag it into
Claude Desktop's Settings → Extensions, then choose Install. Its one setting is the projects
folder (default `Documents/partstyle`), where new projects go and whose `library/` subfolder is
their shared part library. The extension runs on Claude Desktop's own Node.js, so nothing else
is needed; it is the same MCP server as `partstyle mcp`. See
[docs/claude-code.md](docs/claude-code.md#claude-desktop) for working with it.

The extension is not signed, so Claude Desktop shows it as unverified when installing.

## Seed part library

Optional: `partstyle-library.zip` on the releases page holds the starter part records from this
repository's `library/` (20 records: regulators, an MCU, an op-amp, diodes, connectors,
passives and LEDs), released under CC0 1.0 (public domain; see `library/LICENSE`). Unzip it
in the projects folder (`Documents/partstyle` by default): it unpacks as `library/`, the shared
library every project the MCP server opens uses (and the CLI too, once the server has run).
Records added later with `part_put` go there too. To use a library elsewhere, add its folder
under `libraries:` in `~/.partstyle/settings.yaml` (see [Settings](docs/cli.md#settings)).

## Standalone executable

Download the file for your platform from the GitHub releases page: `partstyle-linux-x64`,
`partstyle-linux-arm64`, `partstyle-darwin-arm64` (Apple Silicon), `partstyle-darwin-x64` or
`partstyle-windows-x64.exe`. `SHA256SUMS` lists their checksums.

Put it on PATH as `partstyle` (`partstyle.exe` on Windows). On Linux and macOS, make it
executable first:

```sh
chmod +x partstyle
```

The macOS builds are only ad-hoc signed, so macOS blocks the first run as coming from an
unidentified developer: allow it in System Settings → Privacy & Security, or run
`xattr -d com.apple.quarantine partstyle`. Windows SmartScreen may warn once for the same reason.

## From source

Needs Node 22 or later and pnpm.

```sh
pnpm install && pnpm build        # in the Partstyle repository
pnpm add -g ./packages/cli        # puts `partstyle` on PATH, linked to this checkout
```

The global install links to the checkout, so later `pnpm build` runs update it. Without it, run
`node <repo>/packages/cli/dist/main.js`, or `pnpm partstyle ...` from the repository root.

## Building the standalone executable

Needs [Bun](https://bun.sh) as well. After `pnpm build`:

```sh
pnpm standalone                       # this machine: packages/cli/standalone/out/partstyle-<os>-<arch>
pnpm standalone bun-linux-x64 bun-darwin-arm64 bun-windows-x64   # cross-compile
```

Targets are Bun's: `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`, `bun-darwin-x64`,
`bun-windows-x64`. Set `BUN` to the bun binary if it is not on PATH.

`scripts/standalone.mjs` writes a generated entry (`packages/cli/standalone/entry.js`) that
embeds `docs/ckt-grammar.md`, `docs/part-records.md` and the viewer's `dist/`, then runs
`bun build --compile`.
`packages/cli/src/standalone.test.ts` smoke-tests the native executable when it exists (CLI
output, MCP over stdio, the embedded grammar and viewer); set `PARTSTYLE_BINARY` to test a
particular file, which also makes a missing file fail the test instead of skipping it.

## Building the Claude Desktop extension

Needs Bun too. After `pnpm build`:

```sh
pnpm mcpb                             # packages/cli/standalone/out/partstyle.mcpb
node scripts/standalone.mjs --check-mcpb   # check the built server under another Node
```

`pnpm mcpb` bundles the same generated entry for Node (`bun build --target=node`) into
`packages/cli/standalone/out/mcpb/server/index.mjs` (about 2.6 MB), then runs it under the
current Node the way Claude Desktop would: MCP handshake, the grammar, and the viewer drawing a
copy of `examples/bench-sensor`. It then writes the manifest from the template
`packages/cli/mcpb/manifest.json`, with the server's tool list and the `package.json`
version, adds `LICENSE` and `THIRD_PARTY_NOTICES.txt`
(every bundled package's license, found from Bun's metafile, plus the viewer's Svelte runtime;
also written to `out/` for releases), and packs it with the `mcpb` CLI
(`@anthropic-ai/mcpb`). The manifest asks for Node 22 or later; `--check-mcpb` repeats the check
alone, e.g. under another Node. The smoke test also covers the bundle once it is built.

## CI and releases

- `.github/workflows/ci.yml`, on pushes to `main` and pull requests: `pnpm check` on Linux and
  Windows, then builds and smoke-tests each runner's executable and the extension.
- `.github/workflows/release.yml`, on a `vX.Y.Z` tag: checks the tag against the version (below);
  builds all five executables on Linux,
  macOS and Windows runners (the macOS ones ad-hoc signed) and smoke-tests the ones each runner
  can execute; builds the extension and checks it under Node 22;
  zips `library/` as `partstyle-library.zip`; then publishes them all, with `SHA256SUMS` and
  `THIRD_PARTY_NOTICES.txt` (the licenses of the bundled packages), as a
  GitHub release with generated notes. A tag with a
  `-`, like `v0.2.0-rc1`, makes a prerelease.

**Versions.** The `version` in `packages/*/package.json` is the version: what
`partstyle --version` prints and the MCP server reports, from source, the executables and the
extension alike, and what the extension manifest says. The packages move together, and it must
be a semantic version (`X.Y.Z` or `X.Y.Z-suffix`), which the extension manifest requires;
`scripts/check-version.mjs` checks both (so does `pnpm check`). A release tag must be exactly `v`
plus that version: the release workflow's first job runs `check-version.mjs` with the tag and
fails, before building anything, if it does not match.

**Release.**

1. Bump `version` in every `packages/*/package.json` to the new version (the root
   `package.json` has none), and commit.
2. Make sure CI is green on `main`, then tag that commit with `v` and the version:

```sh
git tag v0.1.0 && git push origin v0.1.0
```
