# BanyanCode Implementation Plan

> **Convention reminder.** `AGENTS.md` says "Active work is tracked via issues and PRs — there is no separate implementation plan doc." This file exists because it was explicitly requested. It is the Wave 2 shipped snapshot and the Wave 3+ outline. It is not a substitute for issues/PRs.

## Status (as of Wave 2)

| Wave | Theme | Status | Commits |
|------|-------|--------|---------|
| 1 | Repository Intelligence v1 (graph-first retrieval, hybrid search, structural queries, trace instrumentation) | **Shipped** | `0962825`, `a39b85e`, `78030e4`, `8a9ceeb`, `1f64078`, `a002810` |
| 2 | Repository Intelligence v2 (9-method public surface, ArchitecturalSlice shape, 9 HTTP endpoints, 9 tool wrappers, 9 slash commands, CLI subcommands, DuckDuckGo free web search wiring, trace rolling cap, PermissionV2 bridge) | **Shipped** | `771800e`, `d5cd170`, `fd8f899`, `f85e85a`, `ec055e0` |
| 3 | Cache layer interfaces + semantic code search (embeddings over codegraph nodes) | Not started | — |
| 4 | TUI intel-trace panel registration + recent-queries strip on the home screen | Not started | — |

## Wave 2 — what shipped

### 1. Repository Intelligence v2 service shape

`packages/core/src/banyancode/repository-intelligence/service.ts` now exposes 9 methods:

| Method | Purpose |
|--------|---------|
| `query({ query, limit?, workspace? })` | Single unified repository context (symbols + tests + docs + configs + graph + recent commits) |
| `slice(ctx)` | Compose an `ArchitecturalSlice` from a `RepositoryContext` |
| `explain({ symbol, workspace? })` | ArchitecturalSlice for a symbol |
| `impact({ path, workspace? })` | Direct dependents expanded into `importantSymbols` |
| `trace({ symbol, depth?, workspace? })` | Downstream entrypoints via graph walk |
| `tests({ symbol })` | Test nodes that reference a symbol |
| `symbols({ query, limit? })` | Exact-then-prefix symbol lookup |
| `relationships({ nodeID, depth? })` | BFS up to depth N from a node |
| `findOwner({ path })` | Most active git author for a file |

`ArchitecturalSlice` is the canonical return shape — `{ summary, entrypoints, importantSymbols, relatedTests, relatedDocs, configs, routes, dependencies }`. Stable across waves; downstream consumers can pattern-match it.

`Search` gained a public `searchAuto(query, opts)` cascade (Exact → Qualified → Prefix → Graph → BM25 → Fuzzy) plus a `mode: "manual"` escape hatch for SDK/CLI users who want to override the cascade.

`StructuralQueries` now exposes `findInterfaces`, `findExports`, `findImports` in addition to the Wave 1 set.

`CodegraphNodeKind` extended with `ci | docker | env | doc` so markdown / Dockerfile / `.env` / config-style files emit meaningful file-kind nodes. New parsers: `langs/markdown.ts`, `langs/docker.ts`.

### 2. New HTTP surface (9 endpoints)

`packages/opencode/src/server/routes/instance/httpapi/groups/repository-intel.ts`:

```
POST /global/repository/query
POST /global/repository/slice
POST /global/repository/explain
POST /global/repository/impact
POST /global/repository/trace
POST /global/repository/tests
POST /global/repository/symbols
POST /global/repository/relationships
POST /global/repository/ownership
```

Plus `/global/websearch-free` (DuckDuckGo HTML, gated by `BANYANCODE_DISABLE_WEBSEARCH`).

All paths use `Schema.isPattern`-constrained inputs and resolve to `Global.Path.*` — no path traversal surface.

### 3. Nine `repository_*` tool wrappers

`packages/core/src/tool/repository-wave2.ts` exposes 9 canonical tools the LLM can invoke:

- `repository_query`, `repository_slice`, `repository_explain`, `repository_impact`, `repository_trace`, `repository_tests`, `repository_symbols`, `repository_relationships`, `repository_ownership`

Each tool:
1. Calls `PermissionV2.assert(...)` with the tool name as the action.
2. Wraps the inner Effect in `traced(...)` so every call lands in `.banyancode/trace/<sessionID>.jsonl`.
3. Returns a `Schema.Struct`-validated output (ArchitecturalSlice / RepositoryContext / node list / ownership record).

