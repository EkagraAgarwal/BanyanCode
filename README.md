# BanyanCode

> CLI/TUI fork of [OpenCode](https://github.com/anomalyco/opencode) · `banyancode` is on by default · desktop/web/app/storybook out of scope

| What | Status |
|---|---|
| Orchestrator + parallel subagent mesh | ✅ default on |
| Cross-session memory (JSONB) | ✅ default on |
| Tree-sitter code graph | ✅ default on |
| Free web search (DuckDuckGo) | ✅ default on |
| Repository intelligence (9 methods) | ✅ default on |

Disable everything: `BANYANCODE_ENABLE=0`

---

## Install

Pick whichever channel works on your platform:

```bash
# macOS / Linux / WSL — one-liner (binary lands in ~/.banyancode/bin)
curl -fsSL https://raw.githubusercontent.com/EkagraAgarwal/BanyanCode/main/install | bash

# npm (any platform with Node)
npm i -g banyancode

# Homebrew (macOS / Linux)
brew tap ekagraagarwal/tap
brew install banyancode

# Arch Linux / Manjaro / EndeavourOS
paru -S banyancode-bin   # or: pacman -S banyancode-bin
```

Windows users running `npm i -g banyancode` from PowerShell get `banyancode.exe` automatically; the curl installer requires a Bash shell (Git Bash, WSL, MSYS).

BanyanCode and OpenCode install side by side and never read or write each other's files — `banyancode.json` vs `opencode.json`, `.banyancode/` vs `.opencode/`, etc. See [AGENTS.md](./AGENTS.md) for the full identity table.

To upgrade an existing install: `banyancode upgrade` from inside the CLI (npm/brew/scoop/curl available), or re-run the matching install command above.

---

## Quick start

| | Dev (hot reload) | Standalone binary (system-wide) |
|---|---|---|
| **Setup** | `bun install` | `cd packages/opencode && bun run script/build.ts -- --single` |
| **Run** | `bun dev` | `cd /any/project && banyancode` |
| **Needs** | Bun + source tree | Just the `.exe` (no `node_modules`) |
| **Update** | `git pull` | Rebuild + overwrite the same file |

**Install the binary system-wide:**

```bash
# build
cd packages/opencode
bun run script/build.ts -- --single

# macOS / Linux
install -d ~/.local/bin
install -m 0755 dist/banyancode-<platform>-<arch>/bin/banyancode ~/.local/bin/

# Windows
$bin = "$env:LOCALAPPDATA\banyancode\bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
Copy-Item dist\banyancode-windows-x64\bin\banyancode.exe "$bin\banyancode.exe"
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";$bin", "User")
```

---

## Features

```
┌─────────────────────────────────────────────────────────────────────┐
│                         orchestrator                               │
│              (decomposes · plans · fans out)                        │
└──────┬──────────────┬───────────────┬──────────────┬────────────────┘
       │              │               │              │
   ┌───▼────┐    ┌────▼────┐    ┌─────▼─────┐   ┌────▼────┐
   │researcher│   │  coder  │    │  explore  │   │  scout  │
   │ websearch│   │  write  │    │   grep    │   │  find   │
   │  free   │    │  edit   │    │   glob    │   │  files  │
   └────────┘    └─────────┘    └───────────┘   └─────────┘
                          │
                          ▼
                 ┌─────────────────┐
                 │  shared memory   │ ←─── cross-session JSONB store
                 │  code graph DB   │
                 └─────────────────┘
```

| Feature | What it does | Where |
|---|---|---|
| **Orchestrator** | Decomposes prompt → fans out to ≤ N subagents in parallel | `packages/opencode/src/agent/agent.ts` |
| **Subagent mesh** | Peer messaging + bounded slot reservation (default 5, max 20) | `packages/core/src/banyancode/mesh-coordinator.ts` |
| **Memory** | `memory_store` / `memory_recall` / `memory_search` · BM25 · optimistic-concurrency updates | `packages/core/src/banyancode/memory-*.ts` |
| **Code graph** | Tree-sitter (TS/JS/Python/Go/Rust) + regex fallback · L0/L1/L2/L3 layers | `packages/core/src/banyancode/codegraph-*` |
| **Researcher** | DuckDuckGo HTML scrape, no API key | `packages/core/src/banyancode/websearch-free.ts` |
| **Repo intel** | `query` / `slice` / `explain` / `impact` / `trace` / `tests` / `symbols` / `relationships` / `ownership` | `packages/core/src/banyancode/repository-intelligence.ts` |

---

## CLI

```bash
banyancode                              # TUI in cwd
banyancode "explain this"               # non-interactive run

# Code graph
banyancode codegraph build [--root PATH] [--force]
banyancode codegraph status | cancel | force-kill | path
banyancode codegraph trace --session <id>

# Repository intelligence
banyancode repository query <query>
banyancode repository {explain|trace|impact|tests|symbols|relationships|ownership} <arg>

# Free web search
banyancode websearch-free <query> [--num N]

# Misc
banyancode --version | --help
banyancode memory {list|store|recall|search|forget}
```

---

## HTTP API

```
POST /global/codegraph-build        POST /global/codegraph-cancel
POST /global/codegraph-force-kill   POST /global/codegraph-remove

POST /global/repository/query       POST /global/repository/explain
POST /global/repository/trace       POST /global/repository/impact
POST /global/repository/tests       POST /global/repository/symbols
POST /global/repository/relationships POST /global/repository/ownership

POST /global/websearch-free         POST /global/banyan-agent/save
GET  /global/banyan-config          POST /global/banyan-config
```

All mounted on `RootHttpApi` → work without an active session.

---

## TUI

```
┌─ Tabs ──────────────────────────────────────────────────────┐
│ Chat │ Sessions │ Agents │ Graph │ Memory │ Settings       │
└─────────────────────────────────────────────────────────────┘
```

| Tab | Highlights |
|---|---|
| **Chat** | Inline tool rows (single-line · `→ icon + name + args`), Obsidian-style tool rendering |
| **Sessions** | Inline-editable session titles (`Enter` save, `Esc` cancel) |
| **Agents** | Registry + `+ Add` wizard → writes `.banyancode/agent/<name>.md` |
| **Graph** | `d3-force` layout · L0/L1/L2/L3 layers · click node to focus |
| **Memory** | Cross-session entries · scope (`global` / `session`) · version-controlled updates |
| **Settings** | Accordion · Model · Orchestration (max subagents, YOLO, web search) · Endpoints · Telegram · Custom Subagents |

**Keybinds:** `Tab` / `Shift+Tab` cycle tabs · `<leader>:` command palette · `/` slash autocomplete

---

## Per-project state

```
<project>/.banyancode/
├── banyancode.db        ← libSQL/Turso: memory + codegraph + subagent data
├── ignore               ← one glob per line, codegraph skips
└── agent/               ← custom subagent definitions (.md with frontmatter)
    └── my-researcher.md ← hot-reloadable
```

Fallback (no project markers): `~/.local/share/banyancode/banyancode.db`

| BanyanCode | OpenCode |
|---|---|
| `./banyancode.json` | `./opencode.json` |
| `./.banyancode/` | `./.opencode/` |
| `~/.config/banyancode/` | `~/.config/opencode/` |
| `~/.local/share/banyancode/` | `~/.local/share/opencode/` |
| `banyancode.db` | `opencode.db` |
| `BANYANCODE_*` env vars | `OPENCODE_*` env vars |
| `BanyanConfig.Info` schema | `ConfigV1.Info` schema |

Both products install side-by-side. No shared paths. No config collisions.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        BanyanCode                            │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │ orchestrator│  │ repository_* │  │ codegraph_*        │    │
│  │  + 5 agents │  │  9 tools     │  │ memory_*  websearch│    │
│  └──────┬──────┘  └──────┬───────┘  └─────────┬──────────┘    │
│         │               │                    │               │
│  ┌──────▼───────────────▼────────────────────▼──────────┐    │
│  │              BanyanConfigService                     │    │
│  │         (BanyanConfig.Info — separate schema)        │    │
│  └──────────────────────┬───────────────────────────────┘    │
│                         │                                    │
│  ┌──────────────────────▼───────────────────────────────┐    │
│  │  CodegraphRepo · MemoryRepo · SubagentMessagesRepo    │    │
│  │  SubagentPlansRepo · RepositoryIntelligence · Search  │    │
│  │  StructuralQueries · CodegraphBuildService           │    │
│  └──────────────────────┬───────────────────────────────┘    │
│                         │                                    │
│  ┌──────────────────────▼───────────────────────────────┐    │
│  │       Database · Effect v4 services · EventV2         │    │
│  └──────────────────────┬───────────────────────────────┘    │
│                         │                                    │
│  ┌──────────────────────▼───────────────────────────────┐    │
│  │  libSQL/Turso  ·  banyancode.db  ·  FTS5 + JSONB      │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                        OpenCode (unchanged)                  │
│  Agent registry · Tool registry · Permission · Providers ·   │
│  Storage · Event bus · CLI · Server                          │
└──────────────────────────────────────────────────────────────┘
```

| Layer | BanyanCode addition | File |
|---|---|---|
| Agents | `orchestrator` + 5 subagents | `packages/opencode/src/agent/agent.ts` |
| Slash cmds | `/codegraph-build`, `/repository-*`, `/websearch-free`, `/yolo` | `packages/opencode/src/command/` |
| Tools | `memory_*`, `websearch_free`, `codegraph_*`, `repository_*`, `system_*` | `packages/core/src/tool/` |
| CLI | `banyancode codegraph ...`, `banyancode repository ...`, `banyancode websearch-free` | `packages/opencode/src/cli/cmd/` |
| Storage | `banyancode.db` (libSQL) + 5 tables | `packages/core/src/database/` |
| Config | `BanyanConfig.Info` (separate from `ConfigV1.Info`) | `packages/core/src/v1/config/banyan-config.ts` |
| TUI | 6 tabs + sidebar widgets + Obsidian-style graph | `packages/tui/src/` |

---

## Stack

| | |
|---|---|
| Runtime | Bun 1.3+ (Bun.compile for standalone `.exe`) |
| Language | TypeScript 5.8 |
| Effects | Effect v4 (`effect-smol` 4.0.0-beta) |
| Storage | libSQL (Turso fork of SQLite) · FTS5 · JSONB · STRICT tables |
| Parsing | tree-sitter (TS/JS/Python/Go/Rust) + regex fallback |
| TUI | Solid.js + OpenTUI primitives |
| Permissions | `PermissionV2.Service` bridge over OpenCode's `Permission.Service` |
| Native bindings | N-API addons embedded via Bun.build `loader` + bundler plugin |

---

## Repo layout

```
packages/
├── core/                 # Effect services, database, plugins, tool framework
│   └── src/banyancode/   # ← all BanyanCode services live here
├── opencode/             # CLI binary, command shell, HTTP API, agent registry
│   ├── bin/
│   │   ├── opencode      # npm shim
│   │   └── banyancode    # npm shim
│   └── script/
│       └── build.ts      # builds standalone binary (per-platform, embeds N-API)
├── tui/                  # Solid.js terminal UI
│   └── src/feature-plugins/
│       ├── sidebar/      # codegraph-panel, system-status, agent-tree, files
│       ├── tabs/         # chat, sessions, agents, graph, memory, settings
│       └── inspector/    # agent-details, graph-explorer, pending-actions
├── sdk/                  # Generated JS client SDK (auto-includes BanyanCode endpoints)
├── llm/                  # AI SDK provider adapters + HTTP recorder
├── plugin/               # Plugin authoring SDK
└── docs/                 # Mintlify docs site

specs/banyancode/         # per-feature design docs
ARCHITECTURE.md           # repo layout, runtime layers, service architecture
```

---

## Commands cheat-sheet

```bash
# Development
bun install                          # install workspace deps
bun dev                              # run TUI in dev mode
bun typecheck                        # tsgo --noEmit (per package)
bun test                             # (per package, never from root)

# Build & ship
cd packages/opencode
bun run script/build.ts -- --single                     # current platform
bun run script/build.ts -- --single --baseline           # pre-2013 CPUs
bun run script/build.ts                                 # all 12 platform/arch combos
```

Build output: `dist/<pkg>-<os>-<arch>/bin/<binary>` (~165 MB self-contained)

Build runs two smoke tests:
1. `--version` exits cleanly
2. Spawn TUI in fresh temp dir, assert `[turso.schema]` on stderr (proves libsql N-API loaded from embedded binary)

---

## Docs

| | |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Repo layout, runtime layers, BanyanCode service architecture, changelog |
| [`specs/banyancode/`](specs/banyancode/) | Per-feature design (storage, orchestrator, mesh, memory, code graph, web search) |
| [`specs/banyancode/overview.md`](specs/banyancode/overview.md) | Pitch + reuse map |
| [`packages/docs/src/content/docs/banyancode.mdx`](packages/docs/src/content/docs/banyancode.mdx) | User-facing feature overview |

---

## Env vars

| | Default | Effect |
|---|---|---|
| `BANYANCODE_ENABLE` | `1` (on) | Set `0` to run as upstream OpenCode |
| `BANYANCODE_DISABLE_WEBSEARCH` | `0` (off) | Skip registering `websearch_free` |
| `BANYANCODE_CONFIG_DIR` | `~/.config/banyancode/` | Override global config directory |
| `BANYANCODE_DISABLE_PROJECT_CONFIG` | `0` (off) | Skip project-local `.banyancode/` discovery |
| `BANYANCODE_YOLO_MODE` | `0` (off) | Auto-approve all permissions (dangerous) |

---

## License

MIT — same as upstream [OpenCode](https://github.com/anomalyco/opencode).

Issues & PRs: <https://github.com/EkagraAgarwal/BanyanCode>
