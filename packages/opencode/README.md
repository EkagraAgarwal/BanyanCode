> **BanyanCode fork note.** This is a fork of [OpenCode](https://github.com/anomalyco/opencode). BanyanCode adds an orchestrator + subagent mesh, cross-session memory, a code graph + embeddings utility, and a researcher agent with free web search. See [`ARCHITECTURE.md`](../../ARCHITECTURE.md) for the architecture. TUI/CLI only - the desktop, web, and Storybook packages are not in scope for BanyanCode.

# `opencode` — BanyanCode CLI

This package is the BanyanCode CLI and TUI. BanyanCode services are on by default; set `BANYANCODE_ENABLE=0` to run as upstream OpenCode.

## Development

```bash
# from the repo root
bun install
bun dev                  # TUI in dev mode (hot reload, all source in-process)
```

## Build a standalone binary

```bash
cd packages/opencode
bun run script/build.ts -- --single      # build for the current platform
# output: dist/<platform>-<arch>/bin/banyancode[.exe]
```

The build produces a single self-contained executable. JS, the libsql N-API addon, and the OpenTUI parser worker are all embedded — no `node_modules`, Bun runtime, or env vars needed at install time. The build runs two smoke tests: `--version` and a TUI spawn in a clean temp dir that asserts the libsql addon loads.

To ship system-wide, copy the binary to a directory on `PATH`:

```powershell
# Windows
$bin = "$env:LOCALAPPDATA\banyancode\bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
Copy-Item dist\opencode-windows-x64\bin\banyancode.exe "$bin\banyancode.exe"
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";$bin", "User")
```

```bash
# macOS / Linux
install -d ~/.local/bin
install -m 0755 dist/opencode-darwin-arm64/bin/banyancode ~/.local/bin/
```

The package also ships an `opencode` shim that finds the right platform binary under `node_modules/<platform-pkg>/bin/`, for users who install via `npm install -g opencode-ai`.

## Type checking and tests

```bash
bun run typecheck        # tsgo --noEmit
bun test                 # from a package directory, never from the repo root
```

## Project structure

```
src/
├── agent/           # agent registry; BanyanCode adds orchestrator, researcher, etc.
├── cli/             # yargs command tree; BanyanCode adds codegraph, repository, websearch-free
├── command/         # slash command templates
├── server/          # HTTP API; BanyanCode mounts /global/repository/*, /global/codegraph-*
├── effect/          # Effect v4 service layer
└── install/         # upgrade + uninstall commands
```

BanyanCode-specific code lives under `src/cli/cmd/codegraph.ts`, `src/cli/cmd/repository.ts`, `src/cli/cmd/websearch-free.ts`, and the orchestrator agent at `src/agent/agent.ts`. All BanyanCode additions are wired through `runtime-flags.ts` and gate on `BANYANCODE_ENABLE`.
