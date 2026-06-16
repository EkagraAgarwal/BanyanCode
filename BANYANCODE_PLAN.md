# BanyanCode — Implementation Plan

> Status: **active plan**. BanyanCode is a CLI/TUI-only fork of OpenCode that adds a parallel subagent mesh, cross-session memory, a 2-phase codebase utility (code graph + embeddings), and a free web search backend for a new researcher agent. Desktop, web, and Storybook packages are explicitly out of scope.
>
> Read order: this file is the master plan. Phase-specific deep dives live in `specs/banyancode/`. Every phase references the spec it depends on.

---

## GraphRAG Codebase Utility Rebuild Amendment

## Summary

- Rebuild the current codegraph/embedding feature as a native SQLite-first GraphRAG system for BanyanCode, keeping TUI/CLI scope only.
- Replace the regex-only parser path in `packages/core/src/banyancode/codegraph-indexer.ts` and `packages/core/src/banyancode/langs/typescript.ts` with real tree-sitter indexing, stable graph storage, and graph-aware retrieval.
- Replace the unimplemented `aisdk.embed` hook path in `packages/core/src/banyancode/embedding-provider.ts` with an OpenAI-compatible `/v1/embeddings` client.
- Fix TUI/codegraph UX, including mojibake in `packages/tui/src/component/codegraph-progress.tsx`, clearer status, and embedding configuration for custom endpoints.
- Keep GraphRAG native to BanyanCode. OpenCode, Claude Code, MCP, and plugin ecosystems are design references for extension surfaces, not dependencies to vendor in this pass.

## Current Implementation Gaps

- The indexer is regex-based and only indexes `.ts`, `.tsx`, `.js`, `.jsx`, and `.py`; it does not implement the polyglot tree-sitter graph promised by the docs.
- Parser output records imports but does not resolve them into durable graph edges.
- Hashing is non-cryptographic and uses absolute file paths, which makes graph identity less stable across machines and roots.
- Incremental indexing skips unchanged files but does not fully clean up stale nodes, edges, or embeddings for changed/deleted files.
- `code_search` is vector scan plus keyword fallback; it does not perform GraphRAG seed selection, graph expansion, path-aware scoring, or rationale output.
- `EmbeddingProvider` depends on an `aisdk.embed` plugin trigger that is typed and test-stubbed but not implemented as a production embedding path.
- The TUI progress widget contains mojibake and only exposes partial build state.

## Storage And Schema

- Add a v2 SQLite schema around:
  - `codegraph_roots`
  - `codegraph_files`
  - `codegraph_nodes`
  - `codegraph_edges`
  - `codegraph_embeddings`
  - `codegraph_fts`
- Store project-relative file paths plus `root_id`, SHA-256 content hashes, parser version, byte ranges, line ranges, node code hash, text excerpt, and optional metadata JSON.
- Store embeddings by `(node_id, model, base_url_hash)` with `input_hash`, `dim`, `encoding_format`, `created_at`, and Float32 blob.
- On migration, clear or supersede incompatible existing codegraph rows rather than attempting to preserve regex-derived node IDs.
- Keep SQLite as the only required backend for v1. Do not introduce Neo4j, Kuzu, or another external graph database in this pass.

## Indexing

- Vendor/load tree-sitter WASM grammars through `web-tree-sitter` for:
  - TypeScript/TSX
  - JavaScript/JSX
  - Python
  - Go
  - Rust
- Keep regex fallback only for file-level and import-level indexing in unsupported languages.
- Use a two-pass indexer:
  - Pass 1 parses files and emits declarations, imports, exports, references, and symbol keys.
  - Pass 2 resolves imports, local references, calls, inheritance, and cross-file relationships into graph edges.
- Emit explicit edge kinds:
  - `contains`
  - `imports`
  - `calls`
  - `extends`
  - `implements`
  - `references`
  - `exports`
- Keep unresolved edges with `target_key` instead of dropping them.
- Use the `ignore` package for `.gitignore` plus `.banyancode/ignore`.
- Index only supported source extensions by default.
- Incremental behavior:
  - Unchanged files skip.
  - Changed files delete and rewrite their nodes, edges, FTS rows, and stale embeddings.
  - Removed files are deleted from the graph.
  - `force` rebuilds the root.

## Embeddings

- Add Banyan config/env keys:
  - `banyancode_embedding_base_url`
  - `banyancode_embedding_model`
  - `banyancode_embedding_api_key_env`
  - `banyancode_embedding_dimensions`
  - `banyancode_embedding_batch_size`
- Default `banyancode_embedding_base_url` to `https://api.openai.com/v1`.
- Read the API key from the configured env var, defaulting to `BANYANCODE_EMBEDDING_API_KEY`.
- POST batches to `{base_url}/embeddings` with:

```json
{
  "model": "MODEL_NAME",
  "input": ["text"],
  "encoding_format": "float",
  "dimensions": 1536
}
```

- Omit `dimensions` when unset.
- Validate response order, vector dimensions, finite numeric values, and response model when present.
- Retry transient `429` and `5xx` failures with bounded backoff.
- Re-embed only when model, base URL, dimensions, or embedding input hash changes.
- Embedding support is OpenAI-compatible HTTP only in this pass, not AI SDK/plugin-based.

## Retrieval And Tools

- Keep existing tool names:
  - `codegraph_build`
  - `codegraph_query`
  - `codegraph_callers`
  - `codegraph_dependents`
  - `codegraph_impact`
  - `code_embed_update`
  - `code_search`
- Upgrade outputs to include useful node summaries with:
  - `id`
  - `file`
  - `range`
  - `name`
  - `kind`
  - `score`
  - `reason`
  - optional `code`
- Add `codegraph_status` for TUI and agents:
  - root
  - last build time
  - indexed file count
  - node count
  - edge count
  - embedding model
  - embedded count
  - stale embedding count
  - active job state
- Make `code_search` GraphRAG by default:
  - Seed with FTS/BM25.
  - Add vector similarity seeds when embeddings are configured.
  - Combine seed ranks with reciprocal rank fusion.
  - Expand over graph neighbors up to `maxDepth`, default `2`.
  - Weight edge types and decay by graph distance.
  - Return paths/rationales showing why related nodes were included.
- Add optional `code_search` inputs:
  - `mode: "auto" | "lexical" | "semantic" | "graph" | "hybrid"`
  - `fileGlob`
  - `maxDepth`
  - `direction: "upstream" | "downstream" | "both"`
  - `limit`
  - `includeCode`
- Degraded behavior:
  - No embedding config: lexical + graph search still works with `degraded: true`.
  - Embedding request failure: fall back to lexical + graph search with an explanatory warning.
  - Empty graph: return empty hits and a status message suggesting `codegraph_build`.

## TUI And CLI UX

- Replace broken Unicode progress glyphs with ASCII-safe rendering.
- Add a compact Codegraph status surface with these states:
  - Not indexed
  - Stale
  - Indexing
  - Ready
  - Embeddings missing
  - Embedding stale
  - Failed
- Add quick actions for:
  - build
  - cancel
  - embed
  - configure embeddings
  - search
- Replace the current embedding model picker with an OpenAI-compatible settings dialog:
  - base URL
  - model
  - API key env var
  - dimensions
  - batch size
  - test connection
- Update slash command text and docs to match actual behavior, including degraded search states and GraphRAG retrieval modes.
- Keep desktop, web, app, and Storybook packages out of scope.

## Implementation Order

