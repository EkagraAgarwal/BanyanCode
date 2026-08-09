# Tool Hardening — Resolver, Batching, FTS, Scope, Preflight

## Status

Benchmark-driven hardening pass (2026-08-09) over the BanyanCode tool stack. Root causes were verified live on the workspace graph (20k+ nodes) and via a service-layer microbenchmark (5k memory rows, 10k-node synthetic graph). Supersedes nothing; complements `codegraph-tools-v2.md`.

## Goal

(a) make qualified symbol names (`MemoryRepo.update`, `CodegraphBuildService.start`) resolve on real graphs, (b) remove the SQLite variable-limit ceiling on graph batch writes, (c) cut memory FTS search from ~1.2s to <100ms at 5k rows, (d) eliminate the silent-null memory recall scope gap, (e) make `preflight` reports graph-complete, (f) fix the orchestrator test timeout flake, (g) ship three new tools: `codegraph_staleness`, `memory_stats`, `mesh_status`.

## Confirmed Gaps (verified, file:line on `main`)

| ID | File:Line | Severity | Issue |
|---|---|---|---|
| R1 | `symbol-resolver.ts:191,250` | HIGH | Qualified-split and code-substring steps scan `searchNodesLight({limit:1000})` with no name filter → SQL `ORDER BY name LIMIT 1000` (`codegraph-repo.ts:734`). Live graph: window covers only names ≤ "D"; `MemoryRepo.update`, `MemoryRepo.put`, `CodegraphBuildService.start` → `target-not-resolved`. Bare names resolve because tag-fallback is full-table SQL. |
| R2 | `symbol-resolver.ts:61-71` | MEDIUM | `ftsSearchNodes` not in `ResolveRepo`; `fts-bm25` derivation is dead code (`code-find.ts:71`). |
| R3 | `repository-intelligence/layer.ts:410,596` | MEDIUM | `searchNodesLight({limit:100000})` — same silent truncation above 100k nodes. |
| B1 | `codegraph-repo.ts:1456-1474` | MEDIUM | `putNodes` single unbounded multi-row INSERT (10 cols/row → ~3,276-row ceiling). `MAX_NODES_PER_INSERT=1000` (`:18`) exists but is unused. `writeFileGraph` node insert `:1544-1549` same. `putEdges` already chunks (`:1141-1165`). |
| F1 | `memory-repo.ts:371-377` | HIGH | Separate `COUNT(*)` re-runs the identical FTS MATCH — 2× scan per search (measured 0.5–1.2s @ 5k rows vs codegraph 28ms @ 10k). |
| F2 | `memory-repo.ts:334-339` | MEDIUM | 1-char tokens, unbounded token count, unweighted `bm25()`, `SELECT *` includes 64KB JSON value column before sort+limit. |
| F3 | `memory-repo.ts:386-417` | LOW | Degraded LIKE path: no ORDER BY, `totalHits` = limit-capped row count (wrong). |
| F4 | `migration/20260711130000_memory_entries_fts.ts` | MEDIUM | unicode61 tokenizer — no partial-key matching; codegraph already migrated to trigram (`20260801120000_codegraph_fts_tokenize.ts`, probe + fallback). |
| S1 | `packages/opencode/.../handlers/memory.ts:56,81` | MEDIUM | HTTP `list`/`recall` default `"global"` while `store` requires `scope` (schema `groups/memory.ts:85`) → stored-session rows silently missed. Tool layer is symmetric (`tool/memory.ts:110-121`). |
| S2 | `tool/memory.ts:275-282` | MEDIUM | Lead recall defaults global → misses subagent session-scoped writes; `MemoryRepo.getLatestSessionScoped` (`memory-repo.ts:242-253`) is the existing fix primitive (used by `shared_memory`). |
| P1 | `tool/preflight.ts:310-319` | MEDIUM | docs/configs classified only from caller fileIDs — target file and dependents never classified → always 0 for central TS files. |
| P2 | `tool/preflight.ts:208-254` | MEDIUM | Route/bridge scans are literal-substring scans over two hardcoded `packages/opencode` dirs; `derivation="regex-v1"` label hardcoded at `:401` (callers are actually graph-backed). |
| T1 | `packages/opencode/test/banyancode/orchestrator.test.ts:49` | LOW | No timeout set; 4.4s test vs bun 5s default flakes under parallel load. |

## Non-goals

- No changes to public HTTP/SDK/LLM-tool contracts (new tools are additive).
- No tree-sitter main-path migration (separate Wave-5 track).
- No memory schema column changes; FTS virtual table rebuild only (probe + fallback).

## Workstreams

### WS1 — Resolver correctness (P0)

