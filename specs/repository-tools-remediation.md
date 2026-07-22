# Repository Tools Remediation Plan

## Status

This supersedes `specs/plan.md` as the implementation plan for repository
intelligence. Keep the earlier file as historical context; do not delete it
until this plan is complete.

The earlier plan correctly identified ambiguous-symbol resolution, query
quality, traversal semantics, and test relationships as the main risks. It is
partly stale, however:

- Factory-assigned exports are already parsed by `FACTORY_EXPORT_REGEX` in
  `packages/core/src/banyancode/langs/typescript.ts` and have parser tests.
- `workspace.focusDirs` already influences `findSymbol`.
- Multi-token `repository_query` already has an FTS fallback.
- `repository_slice` is already retired from the public tool surface.
- `ArchitecturalSlice` already includes direct callers, transitive dependents,
  and dependencies.

The remaining work is to make those partial implementations correct, bounded,
and observable rather than to recreate them.

## Goal

Make repository tools resolve the intended graph target, explain why it was
selected, return directional relationships with defensible confidence, and
remain responsive on large indexes.

## Non-goals

- Do not exclude `web`, `app`, `desktop`, or `storybook` by default. A caller's
  workspace scope must control visibility; product-specific ranking is only a
  tie-breaker when the caller did not provide scope.
- Do not remove public HTTP, CLI, SDK, or LLM-tool contracts while repairing
  internals. Deprecate and migrate a public contract deliberately.
- Do not implement a general semantic search engine or redesign the full
  codegraph schema in this work.
- Do not treat regex-parser success as syntax validity. Parser coverage and
  syntax-error reporting remain separate tree-sitter work.

## Confirmed Gaps

| Area | Current behavior | Required outcome |
|---|---|---|
| Factory exports | `Tool.define`, `Layer.*`, and `Context.*` assignments are indexed. | Retain coverage; do not repeat this phase. |
| Focus directories | `findSymbol` does one `getFile` query per candidate and compares raw caller paths. When no candidate is in scope it returns every candidate with `kept: 0`. | Normalize paths once, batch file lookup, and make the fallback/ambiguity contract explicit. |
| Query search | `repository_query` only invokes FTS for multi-token misses. `Search` still materializes all nodes and edges for every mode; graph scoring is a stub. | Use SQL/FTS for normal lookup and restrict in-memory fuzzy matching to a bounded candidate set. |
| Traversal | Multiple BFS implementations issue edge queries per node and use `Array.shift()`. | Use one shared frontier traversal with batched edge/node fetches and deterministic bounds. |
| Test discovery | Fallback loads all files/nodes and permits substring matches against test code. | Prefer verified graph/import evidence; return confidence and do not create exact links from a name substring alone. |
| Limits | `query.limit` does not consistently bound symbols, graph nodes, graph edges, files, or related work. | Apply bounded limits at repository-query boundaries and report truncation. |
| Path handling | Relative lookup normalization exists, but workspace focus directories are not normalized against the indexed root. | Normalize at one boundary and reject paths outside the declared workspace where an endpoint accepts a filesystem path. |

## Delivery Principles

1. Ship behavior changes with regression tests that reproduce the wrong result.
2. Preserve existing output fields; add diagnostics and truncation metadata
   rather than relying on undocumented ranking behavior.
3. Make SQL retrieval set-based before tuning ranking heuristics.
4. Keep each pull request independently typechecked and tested from its package
   directory. Regenerate the JS SDK only if HTTP schemas or routes change.

## Phase 0: Establish the Contract and Baseline

1. Add fixture graph tests with duplicate symbols in `packages/opencode`,
   `packages/web`, and two caller-selected focus directories.
2. Add an integration test that indexes a fixture, then exercises the HTTP and
   LLM-tool paths with the same input and compares the selected node IDs.
3. Define result diagnostics for:
   - exact resolution;
   - qualified resolution;
   - focus-directory preference;
   - product tie-breaker;
   - FTS fallback;
   - unresolved symbol;
   - truncated result.
4. Record query count and elapsed time in test-only instrumentation for a
   medium fixture. This is the baseline for the traversal and search phases.

Acceptance:

- Every ambiguity test asserts node IDs and file paths, not only display names.
- The same query through HTTP and the LLM tool returns the same selected IDs.

