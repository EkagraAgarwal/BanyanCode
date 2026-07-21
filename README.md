# BanyanCode

```text
╭───────────────────────────────────────────────────────────────────╮
   │             .&&%%&%.                       .&&%%&%.               │
   │         .%&%&%&%&%&%&%&%.     .&&%%&%.  .%&%&%&%&%&%&%&%.         │
   │       .%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%.       │
   │       %&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%&%       │
   │       `"||"'"||"'"||"'"'||||||||||||"'"'||"'||"'||"'`       │
   │         ||   ||   |:     ||||||||||||     :|   ||   ||            │
   │         |:   |    .      ||||||||||||      .   |    :|            │
   │         .    .          _//||||||||\\_         .    .             │
   │                        /              \                           │
   │                                                                   │
   │     ████   ███  █   █ █   █  ███  █   █  ████  ███  ████  █████   │
   │     █   █ █   █ ██  █  █ █  █   █ ██  █ █     █   █ █   █ █       │
   │     ████  █████ █ █ █   █   █████ █ █ █ █     █   █ █   █ ████    │
   │     █   █ █   █ █  ██   █   █   █ █  ██ █     █   █ █   █ █       │
   │     ████  █   █ █   █   █   █   █ █   █  ████  ███  ████  █████   │
   │                                                                   │
   │                        \              /                           │
   │         .    .          \\_||||||||_//         .    .             │
   │         |:   |    .      ||||||||||||      .   |    :|            │
   │         ||   ||   |:     ||||||||||||     :|   ||   ||            │
   │        _||_ _||_ _||_   _||||||||||||_   _||_ _||_ _||_           │
   ╰───────────────────────────────────────────────────────────────────╯
```

**The agent harness for loop engineering.** BanyanCode turns one prompt into a coordinated coding system: parallel agents, persistent memory, codebase intelligence, and verification-ready workflows in a fast terminal UI.

<p align="center">
  <a href="https://www.npmjs.com/package/banyancode"><img src="https://img.shields.io/npm/v/banyancode?style=flat-square&color=cb3837" alt="npm version" /></a>
  <a href="https://github.com/EkagraAgarwal/BanyanCode/releases/latest"><img src="https://img.shields.io/github/v/release/EkagraAgarwal/BanyanCode?style=flat-square&color=blue" alt="GitHub release" /></a>
  <a href="https://github.com/EkagraAgarwal/BanyanCode/blob/main/LICENSE"><img src="https://img.shields.io/github/license/EkagraAgarwal/BanyanCode?style=flat-square" alt="License" /></a>
</p>

## Install

Bun is the fastest way to get started:

```bash
bun add -g banyancode
banyancode
```

Or use the platform installer:

```bash
curl -fsSL https://raw.githubusercontent.com/EkagraAgarwal/BanyanCode/main/install | bash
```

```powershell
irm https://raw.githubusercontent.com/EkagraAgarwal/BanyanCode/main/install.ps1 | iex
```

You can also install with npm:

```bash
npm install --global banyancode
```

Run BanyanCode from any project directory. It opens in the current workspace and builds an incremental code graph as you work.

## Highlights

- **Loop engineering** — build repeatable agent loops with goals, actions, verification, retries, and memory instead of manually driving every turn.
- **Agentic coding** — plan, edit, search, test, and iterate through a terminal-native coding workflow.
- **Parallel subagent mesh** — dispatch `scout`, `coder`, and `researcher` agents concurrently from one prompt, with runtime caps and permission boundaries.
- **Persistent context engineering** — keep useful knowledge across sessions with versioned local memory, BM25 retrieval, and structured references.
- **Codebase intelligence** — tree-sitter creates a live code graph for symbols, callers, dependents, tests, impact, and ownership.
- **Verification hooks** — use repository context, blast-radius analysis, preflight checks, tests, and review loops to keep agent work grounded.
- **Free research loop** — a DuckDuckGo-backed researcher agent searches the web without an API key.
- **Terminal-native UX** — a fast TUI, command palette, LSP support, model switching, traces, and full control from your keyboard.

## The workflow

```text
Prompt
  └─► Orchestrator
       ├─► Scout       explores the repository
       ├─► Coder       implements the change
       ├─► Researcher  checks external knowledge
       ├─► Memory      carries context across sessions
       └─► Code graph  verifies structure and impact
                    └─► merged, reviewable result