1. `symbol-resolver.ts:191` (qualified-split): `searchNodesLight({ name: parentName, limit: 1000 })` then `{ name: leaf }` — SQL-side LIKE before LIMIT; keep exact-name JS filter on the small result. Bounds columns, not rows.
2. `symbol-resolver.ts:250` (code-substring): same pattern — scope the light scan by `{ name: leaf }` (or leaf token) so the window never truncates.
3. Wire `ftsSearchNodes` into `ResolveRepo`; insert FTS step between qualified-split and code-substring, filtered by `parentFileIDs` + kind; derivation `"fts-bm25"` already present in both schemas.
4. `repository-intelligence/layer.ts:410,596`: replace `limit:100000` loads with the same name-filtered SQL pattern (or exact `listNodesByFile` scoping) where a name is known.
5. Regression test: seed >1,000 nodes with the leaf sorted beyond the alphabetical window; assert `MemoryRepo.update` / `CodegraphBuildService.start` resolve (existing fixtures seed 2–6 nodes and never exercised the window).

### WS2 — Graph batch writes (P1)

1. `putNodes`: wrap in `db.transaction((tx) => …)` + chunk loop at `MAX_NODES_PER_INSERT` (1000 rows × 10 cols = 10k vars), mirroring `putEdges` `:1143-1164`.
2. `writeFileGraph`: same chunk inside the existing per-file transaction (`:1544-1549`).
3. Regression: 4,000+ node batch through the service (reproduces the pre-fix failure).

### WS3 — Memory FTS performance (P1)

1. `COUNT(*) OVER ()` in the same SELECT (`memory-repo.ts:361-377`) — one MATCH scan; drop the separate count query (fallback: count only when `rankedRows.length === limit`).
2. Token guards (`:334-339`): drop <2-char tokens, cap at 8.
3. Weighted `bm25(memory_entries_fts, 10.0, 3.0, 1.0, 1.0)` (key/title > body/kind) matching the codegraph contract (`fts-bm25-weights.test.ts`).
4. Degraded path (`:405-416`): `ORDER BY created_at DESC`, real `COUNT` when not limit-capped.
5. New migration `YYYYMMDDHHMMSS_memory_entries_fts_trigram.ts` mirroring `20260801120000_codegraph_fts_tokenize.ts` (trigram probe → unicode61 fallback, drop/recreate triggers, backfill); register in `migration.gen.ts`.
6. Bench-gate test: 5k seeded rows, assert search <100ms (generous CI bound) and trigram substring behavior.

### WS4 — Memory scope UX (P1)

1. `tool/memory.ts` recall: on empty results fall back to `repo.getLatestSessionScoped(input.key)` — same primitive as `shared_memory` (`tool/shared-memory.ts:73-78`).
2. HTTP handlers `handlers/memory.ts:56,81`: default list/recall to `undefined` (all-scope read) like search; keep `store` required scope documented.
3. Tests: cross-caller lead-recall (subagent write, lead recall without scope), HTTP recall without scope.

### WS5 — Preflight accuracy (P1)

1. `computePreflight`: merge `deps.repo.dependentsOfFiles({ fileIDs: [primary.fileID], limit: 100 })` into the fileIDs set used for docs/configs classification (`:287-319`).
2. Route/bridge detection: classify any graph-returned file whose path matches `/effect/.*-bridge\.ts$/` or `/httpapi\/groups\/.*\.ts$/`; run the existing extraction regex on it; keep literal-substring gate only as fallback.
3. Derivation label: report the real derivation (`graph` + scan kind) instead of hardcoded `"regex-v1"`.
4. Regression: `preflight(action=modify, target=MemoryRepo)` reports docs/configs > 0.

### WS6 — Mesh test flake (P2)

1. `orchestrator.test.ts`: `{ timeout: 30_000 }` on the two `it.instance` cases (precedent `explore-permissions-regression.test.ts:63`).
2. Optional: memoize `agentLayer()` across the 3 tests.

### WS7 — New tools (P2)

1. `codegraph_staleness` — per-file `mtime_ms > indexed_at` count + top stale files (uses `countStaleFiles` / files table).
2. `memory_stats` — per-scope entry counts, total bytes, quota remaining (constants in `tool/memory.ts:12-14`).
3. `mesh_status` — mesh-coordinator `recentActivity` / agent counts surfaced read-only.
4. Register in `banyan-tools-manifest.ts` (internal + `BANYAN_PUBLIC_TOOL_IDS` where public), `codegraph-system-source.ts` tool guide family lists, and `BanyanTools.locationLayer`-provided tool layer. No system-prompt policy text changes beyond the guide.

## Verification

- `bun typecheck` from `packages/core` and `packages/opencode` after each WS.
- Targeted `bun test` from package dirs per WS (tests named per WS above).
- Final: re-run the four-family suite (codegraph, repository, memory, mesh + opencode integration) and the microbenchmark harness.
- No SDK regeneration unless a route schema changes (WS4 is handler-only).
- One logical change per commit; branch `tool-hardening`.
