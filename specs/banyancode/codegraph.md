# BanyanCode — Code graph + embeddings

> See `ARCHITECTURE.md` for the broader design. This file covers the code graph and embeddings pipeline in detail.

A polyglot code graph that captures files, nodes (functions/classes/types), and edges (imports/calls/extends). Built via tree-sitter for first-class languages, regex for the rest. Phase 2 adds embeddings over the same nodes for semantic search.

## Mental model

```
  /codegraph-build  |  opencode codegraph build  |  POST /global/codegraph-build
                          │
                          ▼
                  ┌──────────────┐
                  │   indexer    │  tree-sitter / regex (8-way parse, batched writes)
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

`packages/core/src/banyancode/langs/registry.ts` maps file extension to parser. When the parser throws, the indexer falls back to regex.

## Indexer

`packages/core/src/banyancode/codegraph-indexer.ts` — `Banyan.CodegraphIndexer.Service`.

Behavior:

- Walks `root` recursively, skipping `.git`, `node_modules`, `dist`, `build`, `.sst`, `.opencode/`, `.banyancode/`, plus patterns from `.gitignore` and `.banyancode/ignore`.
- For each file: compute SHA-256 hash. If the hash matches `codegraph_files.hash` and `force` is not set, skip.
- For first-class languages: parse with tree-sitter, walk the AST, emit `codegraph_nodes` (file, function, class, method, type, variable, plus Wave 1 file-level kinds: `test`, `route`, `config`, `build`, `package`, `generated`) and `codegraph_edges` (imports, calls, extends, implements, uses, references, plus Wave 1 kinds: `tested_by`, `configured_by`, `built_by`, `mounts`, `generated_from`).
- For other languages: regex `^import\s+...`, `^from\s+...`, `require\(...\)` etc. Emit `codegraph_nodes` (file) and `codegraph_edges` (imports) only.
- `text_excerpt` per node: first 512 characters of the source for the node's body. Used as the embedding input.
- `onProgress` fires after each file. The TUI, CLI, and HTTP bridge all consume `banyancode.codegraph.build` events.

**Pipeline.** Eight parse fibers offer parsed file graphs into `Queue.bounded(128)`. A single consumer drains the queue and calls `writeFileGraph` per file. Producers and the consumer run concurrently (`Effect.all` with `concurrency: 2`) so the queue cannot deadlock when full. Post-walk reference edges are deduped and skip artifact node kinds. `putEdges` batches inserts in groups of 1000 inside one transaction per batch.

Cancellation: `CodegraphBuildService.cancel()` flips an internal flag; the walker checks it after every file. `forceKill()` interrupts the build fiber and, on Windows, falls back to `taskkill` when interrupt alone is insufficient.

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

| Command | Effect |
|---------|--------|
| `/codegraph-build` | Kick off build via `POST /global/codegraph-build` (`force: true` by default in template) |
| `/codegraph-cancel` | Cancel in-flight build |
| `/codegraph-remove` | Drop the current index from SQLite |
| `/code-embed` | `code_embed_update` with no `file` — embed everything |

Wave 1 repository-intelligence slash commands (`/codegraph-search`, `/codegraph-find-routes`, etc.) are registered alongside these in `packages/opencode/src/command/index.ts`.

## CLI — `opencode codegraph`

`packages/opencode/src/cli/cmd/codegraph.ts` — works with `BANYANCODE_ENABLE=1`, no TUI session required:

| Subcommand | Description |
|------------|-------------|
| `build [--root PATH] [--force] [--watch] [--timeout N]` | Start a build; streams progress in TTY |
| `status` | Print current build state |
| `cancel` | Cancel in-flight build |
| `force-kill` | Interrupt stuck build (Windows: `taskkill` fallback) |
| `path` | Print resolved `banyancode.db` path |

## Event ownership — `banyancode.codegraph.build`

The build service exposes a bounded `events()` queue (`Queue.bounded(64)`) that downstream consumers drain. The bridge in `packages/opencode/src/effect/banyancode-codegraph-bridge.ts` is the **sole** owner of that queue: it pulls every event and republishes through `EventV2Bridge` (which stamps the instance/workspace location so the TUI can filter by workspace).

The build service layer MUST NOT add an internal drain on the same queue. Effect `Queue` is single-consumer; a second drain will race the bridge and roughly half of the progress events will be lost. The TUI's `banyancode.codegraph.build` subscription is the most visible casualty — without every event, the progress widget stays at `0/0 Running` even though the indexer is happily writing nodes to the DB. Regression test: `packages/opencode/test/banyancode/codegraph-manual-build.test.ts`.

## HTTP routes (global)

BanyanCode workspace-level codegraph commands live on `/global/*`, not `/session/{id}/*`, so they work without an active chat session.

| Route | Purpose |
|-------|---------|
| `POST /global/codegraph-build` | Start build |
| `POST /global/codegraph-cancel` | Cancel in-flight build |
| `POST /global/codegraph-force-kill` | Force-kill stuck build |
| `POST /global/codegraph-remove` | Remove index |

The TUI command palette and prompt slash handler call these via `sdk.client.global.codegraph.*`. The build handler resolves `root` from `InstanceState.context.worktree` when omitted and runs kickoff inside `AppRuntime.runFork(...)` so the build fiber outlives the HTTP request. `CodegraphBuildService.start()` uses `Effect.forkDetach` (not `forkScoped`) so work runs in the runtime global scope. Reference: `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts` and `groups/global.ts`.

## Acceptance criteria

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