1. Add v2 schema, migration, repo methods, and status queries.
2. Replace embedding provider with the OpenAI-compatible HTTP client and config keys.
3. Rework indexer identity, hashing, ignore handling, incremental cleanup, and parser registry.
4. Add tree-sitter parsers for TypeScript/TSX, JavaScript/JSX, Python, Go, and Rust.
5. Implement edge resolution and unresolved edge persistence.
6. Add FTS indexing and lexical search.
7. Implement GraphRAG rank fusion, graph expansion, path/rationale output, and upgraded `code_search`.
8. Upgrade existing tools and add `codegraph_status`.
9. Fix TUI status/progress UX and embedding settings.
10. Update docs, specs, and slash command templates.
11. Add focused tests and run package-level typechecks/tests.

## Test Plan

- Run existing targeted tests from `packages/opencode`.
- Add parser fixture tests for TS/TSX, JS/JSX, Python, Go, Rust, and fallback files.
- Add indexer tests for:
  - SHA-256 hashing
  - relative paths
  - ignore rules
  - incremental skip
  - changed-file rewrite
  - deleted-file cleanup
  - unresolved edge preservation
- Add GraphRAG retrieval tests with deterministic embeddings:
  - lexical-only degraded mode
  - vector seed
  - graph-expanded caller/import neighbor
  - edge-path output
  - max-depth limiting
- Add embedding provider tests using a local fake OpenAI-compatible HTTP server for:
  - success
  - batching
  - missing key
  - invalid dimensions
  - `429` retry
  - base URL config
- Add TUI component/render tests for progress/status text to prevent mojibake and text overflow.
- Run:

```sh
cd packages/core && bun typecheck
cd packages/opencode && bun typecheck
cd packages/tui && bun typecheck
cd packages/opencode && bun test test/banyancode/codegraph.test.ts test/banyancode/codegraph-analysis.test.ts test/banyancode/code-embed.test.ts test/banyancode/codegraph-manual-build.test.ts
```

## Assumptions

- SQLite remains the only required backend for v1 GraphRAG.
- Embedding support is OpenAI-compatible HTTP only, not AI SDK/plugin-based.
- External plugin ecosystems are design references only; do not vendor third-party GraphRAG/code-memory plugins in this pass.
- BanyanCode remains TUI/CLI only for this work.

---
## How to read this document

- **Phases** are ordered. Phase 0 → 1 → 2 are safe to land in one PR. Phase 3+ are independent enough to land in parallel feature branches if desired.
- **Files** are absolute paths from the repo root (Windows: `D:\OpenCode`).
- **Public APIs** show TypeScript signatures only — no full bodies.
- **Acceptance criteria** are the testable contract of a phase. A phase is "done" only when every box is checked.
- **Out of scope** is a real list, not a wishlist — features there are explicitly deferred.

---

## Vision and goals

BanyanCode is OpenCode + a parallel agent mesh, native cross-session memory, and a code-aware research and edit loop. The TUI/CLI experience is identical to OpenCode; the changes are visible only when the user invokes an orchestrator-driven workflow.

The 4 features:

1. **Orchestrator + subagent mesh** — A new primary `orchestrator` agent decomposes tasks, fans out to specialized subagents in parallel, and coordinates them via peer messaging and shared memory.
2. **Cross-session memory** — A persistent, key-value memory store with optional embeddings, exposed as tools and a skill.
3. **2-phase codebase utility** — Phase 5A builds a polyglot code graph (nodes + edges + files) using tree-sitter. Phase 5B / Phase 7 computes embeddings over the same nodes for semantic search.
4. **Researcher agent with free web search** — A new subagent `researcher` that uses a DuckDuckGo-backed `websearch_free` tool as the default, with the existing Exa/Parallel `websearch` tool as an opt-in fallback.

Goals:

- TUI/CLI only. No desktop, web, or Storybook work.
- Reuse the OpenCode systems that already exist (agent, command, skill, tool, bus, Effect runtime, Drizzle storage). The BanyanCode fork should look like a sequence of additions, not a rewrite.
- Keep `@opencode-ai/*` internal package names. Only the user-facing surfaces (binary name, install script, brand text, repo URL) change.
- All new code follows the OpenCode style guide in the root `AGENTS.md` and the Effect v4 rules in `packages/opencode/AGENTS.md`.
- Land in a single coherent `dev` branch and push to a new remote at `https://github.com/EkagraAgarwal/BanyanCode.git`.

---

## Global Changes

These amendments supersede any conflicting statements in the original BanyanCode implementation plan.

### Feature Gate

A new runtime flag is introduced:

```bash
BANYANCODE_ENABLE=1
```

Purpose:

- Safe rollout
- Easy rollback
- Dogfooding support

Location:

```
packages/core/src/effect/runtime-flags.ts
packages/opencode/src/effect/runtime-flags.ts
```

Behavior:

When disabled:

- orchestrator agent is not registered
- researcher agent is not registered
- memory tools are not registered
- codegraph tools are not registered
- mesh tools are not registered
- BanyanCode slash commands are not registered

The existing OpenCode experience remains unchanged.

---

### Shared Types

Canonical definitions live in `specs/banyancode/types.md`:

```ts
export type MemoryEntry
export type CodegraphFile
export type CodegraphNode
export type CodegraphEdge
export type SubagentMessage
export type PeerInfo
```

All tools, repos, and services reference these shared types. No duplicate definitions are permitted.

---

### Resource Limits

#### Subagent Limits

Defaults:

```ts
MAX_PARALLEL_SUBAGENTS = 3
```

Hard cap:

```ts
MAX_PARALLEL_SUBAGENTS_HARD = 5
```

Enforced by:

- MeshCoordinator
- SubagentBus
- orchestrator prompt

#### Memory Limits

Defaults:

```ts
maxEntriesPerScope = 10000
maxValueSizeBytes = 64 * 1024
maxTotalStorageBytes = 100 * 1024 * 1024
```

Memory writes exceeding limits fail with a structured error.

#### Codegraph Ignore Rules

Indexer automatically excludes:

```
node_modules
dist
build
coverage
.next
.cache
target
vendor
```

Respects:

```
.gitignore
.banyancodeignore
```

---

## Confirmed decisions