## Phase 1: Make Resolution Scoped and Deterministic

Primary files:

- `packages/core/src/banyancode/repository-intelligence/layer.ts`
- `packages/core/src/banyancode/symbol-resolver.ts`
- `packages/core/src/banyancode/codegraph-repo.ts`

1. Normalize `workspace.focusDirs` relative to `codegraph_meta.indexed_root`.
   Use slash-normalized graph-relative paths for every comparison.
2. Fetch candidate file records in one batch, not one `getFile` call per node.
   Add a narrow repository method if `nodesByIDs`/existing file APIs cannot
   express this efficiently.
3. Define scope selection precisely:
   - If scoped candidates exist, return only those candidates.
   - If none exist, return no selected candidate and an explicit
     `outside-focus-dirs` diagnostic; do not silently return unrelated nodes.
   - If several scoped exact candidates remain, preserve all of them and report
     ambiguity rather than choosing array order.
4. Apply the same resolved anchor to `explain`, `trace`, `tests`, and `impact`.
   Do not call a second independent name resolver downstream.
5. Keep product-package ranking only for an unscoped exact-name tie. Do not
   remove packages from search results.

Acceptance:

- `focusDirs: ["packages/opencode"]` resolves `TaskTool` in that directory.
- An out-of-scope exact match fails explicitly instead of returning a web/app
  candidate.
- Duplicate in-scope names expose ambiguity and never depend on database row
  order.

## Phase 2: Bound and Push Down Search

Primary files:

- `packages/core/src/banyancode/search/search.ts`
- `packages/core/src/banyancode/codegraph-repo.ts`
- `packages/core/src/banyancode/codegraph.sql.ts`
- `packages/core/src/banyancode/repository-intelligence/layer.ts`

1. Add a migration for an indexed exact-name lookup, such as
   `(name, kind, file_id)`, after validating the query plan against a populated
   fixture database.
2. Replace `listAllNodes()` for exact and prefix search with repository methods
   that use `WHERE name = ?` and anchored `LIKE 'prefix%'` plus a limit.
3. Route multi-token and substring discovery through `codegraph_fts`; keep FTS
   query construction token-safe and deterministic.
4. Restrict fuzzy, camel-case, and snake-case matching to a bounded light-node
   candidate set. Do not select source bodies unless a caller explicitly needs
   them.
5. Remove the `listAllEdges()`/edge-map pass until graph scoring is implemented.
   Do not advertise graph ranking while `graphSignal()` always returns zero.
6. Apply a single validated limit to symbols, related nodes, graph edges, files,
   tests, docs, configs, and Git history. Return per-section truncation counts
   when a result is cut off.

Acceptance:

- Exact and prefix searches do not load every graph node.
- Fuzzy search has a fixed upper bound on candidates and result time.
- A `limit: 20` repository query never returns more than 20 graph nodes or
  edges without an explicit separate section limit.

## Phase 3: Replace Per-node Traversal with Frontier Queries

Primary files:

- `packages/core/src/banyancode/repository-intelligence/layer.ts`
- `packages/core/src/banyancode/codegraph-repo.ts`
- `packages/core/src/banyancode/codegraph-analyzer.ts`

1. Introduce one internal BFS primitive parameterized by direction, allowed edge
   kinds, depth, and result limit. Keep it local until two independent callers
   need a reusable exported API.
2. Store the queue as an array plus head index, not `Array.shift()`.
3. Traverse a complete frontier at a time using batched `IN (...)` edge queries
   and batched node retrieval. Chunk IDs below SQLite bind limits.
4. Mark a node discovered when enqueued. Stop expansion when
   `depth >= maxDepth`; do not append nodes beyond the requested depth.
5. Define relationships precisely:
   - callers/dependents: incoming `calls` and `references`;
   - dependencies: outgoing `calls`, `references`, `imports`, and `extends`;
   - generic related: explicitly labeled mixed-direction traversal.
6. Exclude direct callers from transitive dependents. De-duplicate graph edges
   before returning them.

Acceptance:

- Diamond graphs return each node once.
- `maxDepth: 1` never returns a second-hop node.
- A 1,000-node fixture demonstrates bounded query count by depth, not by node.

## Phase 4: Make Test and Impact Results Evidence-based

