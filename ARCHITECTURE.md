# BanyanCode Architecture

This document describes how BanyanCode is structured on disk, how the runtime layers compose, and where to find things. It replaces the older `BANYANCODE_PLAN.md` (now deleted) which tracked phased implementation history.

## Overview

BanyanCode is a CLI/TUI-only fork of [OpenCode](https://github.com/anomalyco/opencode) that adds four capabilities:

1. **Orchestrator + subagent mesh** — a primary `orchestrator` agent decomposes complex tasks and fans out to specialized subagents in parallel, with a user-configurable hard limit.
2. **Cross-session memory** — a persistent key-value store with JSONB indexable payloads.
3. **Codebase utility** — a tree-sitter code graph (`/codegraph-build`) backed by Turso/libSQL.
4. **Researcher agent with free web search** — a `researcher` subagent backed by DuckDuckGo (no API key required).

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

Both products can be installed side by side. BanyanCode reads/writes only `banyancode.*` and `.banyancode/`; OpenCode reads/writes only its own paths. Disabling BanyanCode (`BANYANCODE_ENABLE` unset) leaves OpenCode untouched.

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

Every BanyanCode service follows the same pattern: a `Context.Service` class, a `layer` builder, and a `defaultLayer` that wires the service's dependencies. All services are gated by `BANYANCODE_ENABLE` (default off) so disabling BanyanCode is a no-op.

| Service | Purpose | Key deps |
|---------|---------|----------|
| `BanyanConfigService` | Read/write `banyancode.json` from `~/.config/banyancode/` | `FSUtil` |
| `CodegraphRepo` | Drizzle CRUD over `codegraph_*` tables; pagination via `searchNodes({ name?, kind?, limit })`; cheap cardinality via `countNodes/Edges/Files` | `Database` |
| `MemoryRepo` | Drizzle CRUD over `memory_entries` (JSONB value/tags), optimistic-concurrency `update` | `Database` |
| `SubagentMessagesRepo`, `SubagentPlansRepo` | Mesh persistence (with `markDelivered` for consume tracking) | `Database` |
| `CodegraphIndexer` | Walk a directory, parse files, extract nodes/edges via tree-sitter | `CodegraphRepo`, `FSUtil` |
| `CodegraphBuildService` | Persistent build state, fork/cancel, publish `banyancode.codegraph.build` events | `CodegraphIndexer`, `EventV2` |
| `CodegraphAnalyzer` | BFS impact/dependents/callers over the graph edges; computes L0/L1/L2/L3 layers | `CodegraphRepo` |
| `MaxSubagentsService` | Reads `banyancode_max_subagents` config (default 5, max 20), validates, provides to orchestrator prompt + hard runtime limit | `BanyanConfigService` |
| `SubagentBus`, `MeshCoordinator`, `SubagentConsumer` | Fire-and-persist peer messaging + fan-out coordination; consumer forks a per-session message loop that calls `markDelivered` after each message. Hard cap via `tryReserveSubagentSlot` | `SubagentMessagesRepo`, `SubagentPlans`, `MaxSubagentsService` |
| `SystemMonitorService` | CPU/memory/platform/GPU health reads; publishes `banyancode.system.updated` every 1s. Bounded queue (size 60), no per-`watch()` fiber leak | `AppProcess` |

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

## L0/L1/L2/L3 layers (codegraph)

The sidebar codegraph panel and the Graph tab both use these layer definitions:

- **L0 Symbol (Current)** — the focused node, fixed at center in the graph view
- **L1 Callers (Direct)** — nodes with edges pointing TO the L0 node (incoming `calls`/`references`)
- **L2 Impact (Transitive)** — full blast radius: all reachable upstream + downstream nodes
- **L3 Dependents (Reverse)** — nodes reachable FROM L0 in the reverse direction

Computed by `CodegraphAnalyzer` via BFS over `codegraph_edges`.

## Orchestrator + mesh

- `orchestrator` agent is registered by `packages/opencode/src/agent/agent.ts` when `BANYANCODE_ENABLE=1`.
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
- `GET /global/banyan-config` — read `BanyanConfig.Info`
- `POST /global/banyan-config` — partial update
- `POST /global/codegraph-cancel` — interrupt a running build
- `GET /global/codegraph-nodes` — list all indexed nodes + summary meta
- `GET /global/codegraph-edges` — edges for a node (query: `nodeID`)
- `POST /global/banyan-agent/save` — write a custom subagent definition to `.banyancode/agent/<name>.md`

All handler payloads use `Schema.isPattern` / `isMaxLength` validation for path-traversal safety. The `name` field on `BanyanAgentSaveInput` is constrained to `^[a-zA-Z0-9._-]+$` and the handler does a second defense-in-depth check (strip disallowed chars + verify the resolved path is inside the agent directory).

Inherited from OpenCode V2: `PATCH /session/{id}` — update session metadata (used for inline title edit).

The TUI listens on `event` SSE for `banyancode.codegraph.build` and `banyancode.system.updated`.

## Slash commands

Server-side commands in `packages/opencode/src/command/index.ts`:
- `/codegraph-build [root] [--force]` — runs in background; `CodegraphBuildService.start` forks.
- `/codegraph-remove` — clears all rows from `codegraph_*` tables (deletes the index).
- `/yolo` — toggles `banyancode_yolo_mode` (skips permission prompts).
- `/init`, `/review`, `/refresh-models` — inherited from OpenCode.

Dialog commands (TUI command palette, not slash commands):
- `/agent-model` — opens the agent model picker.

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
- `BANYANCODE_ENABLE=1` — feature gate; default off
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