| Decision | Choice |
|---|---|
| Free websearch backend | DuckDuckGo HTML only. No SearXNG. |
| Embedding model | Provider-agnostic. No default. `BANYANCODE_EMBEDDING_MODEL` env var required. Degrades to keyword search when unset. |
| Code-graph indexer scope | Full polyglot via tree-sitter. Tree-sitter-TS/JS/Python/Go/Rust are first-class. Other languages fall back to regex import detection. |
| Memory scope | Cross-session default. `scope: "session"` opt-in for isolation. |
| Where new code lives | Built-in inside the fork. Modify `packages/opencode/src/agent/agent.ts` and add tools to `packages/core/src/tool/`. No separate `packages/banyan-extensions/`. |
| Default branch | `dev` (OpenCode default). `git push -u origin main` per user. |
| Internal package names | Stay `@opencode-ai/*` (less churn; SDK consumers don't break). |
| User-facing binary | Stays `opencode` for now (cheaper diff). BanyanCode branding lives in install banner, README, and `package.json` description. Binary rename is a follow-up. |
| Subagent messaging | Fire-and-persist. No explicit acknowledgement protocol for V1. |
| Fanout | Default: 3. Maximum: 5. |
| File deduplication | Do not deduplicate files. Use content hashes only for change detection and incremental indexing, not storage reduction. |

---

## Out of scope

- `packages/desktop`, `packages/app`, `packages/web`, `packages/storybook`, `packages/console`, `packages/enterprise`, `packages/stats`, `packages/slack`, `packages/identity`, `packages/containers`. Do not touch.
- Binary rename (`opencode` → `banyancode`). Defer until after the 4 features are stable.
- Renaming `@opencode-ai/*` workspace packages. Defer.
- Auto-spawning the orchestrator for every prompt. The orchestrator is opt-in via `tab` cycling or `@orchestrator` mention.
- Cluster-wide session execution. The local-only `SessionRunCoordinator` model in `packages/opencode/AGENTS.md` is unchanged.
- Provider-native tools. BanyanCode only adds new tools; it does not change provider behavior.
- A new config file format. All BanyanCode options live in `opencode.json` (or its `jsonc` variant).

---

## Repository baseline

Working from the existing `dev` branch on the OpenCode fork. The `dev` branch contains the V2 Session Core, the LLM route runtime, the Effect-based service layout, and the TUI bridge. The plan assumes:

- Bun 1.3+ (locked at `bun@1.3.14` via `packageManager`).
- `bun dev` runs the TUI from `packages/opencode`.
- `bun typecheck` runs `bun turbo typecheck` from the root.
- `bun test` is not allowed from the root (deliberate guard at `bunfig.toml`).
- All new code follows the Effect v4 / `effect-smol` rules in `packages/opencode/AGENTS.md` and the style guide in the root `AGENTS.md`.

The fork does not change the build system. It only adds files and edits a small, well-known surface.

---

## Phase 0 — Rebranding

**Goal:** BanyanCode is the user-facing name everywhere a user would see the OpenCode name. Internal code namespaces and CLI surface stay unchanged so the diff stays reviewable.

### 0.1 Files to modify

| Path | Change |
|---|---|
| `package.json` (root) | `name`: `opencode` → `banyancode`. `description`: "AI-powered development tool" → "BanyanCode — multi-agent development tool with parallel subagents, cross-session memory, and a code-aware research loop." `repository.url`: `anomalyco/opencode` → `EkagraAgarwal/BanyanCode`. |
| `install` (root) | Banner text "OpenCode Installer" → "BanyanCode Installer". `APP=opencode` → `APP=banyancode`. `INSTALL_DIR=$HOME/.opencode/bin` → `INSTALL_DIR=$HOME/.banyancode/bin`. Path-add lines updated. Banner ASCII art swapped for a new "BANYAN" mark. |
| `README.md` (root) — there is no root README; create one. | Add a short README pointing at `packages/opencode/README.md` for usage. |
| `packages/opencode/README.md` | First line: "OpenCode is an AI-powered development tool." → "BanyanCode is a multi-agent development tool built on top of OpenCode." Reference the fork and the BanyanCode-specific features. |
| `LICENSE` | Unchanged (MIT). |
| `CONTRIBUTING.md` | Update repo URLs (`anomalyco/opencode` → `EkagraAgarwal/BanyanCode`) and the vouch/denounce links if any. |
| `CONTEXT.md` | Unchanged (language glossary, repo-agnostic). |
| `STATS.md`, `SECURITY.md` | Unchanged. |
| `specs/project.md` | Unchanged. |
| `.github/CODEOWNERS` | Add `EkagraAgarwal` as the maintainer. |
| `.github/ISSUE_TEMPLATE/*.yml` | Update repo URL placeholders. |
| `.github/pull_request_template.md` | Unchanged (generic). |
| `sst.config.ts`, `flake.nix`, `nix/`, `infra/`, `github/`, `perf/` | Unchanged. |
| `AGENTS.md` (root) | Add a one-paragraph "BanyanCode fork" note at the top: the 4 features, the local-only branch, and a pointer to `BANYANCODE_PLAN.md`. Keep all existing content. |

### 0.2 Fork notes

Fork notes only appear in:

- `README.md` (root)
- `packages/opencode/README.md`
- `AGENTS.md` (root)

The following packages are explicitly out of scope and untouched:

```
packages/desktop/*
packages/app/*
packages/web/*
packages/storybook/*
```

### 0.3 Acceptance criteria

- `grep -r "OpenCode" README.md CONTRIBUTING.md` (root) returns only the BanyanCode fork note.
- `grep "opencode" install` shows `APP=banyancode` and `INSTALL_DIR=$HOME/.banyancode/bin` only.
- `package.json` (root) has `"name": "banyancode"` and the new repo URL.
- No source file (`packages/opencode/src/**/*.ts`, `packages/core/src/**/*.ts`) is touched by Phase 0.

---

## Phase 1 — Storage layer

**Goal:** All BanyanCode persistence lives in Drizzle tables in `packages/core/src/database/`. The schema, the migration, and the read/write helpers land before any tool that uses them.

Spec: `specs/banyancode/storage.md`.

### 1.1 Files to create

| Path | Purpose |
|---|---|
| `packages/core/src/database/schema/memory.sql.ts` | Drizzle schema for `memory_entries`. |
| `packages/core/src/database/schema/codegraph.sql.ts` | Drizzle schemas for `codegraph_files`, `codegraph_nodes`, `codegraph_edges`, `codegraph_embeddings`. |
| `packages/core/src/database/schema/subagent-messages.sql.ts` | Drizzle schema for `subagent_messages`. |
| `packages/core/src/database/schema.sql.ts` (extend) | The existing barrel only contains a `Timestamps` helper. Add the new table modules by re-exporting them, so the Drizzle schema generator sees the new tables. |
| `packages/core/src/storage/repo/memory.ts` | Effect Service: read/write/list/forget/search memory entries. |
| `packages/core/src/storage/repo/codegraph.ts` | Effect Service: read/write nodes, edges, files, embeddings. |
| `packages/core/src/storage/repo/subagent-messages.ts` | Effect Service: publish/subscribe/list messages. |
| `packages/core/src/storage/repo/index.ts` | Re-export the new repos. |
| `packages/core/src/effect/migrate.ts` | Single `migrate({ dryRun })` Effect that runs all pending migrations including the new ones. |
| `packages/core/script/migration.ts` (extend) | Add the new migration files to the runner. |

### 1.2 Files to modify

- `packages/core/src/database/schema.sql.ts` (existing barrel, only contains a `Timestamps` helper today) — re-export the new `*.sql.ts` modules so the Drizzle schema generator sees them. (There is no `schema.ts`; the file is `schema.sql.ts`.)
- `packages/core/src/storage/index.ts` (existing barrel) — re-export the new repo modules.

### 1.3 Public APIs

```ts
// memory repo
export class MemoryRepo extends Context.Service<MemoryRepo, {
  readonly put: (input: { key: string; value: unknown; context?: string; tags?: string[]; scope: "global" | "session"; sessionID?: string; ttlSeconds?: number }) => Effect.Effect<MemoryEntry>
  readonly get: (input: { key: string; scope: "global" | "session"; sessionID?: string }) => Effect.Effect<MemoryEntry | undefined>
  readonly list: (input: { prefix?: string; tags?: string[]; scope: "global" | "session"; sessionID?: string; limit?: number }) => Effect.Effect<MemoryEntry[]>
  readonly forget: (input: { key: string; scope: "global" | "session"; sessionID?: string }) => Effect.Effect<void>
  readonly search: (input: { query: string; limit?: number; scope: "global" | "session"; sessionID?: string }) => Effect.Effect<MemoryEntry[]>
  readonly vacuum: () => Effect.Effect<number> // expired rows removed
}>()("...") {}

// codegraph repo
export class CodegraphRepo extends Context.Service<CodegraphRepo, {
  readonly upsertFile: (file: CodegraphFile) => Effect.Effect<void>
  readonly upsertNode: (node: CodegraphNode) => Effect.Effect<void>
  readonly upsertEdge: (edge: CodegraphEdge) => Effect.Effect<void>
  readonly upsertEmbedding: (input: { nodeID: string; embedding: Float32Array; model: string; dim: number }) => Effect.Effect<void>
  readonly queryNodes: (input: { file?: string; function?: string; kind?: string }) => Effect.Effect<CodegraphNode[]>
  readonly nodeByID: (id: string) => Effect.Effect<CodegraphNode | undefined>
  readonly edgesFrom: (nodeID: string) => Effect.Effect<CodegraphEdge[]>
  readonly edgesTo: (nodeID: string) => Effect.Effect<CodegraphEdge[]>
  readonly allNodes: () => Effect.Effect<CodegraphNode[]> // for embedding
  readonly embeddingByNodeID: (nodeID: string) => Effect.Effect<Float32Array | undefined>
  readonly reset: () => Effect.Effect<void> // for /codegraph-build --force
}>()("...") {}

// subagent-messages repo
export class SubagentMessagesRepo extends Context.Service<SubagentMessagesRepo, {
  readonly publish: (input: { parentSessionID: string; fromSession: string; fromAgent: string; toSession?: string; toAgent?: string; kind: "request" | "inform" | "answer" | "poll"; payload: unknown }) => Effect.Effect<SubagentMessage>
  readonly unreadFor: (input: { sessionID: string; agent: string; limit?: number }) => Effect.Effect<SubagentMessage[]>
  readonly markDelivered: (id: string) => Effect.Effect<void>
  readonly recent: (input: { parentSessionID: string; limit?: number }) => Effect.Effect<SubagentMessage[]>
}>()("...") {}
```

### 1.4 Acceptance criteria

- `bun run --cwd packages/core migration --dry-run` lists the new migrations.
- `bun test --cwd packages/core test/storage/memory.test.ts` round-trips entries across `global` and `session` scopes.
- `subagent-messages.test.ts` publishes 100 messages from 4 concurrent subagents; reader sees all 100.
- All schemas use `snake_case` column names per the root `AGENTS.md` style guide.
- Phase 1 tests storage only. `codegraph_callers` tests and `codegraph_dependents` tests belong to Phase 5B.

---

## Phase 2 — Feature Gate + Websearch

**Goal:** A new runtime gate `BANYANCODE_ENABLE` controls whether BanyanCode features are registered, plus the `websearch_free` tool for the researcher agent.

### 2.1 Feature Gate

Spec: `specs/banyancode/runtime-flags.md`.

#### Files to create

| Path | Purpose |
|---|---|
| `packages/core/src/effect/runtime-flags.ts` | `RuntimeFlags` service with `BANYANCODE_ENABLE` capture. |
| `packages/opencode/src/effect/runtime-flags.ts` | Same for opencode package. |

#### Files to modify

- Tool registration files — wrap `BANYANCODE_ENABLE` gates around BanyanCode tool registrations.
- Agent registration files — wrap agent registration with `BANYANCODE_ENABLE` check.

#### Behavior

When `BANYANCODE_ENABLE` is not set or is `0`:

- orchestrator agent is not registered
- researcher agent is not registered
- memory tools are not registered
- codegraph tools are not registered
- mesh tools are not registered
- BanyanCode slash commands are not registered

The existing OpenCode experience remains unchanged.

### 2.2 Websearch Free

**Goal:** A new tool that searches DuckDuckGo HTML and returns a normalized result list, ready to be plugged into the researcher agent.

Spec: `specs/banyancode/websearch-free.md`.

#### Files to create

| Path | Purpose |
|---|---|
| `packages/core/src/tool/websearch-free.ts` | `Tool.make(...)` for the new tool. |
| `packages/core/src/tool/websearch-free/parse.ts` | HTML → result list using a small DOM parser. No cheerio; use `htmlparser2` (already in `packages/opencode/package.json`). |
| `packages/core/src/tool/websearch-free/config.ts` | Reads `BANYANCODE_DISABLE_WEBSEARCH` and other flags. |
| `packages/core/src/tool/builtins.ts` (modify) | Import the new layer and `Tools.Service.register` it. |
| `packages/core/src/permission/permission.ts` (modify) | Add `websearch_free` as a new permission key. |
| `packages/core/src/config/config.ts` (modify) | Add `websearch_free` to the `permission` schema. |
| `packages/opencode/src/tool/websearch-free.txt` | Tool description for the LLM. |
| `packages/opencode/test/banyan/websearch-free.test.ts` | Unit tests with a mocked `HttpClient`. |

#### Public APIs

```ts
// packages/core/src/tool/websearch-free.ts
export const WebSearchFreeTool = Tool.make({
  description: "Free web search via DuckDuckGo HTML. No API key required. Use for ad-hoc lookups, library docs, recent events.",
  input: Schema.Struct({
    query: Schema.String,
    numResults: Schema.optional(Schema.Number.check(Schema.isLessThanOrEqualTo(20))),
    region: Schema.optional(Schema.Literals(["wt-wt", "us-en", "uk-en", "in-en"])),
    time: Schema.optional(Schema.Literals(["d", "w", "m", "y"])),
  }),
  output: Schema.Struct({
    provider: Schema.Literal("duckduckgo"),
    text: Schema.String,
    results: Schema.Array(Schema.Struct({ title: Schema.String; url: Schema.String; snippet: Schema.String })),
  }),
  toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
  execute: (input, ctx) => Effect.gen(function* () { /* ... */ }),
})
```

#### Runtime registration

```ts
if (RuntimeFlags.BANYANCODE_ENABLE) {
  register(WebSearchFreeTool)
}
```

#### Acceptance criteria

- `bun test --cwd packages/opencode test/banyan/websearch-free.test.ts` passes against a recorded DuckDuckGo HTML fixture.
- Calling the tool against the live DuckDuckGo endpoint returns at least one result for `query="effect-ts README"`. (Manual smoke test; not in CI.)
- 25 s timeout; 256 KB body cap; same shape as `packages/core/src/tool/websearch.ts:17-19`.
- `websearch_free` is **not** enabled for the `build` primary agent by default. It is only enabled for agents that opt in (the new `researcher` agent in Phase 8).

---

## Phase 3 — Mesh

**Goal:** Two tools that let multiple subagents running under one parent session share state and exchange messages via fire-and-persist semantics.

Spec: `specs/banyancode/subagent-mesh.md`.

### 3.1 Files to create

| Path | Purpose |
|---|---|
| `packages/core/src/tool/shared-memory.ts` | `Tool.make(...)` for `shared_memory`. |
| `packages/core/src/tool/subagent-message.ts` | `Tool.make(...)` for `subagent_message`. |
| `packages/core/src/effect/subagent-bus.ts` | Effect Service that holds the in-memory pub/sub and the durable queue. |
| `packages/core/src/effect/instance-subagent-mesh.ts` | `InstanceState`-scoped cache of peers (one mesh per parent session). |
| `packages/opencode/src/tool/shared-memory.txt` | Tool description. |
| `packages/opencode/src/tool/subagent-message.txt` | Tool description. |
| `packages/opencode/test/banyan/shared-memory.test.ts` | Concurrency tests. |
| `packages/opencode/test/banyan/subagent-mesh.test.ts` | Mesh end-to-end: orchestrator + 3 background subagents. |

### 3.2 Files to modify

- `packages/core/src/permission/permission.ts` — add `shared_memory`, `subagent_message` permission keys.
- `packages/core/src/config/config.ts` — schema updates.
- `packages/core/src/tool/builtins.ts` — register the new layers.
- `packages/opencode/src/effect/instance-state.ts` (read; do not modify if unnecessary) — `InstanceState` already supports per-directory state; subagent mesh uses it.
- `packages/opencode/src/bus/index.ts` — add a new event type `subagent.message` so the TUI can render it.

### 3.3 Public APIs

```ts
// shared_memory
{
  description: "Read/write a small key-value store shared with peer subagents in the same parent session. Use for findings, intermediate results, and coordination flags. Persists across restarts. Keys are namespaced by parent session ID.",
  input: Schema.Struct({
    op: Schema.Literals(["read", "write", "list", "delete"]),
    key: Schema.String,
    value: Schema.optional(Schema.Unknown),
    tags: Schema.optional(Schema.Array(Schema.String)),
  }),
  output: Schema.Struct({ ok: Schema.Boolean; entries: Schema.Array(Schema.Unknown) }),
}

// subagent_message
{
  description: "Send a message to one or more peer subagents in the same parent session. Use to ask for help, share a finding, or poll status. The recipient sees the message in its next tool call description. Replies arrive as a normal assistant turn.",
  input: Schema.Struct({
    to: Schema.optional(Schema.String), // agent name; omit for broadcast
    kind: Schema.Literals(["request", "inform", "answer", "poll"]),
    payload: Schema.Unknown,
  }),
  output: Schema.Struct({ delivered: Schema.Boolean; pending: Schema.Number }),
}
```

```ts
// packages/core/src/effect/subagent-bus.ts
export class SubagentBus extends Context.Service<SubagentBus, {
  readonly publish: (msg: SubagentMessage) => Effect.Effect<void>
  readonly subscribe: (sessionID: string) => Effect.Effect<Queue.Dequeue<SubagentMessage>>
  readonly peers: (parentSessionID: string) => Effect.Effect<PeerInfo[]>
}>()("@banyancode/SubagentBus") {}
```

### 3.4 Fire-and-persist semantics

Subagent messaging uses `fire-and-persist` semantics, not `request-ack`.

Messages are durable via the `subagent_messages` table. No explicit acknowledgement protocol is required for V1.

### 3.5 Acceptance criteria

- `shared-memory.test.ts` asserts: 3 concurrent writes do not lose data; reads see latest write; `list` returns keys with the right tags; `delete` removes only the named key.
- `subagent-mesh.test.ts` asserts: orchestrator-style test that runs 3 background subagents (`it.live`); all 3 publish to shared memory; orchestrator reads them back; subagent-message delivery is observed at the TUI bus level.
- `Effect.sleep` is **never** used to wait for a forked fiber (per `packages/opencode/test/AGENTS.md`). Use `pollWithTimeout`, `awaitWithTimeout`, or `BackgroundJob.wait`.

---

## Phase 4 — Memory

**Goal:** A persistent, cross-session memory store exposed as 5 tools and a skill. Default scope is `global`; `session` opt-in.

Spec: `specs/banyancode/memory.md`.

### 4.1 Files to create

| Path | Purpose |
|---|---|
| `packages/core/src/tool/memory.ts` | `Tool.make(...)` for the 5 memory tools. |
| `packages/core/src/effect/embedding-provider.ts` | Loads `BANYANCODE_EMBEDDING_MODEL` via the `ai` SDK; returns a `Float32Array` for any string. |
| `packages/opencode/src/skill/memory/SKILL.md` | Skill that tells the LLM when to use `memory_*` vs `shared_memory`. |
| `packages/opencode/test/banyan/memory.test.ts` | Round-trip, scope isolation, TTL expiry, embedding-based search. |

### 4.2 Files to modify

- `packages/core/src/permission/permission.ts` — add `memory_store`, `memory_recall`, `memory_list`, `memory_forget`, `memory_search`.
- `packages/core/src/config/config.ts` — schema.
- `packages/core/src/effect/runtime-flags.ts` — `BANYANCODE_EMBEDDING_MODEL` env capture.
- `packages/opencode/src/effect/runtime-flags.ts` — same.

### 4.3 Public APIs

```ts
// 5 tools, all with input/output Schema following the existing style.
// memory_store
{ input: { key: string; value: unknown; context?: string; tags?: string[]; scope?: "global" | "session"; sessionID?: string; ttlSeconds?: number }; output: { id: string; createdAt: number } }
// memory_recall
{ input: { key: string; scope?: "global" | "session"; sessionID?: string }; output: { entry: Schema.Unknown | null } }
// memory_list
{ input: { prefix?: string; tags?: string[]; scope?: "global" | "session"; sessionID?: string; limit?: number }; output: { entries: Schema.Array(Schema.Unknown) } }
// memory_forget
{ input: { key: string; scope?: "global" | "session"; sessionID?: string }; output: { ok: boolean } }
// memory_search
{ input: { query: string; limit?: number; scope?: "global" | "session"; sessionID?: string }; output: { entries: Schema.Array(Schema.Unknown); degraded: boolean /* true if no embedding model */ } }

// embedding provider
export class EmbeddingProvider extends Context.Service<EmbeddingProvider, {
  readonly embed: (input: string | string[]) => Effect.Effect<Float32Array[], EmbeddingError>
  readonly model: () => string | undefined
}>()("@banyancode/EmbeddingProvider") {}
```

### 4.4 Quotas

Memory storage uses quotas defined in Global Changes:

```ts
maxEntriesPerScope = 10000
maxValueSizeBytes = 64 * 1024
maxTotalStorageBytes = 100 * 1024 * 1024
```

Memory writes exceeding limits fail with a structured error.

### 4.5 Embedding search behavior

1. embedding search
2. keyword fallback

When embeddings are unavailable:

```ts
degraded = true
```

must always be returned.

### 4.6 Skill content (`SKILL.md`)

```yaml
---
name: memory
description: Persistent, cross-session memory for BanyanCode agents. Use memory_store / memory_recall when the user explicitly asks you to remember something across sessions, or when you want to retain a long-term fact (preferences, environment quirks, prior decisions). Do NOT use memory_* for ephemeral coordination between subagents in the same session — use shared_memory instead.
---
```

### 4.7 Acceptance criteria

- `memory.test.ts` round-trips 100 entries, exercises `scope: "session"` and `scope: "global"`, asserts `ttlSeconds` expiry via the `vacuum` repo call.
- `memory_search` returns the correct top-1 result when `BANYANCODE_EMBEDDING_MODEL` is set; returns a keyword-match result and `degraded: true` when the env var is unset.
- The `memory` skill is listed in `~/.config/opencode/skills/memory/SKILL.md` after `bun dev` discovers it (manual check).

---

## Phase 5A — Codegraph Build

**Goal:** A polyglot code graph that captures files, nodes (functions/classes/types), and edges (imports/calls/extends). Built via tree-sitter for first-class languages, regex for the rest.

Spec: `specs/banyancode/codegraph.md`.

### 5A.1 Files to create

| Path | Purpose |
|---|---|
| `packages/core/src/tool/codegraph.ts` | `Tool.make(...)` for the 6 codegraph tools + `/codegraph-build` slash command entry. |
| `packages/core/src/codegraph/indexer.ts` | Effect Service that walks a directory, dispatches to a per-language parser, and writes to `CodegraphRepo`. |
| `packages/core/src/codegraph/langs/typescript.ts` | tree-sitter-typescript; emits imports, classes, functions, methods, types, references. |
| `packages/core/src/codegraph/langs/javascript.ts` | tree-sitter-javascript. |
| `packages/core/src/codegraph/langs/python.ts` | tree-sitter-python. |
| `packages/core/src/codegraph/langs/go.ts` | tree-sitter-go. |
| `packages/core/src/codegraph/langs/rust.ts` | tree-sitter-rust. |
| `packages/core/src/codegraph/langs/regex-fallback.ts` | Generic import detection (regex per language family). |
| `packages/core/src/codegraph/langs/registry.ts` | Map from `language` (lowercased extension) to parser. |
| `packages/opencode/src/command/template/codegraph-build.txt` | Slash command template. |
| `packages/opencode/src/command/index.ts` (modify) | Register the command. |
| `packages/opencode/test/banyan/codegraph.test.ts` | Index fixture repo, query files/nodes/edges/imports. |

### 5A.2 Files to modify

- `packages/core/src/permission/permission.ts` — add `codegraph_build`, `codegraph_query`, `codegraph_impact`, `codegraph_dependents`, `codegraph_callers`.
- `packages/core/src/config/config.ts` — schema.
- `packages/opencode/package.json` — add `tree-sitter-typescript`, `tree-sitter-javascript`, `tree-sitter-python`, `tree-sitter-go`, `tree-sitter-rust`.
- `packages/opencode/src/command/index.ts` — register the new command.

### 5A.3 Public APIs

```ts
// codegraph_build
{ input: { root?: string; force?: boolean }; output: { indexed: number; skipped: number; duration_ms: number } }
// codegraph_query
{ input: { file?: string; function?: string; kind?: "file" | "function" | "class" | "method" | "type" | "variable" }; output: { nodes: CodegraphNode[] } }
// codegraph_impact
{ input: { nodeID?: string; function?: string }; output: { dependents: CodegraphNode[]; transitive: CodegraphNode[] } }
// codegraph_dependents
{ input: { nodeID?: string; function?: string }; output: { dependents: CodegraphNode[] } }
// codegraph_callers
{ input: { nodeID?: string; function?: string }; output: { callers: CodegraphNode[] } }
```

```ts
// packages/core/src/codegraph/indexer.ts
export class CodegraphIndexer extends Context.Service<CodegraphIndexer, {
  readonly index: (input: { root: string; force?: boolean; onProgress?: (info: { file: string; done: number; total: number }) => void }) => Effect.Effect<{ indexed: number; skipped: number }, CodegraphError>
  readonly cancel: () => Effect.Effect<void>
}>()("@banyancode/CodegraphIndexer") {}
```

### 5A.4 Ignore rules

Indexer automatically excludes:

```
node_modules
dist
build
coverage
.next
.cache
target
vendor
```

Respects:

```
.gitignore
.banyancodeignore
```

### 5A.5 Acceptance criteria

- `codegraph_build` over the BanyanCode repo itself indexes 100% of `.ts`/`.tsx` files with no errors.
- `codegraph_query` returns correct nodes by file, function name, and kind.
- Tree-sitter WASM loads in Bun (`web-tree-sitter` already vendored in `packages/opencode/package.json`). The same code path works under Node for CI.
- The indexer is **cancellable** via an `AbortController` plumbed through the Effect layer (no leaks if the user hits `Esc`).

---

## Phase 5B — Codegraph Analysis

**Goal:** Graph analysis utilities: impact analysis, dependents, transitive traversal, and graph walking utilities.

### 5B.1 Files to create

| Path | Purpose |
|---|---|
| `packages/core/src/codegraph/analyzer.ts` | Effect Service for graph analysis operations. |
| `packages/opencode/test/banyan/codegraph-analysis.test.ts` | Impact analysis, transitive traversal tests. |

### 5B.2 Public APIs

Graph analysis operations:

```ts
// impact analysis
{ input: { nodeID?: string; function?: string }; output: { dependents: CodegraphNode[]; transitive: CodegraphNode[] } }

// dependents
{ input: { nodeID?: string; function?: string }; output: { dependents: CodegraphNode[] } }

// callers
{ input: { nodeID?: string; function?: string }; output: { callers: CodegraphNode[] } }
```

### 5B.3 API change for callers/dependents/impact

Replace:

```ts
{
  nodeID: string
}
```

with:

```ts
{
  nodeID?: string
  function?: string
}
```

for `codegraph_callers`, `codegraph_dependents`, and `codegraph_impact`. This allows both direct node queries and agent-friendly function name queries.

### 5B.4 Acceptance criteria

- `codegraph_callers({ function: "SessionV2.prompt" })` returns the test file, the orchestrator prompt, and the task tool call site.
- `codegraph_impact` returns the full transitive dependent set within 1 s for the same fixture.
- Impact analysis completes within 1 second on fixture repositories.

---

## Phase 6 — Resource Monitoring

**Goal:** Expose machine health to orchestrator and users.

### 6.1 Files to create

| Path | Purpose |
|---|---|
| `packages/core/src/effect/system-monitor.ts` | Effect Service for system metrics. |
| `packages/core/src/tool/system-status.ts` | `Tool.make(...)` for `system_status`. |
| `packages/opencode/test/banyan/system-monitor.test.ts` | Unit tests. |

### 6.2 Implementation

Primary library:

```
systeminformation
```

Provides:

- CPU
- RAM
- Disk
- Network

GPU Support:

Optional adapters:

```
nvidia-smi
rocm-smi
Metal
```

### 6.3 Output

```ts
{
  cpuPercent: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  gpuPercent?: number
  vramUsedBytes?: number
  platform: "windows" | "linux" | "darwin"
}
```

### 6.4 Acceptance criteria

Works on:

- Windows
- Linux

macOS support is best-effort.

---

## Phase 7 — Code Embeddings

**Goal:** Compute embeddings for every codegraph node, store them in `codegraph_embeddings`, and expose a semantic search tool.

### 7.1 Local-first design

Embeddings are generated on the user's machine. The model may be remote. Storage remains local. No server-side BanyanCode infrastructure is required.

### 7.2 Files to create

| Path | Purpose |
|---|---|
| `packages/core/src/tool/code-embed.ts` | `Tool.make(...)` for `code_embed_update` and `code_search`. |
| `packages/core/src/codegraph/embedder.ts` | Effect Service: `embedAll()`, `embedFile(file)`, `embedNode(node)`. |
| `packages/opencode/src/command/template/code-embed.txt` | Slash command template. |
| `packages/opencode/src/command/index.ts` (modify) | Register the command. |
| `packages/opencode/test/banyan/code-embed.test.ts` | Embed a fixture, run `code_search`, assert top-k relevance. |

### 7.3 Files to modify

- `packages/core/src/permission/permission.ts` — add `code_search`, `code_embed`.
- `packages/core/src/config/config.ts` — schema.
- `packages/core/src/effect/embedding-provider.ts` — already created in Phase 4; reuse.

### 7.4 Public APIs

```ts
// code_search
{ input: { query: string; limit?: number; fileGlob?: string }; output: { hits: Array<{ node: CodegraphNode; score: number }>; degraded: boolean } }
// code_embed_update
{ input: { file?: string }; output: { embedded: number; skipped: number; model: string | undefined } }
```

### 7.5 Acceptance criteria

- With `BANYANCODE_EMBEDDING_MODEL=openai/text-embedding-3-small`, `code_search("error handling in session runner")` returns the matching function in the top 3.
- Without the env var, `code_search` returns keyword-match results and `degraded: true`.
- `code_embed_update` re-embeds only the files whose content hash has changed since last index.

---

## Phase 8 — Agents

**Goal:** Two new built-in agents wired into the agent registry: `orchestrator` and `researcher`.

Spec: `specs/banyancode/orchestrator.md`.

### 8.1 Files to create

| Path | Purpose |
|---|---|
| `packages/opencode/src/agent/prompt/orchestrator.txt` | System prompt. |
| `packages/opencode/src/agent/prompt/researcher.txt` | System prompt. |

### 8.2 Files to modify

- `packages/opencode/src/agent/agent.ts` — add `orchestrator` and `researcher` to the `agents` table. **Insert before** the `for (const [key, value] of Object.entries(cfg.agent ?? {}))` loop so user config can still override.
- `packages/opencode/src/cli/cmd/tui.ts` — register the new agent names in the cycle order. Default cycle becomes: `build`, `plan`, `orchestrator`.

### 8.3 Public APIs

The agents use the existing `Agent.Info` shape (`packages/opencode/src/agent/agent.ts:35-56`). The new entries are:

```ts
// in the agents table:
orchestrator: {
  name: "orchestrator",
  description: "Decomposes complex tasks, fans out to parallel subagents, coordinates via shared memory and peer messages.",
  mode: "primary",
  native: true,
  prompt: PROMPT_ORCHESTRATOR,
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      task: {
        "*": "deny",
        researcher: "allow",
        coder: "allow",
        explore: "allow",
        general: "allow",
        scout: "allow",
      },
      shared_memory: "allow",
      subagent_message: "allow",
      todowrite: "allow",
      question: "allow",
    }),
    user,
  ),
  options: {},
},
researcher: {
  name: "researcher",
  description: "Read-only subagent. Performs free web search via DuckDuckGo and reads external docs. Writes findings to shared_memory.",
  mode: "subagent",
  native: true,
  prompt: PROMPT_RESEARCHER,
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      edit: "deny",
      bash: "deny",
      websearch: "allow",
      websearch_free: "allow",
      webfetch: "allow",
      read: "allow",
      grep: "allow",
      glob: "allow",
      shared_memory: "allow",
      subagent_message: "allow",
    }),
    user,
  ),
  options: {},
},
```

### 8.4 Fanout limits

Default fanout:

```ts
3 subagents
```

Maximum:

```ts
5 subagents
```

Enforced by MeshCoordinator, SubagentBus, and orchestrator prompt.

### 8.5 Orchestrator prompt additions

- Prefer 2–3 subagents
- Escalate to user before larger fanouts
- Reuse `shared_memory`
- Reuse prior findings from `memory_store`

### 8.6 Acceptance criteria

- `tab` cycles through `build`, `plan`, `orchestrator` in the TUI.
- `@researcher` resolves to the new subagent.
- The orchestrator's system prompt contains explicit instructions to: (a) use `task` with `background: true` for fan-out, (b) use `pollWithTimeout` or `BackgroundJob.wait` to wait, (c) read `shared_memory` for results, (d) prefer `subagent_message` over busy polling, (e) never block on `Effect.sleep` (per `packages/opencode/AGENTS.md`).
- The researcher's system prompt contains explicit instructions to use `websearch_free` first and only fall back to `websearch` (Exa/Parallel) when the user explicitly configured keys.

---

## Phase 9 — TUI

**Goal:** A small Effect service that drains subagent messages and emits TUI events. Optional: a sidebar widget.

### 9.1 Files to create

| Path | Purpose |
|---|---|
| `packages/opencode/src/effect/mesh-coordinator.ts` | Effect Service that watches the SubagentBus and emits status events. |

### 9.2 Files to modify

- `packages/tui/src/context/...` — wire a new sidebar widget that shows live peer activity. (Out of detailed scope: ship a minimal version, defer polish.)
- `packages/opencode/src/cli/cmd/tui.ts` — bootstrap the `MeshCoordinator` on session start.

### 9.3 Mesh sidebar

The mesh sidebar becomes:

```ts
enabled: false
```

by default.

Config:

```json
{
  "meshSidebar": true
}
```

Reason: Avoid overwhelming users with orchestration noise.

### 9.4 Public APIs

```ts
export class MeshCoordinator extends Context.Service<MeshCoordinator, {
  readonly status: (parentSessionID: string) => Effect.Effect<MeshStatus>
  readonly drain: (parentSessionID: string) => Effect.Effect<SubagentMessage[]>
}>()("@banyancode/MeshCoordinator") {}
```

### 9.5 Acceptance criteria

- While 3 background subagents run, the TUI sidebar updates within 1 s when each one writes to `shared_memory` or sends a peer message (if `meshSidebar: true`).
- Closing the TUI cleanly disposes the mesh (no leaked fibers).
- Default `meshSidebar: false` does not show the mesh sidebar.

---

## Phase 10 — Tests

**Goal:** Tests for every new code path, plus a focused orchestrator + subagent mesh end-to-end test.

### 10.1 Files to create

| Path | Purpose |
|---|---|
| `packages/opencode/test/banyan/memory.test.ts` | Phase 4 tests. |
| `packages/opencode/test/banyan/shared-memory.test.ts` | Phase 3 tests. |
| `packages/opencode/test/banyan/subagent-mesh.test.ts` | Phase 3 end-to-end. |
| `packages/opencode/test/banyan/codegraph.test.ts` | Phase 5A tests. |
| `packages/opencode/test/banyan/codegraph-analysis.test.ts` | Phase 5B tests. |
| `packages/opencode/test/banyan/code-embed.test.ts` | Phase 7 tests. |
| `packages/opencode/test/banyan/websearch-free.test.ts` | Phase 2 tests. |
| `packages/opencode/test/banyan/system-monitor.test.ts` | Phase 6 tests. |
| `packages/opencode/test/banyan/orchestrator.test.ts` | Phase 8 tests (orchestrator spawns researcher + explore). |

### 10.2 Test patterns (per `packages/opencode/test/AGENTS.md`)

- `it.effect` for tests that should run with `TestClock` and `TestConsole`.
- `it.live` for tests that depend on real time, filesystem, git, or live HTTP.
- `it.instance` for live Effect tests that need a scoped temp directory and instance context.
- `await using tmp = await tmpdir({ git: true })` from `test/fixture/fixture.ts`.
- `pollWithTimeout`, `awaitWithTimeout`, `BackgroundJob.wait` for concurrency.
- `Layer.mock` for partial service stubs.
- Recorded tests (`RECORD=true` + `RECORDED_*` filters) only for live provider paths; BanyanCode tests do not need them.

### 10.3 Acceptance criteria

- `bun turbo test --filter @opencode-ai/opencode` passes locally and in CI.
- `subagent-mesh.test.ts` runs 3 background subagents and asserts all 3 publish to `shared_memory` before the orchestrator reads. This is the most important test in BanyanCode.

---

## Phase 11 — Docs

**Goal:** BanyanCode is documented in a way that makes its value obvious.

### 11.1 Files to create

| Path | Purpose |
|---|---|
| `BANYANCODE_PLAN.md` (this file) | Top-level plan. |
| `specs/banyancode/overview.md` | One-paragraph pitch. |
| `specs/banyancode/orchestrator.md` | Orchestrator design. |
| `specs/banyancode/subagent-mesh.md` | Inter-agent messaging protocol. |
| `specs/banyancode/memory.md` | Cross-session memory. |
| `specs/banyancode/codegraph.md` | Code graph + embeddings. |
| `specs/banyancode/websearch-free.md` | DuckDuckGo tool. |
| `specs/banyancode/storage.md` | Drizzle tables. |
| `specs/banyancode/types.md` | Shared type definitions. |
| `packages/opencode/README.md` (modify) | BanyanCode fork note. |
| `packages/opencode/src/skill/memory/SKILL.md` | Memory skill. |
| `packages/opencode/src/skill/codegraph/SKILL.md` | Codegraph skill. |
| `packages/docs/src/content/docs/banyancode.mdx` | User-facing overview (TUI/CLI features). |
| `packages/docs/src/content/docs/banyancode-orchestrator.mdx` | Orchestrator usage. |
| `packages/docs/src/content/docs/banyancode-memory.mdx` | Memory usage. |
| `packages/docs/src/content/docs/banyancode-codegraph.mdx` | Codegraph + embeddings usage. |
| `packages/docs/src/content/docs/banyancode-websearch.mdx` | WebSearch tool usage. |
| `packages/docs/src/content/docs/banyancode-mesh.mdx` | Mesh and subagent messaging. |
| `packages/docs/src/content/docs/banyancode-system-monitor.mdx` | System monitoring. |
| `packages/docs/src/content/docs/banyancode-resource-monitoring.mdx` | Resource monitoring. |

### 11.2 Documentation requirements

Every BanyanCode feature must have:

- overview
- usage examples
- troubleshooting section

### 11.3 Acceptance criteria

- A new user reading the docs can answer: "What does BanyanCode add over OpenCode?" in 30 seconds.
- Each new tool has a usage example in `packages/docs/`.
- `bun dev:storybook` is unchanged (out of scope).

---

## Risk register

| Risk | Phase | Mitigation |
|---|---|---|
| Tree-sitter WASM fails to load under Bun or Node in CI | 5A | Smoke test on first launch; fall back to regex-only mode with a clear warning. |
| `codegraph_build` over a large monorepo takes >5 min | 5A | Stream progress to the TUI; cancellable; `/codegraph-build --force` only re-indexes changed files. |
| `subagent_message` delivery races a process restart | 3 | Persist every message in the `subagent_messages` table; `subagent-bus` reads on subscription. |
| DuckDuckGo HTML format changes | 2 | Parser is isolated to `parse.ts`; one place to update. |
| `BANYANCODE_EMBEDDING_MODEL` left unset in production | 4, 7 | `code_search` and `memory_search` degrade to keyword match; `degraded: true` flag in the result; one-line notice in the TUI. |
| Orchestrator over-uses parallel subagents | 8 | Prompt explicitly limits fan-out: prefer 2-3 subagents, maximum 5, escalate to user if more is needed. |
| Memory grows unbounded | 4 | `ttlSeconds` per entry; `vacuum()` runs on every `memory_store`; CLI exposes `banyancode memory vacuum`; quotas enforced. |
| Permission key `websearch_free` collides with future OpenCode permission keys | 2, 4-8 | Use `websearch_free` (snake_case, descriptive); document in the BanyanCode README. |
| TUI sidebar pollutes with too many mesh events | 9 | Default `meshSidebar: false`; `MeshCoordinator.status` collapses repeated events. |
| `BANYANCODE_ENABLE` not set by default | 2 | Phase C removes the env gate after stable release. |

---

## Migration and rollout

### Migration from OpenCode

1. Pull the BanyanCode fork.
2. `bun install` (workspace catalog versions unchanged).
3. `bun dev` runs the TUI exactly as before, with the orchestrator + researcher available via `tab` and `@`.
4. Existing `opencode.json` files work unchanged. New permission keys default to `allow` for the new tools, with the same user-overridable ruleset.
5. Existing plugins continue to work. The new tools register through the same `Tools.Service.register` and `ApplicationTools.Service.register` seams.
6. `BANYANCODE_EMBEDDING_MODEL` is the only new env var. Optional.
7. `BANYANCODE_ENABLE=1` enables BanyanCode features (default off until Phase C).

### Rollout

- **Phase A (dogfood):** BanyanCode maintainers use the fork on real projects for 2 weeks.
- **Phase B (opt-in):** Add a top-level `BANYANCODE_ENABLE=1` env var. If unset, the new tools are not registered and the new agents are not exposed.
- **Phase C (default-on):** Remove the env gate after a stable release.

---

## Open questions

1. Should the binary name change to `banyancode` (path under `~/.banyancode/bin`)? Or stay `opencode` for diff size?
2. Should `/code-embed` run on the user's machine (using `BANYANCODE_EMBEDDING_MODEL`) or be deferred to a server?
3. Should `subagent_message` between siblings require an explicit ack, or is fire-and-deliver-with-retry acceptable? — **Closed: fire-and-persist, no ack.**
4. Should the orchestrator default to a 3-subagent fan-out, or learn from past tasks via `memory_store`? — **Closed: default 3, max 5.**
5. Should `codegraph_build` deduplicate identical files by hash, or always re-parse? — **Closed: do not deduplicate; use content hashes only for change detection and incremental indexing.**
6. Should the TUI sidebar widget for the mesh be opt-in (config flag) or always on? — **Closed: opt-in, `meshSidebar: false` by default.**

---

## Appendix A — File-change summary by phase

| Phase | New files | Modified files |
|---|---|---|
| 0 | 1 (root `README.md`) | `package.json`, `install`, `CONTRIBUTING.md`, `.github/CODEOWNERS`, `AGENTS.md`, `packages/*/README.md` |
| 1 | 11 (4 schemas + 3 repos + 1 effect + 1 barrel + 1 migration glue + 1 existing migration update) | 2 existing barrels |
| 2 | 8 (websearch + runtime-flags) | 4 |
| 3 | 8 | 4 |
| 4 | 4 | 4 |
| 5A | 11 | 5 |
| 5B | 2 | 0 |
| 6 | 3 | 0 |
| 7 | 5 | 3 |
| 8 | 2 | 2 |
| 9 | 1 | 2 |
| 10 | 9 | 0 |
| 11 | 18 | 4 |
| **Total** | **~83 new** | **~35 modified** |

## Appendix B — Reuse map (full)

| BanyanCode concept | Reuses | File |
|---|---|---|
| New agents | `Agent.Service` + the `agents` table | `packages/opencode/src/agent/agent.ts:138-263` |
| Parallel subagents | `task` tool with `background: true` | `packages/opencode/src/tool/task.ts` |
| Background job waiting | `BackgroundJob.wait` | `packages/opencode/src/background/job.ts` |
| New tools | `Tool.make` + `Tools.Service.register` | `packages/core/src/tool/tool.ts`, `tools.ts` |
| Permission keys | `PermissionV1.Ruleset` + the `Permission.fromConfig` merge | `packages/core/src/permission/permission.ts` |
| New commands | `Command.Service` + `cfg.command` loop | `packages/opencode/src/command/index.ts:98-111` |
| Skills | `Skill.discovery` | `packages/opencode/src/skill/discovery.ts` |
| Bus events | `bus.subscribe` / `bus.publish` | `packages/opencode/src/bus/` |
| Drizzle tables | existing schema barrel + migration runner | `packages/core/src/database/schema/`, `packages/core/script/migration.ts` |
| Effect runtime | `makeRuntime` | `packages/opencode/src/effect/run-service.ts` |
| Per-session state | `InstanceState` | `packages/opencode/src/effect/instance-state.ts` |
| Callback bridges | `EffectBridge` | `packages/opencode/src/effect/bridge.ts` |
| TUI tool discovery | `Tools.Service.named()` | `packages/opencode/src/tool/registry.ts` |
| TUI sidebar events | existing bus | `packages/tui/` |
| Embeddings | `ai` SDK | `packages/opencode/src/session/llm.ts` |
| Tree-sitter | existing `web-tree-sitter` and `tree-sitter-bash/powershell` | `packages/opencode/package.json` |
| HTTP client for DuckDuckGo | `HttpClient.HttpClient` from `effect/unstable/http` | `packages/core/src/tool/websearch.ts:154-177` (mirror) |
| HTML parsing | `htmlparser2` | `packages/opencode/package.json` |
| Test helpers | `testEffect`, `it.effect`, `it.live`, `it.instance`, `tmpdir` | `packages/opencode/test/AGENTS.md` |
| Recorded tests | `RECORD=true`, `RECORDED_*` filters | `packages/llm/AGENTS.md` |
| System monitoring | `systeminformation` | `packages/core/src/effect/system-monitor.ts` |

(End of file - total ~800 lines)
