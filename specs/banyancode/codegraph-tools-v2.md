# Codegraph Tools v2 — Deep Analysis and Improvement Plan

## Status

Deep-analysis pass over the full codegraph pipeline (`codegraph-indexer.ts`, `codegraph-repo.ts`, `search/`, `symbol-resolver.ts`, `repository-intelligence/`, `codegraph-analyzer.ts`, `tool/codegraph.ts`, `tool/code-find.ts`, `tool/repository-wave2.ts`, `tool/blast-radius.ts`, `tool/preflight.ts`, `tool/repo-map.ts`, `codegraph-system-source.ts`, HTTP routes, migrations). Supersedes nothing — this is the next generation of `repository-tools-remediation.md` (completed) and `repository-tools-followup.md` (mostly completed; verified fixes: migration registration `migration.gen.ts:15`, batched `bfs.ts`, batched `edgesFromBatch/edgesToBatch`, `impact` graph traversal at `layer.ts:949-964`, FTS5 trigram tokenizer, tool-usage migration).

## Goal

Make the codegraph tool stack (a) never silently serve data older than the files it reports on, (b) stop materializing the full graph on ordinary queries, (c) use one batched traversal everywhere, and (d) stop advertising signals it does not compute.

## Confirmed Gaps (verified, file:line on `dev`)

| ID | File:Line | Severity | Issue |
|---|---|---|---|
| P1 | `graph-staleness.ts:20-51`, `codegraph-readiness.ts:119-121` | HIGH | Staleness is meta-age/coverage only. A graph built 10 min ago with files changed 5 min ago reports `ready`; `repository_impact` returned pre-edit line numbers in a live session. `ReadinessResult.changedFiles` (schema `codegraph-readiness.ts:38`) is never populated. Watcher (`codegraph-auto-update.ts:112`) is the only drift mechanism, in-memory + debounced + disableable. |
| P2 | `codegraph-analyzer.ts:83-121` | HIGH | `walkTransitive` issues `edgesTo`/`edgesFrom` per node (N+1). Used by `code_find impact`, `blast_radius`, `preflight`, `safe_rename`. Batched `bfsPure` exists only in repository-intelligence — two traversal implementations. |
| P3 | `repository-intelligence/layer.ts:800-803` | MEDIUM | `ranking: { score: 0, signals: all 0 }` is a hardcoded stub. Real scorer `ranking/rank.ts:102-152` is consumed only by `banyan_repo_map` search. |
| P4 | `search/search.ts:439-449, 257-260` | MEDIUM | Every cascade calls `listAllEdges()` to feed `graphSignal()`, which unconditionally returns 0. Full edge-table load per query, pure waste. |
| P5 | `symbol-resolver.ts:226, 248` | MEDIUM | Fallback steps 4-5 call `listAllNodes()` — every node including `code` column — on every miss. |
| P6 | `codegraph-repo.ts:664, 690`; `codegraph-repo.ts:741` | MEDIUM | Leading-wildcard `LIKE '%x%'` defeats `codegraph_node_name_idx`; FTS multi-token joins with OR only; <3-char identifiers dropped by trigram. |
| P7 | `banyan-tools-manifest.ts:34-38` vs `repository-wave2.ts` | LOW | `repository_impact` in BOTH internal manifest list AND public contract — manifest is not the visibility authority and nothing validates the drift. 4 overlapping search entry points; `no-edges-found` indistinguishable from zero dependents; `code_find` in-agent only while `repository_*` is HTTP. |
| P8 | `codegraph-indexer.ts:758-868` | MEDIUM | `imports` declared but never emitted (scope only). All 7 edge kinds are name/substring `includes()` heuristics; strings/comments not excluded; `derivation: "regex-v1"` everywhere; parse errors record only Effect failures. |
| P9 | `codegraph-repo.ts:1187-1200`; `adapted-catalog.ts:65-68` | LOW | 3 full `COUNT(*)` per build; `recomputeInDegree` full-pass; O(n²) indexer spots (`:787-868`, `:915-945`, `:981`); tool-usage recorded/tiered but never surfaced (no HTTP endpoint, no TUI widget). |

## Non-goals

- No vector/embedding index — FTS5 trigram + weighted BM25 is the sanctioned substrate.
- No tree-sitter migration of the main parse path in this work (separate Wave-5 track).
- No new cache layer until profiling identifies a repeated, version-keyed query worth caching.
- Do not change public HTTP/SDK/LLM-tool contracts; deprecate and migrate deliberately.

## Phase 1 — Freshness and trust (PR 1)

Primary files: `codegraph-readiness.ts`, `codegraph-repo.ts`, `graph-staleness.ts`, `tool/code-find.ts`, `tool/repository-wave2.ts`, `tool/blast-radius.ts`, `tool/preflight.ts`.

1. Add `repo.countStaleFiles()` — `SELECT COUNT(*) FROM codegraph_files WHERE mtime_ms > indexed_at` (both columns exist, `codegraph.sql.ts:8,10`). Bounded, indexed-friendly.
2. Populate `ReadinessResult.changedFiles` from it in `codegraph-readiness.ts:runReadiness`.
3. Surface per-result staleness in tools: when the result's file rows have `mtime_ms > indexed_at`, emit `_diagnostic: "stale-graph"` (code_find already has the slot at `code-find.ts:83`) and add `staleFiles?: number` to tool outputs. Centralize in one helper used by code_find, repository_* , blast_radius, preflight.
4. Keep meta-age advisory; escalate to `high` only when changed-file count is also high. Never make age a rebuild trigger (already the rule at `codegraph-readiness.ts:123`).
5. Tests: index a fixture, edit a file after indexing, assert `code_find`/`repository_impact` surface `stale-graph`/`staleFiles`; assert `changedFiles > 0` from readiness.

