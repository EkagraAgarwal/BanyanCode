# BanyanCode — Code graph + embeddings

> See `ARCHITECTURE.md` for the broader design. This file covers the code graph and embeddings pipeline in detail.

A polyglot code graph that captures files, nodes (functions/classes/types), and edges (imports/calls/extends). Built via tree-sitter for first-class languages, regex for the rest. Phase 2 adds embeddings over the same nodes for semantic search.

## Mental model

```
                  /codegraph-build
                          │
                          ▼
                  ┌──────────────┐
                  │   indexer    │  tree-sitter / regex
                  └──────┬───────┘
                         │ upsert
              ┌──────────┼──────────┐
              ▼          ▼          ▼
         codegraph_files  nodes  edges
                                │
                                ▼
                       /code-embed (Phase 6)
                                │
                                ▼
                      codegraph_embeddings
                                │
                                ▼
                         code_search
```

## Languages

First-class (tree-sitter):
- TypeScript, TSX (`tree-sitter-typescript`)
- JavaScript (`tree-sitter-javascript`)
- Python (`tree-sitter-python`)
- Go (`tree-sitter-go`)
- Rust (`tree-sitter-rust`)

Fallback (regex import detection):
- All other languages. Detects top-level `import` / `from` / `require` patterns. Lower accuracy.

The `registry.ts` maps file extension to parser. When the parser throws, the indexer falls back to regex.

## Indexer

`packages/core/src/codegraph/indexer.ts`:

```ts
export class CodegraphIndexer extends Context.Service<CodegraphIndexer, {
  readonly index: (input: { root: string; force?: boolean; onProgress?: (info: { file: string; done: number; total: number }) => void }) => Effect.Effect<{ indexed: number; skipped: number }, CodegraphError>
  readonly cancel: () => Effect.Effect<void>
}>()("@banyancode/CodegraphIndexer") {}
```

Behavior:

- Walks `root` recursively, skipping `.git`, `node_modules`, `dist`, `build`, `.sst`, `.opencode/`.
- For each file: compute SHA-256 hash. If the hash matches `codegraph_files.hash` and `force` is not set, skip.
- For first-class languages: parse with tree-sitter, walk the AST, emit `codegraph_nodes` (file, function, class, method, type, variable) and `codegraph_edges` (imports, calls, extends, implements, uses, references).
- For other languages: regex `^import\s+...`, `^from\s+...`, `require\(...\)` etc. Emit `codegraph_nodes` (file) and `codegraph_edges` (imports) only.
- `text_excerpt` per node: first 512 characters of the source for the node's body. Used as the embedding input.
- `onProgress` is called every 50 files. The TUI renders it.

Cancellation: an internal `Ref<boolean>` flipped by `cancel()`. The walker checks it after every file.

## Tools

### `codegraph_build`

```ts
{ input: { root?: string, force?: boolean },
  output: { indexed: number, skipped: number, duration_ms: number } }
```

Default `root`: current working directory.

### `codegraph_query`

```ts
{ input: { file?: string, function?: string, kind?: "file" | "function" | "class" | "method" | "type" | "variable" },
  output: { nodes: CodegraphNode[] } }
```

### `codegraph_impact`

```ts
{ input: { nodeID: string },
  output: { dependents: CodegraphNode[], transitive: CodegraphNode[] } }
```

`transitive` is the BFS of `codegraph_edges` where `to_node = X`, capped at depth 5 by default.

### `codegraph_dependents`

```ts
{ input: { nodeID: string }, output: { dependents: CodegraphNode[] } }
```

### `codegraph_callers`

```ts
{ input: { nodeID: string }, output: { callers: CodegraphNode[] } }
```

### `code_search`

```ts
{ input: { query: string, limit?: number, fileGlob?: string },
  output: { hits: Array<{ node: CodegraphNode; score: number }>, degraded: boolean } }
```

`score` is cosine similarity if `BANYANCODE_EMBEDDING_MODEL` is set, else a simple BM25 score.

### `code_embed_update`

```ts
{ input: { file?: string },
  output: { embedded: number, skipped: number, model: string | undefined } }
```

If `file` is unset, embeds all nodes. If a file is set, embeds only the nodes in that file. Re-embeds nodes whose `text_excerpt` has changed.

## Slash commands

`/codegraph-build` → `codegraph_build` with `force: true`. Run from a clean state.

`/code-embed` → `code_embed_update` with no `file`. Embed everything.

Both commands are registered in `packages/opencode/src/command/index.ts` and the templates live in `packages/opencode/src/command/template/codegraph-build.txt` and `code-embed.txt`.

## Event ownership — `banyancode.codegraph.build`

The build service exposes a bounded `events()` queue (`Queue.bounded(64)`) that downstream consumers drain. The bridge in `packages/opencode/src/effect/banyancode-codegraph-bridge.ts` is the **sole** owner of that queue: it pulls every event and republishes through `EventV2Bridge` (which stamps the instance/workspace location so the TUI can filter by workspace).

The build service layer MUST NOT add an internal drain on the same queue. Effect `Queue` is single-consumer; a second drain will race the bridge and roughly half of the progress events will be lost. The TUI's `banyancode.codegraph.build` subscription is the most visible casualty — without every event, the progress widget stays at `0/0 Running` even though the indexer is happily writing nodes to the DB. Regression test: `packages/opencode/test/banyancode/codegraph-manual-build.test.ts`.

## HTTP route — `POST /global/codegraph-build`

The build is exposed as a global HTTP route (`POST /global/codegraph-build`) so it works from any route, not only when the user has an active session. The TUI command palette (`app.tsx`) and the prompt-input slash handler (`component/prompt/index.tsx`) both call this endpoint directly via `sdk.client.global.codegraph.build({...})`. The handler resolves `root` from `InstanceState.context.worktree` if not provided, and runs the kickoff inside `AppRuntime.runFork(...)` so the forked build fiber outlives the HTTP request. The build service's `start()` uses `Effect.forkDetach(forkWork)` so the work runs in the runtime's global scope (never closed) — this avoids `Effect.forkScoped`'s "Scope not in context" failure that silently killed earlier attempts. Reference: `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:174-189` and `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:106-118`.

## Acceptance criteria (from the master plan)

- `codegraph_build` over the BanyanCode repo itself indexes 100% of `.ts`/`.tsx` files with no errors.
- `codegraph_callers({ function: "SessionV2.prompt" })` returns the test file, the orchestrator prompt, and the task tool call site.
- `codegraph_impact` returns the full transitive dependent set within 1 s for the same fixture.
- Tree-sitter WASM loads in Bun (`web-tree-sitter` already vendored in `packages/opencode/package.json`). The same code path works under Node for CI.
- The indexer is **cancellable** via an `AbortController` plumbed through the Effect layer (no leaks if the user hits `Esc`).
- With `BANYANCODE_EMBEDDING_MODEL=openai/text-embedding-3-small`, `code_search("error handling in session runner")` returns the matching function in the top 3.
- Without the env var, `code_search` returns keyword-match results and `degraded: true`.

## Open question (deferred)

- Should the indexer run incrementally in the background on file save? **No, opt-in via a watcher. Defer to a later phase.**
- Should `codegraph_build` deduplicate identical files by hash? **Yes, the `codegraph_files.hash` column already does this. `force: true` re-parses regardless.**
- Should `code_search` support hybrid scoring (BM25 + cosine)? **Yes, in a later phase.**
