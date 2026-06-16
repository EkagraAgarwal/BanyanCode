# BanyanCode Architecture & System Reference

This document provides a comprehensive, deep-dive architectural review of **BanyanCode** (a multi-agent CLI/TUI-only fork of **OpenCode**). It documents how files and functions are connected, maps the package boundaries, details the schemas and topologies, identifies bugs and implementation gaps, and outlines recommended paths to resolve them.

---

## 1. Executive Summary & Product Split

BanyanCode is partitioned side-by-side with OpenCode. While they reside in the same repository and share standard systems (e.g., Effect runtimes, Drizzle sqlite drivers, tool registry), they maintain strict isolation at the product boundary.

| Concern | OpenCode | BanyanCode |
| :--- | :--- | :--- |
| **Feature Flag** | Standard execution | `BANYANCODE_ENABLE=1` |
| **Config File** | `opencode.json` | `banyancode.json` |
| **Config Directory** | `~/.config/opencode/` | `~/.config/banyancode/` |
| **Data Directory** | `~/.local/share/opencode/` | `~/.local/share/banyancode/` |
| **State Directory** | `~/.local/state/opencode/` | `~/.local/state/banyancode/` |
| **Database** | `opencode.db` | `banyancode.db` |
| **Env Var Prefix** | `OPENCODE_*` | `BANYANCODE_*` |
| **Config Schema** | `ConfigV1.Info` | `BanyanConfig.Info` |
| **Primary Interfaces** | Desktop, Web, Storybook, TUI | CLI / TUI-only |

When `BANYANCODE_ENABLE` is active, BanyanCode registers the `orchestrator` and `researcher` agents, enables memory/codegraph/mesh tools, and sets up custom sqlite database paths.

---

## 2. Directory Layout & Monorepo Package Map

```
D:\opencode\
├── packages/
│   ├── core/                  # Core service layer, database schemas, BanyanCode services
│   ├── opencode/              # Execution host, prompt templates, tool overrides (e.g., task tool)
│   ├── tui/                   # SolidJS-based terminal user interface
│   ├── effect-drizzle-sqlite/ # Effect-TS bindings for Drizzle ORM
│   ├── effect-sqlite-node/    # Low-level Node-SQLite bindings
│   └── sdk/                   # OpenAPI specifications & generated TS client SDK
├── specs/
│   └── banyancode/            # Phase specifications (types, storage, memory, mesh, etc.)
└── BANYANCODE_PLAN.md         # Master roadmap
```

### 2.1 Package Roles & Dependency Flow

```mermaid
graph TD
    TUI[packages/tui] -->|Invokes Client SDK| SDK[packages/sdk]
    TUI -->|Interacts with local server| CLI[packages/opencode]
    CLI -->|Imports Core Services| Core[packages/core]
    Core -->|ORM Operations| Drizzle[packages/effect-drizzle-sqlite]
    Drizzle -->|Low-Level DB| SQLite[packages/effect-sqlite-node]
```

1. **`packages/core`**: Declares database schemas, implements domain repos, and exposes services as Effect-TS `Context.Service`. 
2. **`packages/opencode`**: Exposes the main executable runtime, binds system context builders, loads agent prompts, manages background fibers, and defines execution boundaries.
3. **`packages/tui`**: A terminal UI built with SolidJS and `opentui` wrappers. Communicates with `packages/opencode` using the event bus (`EventV2` bridge).

---

## 3. Subsystem Deep-Dives

### 3.1 Session Runtime & Context Epochs
The Session Runtime (defined in `packages/core/src/session/`) coordinates LLM interaction while maintaining a durable audit history.

* **Context Epochs (`context-epoch.ts`)**: Represents the span where the initial `System Context` rendered to the provider remains immutable. Implements Optimistic Concurrency Control using `RevisionMismatch` retries.
* **System Context (`packages/core/src/system-context/`)**: An aggregate builder combining several `Context Source` items (such as the global `AGENTS.md` instructions, local workspace configuration, active calendar date, etc.) that renders into a baseline system prompt at the start of an epoch.
* **Inbox Reconciliation (`input.ts`)**: Admitting user input durably in FIFO fashion before scheduling execution turns.

### 3.2 BanyanCode Multi-Agent Mesh & subagent-bus
BanyanCode introduces parallel agent coordination using a hub-and-spoke mesh topology:

* **Orchestrator Agent**: Decomposes requests into subagent tasks, spawns them, and coordinates their results.
* **Subagent Bus (`subagent-bus.ts` / `subagent-messages-repo.ts`)**: A durable sqlite-backed queue implementing fire-and-persist message delivery between agents.
* **Mesh Control (`mesh-control.ts` / `mesh-coordinator.ts`)**: Exposes actions to `steer` (inject instruction), `kill` (force terminate), `checkin` (retrieve subagent check-points), and `plan_for` (provide steps).

### 3.3 Code Graph Indexer (single-pass with deferred resolution)
The Code Graph subsystem (defined in `packages/core/src/banyancode/`) builds a polyglot representation of a project workspace. The indexer is **single-pass** at the file level:

* **File discovery**: Walks the directory using `.gitignore` and `.banyancode/ignore` configurations. SHA-256 content hashes enable incremental indexing (unchanged files are skipped).
* **Parsing**: For each file, a per-extension language parser emits nodes (functions, classes, methods, types) plus `contains` edges from a synthetic file node. Imports and class extensions are emitted with `to_target_key` set and `to_node_id` null — these are "unresolved" at index time.
* **Unresolved edges**: Persisted in `codegraph_edges` with `to_node_id = null, to_target_key = "<file>::<name>"`. The repo exposes `unresolvedEdgesFor(rootID)` for the analyzer to lazily resolve later (the second pass is currently a future enhancement; today the graph is queried directly via `to_node_id` or `to_target_key`).
* **Two-pass refinement (planned)**: A future enhancement will walk unresolved edges after the first pass and rewrite them as resolved edges when targets are found.
* **FTS5 Integration**: Trigger-synchronized sqlite virtual tables (`codegraph_fts_ai`/`ad`/`au`) keep `codegraph_fts` in sync with `codegraph_nodes` for BM25 lexical search.
* **Parsers (current)**: Regex-based for TS/TSX, JS/JSX, Python, Go, Rust. `tree-sitter-setup.ts` provides lazy WASM loaders for all 5 grammars; the parsers fall through to regex when tree-sitter is not loaded. Switching the parsers to tree-sitter by default requires an async parser signature and is tracked as a future enhancement.

### 3.4 GraphRAG Retrieval
`code_search` (in `packages/core/src/tool/code-embed.ts`) implements a 5-mode retrieval pipeline:

* **Modes**: `auto`, `lexical` (FTS5 BM25 only), `semantic` (vector cosine only), `graph` (graph expansion only), `hybrid` (default — FTS + vector + graph).
* **Pipeline** (hybrid mode):
  1. Lexical seeds via `repo.searchFTS(query, limit * 2)` (BM25)
  2. Vector seeds via cosine similarity when `BANYANCODE_EMBEDDING_MODEL` is configured
  3. Reciprocal rank fusion (RRF, k=60) of both seed lists
  4. Graph expansion BFS up to `maxDepth` (default 2) along edges. Decay = `1 / (1 + d)`. Expansion score = `seedScore * edgeWeight * decay * 0.5`. Edge weights: `imports=1.0, calls=0.8, extends/implements=0.6, references=0.4, exports=0.5, contains=0.3`.
  5. Output: `{ id, file, range, name, kind, score, reason, code? }` with `reason` tracing the path from a seed to the result (e.g. `seedName --imports--> neighborName`).
* **Degraded mode**: When no embedding model is configured, the tool returns `degraded: true` with a `warning` field, still doing lexical + graph search.

### 3.5 `codegraph_status` Tool
A read-only status tool that reports the state of all indexed roots plus any active build job:

* Returns list of roots with `lastBuildAt`, `indexedFileCount`, `nodeCount`, `edgeCount`, `embeddingModel`, `parserVersion`, `createdAt`.
* Returns `activeJob` (state, root, done, total, currentFile) when a build is in progress; `null` when idle.
* Per-state UI in `packages/tui/src/component/codegraph-progress.tsx`: `not_indexed`, `stale`, `indexing`, `ready`, `embeddings_missing`, `embedding_stale`, `failed`. ASCII-safe bar rendering (no Unicode mojibake).

---

## 4. Database Schema & Persistence

All BanyanCode data is stored in `banyancode.db` using Drizzle tables.

```mermaid
erDiagram
    codegraph_roots ||--o{ codegraph_files : contains
    codegraph_files ||--o{ codegraph_nodes : contains
    codegraph_files ||--o{ codegraph_edges : has
    codegraph_nodes ||--o{ codegraph_edges : "from/to"
    codegraph_nodes ||--o{ codegraph_embeddings : has
    codegraph_nodes ||--|| codegraph_fts : indexes
    memory_entries }o--o| codegraph_embeddings : reference
```

