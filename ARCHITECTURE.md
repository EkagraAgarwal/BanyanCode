# BanyanCode Architecture

This document describes how BanyanCode is structured on disk, how the runtime layers compose, and where to find things in the codebase.

## Overview

BanyanCode is a CLI/TUI-only fork of [OpenCode](https://github.com/anomalyco/opencode) that adds seven core capabilities:

1. **Orchestrator + Subagent Mesh** — a primary `orchestrator` agent decomposes complex tasks and **mandatorily fans out to parallel subagents** (`coder`, `explore`, `researcher`, `scout`, `reviewer`; legacy `general` removed). Fan-out is governed by a user-configurable hard limit (`banyancode_max_subagents`, default 5, max 20) and an idle-eviction policy.
2. **Advanced Cross-Session Memory Subsystem** — a multi-tiered persistent memory engine featuring candidate extraction (deterministic rule gate, no LLM), intent classification, FTS5 BM25 retrieval with a trigram tokenizer, automated hygiene (expire/reconcile/prune), structured on-demand projections, and root-session write scoping.
3. **Tree-Sitter Code Graph** — a code graph indexer (`/codegraph-build`) backed by libSQL, supporting Tree-Sitter parsing (TypeScript, Python, Markdown, Dockerfiles) and regex fallbacks, with git-semantics ignore handling, parallel walking, auto-rebuild readiness (`CodegraphReadiness`), and session-start bootstrap (`CodegraphBootstrap`).
4. **Researcher Agent with Free Web Search** — a `researcher` subagent backed by DuckDuckGo HTML scraping (`websearch_free`), requiring no API keys.
5. **Repository Intelligence — the Canonical Search Interface** — a 9-method public surface (`query`, `slice`, `explain`, `impact`, `trace`, `tests`, `symbols`, `relationships`, `findOwner`) returning typed `RepositoryContext` / `ArchitecturalSlice` results. `banyan_repo_map` was removed; repository tools are the canonical first-class search surface for any source-code question.
6. **Goal Loop** — the orchestrator drives a per-session goal lifecycle (`goal` tool: set/status/list/record_review/complete/block/cancel) with iteration tracking and reviewer verdicts (`pass | fail | blocked`).
7. **Verifier ("did I break it?")** — a `banyan_test` / `banyan_typecheck` / `banyan_lint` surface that shells out to the project's own runners, caches results by content hash, and persists structured runs to `verification_runs`.

Upstream desktop, web, app, and Storybook packages are explicitly out of scope. BanyanCode is a sequence of additions to OpenCode, not a full rewrite.

## Repo Layout

The repo is a Bun workspace composed of packages under `packages/`:

| Package | Purpose | BanyanCode Role |
|---------|---------|-----------------|
| `core` | Effect services, database driver, plugins, tool framework, BanyanCode service layer | Hosts the `Banyan.*` service namespace (38 Effect services + helpers), libSQL driver, and tools |
| `opencode` | CLI binary (`banyancode`), command shell, HTTP API, project bootstrap, agent registry | Hosts BanyanCode slash commands, CLI subcommands, HTTP endpoints, bridges, and runtime setup |
| `tui` | Solid.js terminal UI built on OpenTUI primitives | Hosts BanyanCode tabs (`CHAT`, `SESSIONS`, `AGENTS`, `CONFIG`, `MEMORY`), sidebar/inspector/header/system widgets, and UI primitives |
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
├── banyancode-<workspaceTag>.db   # libSQL/Turso DB (memory, codegraph, subagents, goals, traces)
├── ignore                         # codegraph ignore patterns, one per line
├── agent/                         # custom subagent definitions (.md with frontmatter)
└── trace/                         # session trace logs (<sessionID>.jsonl)
```

### Path & Database Resolution (`packages/core/src/database/database.ts` + `packages/core/src/database/banyan-db-path.ts`):
- **Directory Discovery**: Searches up the directory tree for an existing `.banyancode/`. If not found, locates project root via markers (`.git`, `package.json`, `Cargo.toml`, etc.) and initializes `.banyancode/`. Falls back to `~/.local/share/banyancode/` if no project markers exist.
- **Workspace Hashing**: Project database files are named using a workspace root hash:
  `banyancode-${workspaceTag}${channelSuffix}.db` (where `workspaceTag = shortHash(process.cwd())`).
  This ensures multi-workspace isolation when multiple projects share a common root tree, preventing singleton `codegraph_meta` overwrites. Legacy pathing (`banyancode.db`) can be forced via `BANYANCODE_LEGACY_DB_PATH=1`.
- **Channel Suffixes**:
  - `latest` / `beta` / `prod` → `banyancode-${workspaceTag}.db`
  - Custom channels → `banyancode-${workspaceTag}-${channel}.db` (overridden via `OPENCODE_DISABLE_CHANNEL_DB=1`).
- **Canonical Root Derivation (`WorkspaceIdentity`, `packages/core/src/banyancode/workspace-identity.ts`)**: codegraph build and repository tools operate on an *explicit root* rather than `process.cwd()`. `identityForRoot` realpath-canonicalizes the root (case-folded on win32) and derives the same DB path the server uses, so a build bound to an explicit root and a server started from that root open the same SQLite file. `diagnosisFromMeta` stamps `in-scope` / `out-of-scope` / `no-graph` signals onto repository-tool results.

## Storage & Database Architecture

BanyanCode utilizes **Turso/libSQL** via `@libsql/client` (`packages/core/src/database/sqlite.libsql.ts`).

### Database Engine Configuration:
- **Journaling & Sync**: `WAL` journal mode, `NORMAL` synchronous mode, 64MB cache size, foreign keys enabled, 256MB memory-mapped I/O size, 8KB page size.
- **Features**: Native FTS5 full-text search virtual tables and `STRICT` tables with JSONB columns.
- **Schema & Migrations**: Drizzle table definitions live as `*.sql.ts` files next to their services (`packages/core/src/banyancode/*.sql.ts`, e.g. `memory.sql.ts`, `subagent-goals.sql.ts`, `verification.sql.ts`). Database migrations live in `packages/core/src/database/migration/*.ts` — the `20260621120000_libsql_fresh.ts` baseline creates all core tables, and incremental migrations (e.g. `20260809120000_memory_entries_fts_trigram.ts`, `20260804120000_codegraph_tool_usage.ts`) are applied on startup.

### Complete Table Inventory (BanyanCode tables):

| Table Name | Purpose | Key Features / Indexes |
|------------|---------|------------------------|
| `memory_entries` | Primary storage for cross-session memory entries | Denormalized columns (`kind`, `title`, `body`, `status`), JSONB `value` envelope, `version` (optimistic concurrency), `session_id` |
| `memory_entries_fts` | FTS5 virtual table for memory search | **Trigram tokenizer** over `(key, title, body, kind)`, BM25 ranking |
| `codegraph_files` | File-level index metadata | File path, content hash, language, node/edge counts, `indexed_at` |
| `codegraph_nodes` | Indexed structural code symbols | Symbol name, kind, file path, line ranges, `is_entrypoint`, `in_degree` |
| `codegraph_edges` | Relationships between nodes | Source/target node IDs, edge kind (`imports`, `calls`, `extends`, `references`, `tested_by`, `configured_by`, `built_by`, `mounts`, `generated_from`) |
| `codegraph_meta` | Singleton workspace build metadata | Graph version, build timestamp, coverage, node/edge counts, `indexed_root` |
| `codegraph_traces` | Observed runtime execution traces | Observed tool calls, natural key dedup on session/event ID, time bucketing |
| `codegraph_service_tags` | Classification tags for codegraph nodes | Node tags (e.g. `service`, `component`, `route`) |
| `codegraph_parse_errors` | Diagnostics for indexing failures | File path, error message, timestamp (records Effect failures — regex parsers never throw on syntax errors) |
| `codegraph_tool_usage` | Per-tool invocation counters | `tool_id` PK, `use_count`, `last_used_at`, optional `session_id`; drives hot-tier promotion in the adapted catalog |
| `subagent_messages` | Subagent mesh message queue | Peer messaging log with `delivered_at` consume markers |
| `subagent_plans` | Task execution plan tracking | Subagent plan state, status, step progression |
| `subagent_goals` | Orchestrator goal loop state | `condition`, `plan_path`, `priority`, `status` (active → achieved/blocked/cancelled), `iteration_count`, `last_review_*`, parent-session indexes |
| `subagent_review_requests` | Cross-runtime review dispatch queue | `target_agent`, `status` (pending → dispatched → completed/failed), `result` JSONB; the 2s DB poll bridges runtime boundaries |
| `verification_runs` | Durable verifier run records | `kind` (typecheck/test/lint/compile), `status` (running/passed/failed/errored), `summary` JSONB, `raw_output`, `cache_key` (1h TTL) |

## Service Layer Architecture (`packages/core/src/banyancode/`)

The BanyanCode service layer comprises **38 Effect services** structured around the `Context.Service` pattern, plus pure helper modules (`MemorySignificance`, `MemoryPayload`, `graph-staleness`, `WorkspaceIdentity`, `NestedSpawnRegistry`). Feature gating defaults to enabled (`BANYANCODE_ENABLE=1`); setting `BANYANCODE_ENABLE=0` swaps services for gated no-op implementations.

| Category | Service | Purpose | Key Dependencies |
|----------|---------|---------|------------------|
| **Config & FS** | `BanyanConfigService` | Reads/writes `banyancode.json` in global config or project root | `FSUtil` |
| | `MaxSubagentsService` | Reads and validates subagent limits (default 5, max 20) and nested-spawn caps | `BanyanConfigService` |
| | `BanyanFilesystemService` | File watching and workspace filesystem operations | Effect `Queue` / `Stream` |
| **Codegraph** | `CodegraphRepo` | Drizzle CRUD for codegraph tables with `countNodes/Edges/Files` probes | `Database` |
| | `CodegraphIndexer` | Directory walker & parser (Tree-Sitter for TS/JS, Py, MD, Docker; regex fallback) with git-semantics ignore handling and parallel walking | `CodegraphRepo`, `FSUtil` |
| | `CodegraphBuildService` | Manages build lifecycle, cancellation, force-kill, and event publishing | `CodegraphIndexer`, `EventV2` |
| | `CodegraphReadiness` | Persisted readiness derivation (`missing`/`stale`/`ready`/`building`/`failed`) + auto-rebuild trigger on staleness thresholds | `CodegraphRepo` |
| | `CodegraphBootstrap` | Non-blocking session-start graph kick (once per root) and prompt "Graph state:" stamp | `CodegraphReadiness` |
| | `CodegraphAutoUpdate` | Incremental background graph updating on file change events | `CodegraphIndexer`, `BanyanFilesystemService` |
| | `CodegraphAnalyzer` | Computes L0/L1/L2/L3 structural layers, blast radius, and dependents via `bfsPure` | `CodegraphRepo` |
| | `SymbolResolver` | 5-step target resolution: tag-fallback → name-exact → qualified-split → scoped FTS-BM25 → code-substring/name-like | `CodegraphRepo` |
| | `CodegraphSystemSource` | Formats and injects code graph policy + tool guide into system prompts (V1 + V2 seams) | `CodegraphAnalyzer` |
| **Repo Intel** | `RepositoryIntelligence` | 9-method surface (`query`, `slice`, `explain`, `impact`, `trace`, `tests`, `symbols`, `relationships`, `findOwner`) returning `RepositoryContext` / `ArchitecturalSlice` | `CodegraphRepo`, `Git`, `Search` |
| | `Search` | Search cascade: Exact → Qualified → Prefix → Graph → BM25 → Fuzzy (`CASCADE_ORDER`) | `CodegraphRepo` |
| | `StructuralQueries` | Tree-Sitter structural pattern matcher (routes, interfaces, overrides, imports, exports) | `CodegraphRepo` |
| | `Git` | `Banyan.$` wrapper over bundled `git` binary for history and ownership analysis | `Banyan.$` |
| | `AdaptedCatalog` | Tiered tool catalog (`hot`/`warm`/`cold`): hot = explicitly permitted or used in last 24h; warm = public; cold = rest | `Database`, `ToolRegistry` |
| **Memory** | `MemoryRepo` | Drizzle CRUD over `memory_entries` with JSONB payloads, versioned upserts, and FTS5 BM25 | `Database` |
| | `MemoryService` | Manages memory candidate lifecycle (`pending` → `active` / `superseded` / `rejected` / `expired`); promote is a single transaction with version CAS | `MemoryRepo` |
| | `MemoryExtractor` | Deterministic pre-emit gate (keep/merge/summarize/discard) — no LLM | `MemoryRepo` |
| | `MemoryRetrieval` | Intent classification (`classifyQuery`: code-centric/history/preference/continuation) + FTS BM25 retrieval with JS re-rank (`rankTotal`) | `MemoryRepo` |
| | `MemoryProjection` | On-demand projections: `projectSummary`, `activeDecisions`, `activeWarnings`, `recentChanges`, `openTodos`, `agentWorkingNotes`, `decisionDigest`, `warningDigest` | `MemoryRepo` |
| | `MemoryHygiene` | Automated memory maintenance: `expire` → `reconcile` (fingerprint dedupe) → `prune`; `sweep` composes all three | `MemoryRepo` |
| | `MemorySignificance` | Multi-factor scoring model (`KEEP_THRESHOLD`, `MERGE_THRESHOLD`) — pure functions | none |
| | `MemoryPayload` | Safe payload unwrapping (`unwrapMemoryValue`) and versioned JSONB envelope (`{ _v: 1, data }`) with legacy-shape fallback | none |
| **Goal Loop** | `GoalRepo` | CRUD over `subagent_goals` | `Database` |
| | `GoalService` | `setGoal` (auto-cancels stale active goal in one transaction), `getActiveGoal`, `listGoals`, `recordReviewVerdict` (increments iteration), `achieve`/`block`/`cancel`, events queue (`banyancode.goal.*`) | `GoalRepo`, `Database` |
| **Subagent Mesh** | `SubagentMessagesRepo`, `SubagentPlansRepo` | Mesh message persistence and delivery tracking (`markDelivered`) | `Database` |
| | `SubagentReviewRequestsRepo` | Review request persistence with conditional `pending → dispatched` transition (safe under concurrent queue + DB-poll paths) | `Database` |
| | `SubagentBus`, `MeshCoordinator`, `SubagentConsumer` | Subagent dispatch, slot reservation with idle eviction, at-least-once message loop processing (`Effect.forkDetach`) | `SubagentMessagesRepo`, `MaxSubagentsService` |
| | `NestedSpawnRegistry` | Prevents runaway recursive subagent spawning (1 concurrent / 5 per hour nested explore per coder) | none |
| **Verifier** | `VerificationRepo` | CRUD over `verification_runs` with `findByCacheKey` | `Database` |
| | `VerifierService` | `typecheck`/`test`/`lint`/`compile` shell-outs, content-hash cache keys (1h TTL), 64KB tail truncation, semaphore-bounded concurrency (4) | `AppProcess`, `BanyanConfigService`, `VerificationRepo` |
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
  → CodegraphBuildService.start({ root, force })
    → CodegraphIndexer.index({ root, force, onProgress })
      → Load ignore patterns (DEFAULT_IGNORED + nested .gitignore + .banyancode/ignore)
      → Walk directory (parallel subdir traversal, concurrency 8), filter by supported extensions
      → Parse via Tree-Sitter or regex fallback (bounded body scans, line-offset cache)
      → Extract nodes (functions, classes, interfaces, routes, configs, tests) and edges
      → Upsert into CodegraphRepo with file hashes, entrypoint signals, and in-degree counts
      → Publish BuildEvent progress to TUI / CLI listeners
```

### Ignore Semantics (gitignore rewrite, commit `012aa2368`):
- Nested `.gitignore` files are compiled per build with git-style semantics: basename matches at any depth, anchored `/` prefixes, dir-only trailing `/`, `!` negation, `**` globs; last-match-wins (`evaluatePatterns`).
- `.banyancode/ignore` (inside `.banyancode/`, not the project root) adds user patterns; `DEFAULT_IGNORED` covers `*.db*`, `*.lock`, etc.; upstream product dirs (`packages/web|app|desktop|storybook`) and generated SDK outputs are excluded.

### Skip Accounting:
Nine explicit skip-reason buckets are tracked as per-bucket `Ref<number>` counters incremented at the exact decision site: `gitignored`, `banyanignored`, `artifact`, `tooLarge`, `minified`, `tooLargeParse`, `cached`, `readError`, `parseFailure`. `result.skipped` is the explicit sum of all buckets — never a residual. `eligibleFiles = codeFiles + skippedBySize` is the coverage denominator.

### Readiness, Auto-Build & Bootstrap:
- **`CodegraphStaleness`** (`packages/core/src/banyancode/graph-staleness.ts`, pure `isStale`): age > 1 day (medium) / 7 days (high) or coverage < 0.5 (high).
- **`codegraph_staleness` tool** detects drift two ways: `staleFiles` (mtime > `indexed_at`) and `missingFiles` (indexed paths deleted from disk — ghost rows that only a rebuild prunes; mtime-based checks alone miss them).
- **`CodegraphReadiness.ensureReady`** auto-triggers a background build when the graph is missing or past the high-staleness threshold, with canonical-root comparison (realpath + win32 case-fold) so symlink/junction spellings of the same workspace never force a rebuild.
- **`CodegraphBootstrap`** runs on session start: kicks one non-blocking build per root and exposes `status()` that the system-prompt renderer stamps as a "Graph state:" line.
- **Startup catch-up indexing**: on server start, files whose mtime > `indexed_at` are re-indexed; a poisoned `indexed_root` at the filesystem root is refused.

### L0/L1/L2/L3 Layer Structure:
- **L0 Symbol (Current)** — focused target node, fixed at center in graph view
- **L1 Callers (Direct)** — nodes with direct incoming edges (`calls`, `references`) to L0
- **L2 Impact (Transitive)** — full blast radius: all reachable upstream and downstream nodes
- **L3 Dependents (Reverse)** — reverse graph walk from L0

Computed by `CodegraphAnalyzer` (`callers`, `dependents`, `impact`, `walkTransitive`) using `bfsPure` (`packages/core/src/banyancode/repository-intelligence/bfs.ts`) with batched SQL queries (`edgesFromBatch` / `edgesToBatch`) and direction-specific edge allowlists.

### Parse-Error Caveat:
The TypeScript/Python parsers in `packages/core/src/banyancode/langs/` are pure regex — they silently produce empty node lists for malformed input and never raise. `codegraph_parse_errors` therefore records Effect failures (e.g. DB write errors), not syntax errors. `parseErrors.length === 0` does NOT mean the code parsed correctly.

## Repository Intelligence (Canonical Search Interface)

Since commit `925521965` (removal of `banyan_repo_map`), repository intelligence is the **canonical search surface** for any source-code question — repository tools are always preferred over grep/glob/bash primitives.

### Public Surface (`packages/core/src/banyancode/repository-intelligence/service.ts`):
`query`, `slice`, `explain`, `impact`, `trace`, `tests`, `symbols`, `relationships`, `findOwner` (the doc's old "ownership" is `findOwner`, delegating to `git.owners`). `slice` (RepositoryContext → ArchitecturalSlice) is the 9th method. The old `repository_slice` tool was retired — `repository_explain` supersedes it.

### `repository_query` Semantics:
Returns a `RepositoryContext`: `status, reason, recoveryHint, degraded, fallbackUsed, query, searchDerivation, symbols, files, graph{nodes,edges}, tests, docs, configs, git{recentCommits,ownership}, workspace, diagnostics, ranking{score,signals}, ambiguity`. Pipeline: file-path resolution → `resolveGraphTargetPure` → FTS5 BM25 over the node tables (Phase 3, with focusDirs post-filter and product-package tie-breaker) → test discovery cascade (`tested_by` → `references` → import-substring) → depth-1 related BFS with batched edge queries → git commits → real ranking (`packages/core/src/banyancode/ranking/rank.ts`).

### Search Cascade (`packages/core/src/banyancode/search/search.ts`):
`CASCADE_ORDER = Exact → Qualified → Prefix → Graph → BM25 → Fuzzy` (CamelCase/snake_case modes exist outside the default cascade). Weights 10/3/5/≤5/8/3-1; BM25 routes through FTS5; graph signal from indexed `in_degree`; candidate caps 500 (exact/prefix/qualified) / 1000 (others).

## Tool Catalog & Tiering

Banyan tools are defined in `packages/core/src/banyancode/banyan-tools-manifest.ts` and registered through `BanyanToolsMount.attachToCatalog` (`packages/opencode/src/effect/banyan-tools-mount.ts`) in **both** `AppLayer` and `createRoutes` (the HTTP route runtime) — mounting in only one runtime silently drops Banyan tools for the other.

- **30 public tool IDs** (`BANYAN_PUBLIC_TOOL_IDS`): `codegraph_build`, `codegraph_remove`, `code_find`, `repository_query`/`explain`/`impact`/`trace`/`tests`, `blast_radius`, `preflight`, `safe_rename`, `edit_plan`, `websearch_free`, `memory_store`/`recall`/`list`/`search`/`forget`/`candidate_emit`, `shared_memory`, `mesh_control`, `mesh_subscribe`, `subagent_message`, `system_status`, `goal`, `banyan_tool_search`, `banyan_test`, and the diagnostics `codegraph_staleness`, `memory_stats`, `mesh_status`.
- **12 internal IDs**: `codegraph_query`/`search`/`callers`/`dependents`/`impact`, `codegraph_find_*` (implementations/overrides/recursive/async/http_routes), `repository_symbols`, `repository_relationships`, `repository_ownership`.
- **Tiers are dynamic** (`AdaptedCatalog`): `hot` = explicitly allowed in the agent's permissions OR used within the last 24h (via `codegraph_tool_usage` upserts); `warm` = contract `visibility: "public"`; `cold` = otherwise. `banyan_tool_search` consumes the tiered list; the TUI sidebar `tool-usage.tsx` reads the same usage table.
- Startup enforces `registered === materialized` and the presence of every public ID; drift is a fatal defect.

## Goal Loop

The orchestrator drives a per-session goal lifecycle (`goal` tool, `packages/core/src/tool/goal.ts`; `GoalService`, `packages/core/src/banyancode/goal-service.ts`):

- Actions: `set` (condition + optional plan path + priority), `status`, `list`, `record_review` (verdict `pass | fail | blocked` + reason, increments `iteration_count`), `complete`, `block`, `cancel`.
- **One active goal per parent session** — `setGoal` fails with `GoalConflictError` if another active goal exists, but auto-cancels a *stale* active goal in the same transaction.
- Lifecycle: `active → (achieved | blocked | cancelled)`; iteration budget from `banyancode_max_goal_iterations`.
- Config keys: `banyancode_max_goal_iterations`, `banyancode_goal_evaluator_model`, `banyancode_goal_max_time_ms`, `banyancode_goal_auto_retry_on_block`.
- Surfaces: `goal` tool, `banyancode goal set|status|list|cancel` CLI, `/goal` slash command (delegates to the orchestrator), `banyancode.goal.*` events queue (bounded 64 — queue ownership reserved for a future bridge; do not add an internal drain).

## Verifier ("Did I break it?")

`VerifierService` (`packages/core/src/banyancode/verifier-service.ts`) gives the agent a verification surface:

- Four methods: `typecheck` (`bunx tsc --noEmit`), `test` (`bun test <path>`, framework passthrough for jest/vitest/mocha), `lint` (`bun run lint`, or `banyancode.json → commands.lint` override), `compile` (`bun build`).
- Cache key from `(kind, path, package.json hash, tsconfig.json hash)`; recent completed runs (< 1h) return as `cacheHit: true`. Concurrency bounded by a single semaphore (4). Output truncated to the last 64 KB.
- Every run persists to `verification_runs`; exposed to the agent via `banyan_test` (with `banyan_typecheck`/`banyan_lint`/`banyan_compile`) and to the TUI/HTTP via `POST /global/typecheck`, `POST /global/test-run`, `POST /global/lint`.

## Subagent Mesh & Parallel Orchestration

- **`orchestrator` Agent**: Registered by `packages/opencode/src/agent/agent.ts`. Its prompt (`agent/prompt/orchestrator.txt`) mandates parallel fan-out — "MUST fan out 2-3 parallel subagents", default 3, maximum `{{maxSubagents}}` rendered from `BanyanConfig.banyancode_max_subagents`. Mode fan-out: plan mode = `explore` + `researcher`; build mode = `explore` + `coder` + `researcher`. The same policy ships as a system block (`session/prompt/banyan.txt`, rendered by `SystemPrompt.banyan()` into every session).
- **Subagent Roster** (`packages/opencode/src/agent/agent.ts`): subagent-mode `explore`, `coder`, `scout`, `reviewer`, `researcher`; primary `build`, `plan`, `orchestrator`, `compaction`, `title`, `summary`. `general` was removed (commit `81eb89c0c`). `scout` is a single-shot leaf (≤ 3 tool calls); `reviewer` is read-only (verdict: pass/fail/blocked). Task-delegation allowlists are per-agent (`explore→scout`, `coder→explore/scout/researcher`, `reviewer→task denied`).
- **Parallel Dispatch**: subagent spawns go through the `task` tool + `MeshCoordinator`; long-lived mesh loops run via `Effect.forkDetach` (never `forkScoped`/`forkIn` — the fiber needs the global scope, not a request scope).
- **Runtime Capacity & Eviction Policy**: `MeshCoordinator.tryReserveSubagentSlot` enforces the maximum active subagent cap:
  1. If at capacity, finds the subagent whose `lastSeenAt` is > 60s ago (idle-based eviction, not oldest-ended).
  2. If found, evicts it via a `kill` message with reason `"evicted-by-new-spawn"` and assigns the slot.
  3. If no evictable subagent exists, refuses spawn and returns an actionable error message.
- **Subagent Communication**: inter-agent messages pass through `SubagentBus` (persisted in SQLite `subagent_messages`, bounded in-memory queue with backpressure drops). Message kinds: `request`, `inform`, `answer`, `poll`, `steer`, `checkpoint`, `plan`, `plan_update`, `kill`, `review`. `SubagentConsumer` runs a per-session loop that calls `markDelivered` on each row (at-least-once, idempotent via deterministic message IDs). `MeshCoordinator` GC sweeps ended/idle-parent sessions and recovers undelivered messages from dead parents at startup.
- **Review Dispatch Across Runtimes**: `mesh_control.review` reserves a slot, persists a `subagent_review_requests` row (`status: pending`), and publishes `kind: "review"`. `banyancode-review-bridge.ts` is the sole `subscribeAll` consumer — it takes the in-memory queue fast path AND polls `listPending` every 2s, because the bus queue is per-runtime while the SQLite rows are the cross-runtime source of truth. A conditional `pending → dispatched` transition (plus an `inFlight` Ref) prevents double dispatch; results are injected into the parent session as synthetic `<review_result>` parts.
- **`shared_memory`**: key-value store for mesh collaboration with namespaced keys (e.g. `research:topic:name`); writes are session-scoped and resolved to the **root parent session**; global writes restricted to build/orchestrator agents; re-writes upsert (idempotent); optional `expectedVersion` CAS. `normalizeSharedMemoryInput` recovers stuffed-invocation shapes.
- **`mesh_status` tool**: returns `{ agents: [{agent, status}], recentActivity }` for the tracked mesh tree; never fails.

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
  - `tool-usage.tsx` — most-used BanyanCode tools from `codegraph_tool_usage` (`GET /global/tool-usage`).
  - `mcp.tsx` — Model Context Protocol connection status.
  - `files.tsx` — attached files and active open file contexts.
  - `footer.tsx` — sidebar footer control bar.
- **Authored but Unregistered**: `intel-trace-panel.tsx` (repository intel traces), `codegraph-panel.tsx` (L0–L3 counts and `/codegraph-build` status), `codegraph-intel-panel.tsx`, `agent-tree.tsx`, `codebase-tree.tsx`, `lsp.tsx`, `todo.tsx`.

### Inspector Widgets (`packages/tui/src/feature-plugins/inspector/`):

- **Registered in `builtins.ts`**: `agent-details.tsx` (current agent status, task, model, tools, memory, last message), `todo.tsx` (active task todo list).
- **Authored but Unregistered**: `graph-explorer.tsx` (L0–L3 layer symbol explorer tree), `pending-actions.tsx` (pending sessions, permission requests, and agent questions).

### Other Plugin Slots (`packages/tui/src/feature-plugins/`):
- **Header**: `brand.tsx`, `status-pills.tsx` (codegraph readiness pill), `keybinding-hints.tsx`.
- **System**: `diff-viewer.tsx`, `notifications.tsx`, `plugins.tsx` (plugin manager), `which-key.tsx`, `attention-strip.tsx`.
- **Home**: `footer.tsx`, `tips.tsx`. **Session footer**: `footer/session-footer.tsx`.

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
Every `useEvent().on(...)` and `event.on(...)` subscription in TUI components is strictly paired with `onCleanup(unsub)` or `onCleanup(() => unsubs.forEach(...))` to prevent listener leaks across tab switches and remounts. Sidebar inter-plugin spacing is owned by the wrapper (`gap={1}`); plugins must NOT add their own `marginTop` on their first content element.

## HTTP API Specification

HTTP endpoints added by BanyanCode (`packages/opencode/src/server/routes/instance/httpapi/`). Three BanyanCode groups mount on `RootHttpApi` (`groups/global.ts`, `groups/repository-intel.ts`, `groups/memory.ts`); `websearch_free` and all codegraph/verifier endpoints live inside the `global` group.

### Global Group (`groups/global.ts` & `handlers/global.ts`):
- `GET /global/health`, `GET /global/event` (SSE), `GET/PATCH /global/config` — upstream contracts
- `GET /global/banyan-config` / `PATCH /global/banyan-config` — read / update `BanyanConfig.Info`
- `PATCH /global/banyan-agent-override` — update per-agent enabled/model override
- `PATCH /global/banyan-agent-prompt` — update agent system prompts
- `POST /global/banyan-agent/save` — save subagent definition to `.banyancode/agent/<name>.md` (strictly validated against `^[a-zA-Z0-9._-]+$` with path-traversal containment checks)
- `POST /global/startup` — startup hook (currently a no-op; bridges fork once at process start)

### Codegraph, Refactoring & Diagnostics Endpoints:
- `POST /global/codegraph-build` — start background index build (result carries canonical `root`/`dbPath`/`banyanDir`)
- `POST /global/codegraph-cancel` — interrupt active build
- `POST /global/codegraph-force-kill` — force-kill wedged build (Fiber interrupt + `taskkill` on Windows)
- `POST /global/codegraph-remove` — clear index (`dropFile: true` unlinks DB file)
- `GET /global/codegraph-status?root=` — persisted readiness (`missing`/`stale`/`ready`/`building`/`failed`) + graph metadata
- `GET /global/codegraph-nodes` / `GET /global/codegraph-edges` — inspect indexed nodes/edges
- `GET /global/tool-usage?session=` — most-used tools from `codegraph_tool_usage` (drives hot-tier promotion + TUI widget)
- `POST /global/code-find` — symbol locator (mirrors the `code_find` tool)
- `POST /global/preflight` — preflight code change check
- `POST /global/blast-radius` — evaluate blast radius before editing
- `POST /global/safe-rename` — perform safe symbol refactoring
- `POST /global/typecheck` / `POST /global/test-run` / `POST /global/lint` — verifier surface

### Repository Intelligence (`groups/repository-intel.ts` & `handlers/repository-intel.ts`):
- `POST /global/repository/query` — unified repository search (returns `RepositoryContext`)
- `POST /global/repository/explain` — ArchitecturalSlice for symbol
- `POST /global/repository/impact` — slice expanded with file dependents
- `POST /global/repository/trace` — downstream entrypoint trace
- `POST /global/repository/tests` — tests referencing symbol
- `POST /global/repository/symbols` — exact/prefix symbol lookup
- `POST /global/repository/relationships` — BFS walk from node ID
- `POST /global/repository/ownership` — primary Git author for path
- `GET /global/repository/architectural-slice` — fetch architectural slice

### Cross-Session Memory (`groups/memory.ts` & `handlers/memory.ts`):
- `POST /global/memory/list`, `/get`, `/recall`, `/search`, `/store`, `/forget`, `/candidates`, `/promote`, `/reject`, `/summary`

### Web Search & Mesh Lifecycle:
- `POST /global/websearch-free` — free DuckDuckGo HTML web search (inside the global group)
- `GET /global/mesh/status?parentSessionID=` — read subagent mesh status for a parent session (works whether or not the session is active)

*Note: `codegraph_staleness` and `memory_stats` are agent tools only — no HTTP routes.*

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
- `recall <key> [--scope SCOPE]` — exact key lookup (session-scope fallback when unset)
- `store <key> <value> [--scope SCOPE] [--tags TAGS]` — store/update entry
- `forget --id ID | --key KEY` — remove memory entry
- `candidates list | approve <id> | reject <id>` — manage memory candidate lifecycle
- `vacuum` — purge expired memory rows
- `sweep [--scope SCOPE]` — execute hygiene sweep (expire → reconcile → prune)

### `opencode goal ...` (`packages/opencode/src/cli/cmd/goal.ts`)
- `set <condition> [--plan PATH] [--priority low|normal|high] --session <id>` — create active goal
- `status --session <id>` — print active goal
- `list --session <id>` — list goals (active + terminal)
- `cancel --session <id>` — cancel active goal

### `opencode websearch-free <query> [--num N]` (`packages/opencode/src/cli/cmd/websearch-free.ts`)
- Free DuckDuckGo HTML scraping without API keys.

### `opencode stats ...` (`packages/opencode/src/cli/cmd/stats.ts`)
- `--days/--tools/--models/--project/--heatmap` — LLM usage analytics.

### Debugging & Tools:
- `opencode tools [--category CAT]` — inspect registered vs materialized tools and report catalog drift
- `opencode db [query] [--format tsv|json]` / `opencode db path` — interactive SQLite shell or direct SQL execution against workspace DB

## Slash Commands

Server-side slash commands (`packages/opencode/src/command/index.ts`):

- `/codegraph-build [root] [--force]` — executes background build with progress polling (`terminal` result)
- `/goal [condition|status|cancel]` — drives the orchestrator loop until a stated goal is achieved; persists a goal row then `continue`s into the orchestrator template (or `terminal` for status/cancel/usage)
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

*Note: `/codegraph-remove` is declared in `Default` but has no registered handler — removal is via CLI `codegraph remove`, `POST /global/codegraph-remove`, or the TUI palette.*

## Server Runtime & Permission Bridge

Defined in `packages/opencode/src/effect/`:

- **`AppRuntime` (`app-runtime.ts`)**:
  - Initializes the Effect service layer and registers **8 event bridges**: `applyCodegraphBuildBridge`, `applyCodegraphAutoUpdateBridge`, `applyCodegraphAutoUpdateProgressBridge`, `applyFilesystemBridge`, `applyMemoryBridge`, `applyMeshBridge`, `applyReviewBridge`, `applySystemMonitorBridge`. Each bridge is the *sole* consumer of its service's `events()` queue — Effect queues are single-consumer, so a second drain would race and lose events.
  - **Startup Catch-Up Indexing**: On startup, compares file `mtime` against DB `indexedAt` timestamps to automatically re-index files modified while the server was offline.
  - **Tool Catalog Drift Check**: Enforces `registered === materialized` tool counts (plus presence of every `BANYAN_PUBLIC_TOOL_IDS` entry via `registerBanyanTools`) at startup and terminates the process if drift is detected.
  - Long-running kickoffs (codegraph build handlers, etc.) run via `AppRuntime.runFork(Effect.forkDetach(...))` so the work survives request-scope teardown.
- **`BanyanToolsMount` (`banyan-tools-mount.ts`)**: Mounts `banyanToolLayer()` with all Banyan deps wired from canonical default layers — no `serviceOption` / `Layer.empty` / `Layer.build`. Attached in **both** `AppLayer` and `createRoutes` (`packages/opencode/src/server/routes/instance/httpapi/`).
- **`PermissionBridge` (`permission-bridge.ts`)**:
  - Bridges `PermissionV2.Service` (Effect-native) to `Permission.Service` (V1).
  - Automatically grants permission (`effect: allow`) without user prompts for BanyanCode actions: `codegraph_*`, `repository_*`, `edit_plan`, `code_find`, `websearch_free`.
- **`BanyanGate` (`banyancode-gate.ts`)**: reads `RuntimeFlags.banyancodeEnable`; bridges check it before forking.

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
- **NPM-Only Pipeline**: Releases ship strictly to NPM. Homebrew tap and AUR pushes are explicitly out of scope.
- **Channel-Aware Dist-Tags**: `.github/workflows/publish.yml` derives the npm dist-tag from the version — no prerelease suffix → `latest`, `-rc.*`/`-beta.*` → `next`, `-dev.*` → `dev`. `publish.ts` runs `npm publish --tag ${Script.channel}`; the channel is baked into the binary, so canary installs use isolated `-dev.db` files and never touch stable data.
- **`publish.ts` Idempotency**: Checks `npm view <name>@<version>` before publishing to prevent duplicate publish failures.
- **Umbrella Wrapper (`bin/banyancode.js`)**: The `banyancode` umbrella package's bin entry is a generated JS shim (`publish.ts` writes it via `shimScript`), so the CLI works even when lifecycle scripts never run (npm 11 allow-scripts default-deny, `--ignore-scripts`, bun global installs, pnpm's no-build default). At runtime the shim probes CPU AVX2 (`/proc/cpuinfo`, `sysctl`, `IsProcessorFeaturePresent`) and libc (`glibc` vs `musl`), resolves the optimal binary from the `optionalDependencies` platform packages, spawns it with inherited stdio, and falls back to a temporary `npm install` if none is present. The `postinstall.mjs` script is best-effort: when it runs it pre-copies the native binary to `bin/banyancode.exe`, which the shim uses as a magic-checked (ELF/MZ) fast path; failures only warn.
- **Windows Code-Signing (`.github/workflows/publish.yml`)**: Optional Azure Trusted Signing step (`sign-windows` job) for Windows binaries; falls back to unsigned binaries with a workflow warning annotation if Azure credentials are missing.

### SDK Build Pipeline (`packages/sdk/js/script/build.ts`)
- Generates OpenAPI spec from `packages/opencode`.
- Uses `@hey-api/openapi-ts` to generate TypeScript client code (`src/v2/gen`).
- Applies codegen patch to `types.gen.ts` (corrects `TError` parameter in `ServerSentEventsResult` to default `TReturn` to `void`).
- Compiles declarations and JS artifacts via `tsc`.
- Regenerate after any HTTP route or schema change: `./packages/sdk/js/script/build.ts`.

## Testing Guidelines & Execution Conventions

- **Root Execution Guard**: Root `package.json` enforces `"test": "echo 'do not run tests from root' && exit 1"`. Tests MUST be run from package directories (e.g., `packages/opencode` or `packages/core`).
- **Test Preload Isolation (`packages/opencode/test/preload.ts`)**:
  - Sets PID-isolated XDG environment paths before importing source files.
  - Clears all LLM provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) to prevent test leakage.
  - Configures `OPENCODE_DB=":memory:"`.
  - Implements `afterAll` cleanup with retry loops to resolve Windows SQLite WAL file handle locking (`EBUSY`).
- **`Database.layerFromPath(tmpDbPath)` Requirement**:
  - Services depending on `Database.Service` (`MemoryRepo`, `CodegraphRepo`, `SubagentMessagesRepo`, `SubagentPlansRepo`, `GoalRepo`, `VerificationRepo`) MUST explicitly receive `Database.layerFromPath(tmpDbPath)` in tests.
  - *Warning*: Omitting this causes tests to fall back to the global user database (`~/.local/share/banyancode/banyancode.db`) and fail.
- **Deterministic Synchronization**:
  - Avoid fixed sleep hacks (`Effect.sleep`). Use readiness signals (`pollWithTimeout`, `awaitWithTimeout`, `Deferred`).
- **Verifier Tests**: the agent's "did I break it" surface is exercised via `banyan_test`-style tests that run real shells against a `tmpdir()` project; assert on `VerifierResult.status` and `cacheHit` rather than raw output.

## Versioning Conventions

- **CalVer Standard**: `YY.MM.PATCH` (e.g. `26.07.4`). Git tags use the `v` prefix (`v26.07.4`); NPM drops leading zeros (`banyancode@26.7.4`).
- **Single Source of Truth**: `packages/opencode/package.json` `version` field.
- **Tag Format**: Annotated git tags (`git tag -a v26.07.4 -m "BanyanCode 26.07.4"`). Tags are immutable once a release ships — never force-move a published tag; cut a new patch instead.
- **Channels**: stable tags → `latest`; `-rc.*`/`-beta.*` → `next`; `dev` branch pushes auto-publish `-dev.<sha7>` canaries → `dev` dist-tag.
