# BanyanCode Architecture

This document describes how BanyanCode is structured on disk, how the runtime layers compose, and where to find things. It replaces the older `BANYANCODE_PLAN.md` (now deleted) which tracked phased implementation history.

## Overview

BanyanCode is a CLI/TUI-only fork of [OpenCode](https://github.com/anomalyco/opencode) that adds four capabilities:

1. **Orchestrator + subagent mesh** — a primary `orchestrator` agent decomposes complex tasks and fans out to specialized subagents in parallel, with a user-configurable hard limit.
2. **Cross-session memory** — a persistent key-value store with JSONB indexable payloads.
3. **Codebase utility** — a tree-sitter code graph (`/codegraph-build`) backed by Turso/libSQL.
4. **Researcher agent with free web search** — a `researcher` subagent backed by DuckDuckGo (no API key required).
5. **Repository intelligence (Wave 1 + Wave 2)** — a graph-first retrieval stack on top of the codegraph. Wave 1 shipped the 7-method `RepositoryIntelligence` (`findSymbol`, `findSubsystem`, ...), hybrid `Search`, and `StructuralQueries`. Wave 2 reshaped it into a stable 9-method public surface (`query`, `slice`, `explain`, `impact`, `trace`, `tests`, `symbols`, `relationships`, `ownership`) returning a typed `ArchitecturalSlice` (`{ summary, entrypoints, importantSymbols, relatedTests, relatedDocs, configs, routes, dependencies }`). All features have been successfully verified.

Desktop, web, app, and Storybook packages are explicitly out of scope. BanyanCode is a sequence of additions to OpenCode, not a rewrite.

## Repo layout

The repo is a Bun workspace with these packages (under `packages/`):

| Package | Purpose | BanyanCode role |
|---------|---------|-----------------|
| `core` | Effect services, database, plugins, tool framework, BanyanCode service layer | Hosts the BanyanCode service namespace |
| `opencode` | CLI binary, command shell, HTTP API, project bootstrap, agent registry | Hosts BanyanCode slash commands, agents, and HTTP endpoints |
| `tui` | Solid.js terminal UI with OpenTUI primitives | Hosts BanyanCode widgets, tabs, dialogs |
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
| Data dir | `~/.local/share/opencode/` | `~/.local/share/banyancode/` |
| DB filename | `opencode.db` | `banyancode.db` |
| Env var prefix | `OPENCODE_*` | `BANYANCODE_*` |
| Config schema | `ConfigV1.Info` | `BanyanConfig.Info` |

Both products can be installed side by side. BanyanCode reads/writes only `banyancode.*` and `.banyancode/`; OpenCode reads/writes only its own paths. BanyanCode is on by default; set `BANYANCODE_ENABLE=0` to disable it, at which point the binary behaves like upstream OpenCode.

The repo's source code uses the `@opencode-ai/*` package namespace internally (e.g. `@opencode-ai/core/banyancode`); only user-facing surfaces (binary, install script, brand text, repo URL) carry the BanyanCode name.

## Project-local `.banyancode/` layout

When BanyanCode is enabled and the user runs from a project directory, BanyanCode creates `<project>/.banyancode/` if it does not exist:

```
<project>/.banyancode/
├── banyancode.db        # libSQL/Turso: memory, codegraph, subagent data
├── ignore               # codegraph ignore patterns, one per line
└── agent/               # custom subagent definitions (.md with frontmatter)
```

Resolution rules (`packages/core/src/database/database.ts:67`):
- If an existing `.banyancode/` is found anywhere up the directory tree, use it.
- Otherwise, find the project root via markers (`.git`, `package.json`, `Cargo.toml`, etc.) and create `.banyancode/` there.
- Fallback: global `~/.local/share/banyancode/banyancode.db` when no project markers exist.

DB filename suffixes by installation channel:
- `latest` / `beta` / `prod` → plain `banyancode.db`
- Anything else → `banyancode-<channel>.db` (set `OPENCODE_DISABLE_CHANNEL_DB=1` to override)

## Storage: Turso/libSQL (V2)

As of V2 (branch `banyancode-v2-turso`), BanyanCode uses **Turso/libSQL** via `@libsql/client` instead of `bun:sqlite` / `node:sqlite`. The driver adapter lives at `packages/core/src/database/sqlite.libsql.ts`.

What this gives us:
- **FTS5 full-text search**: virtual tables with BM25 ranking for symbol-name search in codegraph.
- **JSONB type**: indexable JSON paths for memory entries.
- **STRICT tables** + user-defined types.
- **MVCC concurrent writes** (Turso 0.5+, beta — not enabled by default yet).

The TUI sidebar shows L0/L1/L2/L3 layer counts driven by the `banyancode.codegraph.build` event payload.

Debug logs (stderr):
```
[turso.driver] opening file:.banyancode/banyancode.db
[turso.schema] memory_entries with jsonb columns configured
```

## BanyanCode service layer (`packages/core/src/banyancode/`)

Every BanyanCode service follows the same pattern: a `Context.Service` class, a `layer` builder, and a `defaultLayer` that wires the service's dependencies. The feature gate defaults to **on** (`boolTrue` in `runtime-flags.ts`); set `BANYANCODE_ENABLE=0` to disable, in which case every service is a no-op.

| Service | Purpose | Key deps |
|---------|---------|----------|
| `BanyanConfigService` | Read/write `banyancode.json` from `~/.config/banyancode/` | `FSUtil` |
| `CodegraphRepo` | Drizzle CRUD over `codegraph_*` tables; pagination via `searchNodes({ name?, kind?, limit })`; cheap cardinality via `countNodes/Edges/Files` | `Database` |
| `MemoryRepo` | Drizzle CRUD over `memory_entries` (JSONB value/tags), optimistic-concurrency `update` | `Database` |
| `SubagentMessagesRepo`, `SubagentPlansRepo` | Mesh persistence (with `markDelivered` for consume tracking) | `Database` |
| `CodegraphIndexer` | Walk a directory, parse files, extract nodes/edges via tree-sitter (TS/JS/Python in PR 5/6, fallback regex for everything else). Wave 2 classifier adds `ci/docker/env/doc` file kinds + Markdown + Dockerfile parsers | `CodegraphRepo`, `FSUtil` |
| `CodegraphBuildService` | Persistent build state, fork/cancel, publish `banyancode.codegraph.build` events | `CodegraphIndexer`, `EventV2` |
| `CodegraphAnalyzer` | BFS impact/dependents/callers over the graph edges; computes L0/L1/L2/L3 layers | `CodegraphRepo` |
| `MaxSubagentsService` | Reads `banyancode_max_subagents` config (default 5, max 20), validates, provides to orchestrator prompt + hard runtime limit | `BanyanConfigService` |
| `SubagentBus`, `MeshCoordinator`, `SubagentConsumer` | Fire-and-persist peer messaging + fan-out coordination; consumer forks a per-session message loop that calls `markDelivered` after each message. Hard cap via `tryReserveSubagentSlot` | `SubagentMessagesRepo`, `SubagentPlans`, `MaxSubagentsService` |
| `SystemMonitorService` | CPU/memory/platform/GPU health reads; publishes `banyancode.system.updated` every 1s. Bounded queue (size 60), no per-`watch()` fiber leak | `AppProcess` |
| `RepositoryIntelligence` (Wave 2) | 9-method public surface: `query`, `slice`, `explain`, `impact`, `trace`, `tests`, `symbols`, `relationships`, `ownership`. All slice-returning methods emit the stable `ArchitecturalSlice` shape. Workspace context propagated via optional `workspace?: WorkspaceContext`. Internal helpers (`findSymbol`, `findSubsystem`, `findEntrypoints`, `findTests`, `findRelated`) stay in the layer | `CodegraphRepo`, `Git` |
| `Search` (Wave 2) | Hybrid lexical/structural search. Modes: `exact`, `prefix`, `BM25`, `Fuzzy`, `CamelCase`, `snake_case`, `Qualified`, `Graph`. Public `searchAuto(query, opts)` cascade (Exact→Qualified→Prefix→Graph→BM25→Fuzzy) with a `mode: "manual"` SDK escape | `CodegraphRepo` |
| `StructuralQueries` (Wave 2) | Tree-sitter structural queries. Wave-1: `findImplementations`, `findOverrides`, `findRecursiveFunctions`, `findAsyncFunctions`, `findHTTPRoutes`. Wave 2 adds `findInterfaces`, `findExports`, `findImports` | `CodegraphRepo` |
| `Git` (Wave 2) | `Banyan.$` wrappers over the bundled git binary. Powers `intel.findOwner` and `intel.query.git.recentCommits` | none |

Service exports live in `packages/core/src/banyancode/index.ts` in two flavors:
- Named (`CodegraphBuildService`, `codegraphBuildServiceDefaultLayer`) for direct imports inside `core`.
- Namespace (`Banyan.CodegraphBuildService`) for consumer packages (`opencode`, `tui`).

## Code graph pipeline

```
/codegraph-build (slash command)
  → CodegraphBuildService.start({ root, force, dbPath })
    → CodegraphIndexer.index({ root, force, onProgress })
      → load ignore patterns (DEFAULT_IGNORED + .gitignore + .banyancode/ignore)
      → walk directory, filter by parser-recognized extensions
      → parse each file via tree-sitter (TS/JS/Python only in PR 5/6, regex for others) or regex fallback
      → upsert CodegraphRepo with file hash, nodes, edges
      → onProgress per file → publish BuildEvent
```

Supported languages and their parsers live in `packages/core/src/banyancode/langs/`:
- `typescript.ts` — TS/TSX/JS/JSX
- `python.ts` — Python
- `regex-fallback.ts` — generic regex-based parser for other languages (imports only)
- `registry.ts` — extension → parser dispatch

The resolved DB path is computed by `Database.path()` and passed into `BuildService.start({ dbPath })`. The build service publishes the path in every `banyancode.codegraph.build` event so the TUI's progress widget can show "Index → /abs/path/to/banyancode.db".

## L0/L1/L2/L3 layers (codegraph)

The sidebar codegraph panel and the Graph tab both use these layer definitions:

- **L0 Symbol (Current)** — the focused node, fixed at center in the graph view
- **L1 Callers (Direct)** — nodes with edges pointing TO the L0 node (incoming `calls`/`references`)
- **L2 Impact (Transitive)** — full blast radius: all reachable upstream + downstream nodes
- **L3 Dependents (Reverse)** — nodes reachable FROM L0 in the reverse direction

Computed by `CodegraphAnalyzer` via BFS over `codegraph_edges`.

## Orchestrator + mesh

- `orchestrator` agent is registered by `packages/opencode/src/agent/agent.ts` when BanyanCode is enabled (the default).
- The orchestrator prompt is templated: `{{maxSubagents}}` is rendered from `BanyanConfig.banyancode_max_subagents` (default `5`, capped at `20`) at agent-load time.
- It decomposes a prompt into a plan, then `MeshCoordinator` issues bounded parallel `Effect.forkIn(scope, ...)` calls to subagents.
- Hard cap: `MeshCoordinator.tryReserveSubagentSlot` enforces the limit. At cap:
  1. Find the oldest subagent that has **already ended its task** (idle > 60s).
  2. If found, evict it via `kill({ reason: "evicted-by-new-spawn" })` and proceed.
  3. If no evictable subagent, refuse spawn and surface `Max ${n} subagents reached. No idle agents to evict.` to the orchestrator.
- Subagents talk back via `SubagentBus` (a fire-and-persist log in SQLite). Each consumer is a `SubagentConsumer.start(...)` fiber that loops on the queue, processes the message (e.g. writes a plan into memory), and calls `markDelivered` on the row so retries don't see the same payload twice.
- The max is also a **soft prompt hint**: the orchestrator's prompt says "PREFER 2-3 parallel subagents. Default fanout is 3, maximum is N" where N is the configured value.

## Provider plugin system

`packages/core/src/plugin/provider/` holds 32+ provider plugins. Each plugin:
- Handles `aisdk.sdk` (chat): provides the AI SDK instance for its package.
- May handle `catalog.transform`: mutates catalog entries (e.g. `NvidiaPlugin` adds billing headers).

## TUI integration

The TUI (`packages/tui/`) is a Solid.js app using OpenTUI primitives. It exposes a slot-based plugin system (`packages/tui/src/feature-plugins/builtins.ts`).

### Tab structure (V3)

The session route renders 6 tabs via the `ActiveTab` union (`packages/tui/src/feature-plugins/tabs/state.tsx`):

- **CHAT** — main conversation view (default)
- **SESSIONS** — tree view of root sessions + subsessions. Each row is **inline-editable**: click the title to edit, Enter to save, Escape to cancel. Uses `sdk.client.session.update({ sessionID, title })`.
- **AGENTS** — registry of built-in agents (`orchestrator`, `coder`, `explore`, `researcher`, `scout`, `general`) plus custom agents from `.banyancode/agent/*.md`. **+ Add** button opens `DialogAgentConfig` wizard.
- **GRAPH** — Obsidian-style force-directed view of the codegraph. L0/L1/L2/L3 toggle, click a node to focus it, d3-force layout via `packages/tui/src/util/graph-layout.ts`. Falls back to flat list if >50 nodes.
- **MEMORY** — cross-session memory entries
- **SETTINGS** — accordion sections: Model & Provider, Orchestration (max_subagents, YOLO, web search), Endpoints, Telegram, Custom Subagents. Saves to BanyanConfig via `sdk.client.global.banyanConfig.update`.

Tabs are `Tab` / `Shift+Tab` navigable; the keybind is surfaced in the prompt footer.

### Reusable UI primitives (`packages/tui/src/ui/`)

- `accordion.tsx` — collapsible sections with header/expand chevron
- `toggle-switch.tsx` — boolean toggle with `[● ON]` / `[○ OFF]` indicator
- `number-input.tsx` — click-to-edit with bounds clamping (used for max_subagents)
- `dialog-select.tsx` — single-select picker
- `dialog-multi-select.tsx` — **grouped + searchable** multi-select with category headers, used for tool selection
- `empty-state.tsx` — glyph + title + hint + action, used for every "No X" / "Loading…" surface
- `tokens.ts` — `space`, `density`, `fontWeight`, `glyph`, `separator` const maps (seeding wider refactor)

### Dialog backdrop

Modal dialogs use `theme.background` as the backdrop (fully opaque) so the underlying tab content is fully obscured — earlier the backdrop was `RGBA.fromInts(0, 0, 0, 150)` (59% alpha) which let graph nodes and agent cards bleed through. See `packages/tui/src/ui/dialog.tsx`.

### Sidebar widgets (`packages/tui/src/feature-plugins/sidebar/`)

- `agent-tree.tsx` — orchestrator + subagent tree with L-bracket connectors. `ev.on()` subscriptions are paired with `onCleanup` to avoid listener accumulation across remounts.
- `codegraph-panel.tsx` — L0/L1/L2/L3 layer counts, codegraph overview (version, built at, coverage, nodes/edges), explanation of what each layer means. Empty state with `/codegraph-build` hint when no graph exists.
- `system-status.tsx` — CPU/memory/GPU/VRAM bars with color-coded warnings (green < 60%, yellow < 85%, red > 85%), subscribed to `banyancode.system.updated`. Designed loading state via EmptyState.
- `files.tsx`, `mcp.tsx`, `lsp.tsx`, `todo.tsx` — other context widgets

### Inspector widgets (`packages/tui/src/feature-plugins/inspector/`)

- `agent-details.tsx` — current agent: status, task, model, tools, memory, last message
- `graph-explorer.tsx` — L0/L1/L2/L3 toggle with focused-node detail; "no symbol selected for layer" empty state with click-a-node hint
- `pending-actions.tsx` — pending sessions/permissions/questions with keybindings. "All caught up" empty state.

### Subscription cleanup

All `useEvent().on(type, handler)` and `event.on(type, handler)` calls inside component bodies are paired with `onCleanup(unsub)` so listeners don't accumulate across remounts. The pattern is `const unsub = ev.on(...); onCleanup(unsub)` or inline `onCleanup(event.on(...))`.

## HTTP API

Endpoints added by BanyanCode (`packages/opencode/src/server/routes/instance/httpapi/`):

**Config + workspace state**
- `GET /global/banyan-config` — read `BanyanConfig.Info`
- `POST /global/banyan-config` — partial update

**Codegraph build lifecycle**
- `POST /global/codegraph-build` — start a background build
- `POST /global/codegraph-cancel` — interrupt a running build
- `POST /global/codegraph-force-kill` — force-kill a stuck build (Windows: `taskkill` fallback)
- `POST /global/codegraph-remove` — clear the index

**Wave 2 — repository intelligence (under `/global/repository/*`)**
- `POST /global/repository/query` — unified repository context
- `POST /global/repository/slice` — ArchitecturalSlice from a context
- `POST /global/repository/explain` — slice for a symbol name
- `POST /global/repository/impact` — slice expanded with the file's dependents
- `POST /global/repository/trace` — downstream entrypoints for a symbol
- `POST /global/repository/tests` — test nodes referencing a symbol
- `POST /global/repository/symbols` — exact-then-prefix symbol lookup
- `POST /global/repository/relationships` — BFS from a codegraph nodeID
- `POST /global/repository/ownership` — most active git author for a path

**Free web search (Wave 2)**
- `POST /global/websearch-free` — DuckDuckGo HTML scrape, no API key. Gated by `BANYANCODE_DISABLE_WEBSEARCH=1`

**Agent authoring**
- `POST /global/banyan-agent/save` — write a custom subagent definition to `.banyancode/agent/<name>.md`

All paths use `Schema.isPattern` / `isMaxLength` validation for path-traversal safety. The `name` field on `BanyanAgentSaveInput` is constrained to `^[a-zA-Z0-9._-]+$` and the handler does a second defense-in-depth check (strip disallowed chars + verify the resolved path is inside the agent directory). The 9 wave-2 endpoints reuse the same schema-validation pattern.

Inherited from OpenCode V2: `PATCH /session/{id}` — update session metadata (used for inline title edit).

The TUI listens on `event` SSE for `banyancode.codegraph.build` and `banyancode.system.updated`.

## Slash commands

Server-side commands in `packages/opencode/src/command/index.ts`:

**Wave 0 / Wave 1**
- `/codegraph-build [root] [--force]` — runs in background; `CodegraphBuildService.start` forks.
- `/codegraph-remove` — clears all rows from `codegraph_*` tables (deletes the index).
- `/yolo` — toggles `banyancode_yolo_mode` (skips permission prompts).

**Wave 2 — repository intelligence**
- `/repository-query <query> [--limit N]` — uniform `RepositoryContext`
- `/repository-explain <symbol>` — ArchitecturalSlice for a symbol
- `/repository-trace <symbol> [--depth N]` — downstream entrypoints
- `/repository-impact <path>` — dependents of a file
- `/repository-tests <symbol>` — tests referencing a symbol
- `/repository-symbols <query> [--limit N]` — exact/prefix symbol lookup
- `/repository-relationships <nodeID> [--depth N]` — BFS from a nodeID
- `/repository-ownership <path>` — most active git author for a file

**Wave 2 — free web search**
- `/websearch-free <query>` — DuckDuckGo HTML scrape

**Inherited**
- `/init`, `/review`, `/refresh-models` — from upstream OpenCode.

Dialog commands (TUI command palette, not slash commands):
- `/agent-model` — opens the agent model picker.

## CLI subcommands

`opencode` (TUI/CLI binary) gains two wave-2 top-level groups, registered in `packages/opencode/src/index.ts`:

**`opencode codegraph ...`** (`packages/opencode/src/cli/cmd/codegraph.ts`)
- `build [--root PATH] [--force] [--watch] [--timeout N]` — start a build; streams progress in TTY
- `status` — current build state
- `cancel` — cancel in-flight build
- `force-kill` — interrupt stuck build (Windows: `taskkill` fallback)
- `path` — print resolved `banyancode.db` path
- `trace --session <id> [--limit N]` — tail `.banyancode/trace/<sessionID>.jsonl` (Wave 2)

**`opencode repository ...`** (`packages/opencode/src/cli/cmd/repository.ts`, Wave 2)
- `query <query> [--limit N]` — unified repository context
- `explain <symbol>` — ArchitecturalSlice for a symbol
- `trace <symbol> [--depth N]` — downstream entrypoints
- `impact <path>` — dependents of a file
- `tests <symbol>` — tests referencing a symbol
- `relationships <nodeID> [--depth N]` — BFS from a nodeID
- `ownership <path>` — most active git author

**`opencode websearch-free <query> [--num N]`** (`packages/opencode/src/cli/cmd/websearch-free.ts`, Wave 2) — DuckDuckGo HTML scrape.

The `repository` group is `instance: false` so it works whether or not the user has an active session; it re-provides `Banyan.repositoryIntelligenceDefaultLayer` for its own DB access (no app-layer add of an external service needed). The `websearch-free` group is also `instance: false` and is gated by `BANYANCODE_DISABLE_WEBSEARCH=1` or `BanyanConfig.banyancode_disable_websearch`.

## Tests

Test fixture conventions in `packages/opencode/test/AGENTS.md`:
- `tmpdir()` from `fixture/tmpdir.ts` for real disk paths.
- `testEffect(...)` from `lib/effect.ts` for Effect-based tests.
- `it.effect(...)`, `it.live(...)`, `it.instance(...)` for clock control.
- BanyanCode repos (`CodegraphRepo`, `MemoryRepo`, `SubagentMessagesRepo`, `SubagentPlansRepo`) need `Database.layerFromPath(tmpDbPath)` provided explicitly or they fall back to the global home dir DB and fail.

BanyanCode-specific test files:
- `packages/core/test/banyancode/` — service-level tests for every BanyanCode service (incl. `codegraph-pagination.test.ts`).
- `packages/opencode/test/banyancode/` — command shell, agent registry, command-execute tests, `banyan-agent-save-validation.test.ts` (path-traversal regressions).
- `packages/opencode/test/banyancode/` — command shell, agent registry, command-execute tests, `banyan-agent-save-validation.test.ts` (path-traversal regressions).
- `packages/tui/test/util/tokens.test.ts` — design token assertions.

## Runtime flags

`packages/core/src/effect/runtime-flags.ts` (and the opencode-package twin) captures env-var configuration into a `RuntimeFlags` service:
- `BANYANCODE_ENABLE` — feature gate; default on (`boolTrue`). Set to `0` to disable BanyanCode and run as upstream OpenCode.
- `BANYANCODE_DISABLE_WEBSEARCH=1` — disable `websearch_free`
- `BANYANCODE_CONFIG_DIR` — override global config directory
- `BANYANCODE_DISABLE_PROJECT_CONFIG=1` — skip project-local `.banyancode/` discovery

## Per-feature deep dives

Detailed design docs live in `specs/banyancode/`:
- `overview.md` — high-level pitch and reuse map
- `orchestrator.md` — orchestrator prompt + agent layout
- `subagent-mesh.md` — wire format, capacity, failure modes, eviction policy
- `memory.md` — memory tables, vacuum
- `codegraph.md` — code graph pipeline
- `storage.md` — Drizzle schemas and migrations (libSQL)
- `types.md` — shared types
- `websearch-free.md` — DuckDuckGo HTML scraping

User-facing docs (rendered to the docs site) live in `packages/docs/src/content/docs/banyancode*.mdx`.

The deep-review notes that produced the V3.1 round live at `.banyancode/deep-codebase-review.md` (historical reference, 100+ findings).

## Coding conventions for BanyanCode work

In addition to the root `AGENTS.md` style guide:
- BanyanCode-specific keys (`banyancode_yolo_mode`, `banyancode_max_subagents`, `banyancode_telegram_*`, future runtime keys) live in `BanyanConfig.Info`. Never in `ConfigV1.Info`.
- Consumers read via `Banyan.BanyanConfigService` or `Effect.serviceOption(Banyan.BanyanConfigService)`.
- Do NOT add BanyanCode service deps to `BanyanTools.locationLayer` (`packages/core/src/banyancode/tools-layer.ts`). Provide them at the consumer level instead — see `packages/opencode/src/effect/app-runtime.ts` for the canonical wiring.
- New BanyanCode services should follow the `Service / layer / defaultLayer` triple with a gated no-op path when `BANYANCODE_ENABLE=0`.
- Service reference pattern: `packages/core/src/banyancode/index.ts` exports each service both as a named constant and via `export * as Banyan from "."` for consumer namespace imports.

## Changelog

- **V2** (`banyancode-v2-turso`): migrated storage from `bun:sqlite` / `node:sqlite` to `@libsql/client`; added FTS5 symbol search, JSONB memory; UI refined to match design mockup.
- **V3** (`banyancode-v3-fixes`): split Sessions from Agents tab with inline-editable titles; Obsidian-style force-directed Graph tab via `d3-force`; agent config dialog with file-based subagent definitions; complete Settings tab with all BanyanConfig sections; `banyancode_max_subagents` plumbed into orchestrator prompt template + `MeshCoordinator` hard limit with oldest-ended eviction; `systeminfo` tool for agents + sidebar status widget; fixed silent `tab-graph.tsx` "No nodes indexed" bug; removed fake layer counts in `codegraph-panel.tsx`.
- **V3.1** (`review-fixes`): deep-codebase-review fixes.
  - **Security**: `BanyanAgentSaveInput.name` schema validation (`^[a-zA-Z0-9._-]+$`) + handler defense-in-depth (resolved-path containment) closes path traversal in `POST /global/banyan-agent/save`.
  - **Correctness**: `SubagentConsumer.start` actually forks the message loop and calls `markDelivered` on every consumed message; `SystemMonitor` queue is bounded to 60 entries and `watch()` no longer spawns per-call unmanaged fibers.
  - **Performance**: `CodegraphRepo` gained `countNodes/Edges/Files` (`SELECT COUNT(*)`) so `bumpVersion` no longer materializes every node+edge into JS; `searchNodes({ name?, kind?, limit })` pushes `LIKE`/`=` filters to SQL with a default `LIMIT 1000`.
  - **TUI quality**: every `ev.on()`/`event.on()` inside a component body is paired with `onCleanup(unsub)`; `.map()` in JSX is replaced with Solid `<For>` for keyed iteration; every "No X" / "Loading…" surface renders the same `EmptyState` shape (glyph + title + suggested next action); modal dialogs use `theme.background` as backdrop (fully opaque) instead of `RGBA.fromInts(0, 0, 0, 150)`.
- **Wave 1** (`graph-extra`): shipped the first repository-intelligence surface — 7-method `RepositoryIntelligence` (`findSymbol`, `findSubsystem`, `findEntrypoints`, `findTests`, `findRelated`, `estimateImpact`, `traceExecution`); hybrid `Search` (exact, prefix, BM25, fuzzy, camelCase, snake_case, qualified); `StructuralQueries` (implementations, overrides, recursive, async, HTTP routes); 6 new file-level codegraph node kinds (`test`, `route`, `config`, `build`, `package`, `generated`) + 5 new edge kinds. LLM tool surface: 13 `repo_*` + `codegraph_*` tools, all wrapped in `traced(...)` against `.banyancode/trace/<sessionID>.jsonl`. Commits: `0962825`, `a39b85e`, `78030e4`, `8a9ceeb`, `1f64078`, `a002810`.
- **Wave 2** (`main`): repository intelligence v2. Reshaped `RepositoryIntelligence` from 7 to a stable **9-method public surface** (`query`, `slice`, `explain`, `impact`, `trace`, `tests`, `symbols`, `relationships`, `ownership`). New canonical return type `ArchitecturalSlice` (`{ summary, entrypoints, importantSymbols, relatedTests, relatedDocs, configs, routes, dependencies }`) emitted by all slice-returning methods. `Search` gained `searchAuto(query, opts)` cascade + `mode: "manual"` SDK escape. `StructuralQueries` added `findInterfaces`, `findExports`, `findImports`. Codegraph `CodegraphNodeKind` extended with `ci | docker | env | doc`; new parsers in `langs/{markdown,docker}.ts`. Shared types in `packages/core/src/banyancode/types.ts`: `ArchitecturalSlice`, `RepositoryContext`, `WorkspaceContext`, `Ranking`, `Diagnostic`. New `Banyan.Git` service (`packages/core/src/banyancode/repository-intelligence/git-service.ts`) wrapping `Banyan.$` over the bundled git binary.
  - **HTTP**: 9 new endpoints under `/global/repository/*` (mounted on `RootHttpApi`, instance-independent) plus `POST /global/websearch-free` for DuckDuckGo. Handlers rewritten in `packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}/repository-intel.ts` to call the 9-method surface.
  - **Tools**: 9 new `repository_*` tool wrappers in `packages/core/src/tool/repository-wave2.ts` (`repository_query`, `repository_slice`, `repository_explain`, `repository_impact`, `repository_trace`, `repository_tests`, `repository_symbols`, `repository_relationships`, `repository_ownership`), each passes through `PermissionV2.assert(...)` and `traced(...)`, returns the schema-validated output, and is registered via `banyanToolLayers` in `packages/opencode/src/tool/registry.ts`.
  - **Slash commands**: 9 new entries (`/repository-query`, `/repository-explain`, `/repository-trace`, `/repository-impact`, `/repository-tests`, `/repository-symbols`, `/repository-relationships`, `/repository-ownership`) plus `/websearch-free`. Templates in `packages/opencode/src/command/template/`.
  - **CLI**: 2 new top-level commands — `opencode repository {query,explain,trace,impact,tests,relationships,ownership}` and `opencode websearch-free <query>`. Both are `instance: false` so they work whether or not the user has an active chat session. Wired into `packages/opencode/src/index.ts` and registered in `AppRuntime` via `Layer.provideMerge(Banyan.repositoryIntelligenceDefaultLayer.pipe(...))`.
  - **Permissions**: `PermissionV2.Service` now implemented as a thin bridge over `Permission.Service` in `packages/opencode/src/effect/permission-bridge.ts`; mounted via `Layer.provideMerge(PermissionBridge.layer.pipe(Layer.provide(Permission.defaultLayer)))` so core services can stay Effect-native without depending on the v1 schema. 3/3 tests pass.
  - **Trace**: `TraceEvent` gained optional `cache?: CacheLayer<...>` and `workspace?: WorkspaceContext` slots. Trace file is bounded to **7 days OR 10,000 events**, whichever first; oldest lines dropped from `.banyancode/trace/<sessionID>.jsonl`. CLI subcommand `opencode codegraph trace --session <id> [--limit N]` tails the file. The `intel-trace-panel.tsx` TUI sidebar widget is authored but not registered — left as a Wave-4 task.
  - **Commits**: `771800e` (core surface), `d5cd170` (trace instrumentation), `fd8f899` (HTTP routes + permission bridge), `f85e85a` (9 `repository_*` tool wrappers), `ec055e0` (slash commands + CLI). All five on `main` and pushed to `origin/main`. Test status: 163/163 banyancode core tests pass; 9/9 opencode-banyancode tests pass (`repository-intel-http` ×2, `trace` ×4, `permission-bridge` ×3); pre-push `bun turbo typecheck` passes for all 29 packages. The next-wave outline (cache layer, semantic code search, evaluator harness, intel-trace panel registration) is planned for future work.
