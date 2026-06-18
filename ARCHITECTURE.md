# BanyanCode Architecture

This document describes how BanyanCode is structured on disk, how the runtime layers compose, and where to find things. It replaces the older `BANYANCODE_PLAN.md` (now deleted) which tracked phased implementation history.

## Overview

BanyanCode is a CLI/TUI-only fork of [OpenCode](https://github.com/anomalyco/opencode) that adds four capabilities:

1. **Orchestrator + subagent mesh** — a primary `orchestrator` agent decomposes complex tasks and fans out to specialized subagents in parallel.
2. **Cross-session memory** — a persistent key-value store with optional embeddings.
3. **2-phase codebase utility** — a tree-sitter code graph (`/codegraph-build`) plus an embeddings layer (`/code-embed`) for semantic search.
4. **Researcher agent with free web search** — a `researcher` subagent backed by DuckDuckGo (no API key required).

Desktop, web, app, and Storybook packages are explicitly out of scope. BanyanCode is a sequence of additions to OpenCode, not a rewrite.

## Repo layout

The repo is a Bun workspace with these packages (under `packages/`):

| Package | Purpose | BanyanCode role |
|---------|---------|-----------------|
| `core` | Effect services, database, plugins, tool framework, BanyanCode service layer | Hosts the BanyanCode service namespace |
| `opencode` | CLI binary, command shell, HTTP API, project bootstrap, agent registry | Hosts BanyanCode slash commands and agents |
| `tui` | Solid.js terminal UI | Hosts BanyanCode widgets (progress, dialog, sidebar) |
| `sdk` | Generated JS client SDK (`@opencode-ai/sdk`) | Auto-includes BanyanCode HTTP endpoints |
| `llm` | AI SDK provider adapters and HTTP recorder | Unchanged for BanyanCode |
| `effect-drizzle-sqlite`, `effect-sqlite-node` | Generic SQLite bindings | Unchanged |
| `plugin` | Plugin authoring SDK | Unchanged |
| `server`, `console`, `storybook`, `app`, `web`, `desktop` | Upstream surfaces | Out of scope for BanyanCode |
| `stats` | Public download stats | Unchanged |

Build system: Turborepo on top of Bun (`bun turbo`). Tests run from a package directory with `bun test <file>`, never from the repo root.

## BanyanCode identity separation

BanyanCode is its **own product** that runs alongside OpenCode. The two products do not share file paths, env vars, or config schemas.

| Concern | OpenCode | BanyanCode |
|---------|----------|------------|
| Per-project config file | `./opencode.json` | `./banyancode.json` |
| Per-project dir | `./.opencode/` | `./.banyancode/` |
| Global config | `~/.config/opencode/` | `~/.config/banyancode/` |
| Global data | `~/.local/share/opencode/` | `~/.local/share/banyancode/` |
| DB filename | `opencode.db` | `banyancode.db` |
| Env var prefix | `OPENCODE_*` | `BANYANCODE_*` |
| Config schema | `ConfigV1.Info` | `BanyanConfig.Info` |

Both products can be installed side by side. BanyanCode reads/writes only `banyancode.*` and `.banyancode/`; OpenCode reads/writes only its own paths. Disabling BanyanCode (`BANYANCODE_ENABLE` unset) leaves OpenCode untouched.

The repo's source code uses the `@opencode-ai/*` package namespace internally (e.g. `@opencode-ai/core/banyancode`); only user-facing surfaces (binary, install script, brand text, repo URL) carry the BanyanCode name.

## Project-local `.banyancode/` layout

When BanyanCode is enabled and the user runs from a project directory, BanyanCode creates `<project>/.banyancode/` if it does not exist:

```
<project>/.banyancode/
├── banyancode.db        # SQLite: memory, codegraph, subagent data
└── ignore               # codegraph ignore patterns, one per line
```

Resolution rules (`packages/core/src/database/database.ts:67`):
- If an existing `.banyancode/` is found anywhere up the directory tree, use it.
- Otherwise, find the project root via markers (`.git`, `package.json`, `Cargo.toml`, etc.) and create `.banyancode/` there.
- Fallback: global `~/.local/share/banyancode/banyancode.db` when no project markers exist.

DB filename suffixes by installation channel:
- `latest` / `beta` / `prod` → plain `banyancode.db`
- Anything else → `banyancode-<channel>.db` (set `OPENCODE_DISABLE_CHANNEL_DB=1` to override)

## BanyanCode service layer (`packages/core/src/banyancode/`)

Every BanyanCode service follows the same pattern: a `Context.Service` class, a `layer` builder, and a `defaultLayer` that wires the service's dependencies. All services are gated by `BANYANCODE_ENABLE` (default off) so disabling BanyanCode is a no-op.

| Service | Purpose | Key deps |
|---------|---------|----------|
| `BanyanConfigService` | Read/write `banyancode.json` from `~/.config/banyancode/` | `FSUtil` |
| `CodegraphRepo` | Drizzle CRUD over `codegraph_*` tables | `Database` |
| `MemoryRepo` | Drizzle CRUD over `memory_entries` | `Database` |
| `SubagentMessagesRepo`, `SubagentPlansRepo` | Mesh persistence | `Database` |
| `CodegraphIndexer` | Walk a directory, parse files, extract nodes/edges via tree-sitter | `CodegraphRepo`, `FSUtil` |
| `CodegraphBuildService` | Persistent build state, fork/cancel, publish `banyancode.codegraph.build` events | `CodegraphIndexer`, `EventV2` |
| `CodegraphEmbedder` | Walk nodes, call embedding provider, write `codegraph_embeddings` | `CodegraphRepo`, `EmbeddingProvider` |
| `CodegraphEmbedService` | Persistent embed state, fork/cancel, publish `banyancode.codeembed.build` events (mirrors the build service) | `CodegraphEmbedder`, `EventV2` |
| `CodegraphAnalyzer` | BFS impact/dependents/callers over the graph edges | `CodegraphRepo` |
| `EmbeddingProviderService` | Holds the active model, fires `plugin.trigger("aisdk.embed", ...)` | `BanyanConfigService`, `PluginV2` |
| `SubagentBus`, `MeshCoordinator` | Fire-and-persist peer messaging + fan-out coordination | `SubagentMessagesRepo`, `SubagentPlans` |
| `SystemMonitorService` | CPU/memory/platform health reads | `AppProcess` |

Service exports live in `packages/core/src/banyancode/index.ts` in two flavors:
- Named (`CodegraphBuildService`, `codegraphBuildServiceDefaultLayer`) for direct imports inside `core`.
- Namespace (`Banyan.CodegraphBuildService`) for consumer packages (`opencode`, `tui`).

## Embedding pipeline

```
/code-embed (slash command)
  → CodegraphEmbedService.start({ file? })
    → CodegraphEmbedder.embedAll() / embedFile(fileID)
      → CodegraphRepo.listAllNodes()  (or listNodesByFile)
        → for each node:
          → CodegraphRepo.getEmbedding(node.id)  (skip if present)
          → EmbeddingProvider.embed(text)
            → plugin.trigger("aisdk.embed", { model, input })
              → every registered plugin's "aisdk.embed" handler fires
                (NvidiaEmbedTestPlugin for nvidia/* models, etc.)
                → sets evt.embeddings
            → return Float32Array[]
          → CodegraphRepo.putEmbedding(node.id, bytes, model, dim)
          → publish EmbedEvent { status: "running", done, total }
      → publish EmbedEvent { status: "completed", result }
```

Two ways to swap providers:
1. **`aisdk.embed` handler in a plugin** (the production path). Every provider in `packages/core/src/plugin/provider/` can add a handler that returns embeddings for its models.
2. **Direct fetch from `EmbeddingProvider.embed`** (currently used by `NvidiaEmbedTestPlugin` as a test-only escape hatch because NIM rejects `extra_body` at the body root).

`BanyanConfig.banyancode_embedding_model` (or `BANYANCODE_EMBEDDING_MODEL` env) selects the model in `providerID/modelID` form. `BanyanConfigService.update` writes the config; `applyEmbeddingModel` (HTTP handler `/global/embedding-model`) reads it and calls `EmbeddingProvider.setModel`.

## Code graph pipeline

```
/codegraph-build (slash command)
  → CodegraphBuildService.start({ root, force, dbPath })
    → CodegraphIndexer.index({ root, force, onProgress })
      → load ignore patterns (DEFAULT_IGNORED + .gitignore + .banyancode/ignore)
      → walk directory, filter by parser-recognized extensions
      → parse each file via tree-sitter (TS/JS/Python) or regex fallback
      → upsert CodegraphRepo with file hash, nodes, edges
      → onProgress per file → publish BuildEvent
```

Supported languages and their parsers live in `packages/core/src/banyancode/langs/`:
- `typescript.ts` — TS/TSX/JS/JSX
- `python.ts` — Python
- `regex-fallback.ts` — generic regex-based parser for other languages (imports only)
- `registry.ts` — extension → parser dispatch

The resolved DB path is computed by `Database.path()` and passed into `BuildService.start({ dbPath })`. The build service publishes the path in every `banyancode.codegraph.build` event so the TUI's progress widget can show "Index → /abs/path/to/banyancode.db".

## Orchestrator + mesh

- `orchestrator` agent is registered by `packages/opencode/src/agent/agent.ts` when `BANYANCODE_ENABLE=1`.
- It decomposes a prompt into a plan, then `MeshCoordinator` issues bounded parallel `Effect.forkIn(scope)` calls to subagents.
- Hard limits: `MAX_PARALLEL_SUBAGENTS=3` default, `MAX_PARALLEL_SUBAGENTS_HARD=5` enforced by the orchestrator prompt and `MeshCoordinator`.
- Subagents talk back via `SubagentBus` (a fire-and-persist log in SQLite). Cross-agent outputs flow through shared memory.
- Phase 12/13 (subagent subscribe tool, separate message-bodies table) are explicitly deferred.

## Provider plugin system

`packages/core/src/plugin/provider/` holds 32+ provider plugins. Each plugin:
- Handles `aisdk.sdk` (chat): provides the AI SDK instance for its package.
- May handle `aisdk.embed` (embeddings): returns vectors for its models via `evt.embeddings`.
- May handle `catalog.transform`: mutates catalog entries (e.g. `NvidiaPlugin` adds billing headers).

`NvidiaEmbedTestPlugin` (`packages/core/src/plugin/provider/nvidia-embed.ts`) is the only BanyanCode-specific plugin. It is gated by `BANYANCODE_NVIDIA_TEST=1` and exists for end-to-end testing with NVIDIA NIM without committing an API key or non-OpenAI-compatible SDK surface.

## TUI integration

The TUI (`packages/tui/`) subscribes to BanyanCode events via `event.subscribe` at `packages/tui/src/app.tsx:1117-1125`:

```ts
event.subscribe((evt, { workspace }) => {
  if (workspace !== project.workspace.current()) return
  if (evt.type === "banyancode.codegraph.build") build.set(evt.properties)
  else if (evt.type === "banyancode.codeembed.build") build.setEmbed(evt.properties)
})
```

Components:
- `component/codegraph-progress.tsx` — corner widget showing build and embed state, current file, error message on failure, resolved DB path during a build.
- `component/dialog-embedding-model.tsx` — model picker, writes `banyancode_embedding_model` via `sdk.client.global.banyanConfig.update`.
- `feature-plugins/sidebar/` — sidebar widgets (codegraph progress lives here).

## HTTP API

Endpoints added by BanyanCode (`packages/opencode/src/server/routes/instance/httpapi/`):
- `GET /global/banyan-config` — read `BanyanConfig.Info`
- `POST /global/banyan-config` — partial update
- `POST /global/embedding-model/apply` — read config + call `EmbeddingProvider.setModel`
- `POST /global/codegraph-cancel` — interrupt a running build (no slash command for cancel yet)
- The TUI listens on `event` SSE for `banyancode.codegraph.build` and `banyancode.codeembed.build`.

## Slash commands

Server-side commands in `packages/opencode/src/command/index.ts`:
- `/codegraph-build [root] [--force]` — runs in background; `CodegraphBuildService.start` forks.
- `/codegraph-remove` — clears all rows from `codegraph_*` tables (deletes the index).
- `/code-embed [--file <path>]` — runs in background; `CodegraphEmbedService.start` forks.
- `/yolo` — toggles `banyancode_yolo_mode` (skips permission prompts).
- `/init`, `/review`, `/refresh-models` — inherited from OpenCode.

Dialog commands (TUI command palette, not slash commands):
- `/embedding-model` — opens `DialogEmbeddingModel`.
- `/agent-model` — opens the agent model picker.

## Tests

Test fixture conventions in `packages/opencode/test/AGENTS.md`:
- `tmpdir()` from `fixture/tmpdir.ts` for real disk paths.
- `testEffect(...)` from `lib/effect.ts` for Effect-based tests.
- `it.effect(...)`, `it.live(...)`, `it.instance(...)` for clock control.
- BanyanCode repos (`CodegraphRepo`, `MemoryRepo`, `SubagentMessagesRepo`, `SubagentPlansRepo`) need `Database.layerFromPath(tmpDbPath)` provided explicitly or they fall back to the global home dir DB and fail.

BanyanCode-specific test files:
- `packages/core/test/banyancode/` — service-level tests for every BanyanCode service.
- `packages/core/test/plugin/provider-nvidia-embed.test.ts` — NIM plugin gating tests.
- `packages/opencode/test/banyancode/` — command shell, agent registry, command-execute tests.

## Runtime flags

`packages/core/src/effect/runtime-flags.ts` (and the opencode-package twin) captures env-var configuration into a `RuntimeFlags` service:
- `BANYANCODE_ENABLE=1` — feature gate; default off
- `BANYANCODE_EMBEDDING_MODEL` — initial value for `banyancode_embedding_model` (config wins if both set)
- `BANYANCODE_DISABLE_WEBSEARCH=1` — disable `websearch_free`
- `BANYANCODE_NVIDIA_TEST=1` — enable `NvidiaEmbedTestPlugin`
- `BANYANCODE_CONFIG_DIR` — override global config directory
- `BANYANCODE_DISABLE_PROJECT_CONFIG=1` — skip project-local `.banyancode/` discovery

## Per-feature deep dives

Detailed design docs live in `specs/banyancode/`:
- `overview.md` — high-level pitch and reuse map
- `orchestrator.md` — orchestrator prompt + agent layout
- `subagent-mesh.md` — wire format, capacity, failure modes, deferred Phase 12/13
- `memory.md` — memory tables, embedding flow, vacuum
- `codegraph.md` — code graph pipeline + embedding flow
- `storage.md` — Drizzle schemas and migrations
- `types.md` — shared types
- `websearch-free.md` — DuckDuckGo HTML scraping

User-facing docs (rendered to the docs site) live in `packages/docs/src/content/docs/banyancode*.mdx`.

## Coding conventions for BanyanCode work

In addition to the root `AGENTS.md` style guide:
- BanyanCode-specific keys (`banyancode_embedding_model`, `banyancode_yolo_mode`, future telegram/runtime keys) live in `BanyanConfig.Info`. Never in `ConfigV1.Info`.
- Consumers read via `Banyan.BanyanConfigService` or `Effect.serviceOption(Banyan.BanyanConfigService)`.
- Do NOT add BanyanCode service deps to `BanyanTools.locationLayer` (`packages/core/src/banyancode/tools-layer.ts`). Provide them at the consumer level instead — see `packages/opencode/src/effect/app-runtime.ts` for the canonical wiring.
- New BanyanCode services should follow the `Service / layer / defaultLayer` triple with a gated no-op path when `BANYANCODE_ENABLE=0`.
- Service reference pattern: `packages/core/src/banyancode/index.ts` exports each service both as a named constant and via `export * as Banyan from "."` for consumer namespace imports.