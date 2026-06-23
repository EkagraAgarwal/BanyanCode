# BanyanCode Architecture

This document describes how BanyanCode is structured on disk, how the runtime layers compose, and where to find things. It replaces the older `BANYANCODE_PLAN.md` (now deleted) which tracked phased implementation history.

## Overview

BanyanCode is a CLI/TUI-only fork of [OpenCode](https://github.com/anomalyco/opencode) that adds four capabilities:

1. **Orchestrator + subagent mesh** — a primary `orchestrator` agent decomposes complex tasks and fans out to specialized subagents in parallel, with a user-configurable hard limit.
2. **Cross-session memory** — a persistent key-value store with optional embeddings and JSONB indexable payloads.
3. **2-phase codebase utility** — a tree-sitter code graph (`/codegraph-build`) plus a native vector search layer (`/code-embed`) backed by Turso/libSQL vector functions.
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
├── banyancode.db        # libSQL/Turso: memory, codegraph, subagent data, embeddings
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
- **Native vector search**: `F32_BLOB(N)` column type, `vector_distance_cos` / `vector_distance_l2` functions, `vector_top_k(idx, vec, k)` table-valued function.
- **DiskANN ANN algorithm**: `libsql_vector_idx(column)` partial indexes for sub-millisecond KNN at 10K+ nodes.
- **Multiple vector types**: FLOAT64/F32/F16/F8/FLOATB16/FLOAT1BIT (we use F32 by default).
- **FTS5 full-text search**: virtual tables with BM25 ranking for symbol-name search in codegraph.
- **JSONB type**: indexable JSON paths for memory entries.
- **STRICT tables** + user-defined types.
- **MVCC concurrent writes** (Turso 0.5+, beta — not enabled by default yet).

The TUI sidebar shows L0/L1/L2/L3 layer counts driven by the `banyancode.codegraph.build` event payload. The native `vector_top_k('codegraph_embedding_vec_idx', ...)` query is what backs `/codegraph-search` and the Graph tab's Obsidian-style force-directed view.

Schema (`packages/core/src/banyancode/codegraph.sql.ts`):
```ts
export const f32Blob = customType<{ data: Uint8Array; ... }>({
  dataType() { return `F32_BLOB(${PLACEHOLDER_DIM})` },
  ...
})
```

The `PLACEHOLDER_DIM` (1536) is the fixed column size; the actual content size for each row is tracked in the `dim` column. Embeddings under different models with the same dim coexist freely; embeddings under different dims can coexist because each row carries its own `dim`.

Debug logs (stderr):
```
[turso.driver] opening file:.banyancode/banyancode.db
[turso.schema] codegraph_embeddings F32_BLOB(1536) configured (placeholder dim)
[turso.schema] memory_entries with jsonb columns configured
[turso.vector] putEmbedding node_id=abc dim=1536 model=text-embedding-3-small bytes=6144
[turso.vector] searchTopK query_dim=1536 k=10 -> 10 rows in 1.2ms
[turso.picker] probe endpoint=openai/text-embedding-3-small -> dim=1536
[turso.picker] clearEmbeddingsForModel model=text-embedding-3-small
```

## BanyanCode service layer (`packages/core/src/banyancode/`)

Every BanyanCode service follows the same pattern: a `Context.Service` class, a `layer` builder, and a `defaultLayer` that wires the service's dependencies. All services are gated by `BANYANCODE_ENABLE` (default off) so disabling BanyanCode is a no-op.

| Service | Purpose | Key deps |
|---------|---------|----------|
| `BanyanConfigService` | Read/write `banyancode.json` from `~/.config/banyancode/` | `FSUtil` |
| `CodegraphRepo` | Drizzle CRUD over `codegraph_*` tables; native vector search via `searchByVector`; pagination via `searchNodes({ name?, kind?, limit })`; cheap cardinality via `countNodes/Edges/Files` | `Database` |
| `MemoryRepo` | Drizzle CRUD over `memory_entries` (JSONB value/tags), optimistic-concurrency `update` | `Database` |
| `SubagentMessagesRepo`, `SubagentPlansRepo` | Mesh persistence (with `markDelivered` for consume tracking) | `Database` |
| `CodegraphIndexer` | Walk a directory, parse files, extract nodes/edges via tree-sitter | `CodegraphRepo`, `FSUtil` |
| `CodegraphBuildService` | Persistent build state, fork/cancel, publish `banyancode.codegraph.build` events | `CodegraphIndexer`, `EventV2` |
| `CodegraphEmbedder` | Walk nodes, call embedding provider, write `codegraph_embeddings` | `CodegraphRepo`, `EmbeddingProvider` |
| `CodegraphEmbedService` | Persistent embed state, fork/cancel, publish `banyancode.codeembed.build` events | `CodegraphEmbedder`, `EventV2` |
| `CodegraphAnalyzer` | BFS impact/dependents/callers over the graph edges; computes L0/L1/L2/L3 layers | `CodegraphRepo` |
| `EmbeddingProviderService` | Holds the active model, fires `plugin.trigger("aisdk.embed", ...)`, **probes** the endpoint to detect dim at runtime. Interface returns `Effect.Effect<...>` for the sync model accessor | `BanyanConfigService`, `PluginV2`, `CodegraphRepo` |
| `MaxSubagentsService` | Reads `banyancode_max_subagents` config (default 5, max 20), validates, provides to orchestrator prompt + hard runtime limit | `BanyanConfigService` |
| `SubagentBus`, `MeshCoordinator`, `SubagentConsumer` | Fire-and-persist peer messaging + fan-out coordination; consumer forks a per-session message loop that calls `markDelivered` after each message. Hard cap via `tryReserveSubagentSlot` | `SubagentMessagesRepo`, `SubagentPlans`, `MaxSubagentsService` |
| `SystemMonitorService` | CPU/memory/platform/GPU health reads; publishes `banyancode.system.updated` every 1s. Bounded queue (size 60), no per-`watch()` fiber leak | `AppProcess` |

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

**Model switching** (V2): The `/embedding-model` picker probes the endpoint with a 1-char input to detect the model's dim at runtime. After probe, it persists `banyancode_embedding_model` and `banyancode_embedding_dim` to BanyanConfig, then calls `CodegraphRepo.resetEmbeddingsTable(dim, model)`. The reset is **non-destructive by default** — it only removes rows tagged with the new model (none should exist yet), preserving embeddings written under any previously used model. Pass `{ force: true }` to drop all rows.

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
- May handle `aisdk.embed` (embeddings): returns vectors for its models via `evt.embeddings`.
- May handle `catalog.transform`: mutates catalog entries (e.g. `NvidiaPlugin` adds billing headers).

`NvidiaEmbedTestPlugin` (`packages/core/src/plugin/provider/nvidia-embed.ts`) is the only BanyanCode-specific plugin. It is gated by `BANYANCODE_NVIDIA_TEST=1` and exists for end-to-end testing with NVIDIA NIM without committing an API key or non-OpenAI-compatible SDK surface.

## TUI integration

The TUI (`packages/tui/`) is a Solid.js app using OpenTUI primitives. It exposes a slot-based plugin system (`packages/tui/src/feature-plugins/builtins.ts`).

### Tab structure (V3)

The session route renders 6 tabs via the `ActiveTab` union (`packages/tui/src/feature-plugins/tabs/state.tsx`):

- **CHAT** — main conversation view (default)
- **SESSIONS** — tree view of root sessions + subsessions. Each row is **inline-editable**: click the title to edit, Enter to save, Escape to cancel. Uses `sdk.client.session.update({ sessionID, title })`.
- **AGENTS** — registry of built-in agents (`orchestrator`, `coder`, `explore`, `researcher`, `scout`, `general`) plus custom agents from `.banyancode/agent/*.md`. **+ Add** button opens `DialogAgentConfig` wizard.
- **GRAPH** — Obsidian-style force-directed view of the codegraph. L0/L1/L2/L3 toggle, click a node to focus it, d3-force layout via `packages/tui/src/util/graph-layout.ts`. Falls back to flat list if >50 nodes.
- **MEMORY** — cross-session memory entries
- **SETTINGS** — accordion sections: Model & Provider, Orchestration (max_subagents, YOLO, web search), Embeddings, Endpoints, Telegram, Custom Subagents. Saves to BanyanConfig via `sdk.client.global.banyanConfig.update`.

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
- `POST /global/embedding-model/apply` — read config + call `EmbeddingProvider.setModel`
- `POST /global/codegraph-cancel` — interrupt a running build
- `GET /global/codegraph-nodes` — list all indexed nodes + summary meta
- `GET /global/codegraph-edges` — edges for a node (query: `nodeID`)
- `POST /global/banyan-agent/save` — write a custom subagent definition to `.banyancode/agent/<name>.md`

All handler payloads use `Schema.isPattern` / `isMaxLength` validation for path-traversal safety. The `name` field on `BanyanAgentSaveInput` is constrained to `^[a-zA-Z0-9._-]+$` and the handler does a second defense-in-depth check (strip disallowed chars + verify the resolved path is inside the agent directory).

Inherited from OpenCode V2: `PATCH /session/{id}` — update session metadata (used for inline title edit).

The TUI listens on `event` SSE for `banyancode.codegraph.build`, `banyancode.codeembed.build`, and `banyancode.system.updated`.

## Slash commands

Server-side commands in `packages/opencode/src/command/index.ts`:
- `/codegraph-build [root] [--force]` — runs in background; `CodegraphBuildService.start` forks.
- `/codegraph-remove` — clears all rows from `codegraph_*` tables (deletes the index).
- `/code-embed [--file <path>]` — runs in background; `CodegraphEmbedService.start` forks.
- `/yolo` — toggles `banyancode_yolo_mode` (skips permission prompts).
- `/init`, `/review`, `/refresh-models` — inherited from OpenCode.
- `/embedding-model` — opens model picker dialog (V2 probing flow).

Dialog commands (TUI command palette, not slash commands):
- `/agent-model` — opens the agent model picker.
- `/embedding-model` (slash variant) — picker for the codegraph embedding model.

## Tests

Test fixture conventions in `packages/opencode/test/AGENTS.md`:
- `tmpdir()` from `fixture/tmpdir.ts` for real disk paths.
- `testEffect(...)` from `lib/effect.ts` for Effect-based tests.
- `it.effect(...)`, `it.live(...)`, `it.instance(...)` for clock control.
- BanyanCode repos (`CodegraphRepo`, `MemoryRepo`, `SubagentMessagesRepo`, `SubagentPlansRepo`) need `Database.layerFromPath(tmpDbPath)` provided explicitly or they fall back to the global home dir DB and fail.

BanyanCode-specific test files:
- `packages/core/test/banyancode/` — service-level tests for every BanyanCode service (incl. `codegraph-pagination.test.ts`, `codegraph-vector-search.test.ts`).
- `packages/core/test/plugin/provider-nvidia-embed.test.ts` — NIM plugin gating tests.
- `packages/opencode/test/banyancode/` — command shell, agent registry, command-execute tests, `banyan-agent-save-validation.test.ts` (path-traversal regressions).
- `packages/tui/test/util/tokens.test.ts` — design token assertions.

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
- `subagent-mesh.md` — wire format, capacity, failure modes, eviction policy
- `memory.md` — memory tables, embedding flow, vacuum
- `codegraph.md` — code graph pipeline + embedding flow
- `storage.md` — Drizzle schemas and migrations (libSQL)
- `types.md` — shared types
- `websearch-free.md` — DuckDuckGo HTML scraping

User-facing docs (rendered to the docs site) live in `packages/docs/src/content/docs/banyancode*.mdx`.

The full deep-review refactor that produced the V3.1 round lives at `.banyancode/deep-codebase-review.md` (100+ findings) and `plan.md` (active phases).

## Coding conventions for BanyanCode work

In addition to the root `AGENTS.md` style guide:
- BanyanCode-specific keys (`banyancode_embedding_model`, `banyancode_yolo_mode`, `banyancode_max_subagents`, future telegram/runtime keys) live in `BanyanConfig.Info`. Never in `ConfigV1.Info`.
- Consumers read via `Banyan.BanyanConfigService` or `Effect.serviceOption(Banyan.BanyanConfigService)`.
- Do NOT add BanyanCode service deps to `BanyanTools.locationLayer` (`packages/core/src/banyancode/tools-layer.ts`). Provide them at the consumer level instead — see `packages/opencode/src/effect/app-runtime.ts` for the canonical wiring.
- New BanyanCode services should follow the `Service / layer / defaultLayer` triple with a gated no-op path when `BANYANCODE_ENABLE=0`.
- Service reference pattern: `packages/core/src/banyancode/index.ts` exports each service both as a named constant and via `export * as Banyan from "."` for consumer namespace imports.

## Changelog

- **V2** (`banyancode-v2-turso`): migrated storage from `bun:sqlite` / `node:sqlite` to `@libsql/client`; added native vector search, FTS5 symbol search, JSONB memory; replaced in-memory cosine scan with `vector_top_k` DiskANN index; added probing-based `/embedding-model` picker; UI refined to match design mockup.
- **V3** (`banyancode-v3-fixes`): split Sessions from Agents tab with inline-editable titles; Obsidian-style force-directed Graph tab via `d3-force`; agent config dialog with file-based subagent definitions; complete Settings tab with all BanyanConfig sections; `banyancode_max_subagents` plumbed into orchestrator prompt template + `MeshCoordinator` hard limit with oldest-ended eviction; `systeminfo` tool for agents + sidebar status widget; fixed silent `tab-graph.tsx` "No nodes indexed" bug; removed fake layer counts in `codegraph-panel.tsx`.
- **V3.1** (`review-fixes`): deep-codebase-review fixes.
  - **Security**: `BanyanAgentSaveInput.name` schema validation (`^[a-zA-Z0-9._-]+$`) + handler defense-in-depth (resolved-path containment) closes path traversal in `POST /global/banyan-agent/save`.
  - **Correctness**: `EmbeddingProvider.model()` is now an `Effect.Effect<string | undefined, never, never>` (was a sync `Effect.runSync` that threw outside a Fiber); `SubagentConsumer.start` actually forks the message loop and calls `markDelivered` on every consumed message; `resetEmbeddingsTable` is non-destructive by default (only clears the new model's rows, preserves old embeddings under any previously used model) with `{ force: true }` for an explicit wipe; `SystemMonitor` queue is bounded to 60 entries and `watch()` no longer spawns per-call unmanaged fibers.
  - **Performance**: `CodegraphRepo` gained `countNodes/Edges/Files` (`SELECT COUNT(*)`) so `bumpVersion` no longer materializes every node+edge into JS; `searchNodes({ name?, kind?, limit })` pushes `LIKE`/`=` filters to SQL with a default `LIMIT 1000`.
  - **TUI quality**: every `ev.on()`/`event.on()` inside a component body is paired with `onCleanup(unsub)`; `.map()` in JSX is replaced with Solid `<For>` for keyed iteration; every "No X" / "Loading…" surface renders the same `EmptyState` shape (glyph + title + suggested next action); modal dialogs use `theme.background` as backdrop (fully opaque) instead of `RGBA.fromInts(0, 0, 0, 150)`.
