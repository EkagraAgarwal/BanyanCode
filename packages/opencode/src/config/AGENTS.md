# Config Loaders

## Path resolution

`packages/opencode/src/config/paths.ts` exposes discovery functions. New product identities (like BanyanCode) get a parallel set:
- `files(name, dir, worktree)` → `opencode.json` / `opencode.jsonc` paths
- `banyanFiles(dir, worktree)` → `banyancode.json` / `banyancode.jsonc` paths
- `directories(dir, worktree)` → `.opencode/` dirs
- `banyanDirectories(dir, worktree)` → `.banyancode/` dirs

## Per-directory loaders

`config.ts` iterates the discovered dirs and calls the loaders for each. To add a new loader (e.g. for a new sub-dir):

1. The loader takes a single `dir: string` argument
2. Returns the loaded data (e.g. agents, commands, plugins, skills)
3. The caller in `config.ts` merges results across all dirs (`.opencode/` and `.banyancode/`)

Existing loaders to mirror: `ConfigAgent.load`, `ConfigCommand.load`, `ConfigPlugin.load`, `Skill.discover`.

## Sub-dir glob patterns

Each loader uses `Glob.scan("{name,names}/...", { cwd: dir })` to find files. The plural+singular pattern handles both `.opencode/agent/` and `.opencode/agents/`. When called with a `.banyancode/` cwd, the SAME pattern works without code changes — the glob is relative to the dir.

## Config keys per product identity

OpenCode config: `ConfigV1.Info` (`packages/core/src/v1/config/config.ts`).
BanyanCode config: `BanyanConfig.Info` (`packages/core/src/v1/config/banyan-config.ts`).

Consumers MUST use the right service for the right key. Mixing them causes either typecheck failures (if the key doesn't exist) or silent config drift (if a consumer writes to the wrong schema).

## tui.json location

TUI-specific config is loaded from:
- `./.opencode/tui.json` (per-project)
- `./.banyancode/tui.json` (per-project, BanyanCode)
- `~/.config/opencode/tui.json` (global)
- `~/.config/banyancode/tui.json` (global, BanyanCode)
- `OPENCODE_TUI_CONFIG` env var
- `BANYANCODE_TUI_CONFIG` env var

Loaded in `tui.ts` via `directories()` and `banyanDirectories()` merged via `unique()`.

## Merging with the global dir

`ConfigPaths.directories()` and `banyanDirectories()` both include the global config dir (`~/.config/opencode` / `~/.config/banyancode`). When iterating, deduplicate via `unique()` so the global dir isn't processed twice when a `.opencode/` or `.banyancode/` is found at the project root.

## Managed config (MDM / system admin)

`packages/opencode/src/config/managed.ts` handles macOS/Windows/Linux MDM paths. Add parallel `banyancodeManagedPaths()` for BanyanCode managed config if/when needed (e.g. `/Library/Application Support/BanyanCode/` on macOS, `/etc/banyancode/` on Linux).
