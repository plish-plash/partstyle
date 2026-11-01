# Installing and building partstyle

Two ways to get the `partstyle` command: a standalone executable (no Node, git or checkout
needed), or a build from source. Both include `partstyle mcp`, the MCP server; to connect it to
Claude Code or another MCP client, see [claude-code.md](claude-code.md). Commands are described
in the [CLI reference](cli.md).

KiCad is optional and always separate: `kicad export` and `kicad import` need kicad-cli (see
[Finding KiCad](cli.md#finding-kicad)).

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
pnpm install && pnpm build        # in the partstyle repository
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
embeds `docs/ckt-grammar.md` and the viewer's `dist/`, then runs `bun build --compile`.
`packages/cli/src/standalone.test.ts` smoke-tests the native executable when it exists (CLI
output, MCP over stdio, the embedded grammar and viewer); set `PARTSTYLE_BINARY` to test a
particular file, which also makes a missing file fail the test instead of skipping it.

## CI and releases

- `.github/workflows/ci.yml`, on pushes to `main` and pull requests: `pnpm check` on Linux and
  Windows, then builds and smoke-tests each runner's executable.
- `.github/workflows/release.yml`, on a `vX.Y.Z` tag: builds all five executables on Linux,
  macOS and Windows runners (the macOS ones ad-hoc signed), smoke-tests the ones each runner
  can execute, and publishes them with `SHA256SUMS` as a GitHub release with generated notes.
  A tag with a `-`, like `v0.2.0-rc1`, makes a prerelease. Running the workflow by hand builds
  the executables as artifacts without a release.

To release: make sure CI is green on `main`, then

```sh
git tag v0.1.0 && git push origin v0.1.0
```