```

BanyanCode is designed for the full agentic loop:

```text
trigger → context → plan → execute → verify → remember → repeat
```

## Commands

Type `/` in the TUI to browse every command. The core workflow includes:

| Command | Purpose |
|---|---|
| `/init` | Set up `AGENTS.md` for the workspace. |
| `/review` | Review uncommitted changes, commits, branches, or pull requests. |
| `/codegraph-build` | Build or refresh the tree-sitter code graph. |
| `/repository-query` | Search symbols, tests, docs, configs, and relationships together. |
| `/repository-explain` | Understand a symbol through an architectural slice. |
| `/repository-trace` | Trace downstream dependents through the graph. |
| `/repository-impact` | See the blast radius of a change. |
| `/repository-tests` | Find tests connected to a symbol. |
| `/websearch-free` | Search the web with the researcher agent. |
| `/max-subagents` | Set the concurrency ceiling for the mesh. |
| `/lsp` | Toggle built-in language servers. |
| `/yolo` | Enable automatic permission approval for sandboxed workflows. |

## Why BanyanCode

Most coding agents give you a conversation. BanyanCode gives you a system.

- One prompt can launch a coordinated team.
- Every agent gets the context and tools it needs.
- The repository becomes searchable structure, not a pile of files.
- Memory compounds across sessions instead of disappearing with the chat.
- Verification is part of the loop, not an afterthought.

Use it for refactors, migrations, debugging, codebase onboarding, research-heavy implementation, and autonomous software engineering workflows.

## Configuration

BanyanCode is its own product and uses `banyancode.json`, never `opencode.json`.

```json
{
  "banyancode_lsp": true,
  "banyancode_max_subagents": 10,
  "agent": {
    "coder": { "model": "minimax-coding-plan/MiniMax-M3" },
    "scout": { "model": "minimax-coding-plan/MiniMax-M3" },
    "researcher": { "model": "minimax-coding-plan/MiniMax-M3" }
  }
}
```

Useful settings include:

| Key | Default | Purpose |
|---|---:|---|
| `banyancode_lsp` | `false` | Enable built-in language servers. |
| `banyancode_max_subagents` | `5` | Cap concurrent subagents from 1 to 20. |
| `banyancode_yolo_mode` | `false` | Automatically approve permissions. |
| `banyancode_disable_websearch` | `false` | Disable the free researcher agent. |
| `banyancode_codegraph_watch_enabled` | `true` | Update the code graph as files change. |

## Data and privacy

Project data stays local by default:

```text
.banyancode/
├── banyancode.db
├── ignore
└── trace/
```

BanyanCode does not read or write OpenCode configuration or data. Global BanyanCode data lives under `~/.config/banyancode/` and `~/.local/share/banyancode/`.

## Development

BanyanCode uses Bun and a monorepo workspace.

```bash
bun install
bun run lint
bun typecheck
```

Run package tests from the package directory, not the repository root:

```bash
cd packages/core
bun test
```

## Built on

- [OpenCode](https://github.com/anomalyco/opencode) — the TUI / CLI runtime BanyanCode forks from
- [Effect](https://effect.website) — type-safe service architecture
- [tree-sitter](https://tree-sitter.github.io) — incremental parsing
- [DuckDuckGo HTML](https://duckduckgo.com/html/) — free web search
- [libSQL](https://turso.tech) — embedded SQL storage

## License

[MIT](./LICENSE)