Mounted via `banyanToolLayers` in `packages/opencode/src/tool/registry.ts`.

### 4. Slash commands and CLI subcommands

Slash commands (Wave 2):
- `/repository-query`, `/repository-explain`, `/repository-trace`, `/repository-impact`
- `/repository-tests`, `/repository-symbols`, `/repository-relationships`
- `/repository-ownership`, `/websearch-free`

Templates in `packages/opencode/src/command/template/repository-*.txt`. Registry in `packages/opencode/src/command/index.ts`.

CLI (new top-level commands, registered in `packages/opencode/src/index.ts`):
- `opencode repository { query | explain | trace | impact | tests | relationships | ownership }`
- `opencode websearch-free <query>`

The `repository` group is `instance: false` so it works whether or not the user has an active session. It re-provides `Banyan.repositoryIntelligenceDefaultLayer` for its own DB access.

### 5. PermissionV2 bridge

`packages/opencode/src/effect/permission-bridge.ts` implements `BanyanPermissionV2.Service` (the core-side abstract permission service) on top of opencode's `Permission.Service`. The CLI AppRuntime mounts it via `Layer.provideMerge(PermissionBridge.layer.pipe(Layer.provide(Permission.defaultLayer)))`.

Tested by `test/effect/permission-bridge.test.ts` — 3/3 pass.

### 6. Trace rolling cap

`packages/core/src/observability/trace.ts`:
- `cache?: CacheLayer<...>` and `workspace?: WorkspaceContext` slots added to `TraceEvent`.
- 7-day OR 10k-event rolling cap whichever first; oldest lines dropped from `.banyancode/trace/<sessionID>.jsonl`.

CLI subcommand: `opencode codegraph trace --session <id> [--limit 50]` (added in Wave 2).

### 7. TUI side-panel

`packages/tui/src/feature-plugins/sidebar/intel-trace-panel.tsx` is the Wave-2 trace panel. Currently authored but **not registered** in `packages/tui/src/feature-plugins/sidebar/builtins.ts` — left as a Wave 4 task (see below).

## Wave 3 — TODO outline

### Caching layer

Each wave-2 service (`RepositoryIntelligence`, `Search`, `StructuralQueries`) already declares a `cache?: CacheLayer<...>` slot. Wave 3 will:
- Land a generic `CacheLayer<K, V>` in `packages/core/src/observability/cache.ts` with TTL + LRU eviction.
- Wire it into the most expensive read paths (`query`, `symbol`, `searchAuto`, `findHTTPRoutes`).
- Re-run the perf micro-benchmarks from `packages/core/script/test-repo-intel.ts`.

### Semantic code search

Phase 2 of the codegraph pipeline (`/code-embed`):
- Embed every `CodegraphNode.text_excerpt` (first 512 chars of source for the node's body) using the AI SDK.
- New `code_search({ query, limit, fileGlob })` tool that does cosine similarity + BM25 hybrid scoring.
- `BanyanConfig.banyancode_embedding_model` config drives provider/model selection.

### SDK regen

`./packages/sdk/js/script/build.ts` to regenerate `@opencode-ai/sdk` against the new HTTP routes. Today's SDK was generated against the Wave 1 surface; consumers who depend on `repository.*` will get typed access after this regen.

## Wave 4 — TODO outline

### TUI intel-trace panel registration

- Add `intel-trace-panel.tsx` to `packages/tui/src/feature-plugins/sidebar/builtins.ts` next to `codegraph-intel-panel`.
- Add a recent-queries strip to the home screen (the prompt area) that lists the last 8 intel/trace events.

### Evaluator harness (research-report.md follow-up)

- Trace files (`.banyancode/trace/<sessionID>.jsonl`) become the input for an offline evaluator that scores repository-intelligence answer quality.
- Hook into `packages/opencode/src/effect/observability/trace.ts` as a sibling exporter.

## References

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — repo layout, runtime layers, BanyanCode service architecture, V2/V3 changelog (Wave 2 entry to be appended in the same change).
- [`specs/banyancode/`](specs/banyancode/) — per-feature design (storage, orchestrator, subagent mesh, memory, code graph, free web search, types).
- [`specs/banyancode/research-report.md`](specs/banyancode/research-report.md) — the research-report design and the evaluator hooks.
