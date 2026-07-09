# Tool Resolution Inconsistency — Investigation Plan

Captured 2026-07-08 from a session running an "Available tools inquiry" agent that exercised the BanyanCode MCP/codegraph tools. The graph had been freshly built.

## Observations

### Working well

- `codegraph_remove` / `codegraph_build` — both executed cleanly
- `blast_radius` — returned detailed blast radius data
- `repository_query` — rich results for `"permission"`; failed gracefully for `"session recovery"` with a recovery hint
- `repository_explain` — returned full architectural slice
- `safe_rename` — dry-run correctly identified 9,930 transitive dependents and 92 test files

### Mixed / degraded resolution

- `code_find` for `Effect.gen` and `ToolCatalog` — both fell back to name-like / tag-fallback matching rather than exact symbol resolution. The graph may not have captured the primary type-definition nodes for these symbols (they're generic `class Service` tags).
- `repository_trace` for `Effect.gen` — only traced to a doc file, not actual call sites.
- `preflight` for `MemoryRepo.put` — returned `"no target found"` despite `blast_radius` showing it has 9,930 transitive callers. **Inconsistent resolution between tools** on the same target.

### Root cause likely

The graph indexed many generic `class Service` nodes (likely from `Context.Service<Service, Interface>()("@.../Service")` factories in `packages/core/src/banyancode/*` and elsewhere). When multiple symbols share the same `Context.Service` tag, the symbol resolver picks one of them via tag-fallback rather than name-based or path-based resolution.

## Open questions for investigation

- Does `codegraph_build --force` produce a different result? The graph was already freshly built at the time of the report, so this is unlikely to matter.
- Are the degraded matches coming from `code_find`'s substring matching in `SymbolResolver`, or from `codegraph_repo.findSymbolsByServiceTag`? (Need to trace exactly which path returned `Effect.gen` and `ToolCatalog`.)
- Is `MemoryRepo.put` literally the same target identity that `blast_radius` used, or did the two tools resolve to different identities? If different, the inconsistency is in the resolver; if the same, it's a target-not-found bug in `preflight`.
- Are there other resolution paths the tools should be sharing (a `RepositoryContext` or shared symbol table)?

## Proposed investigation order

1. Read `packages/core/src/banyancode/symbol-resolver.ts` and trace the `findByServiceTag` fallback. Confirm it matches by tag when multiple services share the tag, and document the precedence (name → tag → substring).
2. Read `packages/core/src/tool/preflight.ts` and `packages/core/src/tool/blast-radius.ts`. Identify the resolution path each one uses. If they share `symbol-resolver`, they should produce the same answer for the same target identity.
3. Trace a single target (`MemoryRepo.put`) through both tools' resolution paths in a REPL or test, capturing the intermediate nodes.
4. If `codegraph_build --force` is cheap to retry (likely <60s for an incremental rebuild), do that first as a sanity check before digging into the resolver.

## Land in

This investigation is **out of scope** for the current UI v2 overhaul. Best landing spot:

- A new "PR X: investigate code_find / preflight resolver inconsistency" PR
- Or a CHORUS-2 follow-up ticket (separate task)

Dependencies: requires a real session + graph build. Cannot be implemented in a sandboxed unit test alone.