Primary files:

- `packages/core/src/banyancode/repository-intelligence/layer.ts`
- `packages/core/src/banyancode/codegraph-indexer.ts`
- `packages/core/src/banyancode/langs/`

1. Prefer `tested_by`, import, and resolved reference/call edges for test
   discovery.
2. Keep text matching only as an explicitly low-confidence candidate list. A
   matching identifier alone must not be returned as an exact test link.
3. Batch test-file and edge lookups; do not load every node/file per request.
4. Audit indexer generation of `tested_by` edges. Require a resolved imported
   module or verified same-file relationship before emitting an exact edge.
5. Make `impact(path)` resolve the file first and traverse its graph nodes; do
   not approximate impact by filename substring matching.
6. Add confidence/derivation diagnostics to tests and impact outputs without
   changing existing output field meanings.

Acceptance:

- A same-named UI component does not cause a tool test to be reported for
  `packages/opencode/src/tool/task.ts`.
- File impact uses graph edges from nodes in the resolved file, not unrelated
  files whose path contains the same basename.

## Phase 5: Parser and Index Integrity Follow-up

Primary files:

- `packages/core/src/banyancode/langs/typescript.ts`
- `packages/core/src/banyancode/langs/query-executor.ts`
- `packages/core/src/banyancode/codegraph-indexer.ts`

1. Keep existing factory-export extraction tests and add variants only when a
   real production factory is missed. Avoid widening regexes speculatively.
2. Move node and edge extraction toward the existing tree-sitter path so TS and
   Python files do not require both tree-sitter and regex parsing for normal
   indexing.
3. Cache query grammar sources at layer initialization rather than reading
   `.scm` files for every source file.
4. Fix the incremental-index queue lifecycle before enabling broader automatic
   catch-up: start parse producers and the bounded queue drain concurrently.
   The present `indexFiles()` producer-first ordering deadlocks above 128 parsed
   files.
5. Dispose or cap cached tree-sitter trees and remove entries for deleted files.

Acceptance:

- An incremental update of 129 files completes.
- Query grammar reads are proportional to language initialization, not files.
- Tree cache growth is bounded and deletion removes the corresponding entry.

## Phase 6: Cleanup and Documentation

1. Delete `packages/core/src/tool/repository-intel-tool.ts` after confirming no
   package imports its deep path. It is a no-op layer and the public tool layer
   is `repository-wave2.ts`.
2. Remove the duplicate `RepositoryWave2.locationLayer` registration from the
   tool registry.
3. Update `ARCHITECTURE.md` and tool descriptions to state the actual
   resolution and confidence behavior.
4. Document the query/result limits and recovery behavior for stale or missing
   graph indexes.
5. Do not add a cache until profiling identifies a repeated, version-keyed query
   worth caching. Any future cache must key by `codegraph_meta.graph_version`.

Acceptance:

- There is one repository-tool registration path.
- Documentation does not promise heuristic certainty where the graph only has
  a fallback candidate.

## Regression Coverage

Add or extend tests for:

- factory exports already covered by the parser;
- duplicate symbols across packages and within focus directories;
- out-of-scope focus directories;
- deterministic ambiguity diagnostics;
- exact, prefix, FTS, and bounded fuzzy search;
- single- and multi-hop directional traversal;
- diamond graph de-duplication and max-depth boundary;
- evidence-based test discovery;
- path-based impact against duplicate file basenames;
- query section limits and truncation metadata;
- HTTP and LLM-tool parity;
- 129-file incremental indexing.

## Recommended Delivery

1. PR 1: Phase 0 and Phase 1. Resolve the wrong-symbol behavior without a
   broad performance refactor.
2. PR 2: Phase 3 and Phase 4. Correct traversal, test evidence, and impact
   semantics as one graph-behavior change.
3. PR 3: Phase 2. Add SQL/FTS pushdown and result bounds after correctness
   contracts exist.
4. PR 4: Phase 5. Isolate parser/indexer lifecycle work because it has a wider
   performance and correctness blast radius.
5. PR 5: Phase 6. Remove dead wiring and align documentation after the runtime
   paths are stable.

Run `bun typecheck` and targeted `bun test` from `packages/core` and
`packages/opencode` after each PR. Regenerate the JS SDK when a route or schema
changes.