### 4.1 Schema Definitions

#### `codegraph_roots`
Tracks project root workspaces and indexing status.
* `id` (TEXT, Primary Key)
* `root_path` (TEXT, Unique)
* `last_build_at` (INTEGER)
* `indexed_file_count` (INTEGER)
* `node_count` (INTEGER)
* `edge_count` (INTEGER)
* `embedding_model` (TEXT)
* `parser_version` (TEXT)
* `created_at` (INTEGER)

#### `codegraph_files`
Represents indexed source files.
* `id` (TEXT, Primary Key)
* `root_id` (TEXT, Foreign Key -> `codegraph_roots.id` ON DELETE CASCADE)
* `path` (TEXT)
* `content_hash` (TEXT) - SHA-256 hash of file contents for change-detection.
* `byte_size` (INTEGER)
* `language` (TEXT)
* `parser_version` (TEXT)
* `indexed_at` (INTEGER)

#### `codegraph_nodes`
Stores structural entities (functions, classes, interfaces).
* `id` (TEXT, Primary Key)
* `file_id` (TEXT, Foreign Key -> `codegraph_files.id` ON DELETE CASCADE)
* `kind` (TEXT)
* `name` (TEXT)
* `qualified_name` (TEXT)
* `start_line` (INTEGER)
* `start_byte` (INTEGER)
* `end_line` (INTEGER)
* `end_byte` (INTEGER)
* `language` (TEXT)
* `signature` (TEXT)
* `doc` (TEXT)
* `text_excerpt` (TEXT)
* `node_code_hash` (TEXT) - djb2 hash of the node's code.
* `created_at` (INTEGER)

#### `codegraph_edges`
Records semantic relationships.
* `id` (TEXT, Primary Key)
* `from_node_id` (TEXT, Foreign Key -> `codegraph_nodes.id` ON DELETE CASCADE)
* `to_node_id` (TEXT, Nullable, References -> `codegraph_nodes.id`)
* `to_target_key` (TEXT, Nullable) - Used for unresolved imports or external symbols.
* `file_id` (TEXT, Foreign Key -> `codegraph_files.id` ON DELETE CASCADE)
* `line` (INTEGER)
* `kind` (TEXT) - e.g., `contains`, `imports`, `calls`, `extends`
* `weight` (INTEGER)

#### `codegraph_embeddings`
Stores float vector representations of node code.
* `id` (TEXT, Primary Key)
* `node_id` (TEXT, Foreign Key -> `codegraph_nodes.id` ON DELETE CASCADE)
* `embedding` (BLOB) - Serialized Float32Array bytes.
* `model` (TEXT)
* `base_url_hash` (TEXT)
* `input_hash` (TEXT)
* `dim` (INTEGER)
* `encoding_format` (TEXT)
* `created_at` (INTEGER)

#### `codegraph_fts`
Sqlite FTS5 virtual table for lexical searches.
* Virtual columns: `node_id` (UNINDEXED), `qualified_name`, `name`, `doc`, `text_excerpt`.
* Kept in sync via SQLite triggers `codegraph_fts_ai`, `codegraph_fts_ad`, and `codegraph_fts_au`.

#### `memory_entries`
Cross-session semantic memory store.
* `id` (TEXT, Primary Key)
* `key` (TEXT)
* `value` (TEXT) - JSON-stringified payload.
* `context` (TEXT, Nullable)
* `tags` (TEXT) - JSON array.
* `scope` (TEXT) - `global` or `session`.
* `session_id` (TEXT, Nullable)
* `expires_at` (INTEGER, Nullable)
* `created_at` (INTEGER)
* `embedding_id` (TEXT, Nullable, References `codegraph_embeddings.id`)
* `access_count` (INTEGER)
* `last_accessed_at` (INTEGER)
* `updated_at` (INTEGER)
* `ttl_seconds` (INTEGER)

---

## 5. Identified Bugs, Security Risks, & Architectural Deficiencies

During a deep codebase analysis, 8 major architectural bugs and implementation gaps were found. Status reflects the BanyanCode GraphRAG amendment work landing in late June 2026.