Acceptance: a tool never silently reports data for a file whose mtime is newer than its `indexed_at`.

## Phase 2 — Kill full-graph loads (PR 3, merged with Phase 4)

Primary files: `search/search.ts`, `symbol-resolver.ts`, `codegraph-repo.ts`, `repository-intelligence/layer.ts`.

1. Delete the `listAllEdges()` pass from the cascade (`search.ts:439-449`). Replace the `graphSignal` stub with a per-result signal from the indexed `in_degree` column (populated at `codegraph-indexer.ts:30-31`), capped.
2. Replace resolver step 4's `listAllNodes()` with `searchNodesLight({ limit: 1000 })` + per-candidate `nodesByIDs` for `code` (mirrors `findTests` at `layer.ts:424-425`).
3. Route `searchNodes`/`searchNodesLight` callers to `ftsSearchNodes` where ranking matters; keep LIKE only for prefix-anchored `name LIKE 'x%'`.
4. Multi-token FTS: AND-join ≥2 terms with OR fallback on zero hits; keep sanitization at `codegraph-repo.ts:737`.

Acceptance: one `repository_query` never loads the full nodes or edges tables; `searchExact` issues ≤2 SQL statements.

## Phase 3 — One batched traversal (PR 2)

Primary files: `codegraph-analyzer.ts`, `repository-intelligence/bfs.ts`, `tool/blast-radius.ts`, `tool/preflight.ts`, `tool/code-find.ts`.

1. Port `analyzer.callers/dependents/impact/walkTransitive` onto `bfsPure` (batched frontier). Delete the per-node loop at `codegraph-analyzer.ts:99-101`.
2. `blast_radius`, `preflight`, `safe_rename`, `code_find impact` then share the same primitive as `repository_impact/trace/explain`.
3. Add a query-count assertion test for the analyzer path (mirror `phase-a-correctness.test.ts:227-230`).

Acceptance: `code_find impact` and `blast_radius` issue O(depth) edge queries, not O(nodes).

## Phase 4 — Honest outputs + surface consistency (PR 3)

Primary files: `repository-intelligence/layer.ts`, `ranking/rank.ts`, `banyan-tools-manifest.ts`, `code-find.ts`, `groups/repository-intel.ts`, `groups/global.ts`.

1. Wire `rank.ts` scoring into `repository_query.ranking` (name-exact 15 + file 10 + bm25*8, etc.) or remove the field — never ship zeros labeled as signals.
2. Add a test asserting manifest lists match registered `contract.visibility` (extends `v2-probe-baseline.test.ts:404-407`) — catches P7 drift.
3. Add `derivation`/`confidence` to diagnostics so `no-edges-found` ≠ `zero-dependents`; add `POST /global/code-find` passthrough so TUI/plugins get the same resolver as in-agent `code_find`.
4. SDK regen after any route change (`packages/sdk/js/script/build.ts`).

Acceptance: `repository_query.ranking` reflects real signals; manifest ↔ contract test passes; `POST /global/code-find` returns the same node IDs as the in-agent tool.

## Phase 5 — Edge-model improvements (PR 4)

Primary files: `codegraph-indexer.ts`, `langs/typescript.ts`, `langs/query-executor.ts`.

1. Emit the declared `imports` edges (`codegraph-indexer.ts:758` — the scope set is already computed at `:772-785`).
2. Exclude string-literal/comment contexts from reference matching before `includes()` classification.
3. Add a `derivation` value for tree-sitter-verified edges when the wasm path is available (schema already tolerates extra values via `derivation: "regex-v1"` default).

Acceptance: import edges exist in the graph; string-comment false positives drop; tree-sitter-verified edges carry a distinct derivation.

## Phase 6 — Usage surface (PR 4)

Primary files: `adapted-catalog.ts`, `groups/global.ts`, `handlers/global.ts`, TUI `feature-plugins/sidebar/`.

1. `GET /global/tool-usage` returning `codegraph_tool_usage` rows (hot-tier gate already reads it at `adapted-catalog.ts:65-68`).
2. Small TUI sidebar widget listing most-used tools + hot-tier state.

Acceptance: tool usage is visible in TUI and over HTTP.

## Regression coverage

- Fixture: edit-after-index → stale diagnostics (P1).
- `repository_query` never loads full nodes/edges (P4/P5) — spy assertions.
- `code_find impact`/`blast_radius` bounded query count (P2).
- `ranking` non-zero for exact-name hits (P3).
- Manifest ↔ contract parity test (P7).
- Import edges present; string/comment exclusion (P8).

## Recommended delivery

1. **PR 1**: Phase 1 (freshness). User-visible trust fix; `packages/core` + `packages/opencode` tests.
2. **PR 2**: Phase 3 (analyzer BFS port). Performance + correctness, test-locked.
3. **PR 3**: Phases 2 + 4 (full-graph loads, ranking honesty, manifest test, code-find HTTP).
4. **PR 4**: Phases 5 + 6 (edge model + usage surface).

Run `bun typecheck` and targeted `bun test` from `packages/core` and `packages/opencode` after each PR. Regenerate the JS SDK when a route or schema changes.
