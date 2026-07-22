# BanyanCode Architecture

This document describes how BanyanCode is structured on disk, how the runtime layers compose, and where to find things in the codebase.

## Overview

BanyanCode is a CLI/TUI-only fork of [OpenCode](https://github.com/anomalyco/opencode) that adds five core capabilities:

1. **Orchestrator + Subagent Mesh** — a primary `orchestrator` agent decomposes complex tasks and fans out to specialized subagents (`coder`, `explore`, `researcher`, `scout`, `general`) in parallel, governed by a user-configurable hard limit and an oldest-ended eviction policy.
2. **Advanced Cross-Session Memory Subsystem** — a multi-tiered persistent memory engine featuring candidate extraction, intent classification, hybrid FTS5/tag retrieval, automated hygiene (expire/reconcile/prune), and structured projections.
3. **Tree-Sitter Code Graph** — a code graph indexer (`/codegraph-build`) backed by Turso/libSQL, supporting Tree-Sitter parsing (TypeScript, Python, Markdown, Dockerfiles) and regex fallbacks.
4. **Researcher Agent with Free Web Search** — a `researcher` subagent backed by DuckDuckGo HTML scraping (`websearch_free`), requiring no API keys.
5. **Repository Intelligence (Wave 1 & Wave 2)** — a stable 8-method public surface (`query`, `explain`, `impact`, `trace`, `tests`, `symbols`, `relationships`, `ownership`) returning a typed `ArchitecturalSlice`. Driven by `bfsPure` graph traversal, batched SQL queries, and evidence-based test discovery.

Upstream desktop, web, app, and Storybook packages are explicitly out of scope. BanyanCode is a sequence of additions to OpenCode, not a full rewrite.

## Repo Layout

The repo is a Bun workspace composed of packages under `packages/`:

| Package | Purpose | BanyanCode Role |
|---------|---------|-----------------|
| `core` | Effect services, database driver, plugins, tool framework, BanyanCode service layer | Hosts the `Banyan.*` service namespace (~25 Effect services), libSQL driver, and tools |
| `opencode` | CLI binary (`banyancode`), command shell, HTTP API, project bootstrap, agent registry | Hosts BanyanCode slash commands, CLI subcommands, HTTP endpoints, and runtime setup |
| `tui` | Solid.js terminal UI built on OpenTUI primitives | Hosts BanyanCode tabs (`CHAT`, `SESSIONS`, `AGENTS`, `CONFIG`, `MEMORY`), sidebar/inspector widgets, and UI primitives |
| `sdk` | Generated JS client SDK (`@opencode-ai/sdk`) | Client SDK generated via `@hey-api/openapi-ts` from OpenCode API definitions |
| `llm` | AI SDK provider adapters and HTTP recorder | AI SDK provider configuration |
| `effect-drizzle-sqlite`, `effect-sqlite-node` | Generic SQLite bindings | Database integration bindings |
| `plugin` | Plugin authoring SDK | Plugin system |
| `server`, `console`, `storybook`, `app`, `web`, `desktop` | Upstream surfaces | Out of scope for BanyanCode |
| `stats` | Public download stats | Downstream package stats |

Build system: Turborepo on top of Bun (`bun turbo`). Tests run from individual package directories (e.g. `packages/opencode` or `packages/core`), never from the repository root.

## BanyanCode Identity Separation

BanyanCode is its **own product** that runs alongside OpenCode. The two products do not share file paths, environment variables, or configuration schemas.

| Concern | OpenCode | BanyanCode |
|---------|----------|------------|
| Per-project config file | `./opencode.json` | `./banyancode.json` |
| Per-project directory | `./.opencode/` | `./.banyancode/` |
| Global config | `~/.config/opencode/` | `~/.config/banyancode/` |
| Data directory | `~/.local/share/opencode/` | `~/.local/share/banyancode/` |
| DB filename | `opencode.db` | `banyancode-${workspaceTag}${channelSuffix}.db` |
| Env var prefix | `OPENCODE_*` | `BANYANCODE_*` |
| Config schema | `ConfigV1.Info` | `BanyanConfig.Info` |
| Service namespace | (n/a) | `Banyan.X.Service` |

Both products can be installed side-by-side. BanyanCode reads/writes only `banyancode.*` and `.banyancode/`; OpenCode reads/writes only its own paths. BanyanCode is enabled by default; set `BANYANCODE_ENABLE=0` to disable it, causing the binary to behave like upstream OpenCode.

Internal source code uses the `@opencode-ai/*` package namespace (e.g. `@opencode-ai/core/banyancode`), while user-facing surfaces (binary, install script, CLI commands, brand text) use BanyanCode.

## Project-Local `.banyancode/` Layout

When BanyanCode is enabled, it resolves or initializes `<project>/.banyancode/`:

```
<project>/.banyancode/
├── banyancode-<workspaceTag>.db   # libSQL/Turso DB (memory, codegraph, subagents, traces)
├── ignore                         # codegraph ignore patterns, one per line
├── agent/                         # custom subagent definitions (.md with frontmatter)
└── trace/                         # session trace logs (<sessionID>.jsonl)
```

### Path & Database Resolution (`packages/core/src/database/database.ts`):
- **Directory Discovery**: Searches up the directory tree for an existing `.banyancode/`. If not found, locates project root via markers (`.git`, `package.json`, `Cargo.toml`, etc.) and initializes `.banyancode/`. Falls back to `~/.local/share/banyancode/` if no project markers exist.
- **Workspace Hashing**: Project database files are named using a workspace root hash:
  `banyancode-${workspaceTag}${channelSuffix}.db` (where `workspaceTag = shortHash(process.cwd())`).
  This ensures multi-workspace isolation when multiple projects share a common root tree, preventing singleton `codegraph_meta` overwrites. Legacy pathing (`banyancode.db`) can be forced via `BANYANCODE_LEGACY_DB_PATH=1`.
- **Channel Suffixes**:
  - `latest` / `beta` / `prod` → `banyancode-${workspaceTag}.db`
  - Custom channels → `banyancode-${workspaceTag}-${channel}.db` (overridden via `OPENCODE_DISABLE_CHANNEL_DB=1`).

## Storage & Database Architecture

BanyanCode utilizes **Turso/libSQL** via `@libsql/client` (`packages/core/src/database/sqlite.libsql.ts`).

### Database Engine Configuration:
- **Journaling & Sync**: `WAL` journal mode, `NORMAL` synchronous mode, 64MB cache size, foreign keys enabled, 256MB memory-mapped I/O size, 8KB page size.
- **Features**: Native FTS5 full-text search virtual tables and `STRICT` tables with JSONB columns.

### Complete Table Inventory (`packages/core/src/database/schema/`):

| Table Name | Purpose | Key Features / Indexes |
|------------|---------|------------------------|
| `memory_entries` | Primary storage for cross-session memory entries | Denormalized columns (`kind`, `title`, `body`, `status`), JSONB tags/value |
| `memory_entries_fts` | FTS5 virtual table for memory search | BM25 full-text search over memory title and content |
| `codegraph_files` | File-level index metadata | File path, content hash, language, node/edge counts, `indexed_at` |
| `codegraph_nodes` | Indexed structural code symbols | Symbol name, kind, file path, line ranges, `is_entrypoint`, `in_degree` |
| `codegraph_edges` | Relationships between nodes | Source/target node IDs, edge kind (`calls`, `imports`, `tested_by`, etc.) |
| `codegraph_node_name_idx` | Standalone index on symbol names | Accelerates exact and prefix symbol lookups |
| `codegraph_meta` | Singleton workspace build metadata | Graph version, build timestamp, coverage, node/edge counts, `indexed_root` |
| `codegraph_traces` | Observed runtime execution traces | Observed tool calls, natural key dedup on session/event ID |
| `codegraph_service_tags` | Classification tags for codegraph nodes | Node tags (e.g. `service`, `component`, `route`) |
| `codegraph_parse_errors` | Diagnostics for indexing parse failures | File path, parser error message, timestamp |
| `subagent_messages` | Subagent mesh message queue | Peer messaging log with `delivered_at` consume markers |
| `subagent_plans` | Task execution plan tracking | Subagent plan state, status, step progression |

## Service Layer Architecture (`packages/core/src/banyancode/`)

The BanyanCode service layer comprises **25 Effect services** structured around the `Context.Service` pattern. Feature gating defaults to enabled (`BANYANCODE_ENABLE=1`); setting `BANYANCODE_ENABLE=0` swaps services for gated no-op implementations.

| Category | Service | Purpose | Key Dependencies |
|----------|---------|---------|------------------|
| **Config & FS** | `BanyanConfigService` | Reads/writes `banyancode.json` in global config or project root | `FSUtil` |
| | `MaxSubagentsService` | Reads and validates subagent limits (default 5, max 20) | `BanyanConfigService` |
| | `BanyanFilesystemService` | File watching and workspace filesystem operations | Effect `Queue` / `Stream` |
| **Codegraph** | `CodegraphRepo` | Drizzle CRUD for codegraph tables with `countNodes/Edges/Files` probes | `Database` |
| | `CodegraphIndexer` | Directory walker & parser (Tree-Sitter for TS/JS, Py, MD, Docker; regex fallback) | `CodegraphRepo`, `FSUtil` |
| | `CodegraphBuildService` | Manages build lifecycle, cancellation, force-kill, and event publishing | `CodegraphIndexer`, `EventV2` |
| | `CodegraphAutoUpdate` | Incremental background graph updating on file change events | `CodegraphIndexer`, `BanyanFilesystemService` |
| | `CodegraphStaleness` | Detects index drift between DB graph metadata and filesystem state | `CodegraphRepo`, `FSUtil` |
| | `CodegraphAnalyzer` | Computes L0/L1/L2/L3 structural layers, blast radius, and dependents | `CodegraphRepo` |
| | `SymbolResolver` | Performs target symbol resolution across exact, prefix, and fuzzy modes | `CodegraphRepo` |
| | `CodegraphSystemSource` | Formats and injects code graph context into system prompts | `CodegraphAnalyzer` |
| **Repo Intel** | `RepositoryIntelligence` | Stable 8-method surface (`query`, `explain`, `impact`, `trace`, `tests`, `symbols`, `relationships`, `ownership`) | `CodegraphRepo`, `Git` |
| | `Search` | Hybrid search engine (`searchAuto` cascading across Exact → Qualified → Prefix → Graph → BM25 → Fuzzy) | `CodegraphRepo` |
| | `StructuralQueries` | Tree-Sitter structural pattern matcher (routes, interfaces, overrides, imports, exports) | `CodegraphRepo` |
| | `Git` | `Banyan.$` wrapper over bundled `git` binary for history and ownership analysis | `Banyan.$` |
| **Memory** | `MemoryRepo` | Drizzle CRUD over `memory_entries` with JSONB payloads and FTS5 | `Database` |
| | `MemoryService` | Manages memory candidate lifecycle (`pending` → `active` / `superseded` / `rejected`) | `MemoryRepo` |
| | `MemoryExtractor` | LLM/rule pipeline for extracting memory candidates from conversation text | `MemoryRepo` |
| | `MemoryRetrieval` | Intent classification (`classifyQuery`) and hybrid ranking across FTS, tags, and recency | `MemoryRepo` |
| | `MemoryProjection` | Materializes memory entries into Project Summaries, Agent Notes, and Active Lists | `MemoryRepo` |
| | `MemoryHygiene` | Automated memory maintenance (expire, reconcile, prune) | `MemoryRepo` |
| | `MemorySignificance` | Multi-factor scoring model (`KEEP_THRESHOLD`, `MERGE_THRESHOLD`) | `MemoryRepo` |
| | `MemoryPayload` | Safe payload unwrapping (`unwrapMemoryValue`) and schema version envelope | none |
| **Subagent Mesh** | `SubagentMessagesRepo`, `SubagentPlansRepo` | Mesh message persistence and delivery tracking (`markDelivered`) | `Database` |
| | `SubagentBus`, `MeshCoordinator`, `SubagentConsumer` | Subagent dispatch, slot reservation, oldest-ended eviction, message loop processing | `SubagentMessagesRepo`, `MaxSubagentsService` |
| | `NestedSpawnRegistry` | Prevents runaway recursive subagent spawning by tracking call depth | none |
| **Telemetry & Monitor** | `SystemMonitorService` | Real-time hardware monitoring (CPU, RAM, GPU, VRAM) publishing to `banyancode.system.updated` | `AppProcess` |
| | `TraceCollector` | Audits tool execution events into `.banyancode/trace/<sessionID>.jsonl` and DB | `Database` |
| | `RuntimeCallGraph` | Evaluates observed runtime tool call traces against static code graph structures | `CodegraphRepo`, `TraceCollector` |
| | `EditPlanner` | Computes structural edit plans to predict impact before applying code changes | `CodegraphAnalyzer` |
| | `ToolTelemetry` | Monitors tool execution performance and quality diagnostics | `TraceCollector` |

Exports live in `packages/core/src/banyancode/index.ts` under both direct names (`CodegraphBuildService`) and namespace exports (`Banyan.CodegraphBuildService`).

## Code Graph & L0–L3 Layer Architecture

### Indexing Pipeline:
```
/codegraph-build (slash command) or opencode codegraph build (CLI)
  → CodegraphBuildService.start({ root, force, dbPath })
    → CodegraphIndexer.index({ root, force, onProgress })
      → Load ignore patterns (DEFAULT_IGNORED + .gitignore + .banyancode/ignore)
      → Walk directory, filter by supported extensions (.ts, .js, .py, .md, Dockerfile, etc.)
      → Parse via Tree-Sitter or regex fallback
      → Extract nodes (functions, classes, interfaces, routes, configs, tests) and edges
      → Upsert into CodegraphRepo with file hashes, entrypoint signals, and in-degree counts
      → Publish BuildEvent progress to TUI / CLI listeners
```

### L0/L1/L2/L3 Layer Structure:
- **L0 Symbol (Current)** — focused target node, fixed at center in graph view
- **L1 Callers (Direct)** — nodes with direct incoming edges (`calls`, `references`) to L0
- **L2 Impact (Transitive)** — full blast radius: all reachable upstream and downstream nodes
- **L3 Dependents (Reverse)** — reverse graph walk from L0

Computed by `CodegraphAnalyzer` using `bfsPure` (`packages/core/src/banyancode/repository-intelligence/bfs.ts`) with batched SQL queries (`edgesFromBatch` / `edgesToBatch`) and direction-specific edge allowlists.

## Subagent Mesh & Parallel Orchestration

- **`orchestrator` Agent**: Registered by `packages/opencode/src/agent/agent.ts`. Its prompt dynamically injects `{{maxSubagents}}` rendered from `BanyanConfig.banyancode_max_subagents` (default 5, max 20).
- **Parallel Dispatch**: Decomposes tasks into sub-tasks and uses `MeshCoordinator` for parallel `Effect.forkIn(scope, ...)` execution across subagents (`coder`, `explore`, `researcher`, `scout`, `general`).
- **Runtime Capacity & Eviction Policy**: `MeshCoordinator.tryReserveSubagentSlot` enforces the maximum active subagent cap:
  1. If at capacity, finds the oldest subagent that has completed its task (idle > 60s).
  2. If found, evicts it via `kill({ reason: "evicted-by-new-spawn" })` and assigns the slot.
  3. If no evictable subagent exists, refuses spawn and returns an actionable error message.
- **Subagent Communication**: Inter-agent messages pass through `SubagentBus` (persisted in SQLite `subagent_messages`). `SubagentConsumer` runs a per-session message processing loop that calls `markDelivered` on each row to guarantee at-least-once processing without duplication.

## Terminal UI Architecture (`packages/tui/`)

The TUI is a Solid.js terminal application built using OpenTUI primitives.

### Tab Navigation (5 Active Tabs):

The session view routes main content through slots driven by the `activeTab` signal (`packages/tui/src/feature-plugins/tabs/`):

1. **`CHAT` (`"chat"`)**: Main interactive prompt input and conversation scrollbox (default).
2. **`SESSIONS` (`"sessions"`)**: Tree view of root sessions and subagent sessions with inline title editing (`sdk.client.session.update`), continue, rename, and delete actions.
3. **`AGENTS` (`"agents"`)**: Visual hierarchy tree of the subagent session network with parent-child connections, status indicators, token usage, sparklines, and magnitude percentage bars (`tab-agent-tree.tsx`).
4. **`CONFIG` (`"config"`)**: Subagent management and prompt editor (`tab-agents.tsx`). Toggles subagent orchestration, provides agent model selector dialogs (`DialogModel`), and system prompt customization.
5. **`MEMORY` (`"memory"`)**: Cross-session memory entry manager (`tab-memory.tsx`). Filters by scope (`global` / `session`), status (`active`, `pending`, `superseded`), and kind; provides memory detail modals (`DialogAlert`), and actions (`promote`, `reject`, `forget`).

*Note: `tab-graph.tsx` (Obsidian-style force-directed graph tab powered by `d3-force`) is authored on disk but currently unregistered in `builtins.ts`.*

### Sidebar Widgets (`packages/tui/src/feature-plugins/sidebar/`):

- **Registered in `builtins.ts`**:
  - `agents.tsx` — active subagents and mesh status (`banyancode.mesh.status`).
  - `performance.tsx` — LLM execution metrics (TTFT, output tokens, tokens/sec).
  - `context.tsx` — directory path and session context metadata.
  - `system-status.tsx` — CPU, Memory, Disk, and GPU/VRAM hardware health bars (<60% green, <85% yellow, >85% red), subscribed to `banyancode.system.updated`.
  - `mcp.tsx` — Model Context Protocol connection status.
  - `files.tsx` — attached files and active open file contexts.
  - `footer.tsx` — sidebar footer control bar.
- **Authored but Unregistered**: `intel-trace-panel.tsx` (repository intel traces), `codegraph-panel.tsx` (L0–L3 counts and `/codegraph-build` status), `codegraph-intel-panel.tsx`, `agent-tree.tsx`, `codebase-tree.tsx`, `lsp.tsx`, `todo.tsx`.

### Inspector Widgets (`packages/tui/src/feature-plugins/inspector/`):

- **Registered in `builtins.ts`**:
  - `agent-details.tsx` — current agent status, task, model, tools, memory, and last message.
  - `todo.tsx` — active task todo list.
- **Authored but Unregistered**: `graph-explorer.tsx` (L0–L3 layer symbol explorer tree), `pending-actions.tsx` (pending sessions, permission requests, and agent questions).

### Reusable UI Primitives (`packages/tui/src/ui/`):

- `accordion.tsx` — collapsible headers with `▼` / `▶` chevrons and keyboard support.
- `toggle-switch.tsx` — boolean toggle switch rendering `[● ON]` / `[○ OFF]`.
- `number-input.tsx` — numeric input with click-to-edit, min/max clamping, and `Escape` cancellation.
- `dialog.tsx` — modal container using opaque `theme.background` backdrop (preventing underlying text bleeding), focus restoration, and `Escape` / `Ctrl+C` dismissal.
- `dialog-select.tsx` — single-select picker modal.
- `dialog-multi-select.tsx` — searchable multi-select modal picker with category headers (used for tool selection).
- `empty-state.tsx` — standardized empty/loading/error state container with custom glyphs (`◌`, `∅`, `✗`), title, hint, and action buttons.
- `tokens.ts` — design token definitions (`space`, `density`, `fontWeight`, `glyph`, `separator`).
- `border.ts` — border styles (`RoundedBorder`, `SplitBorder`).

### Event Listener Safety:
Every `useEvent().on(...)` and `event.on(...)` subscription in TUI components is strictly paired with `onCleanup(unsub)` or `onCleanup(() => unsubs.forEach(...))` to prevent listener leaks across tab switches and remounts.

## HTTP API Specification

HTTP endpoints added by BanyanCode (`packages/opencode/src/server/routes/instance/httpapi/`):

### Config, Overrides & Agent Authoring (`groups/global.ts` & `handlers/global.ts`):
- `GET /global/banyan-config` — read `BanyanConfig.Info`
- `PATCH /global/banyan-config` — update configuration
- `PATCH /global/banyan-agent-override` — update agent overrides
- `PATCH /global/banyan-agent-prompt` — update agent system prompts
- `POST /global/banyan-agent/save` — save subagent definition to `.banyancode/agent/<name>.md` (strictly validated against `^[a-zA-Z0-9._-]+$` with path-traversal containment checks)

### Codegraph & Refactoring Endpoints:
- `POST /global/codegraph-build` — start background index build
- `POST /global/codegraph-cancel` — interrupt active build
- `POST /global/codegraph-force-kill` — force-kill wedged build (Fiber interrupt + `taskkill` on Windows)
- `POST /global/codegraph-remove` — clear index (`dropFile: true` unlinks DB file)
- `GET /global/codegraph-nodes` — inspect codegraph nodes
- `GET /global/codegraph-edges` — inspect codegraph edges
- `POST /global/preflight` — preflight code change check
- `POST /global/blast-radius` — evaluate blast radius before editing
- `POST /global/safe-rename` — perform safe symbol refactoring

### Repository Intelligence Wave 2 (`groups/repository-intel.ts` & `handlers/repository-intel.ts`):
- `POST /global/repository/query` — unified repository search
- `POST /global/repository/explain` — ArchitecturalSlice for symbol
- `POST /global/repository/impact` — slice expanded with file dependents
- `POST /global/repository/trace` — downstream entrypoint trace
- `POST /global/repository/tests` — tests referencing symbol
- `POST /global/repository/symbols` — exact/prefix symbol lookup
- `POST /global/repository/relationships` — BFS walk from node ID
- `POST /global/repository/ownership` — primary Git author for path
- `GET /global/repository/architectural-slice` — fetch architectural slice

### Cross-Session Memory (`groups/memory.ts` & `handlers/memory.ts`):
- `POST /global/memory/list` — list memory entries
- `POST /global/memory/get` — get memory entry by ID
- `POST /global/memory/recall` — exact key match lookup
- `POST /global/memory/search` — FTS5 memory search
- `POST /global/memory/store` — store/update memory entry
- `POST /global/memory/forget` — remove memory entry
- `POST /global/memory/candidates` — list memory candidates
- `POST /global/memory/promote` — promote candidate
- `POST /global/memory/reject` — reject candidate
- `POST /global/memory/summary` — summarize memory state

### Web Search & Mesh Lifecycle:
- `POST /global/websearch-free` — free DuckDuckGo HTML web search
- `GET /global/mesh/status` — read subagent mesh status
- `POST /global/startup` — trigger server startup tasks

## CLI Subcommands

Top-level subcommands registered in `packages/opencode/src/index.ts`:

### `opencode codegraph ...` (`packages/opencode/src/cli/cmd/codegraph.ts`)
- `build [--root PATH] [--force] [--watch] [--timeout N]` — start build with TTY progress streaming
- `status` — inspect build state
- `cancel` — cancel active build
- `remove [--drop-file]` — clear index (or delete DB file)
- `force-kill` — interrupt wedged build
- `path` — print resolved `banyancode.db` path
- `trace --session <id> [--limit N]` — tail `.banyancode/trace/<sessionID>.jsonl`

### `opencode repository ...` (`packages/opencode/src/cli/cmd/repository.ts`)
- `query <query> [--limit N]` — unified repository search
- `explain <symbol>` — ArchitecturalSlice for symbol
- `trace <symbol> [--depth N]` — downstream entrypoints
- `impact <path>` — dependents of a file
- `tests <symbol>` — tests referencing symbol
- `relationships <nodeID> [--depth N]` — BFS walk from node ID
- `ownership <path>` — primary Git author for path

### `opencode memory ...` (`packages/opencode/src/cli/cmd/memory.ts`)
- `list [--scope SCOPE] [--status STATUS] [--kind KIND] [--limit N]` — list memory entries
- `get <id>` — retrieve memory entry by ID
- `search <query> [--limit N] [--scope SCOPE] [--kind KIND]` — FTS5 BM25 memory search
- `recall <key> [--scope SCOPE]` — exact key lookup
- `store <key> <value> [--scope SCOPE] [--tags TAGS]` — store/update entry
- `forget --id ID | --key KEY` — remove memory entry
- `candidates list | approve <id> | reject <id>` — manage memory candidate lifecycle
- `vacuum` — purge expired memory rows
- `sweep [--scope SCOPE]` — execute hygiene sweep (expire → reconcile → prune)

### `opencode websearch-free <query> [--num N]` (`packages/opencode/src/cli/cmd/websearch-free.ts`)
- Free DuckDuckGo HTML scraping without API keys.

### Debugging & Tools:
- `opencode tools [--category CAT]` — inspect registered vs materialized tools and report catalog drift
- `opencode db [query] [--format tsv|json]` / `opencode db path` — interactive SQLite shell or direct SQL execution against workspace DB

## Slash Commands

Server-side slash commands (`packages/opencode/src/command/index.ts`):

- `/codegraph-build [root] [--force]` — executes background build with progress polling
- `/codegraph-remove` — clears `codegraph_*` tables
- `/repository-query <query>` — uniform repository query
- `/repository-explain <symbol>` — ArchitecturalSlice for symbol
- `/repository-trace <symbol>` — downstream entrypoint trace
- `/repository-impact <path>` — dependents of file
- `/repository-tests <symbol>` — tests referencing symbol
- `/repository-symbols <query>` — symbol search
- `/repository-relationships <nodeID>` — BFS walk from node ID
- `/repository-ownership <path>` — Git author ownership
- `/websearch-free <query>` — DuckDuckGo web search
- `/yolo` — toggles YOLO permissionless mode (`banyancode_yolo_mode`)
- `/max-subagents [1-20]` — views or sets max subagents limit
- `/lsp [on|off|toggle]` — toggles LSP integration
- `/import <path>` — imports transcript file into active session
- `/init`, `/review`, `/refresh-models` — inherited upstream commands

## Server Runtime & Permission Bridge

Defined in `packages/opencode/src/effect/`:

- **`AppRuntime` (`app-runtime.ts`)**:
  - Initializes Effect service layer and registers 6 event bridges (`applyCodegraphBuildBridge`, `applyCodegraphAutoUpdateBridge`, `applyFilesystemBridge`, `applyMemoryBridge`, `applyMeshBridge`, `applySystemMonitorBridge`).
  - **Startup Catch-Up Indexing**: On startup, compares file `mtime` against DB `indexedAt` timestamps to automatically re-index files modified while the server was offline.
  - **Tool Catalog Drift Check**: Enforces `registered === materialized` tool counts at startup and terminates process if drift is detected.
- **`PermissionBridge` (`permission-bridge.ts`)**:
  - Bridges `PermissionV2.Service` (Effect-native) to `Permission.Service` (V1).
  - Automatically grants permission (`effect: allow`) without user prompts for BanyanCode actions: `codegraph_*`, `repository_*`, `edit_plan`, `code_find`, `websearch_free`.

## Build System, SDK, and Publishing Pipeline

### 11-Target Platform Matrix
BanyanCode compiles into single-file binary executables across **11 target architectures**:
`linux-x64`, `linux-x64-baseline`, `linux-x64-musl`, `linux-x64-baseline-musl`, `linux-arm64`, `linux-arm64-musl`, `darwin-x64`, `darwin-x64-baseline`, `darwin-arm64`, `windows-x64`, `windows-x64-baseline`.
*(Note: `win32-arm64` is intentionally excluded because `@libsql` does not publish a native N-API binding for `win32-arm64-msvc`.)*

### Bun Compilation & Embedded Assets (`packages/opencode/script/build.ts`)
- **Native libSQL Embedding (`createLibsqlPlugin`)**: Patches `@libsql/client` `requireNative()` calls to static imports (e.g. `@libsql/win32-x64-msvc`), enabling Bun single-file compilation to embed `.node` N-API binary bindings directly inside the single executable.
- **Embedded Web UI (`createEmbeddedWebUIBundle`)**: Bundles `packages/app` into `opencode-web-ui.gen.ts` via `with { type: "file" }` imports.
- **Binary Smoke Verification**: Runs `banyancode --version` and launches native targets in a temp environment for 2.5 seconds to verify `turso.schema` initialization and ensure `dlopen` of embedded native bindings succeeds.

### Publishing & Installation (`packages/opencode/script/publish.ts` & `postinstall.mjs`)
- **NPM-Only Pipeline**: Releases ship strictly to NPM under tag `latest`. Homebrew tap and AUR pushes are explicitly out of scope.
- **`publish.ts` Idempotency**: Checks `npm view <name>@<version>` before publishing to prevent duplicate publish failures.
- **Umbrella Wrapper & `postinstall.mjs`**: The `banyancode` umbrella package contains `postinstall.mjs` and `bin/banyancode.exe` fallback shim. On installation, `postinstall.mjs` probes CPU AVX2 support (`/proc/cpuinfo`, `sysctl`, `IsProcessorFeaturePresent`) and libc (`glibc` vs `musl`), links the optimal binary from `optionalDependencies`, and falls back to a temporary `npm install` if optional dependencies were ignored by the package manager.
- **Windows Code-Signing (`.github/workflows/publish.yml`)**: Optional Azure Trusted Signing step (`sign-windows` job) for Windows binaries; falls back to unsigned binaries with a workflow warning annotation if Azure credentials are missing.

### SDK Build Pipeline (`packages/sdk/js/script/build.ts`)
- Generates OpenAPI spec from `packages/opencode`.
- Uses `@hey-api/openapi-ts` to generate TypeScript client code (`src/v2/gen`).
- Applies codegen patch to `types.gen.ts` (corrects `TError` parameter in `ServerSentEventsResult` to default `TReturn` to `void`).
- Compiles declarations and JS artifacts via `tsc`.

## Testing Guidelines & Execution Conventions

- **Root Execution Guard**: Root `package.json` enforces `"test": "echo 'do not run tests from root' && exit 1"`. Tests MUST be run from package directories (e.g., `packages/opencode` or `packages/core`).
- **Test Preload Isolation (`packages/opencode/test/preload.ts`)**:
  - Sets PID-isolated XDG environment paths before importing source files.
  - Clears all LLM provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) to prevent test leakage.
  - Configures `OPENCODE_DB=":memory:"`.
  - Implements `afterAll` cleanup with retry loops to resolve Windows SQLite WAL file handle locking (`EBUSY`).
- **`Database.layerFromPath(tmpDbPath)` Requirement**:
  - Services depending on `Database.Service` (`MemoryRepo`, `CodegraphRepo`, `SubagentMessagesRepo`, `SubagentPlansRepo`) MUST explicitly receive `Database.layerFromPath(tmpDbPath)` in tests (e.g. `MemoryRepo.defaultLayer.pipe(Layer.provide(dbLayer))`).
  - *Warning*: Omitting this causes tests to fall back to the global user database (`~/.local/share/banyancode/banyancode.db`) and fail.
- **Deterministic Synchronization**:
  - Avoid fixed sleep hacks (`Effect.sleep`). Use readiness signals (`pollWithTimeout`, `awaitWithTimeout`, `Deferred`).

## Versioning Conventions

- **CalVer Standard**: `YY.MM.PATCH` (e.g. `26.07.4`). Git tags use the `v` prefix (`v26.07.4`); NPM drops leading zeros (`banyancode@26.7.4`).
- **Single Source of Truth**: `packages/opencode/package.json` `version` field.
- **Tag Format**: Annotated git tags (`git tag -a v26.07.4 -m "BanyanCode 26.07.4"`).