| # | Title | Status | Landed in |
|---|---|---|---|
| 5.1 | Stale Embeddings Skipped in `CodegraphEmbedder` | **OPEN** — fix in flight | (this PR) |
| 5.2 | `markStaleEmbeddings` is Dead Code | **OPEN** — fix in flight | (this PR) |
| 5.3 | Web Tree-Sitter is Unused in Parsers | **OPEN** (intentional) | `tree-sitter-setup.ts` exists; parsers fall through to regex until the async-parser refactor lands |
| 5.4 | `shared_memory` is a Global In-Memory Map | **OPEN** — fix in flight | (this PR) |
| 5.5 | `SubagentConsumer.start` is Statically Stubbed to `Effect.void` | **OPEN** — fix in flight | (this PR) |
| 5.6 | Context Blindness in Memory Tools | **OPEN** — fix in flight | (this PR) |
| 5.7 | GraphRAG and Reciprocal Rank Fusion Unimplemented | **FIXED** | commit `b3c42f8` (Step 6+7) |
| 5.8 | Windows `TS1149` Case-Sensitivity Failures | **MITIGATED** | always run from `D:\OpenCode` (capital O); no `forceConsistentCasingInFileNames` set |

### 5.1 [Critical Bug] Stale Embeddings Skipped in `CodegraphEmbedder`
* **Source Location**: [codegraph-embedder.ts](file:///D:/opencode/packages/core/src/banyancode/codegraph-embedder.ts#L63-L65) and [L87-L89](file:///D:/opencode/packages/core/src/banyancode/codegraph-embedder.ts#L87-L89)
* **Root Cause**: The methods `embedFile` and `embedAll` check for the existence of any embedding for the node ID:
  ```typescript
  const existing = yield* repo.getEmbedding(node.id)
  if (existing) {
    skipped++
    continue
  }
  ```
  If any row is returned, the node is skipped entirely. This bypasses the validation logic inside `embedNode` which verifies if the existing embedding is stale (checking if `model === activeModel && baseUrlHash === activeBaseUrlHash && inputHash === activeInputHash`).
* **Impact**: Changing the embedding model, the endpoint base URL, or modifying code inside a function will NOT update the embeddings unless a database clean / rebuild is forced. The system is left with mismatched, stale, or obsolete vectors.

### 5.2 [Critical Bug] `markStaleEmbeddings` is Dead Code
* **Source Location**: [codegraph-repo.ts](file:///D:/opencode/packages/core/src/banyancode/codegraph-repo.ts#L541-L554)
* **Root Cause**: The method `markStaleEmbeddings` is declared and implemented in `CodegraphRepo` to clean up vectors that do not match the current model config. However, this method is never invoked anywhere in production (it is only stubbed out in tests).
* **Impact**: Mismatched/stale embeddings remain in the DB indefinitely when the user switches model config, occupying storage and corrupting semantic search lists.

### 5.3 [Critical Gap] Web Tree-Sitter is Unused in Parsers
* **Source Location**: [registry.ts](file:///D:/opencode/packages/core/src/banyancode/langs/registry.ts) and [tree-sitter-setup.ts](file:///D:/opencode/packages/core/src/banyancode/langs/tree-sitter-setup.ts)
* **Root Cause**: The indexer declares an async tree-sitter wasm setup but never imports it or executes it within the language parsers (`typescript.ts`, `javascript.ts`, `python.ts`, `go.ts`, `rust.ts`). Instead, all parsers rely on basic Regular Expressions (`CLASS_REGEX`, `FUNCTION_REGEX`, etc.) to parse code structure.
* **Impact**: Code relationships, imports, and method overrides are parsed using fragile regexes, failing to resolve scopes, nested classes, template literals, and complex calls.
* **Mitigation plan**: Making the parsers async (required for tree-sitter WASM init) is a separate refactor. The `tree-sitter-setup.ts` module is in place and ready to be wired when that work lands.

### 5.4 [Security / Isolation Leak] `shared_memory` is a Global In-Memory Map
* **Source Location**: [shared-memory.ts](file:///D:/opencode/packages/core/src/tool/shared-memory.ts#L23)
* **Root Cause**: The `shared_memory` tool implements cross-subagent shared memory using a global in-memory variable:
  ```typescript
  const store = new Map<string, { value: unknown; tags: string[] }>()
  ```
  It does not partition or namespace entries by the executing session's parent session ID.
* **Impact**: Parallel user sessions or multi-agent runs on the same CLI process share the same keys. Any subagent can read/overwrite the keys of another concurrent subagent run. Additionally, the memory fails to persist across TUI restarts, violating specifications.

### 5.5 [Critical Gap] `SubagentConsumer.start` is Statically Stubbed to `Effect.void`
* **Source Location**: [subagent-consumer.ts](file:///D:/opencode/packages/core/src/banyancode/subagent-consumer.ts#L58)
* **Root Cause**: The `SubagentConsumer` contains a complete message processing loop for plan, steer, and kill commands, but its entry method is stubbed:
  ```typescript
  const start: Interface["start"] = (input) => Effect.void
  ```
* **Impact**: Spawned subagents do not listen to incoming message queues. When the orchestrator publishes `kill` or `steer` instructions, subagents never receive them, making mesh control commands dead-letters.

### 5.6 [Security / Permission Gap] Context Blindness in Memory Tools
* **Source Location**: [memory.ts](file:///D:/opencode/packages/core/src/tool/memory.ts#L128)
* **Root Cause**: The `execute` methods for memory tools (`memory_store`, `memory_recall`, `memory_list`, `memory_forget`, `memory_search`) omit the `context` parameter from their signatures. They verify permissions with hardcoded empty contexts:
  ```typescript
  yield* permission.assert({
    action: name_store,
    resources: [input.key],
    save: ["*"],
    metadata: input,
    sessionID: (input.sessionID ?? "") as any,
    agent: "" as any,
    source: { type: "tool", messageID: "" as any, callID: "" },
  } as any)
  ```
* **Impact**: Subagents can bypass security policies by querying or modifying global memory because the permission manager cannot verify the executing agent or the real caller session.

### 5.7 [Implementation Gap] GraphRAG and Reciprocal Rank Fusion Unimplemented
* **Status**: **FIXED** in commit `b3c42f8` (Step 6+7 of the GraphRAG amendment).
* **Resolution**: `code_search` now accepts `mode: "auto" | "lexical" | "semantic" | "graph" | "hybrid"` (default `hybrid`), runs FTS5 BM25 lexical seeds + cosine-similarity vector seeds + RRF (k=60) + BFS graph expansion with edge-kind-weighted decay (`imports=1.0, calls=0.8, extends/implements=0.6, references=0.4, exports=0.5, contains=0.3`, decay `1/(1+d)`). Returns `{ id, file, range, name, kind, score, reason, code? }` with the seed-to-result path in `reason`.

---

## 6. Recommended Fixes

### 6.1 Fixing Stale Embeddings Skip
Refactor `packages/core/src/banyancode/codegraph-embedder.ts` loops to always delegate checking to `embedNode`, or perform the check on the returned row:
```typescript
// Replace the early-exit check in embedAll and embedFile with:
const existing = yield* repo.getEmbedding(node.id)
const inputHash = provider.inputHash(node.textExcerpt)
if (
  existing &&
  existing.model === model &&
  existing.baseUrlHash === baseUrlHash &&
  existing.inputHash === inputHash
) {
  skipped++
  continue
}
// Proceed to embedNode...
```

### 6.2 WIRING `markStaleEmbeddings`
Call `markStaleEmbeddings` in the indexer lifecycle when model or configuration changes, or inside a build startup sequence in `codegraph-build-service.ts`.

### 6.3 Fixing `shared_memory` Isolation and Persistence
Transition the shared memory map to database storage under the `memory_entries` schema with `scope="session"`, namespaced by the parent session ID (resolvable from `context.sessionID`).

### 6.4 Restoring `SubagentConsumer` Loop
Implement `SubagentConsumer.start` to fork a fiber running the consumer loop:
```typescript
const start: Interface["start"] = (input) =>
  Effect.gen(function* () {
    const queue = yield* bus.subscribe(input.sessionID)
    yield* Effect.forkScoped(loop(input, queue))
  })
```

### 6.5 Correcting Memory Tool Context
Add the `context` parameter to the tool executor signature in `packages/core/src/tool/memory.ts`:
```typescript
// Example:
execute: (input, context) => {
  return Effect.gen(function* () {
    yield* permission.assert({
      action: name_store,
      resources: [input.key],
      save: ["*"],
      metadata: input,
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
    })
    // ...
```

### 5.8 [Windows Environment Casing Issue] TS1149 Case-Sensitivity Failures
* **Root Cause**: On Windows, the folder name casing of the project directory can resolve as either `D:/OpenCode/...` or `D:/opencode/...` depending on the terminal spawn location, package configuration, and relative import resolution in the program. This causes TypeScript's path casing checks to fail with `error TS1149: File name differs only in casing`.
* **Impact**: Running `bun typecheck` in package subfolders can fail on Windows if the active directory casing does not match the cached paths or symlinks exactly, even though the code is functionally correct.
* **Remediation**: Standardize execution commands to match the exact disk casing (`D:\OpenCode` or `D:\opencode`) or configure tsconfig's `forceConsistentCasingInFileNames: false` if path consistency across Windows environments cannot be guaranteed.
