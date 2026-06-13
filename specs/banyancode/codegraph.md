# BanyanCode — Code graph + embeddings

> Companion to `BANYANCODE_PLAN.md` Phase 5, 6.

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
