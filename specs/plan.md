# Repository Tools Fix Plan

## Goal

Make `repository_*` tools resolve the intended source symbol, return meaningful dependency data, and avoid false test/caller links.

## Root Cause

`TaskTool` resolves to `packages/web/src/components/share/part.tsx` because:

- `packages/opencode/src/tool/task.ts` uses `export const TaskTool = Tool.define(...)`.
- The TypeScript regex parser does not index factory-assigned exports.
- A UI function with the same exact name is indexed.
- Exact-name resolution selects that UI function first.
- `focusDirs` is accepted by repository tools but currently does not filter graph candidates.

## Phase 1: Fix Symbol Extraction

1. Extend `packages/core/src/banyancode/langs/typescript.ts` to index exported factory assignments.
2. Start with the targeted production patterns:
   - `Tool.define(...)`
   - `Layer.effect(...)`
   - `Context.Service(...)`
3. Represent the assigned export as a graph node using its exported identifier, source range, signature, and factory type.
4. Preserve existing arrow-function and `Effect.fn` extraction behavior.
5. Add parser regressions for:
   - `export const TaskTool = Tool.define(...)`
   - `export const Service = Context.Service(...)`
   - `export const layer = Layer.effect(...)`

**Acceptance:** `code_find(definition, "TaskTool")` returns `packages/opencode/src/tool/task.ts`, not the web component.

## Phase 2: Resolve Ambiguous Symbols Correctly

1. Apply `workspace.focusDirs` in `repository-intelligence/layer.ts` before candidate ranking.
2. Normalize each focus directory relative to the indexed graph root.
3. Prefer candidates under focus directories.
4. When no focus directory is supplied:
   - Return all exact-name candidates rather than silently selecting the first.
   - Rank product packages (`packages/opencode`, `packages/core`, `packages/tui`) above excluded UI packages only if both are indexed.
   - Include resolution derivation and ambiguity metadata in tool output.
5. Ensure `repository_trace`, `repository_tests`, and `repository_explain` use the selected candidate consistently.

**Acceptance:** two `TaskTool` symbols in separate packages resolve to the one under `focusDirs: ["packages/opencode"]`.

## Phase 3: Correct Repository Query Behavior

1. Separate symbol lookup from free-text repository search.
2. Use the existing `codegraph_fts` FTS5 table for multi-token query matching and `bm25()` ranking.
3. Keep exact symbol resolution as the first path for unambiguous identifiers.
4. Treat `"TaskTool execute"` as tokenized search, not one exact symbol string.
5. Apply `limit` to returned symbols, files, graph nodes, and edges, not just Git history.
6. Surface search derivation in diagnostics: exact name, qualified name, FTS, or substring fallback.

**Acceptance:** `repository_query("TaskTool execute")` returns `TaskTool`/`run` candidates from `task.ts`, with the derivation shown.

## Phase 4: Make `repository_explain` Complete

1. Update `repository_explain` to populate:
   - `directCallers`
   - `transitiveDependents`
2. Reuse trace traversal after it is made directional.
3. Keep the explain output bounded with a conservative default limit.
4. Add an explicit "dependencies" section for outgoing call/import relationships.

**Acceptance:** explain no longer renders misleading empty caller/dependent sections when graph edges exist.

## Phase 5: Correct Trace and Test Semantics

1. Make traversal directional:
   - Incoming `calls`/`references` edges become callers/dependents.
   - Outgoing edges become dependencies/callees.
2. Do not label `imports`, `extends`, `tested_by`, or `configured_by` as callers.
3. Tighten `tested_by` edge generation in `codegraph-indexer.ts`.
4. Require a source-file import or a verified file relationship before connecting a test artifact to a symbol.
5. Retain token matching only as a lower-confidence fallback, never as the sole exact edge.

**Acceptance:** `repository_tests("TaskTool")` links to the OpenCode task tool node, not a same-named web component.

## Phase 6: Path and Scope Reliability

1. Normalize relative paths against `codegraph_meta.indexed_root`.
2. Apply this to `repository_impact`, `repository_relationships`, and query-as-path behavior.
3. Consume `banyancode_codegraph_exclude_patterns`, which is declared but currently unused.
4. Default-exclude out-of-product packages (`web`, `app`, `desktop`, `storybook`) unless explicitly included.

**Acceptance:** `repository_impact("packages/opencode/src/tool/task.ts")` works against an index storing absolute paths.

## Phase 7: Contract Cleanup

1. Align HTTP and LLM-tool schemas:
   - Trace `limit`
   - Relationships `path`
   - Ownership `owner` naming
   - Architectural slice fields
2. Remove or fold the no-op `repository-intel-tool.ts` into `repository-wave2.ts`.
3. Retire `repository_slice` into `repository_explain`, as the source already intends.
4. Remove or repair the legacy unused `codegraph_nodes_fts` migration.

## Phase 8: Index Identity and Cache Audit

1. Audit repository intelligence and codegraph services for cached snapshots.
2. Tie caches to `codegraph_meta.graph_version`.
3. Invalidate derived query caches after a build/version bump.
4. Make generated node IDs deterministic where stable identity is required.

## Regression Coverage

Add tests for:

- Factory-assigned export extraction.
- Duplicate names across packages.
- `focusDirs` affecting actual resolution.
- Multi-word FTS query ranking.
- Relative-path lookup.
- Directional caller/dependency classification.
- Correct `tested_by` edges.
- `repository_explain` populated callers/dependents.
- HTTP and LLM-tool result parity.

## Recommended Delivery

1. PR 1: Phases 1, 2, and regression tests. Fixes the visible wrong-symbol bug.
2. PR 2: Phases 4 and 5. Fixes misleading explain/trace/tests behavior.
3. PR 3: Phases 3, 6, 7, and 8. Search quality, cleanup, and operational hardening.

This keeps the highest-risk parser and resolver changes isolated from broader API cleanup.