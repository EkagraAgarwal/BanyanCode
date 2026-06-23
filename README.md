# BanyanCode

BanyanCode is a CLI/TUI-only fork of [OpenCode](https://github.com/anomalyco/opencode) that adds a parallel subagent mesh, cross-session memory, a native-vector code graph + embeddings utility, and a free web search backend for a new researcher agent.

The TUI/CLI experience stays close to OpenCode; BanyanCode is a sequence of additions, not a rewrite. Desktop, web, app, and Storybook packages are explicitly out of scope.

## What BanyanCode adds over OpenCode

1. **Orchestrator + subagent mesh.** A primary `orchestrator` agent decomposes complex tasks, fans out to specialized subagents (`researcher`, `explore`, `coder`, `general`, `scout`) in parallel, and coordinates them via peer messaging and shared memory. The max-parallel limit is **user-configurable** via the Settings tab.
2. **Cross-session memory.** A persistent key-value store with optional embeddings and **indexable JSONB payloads**, exposed as tools (`memory_store`, `memory_recall`, `memory_list`, `memory_forget`, `memory_search`) and a `memory` skill.
3. **2-phase codebase utility.** Phase 1 (`/codegraph-build`) builds a polyglot code graph using tree-sitter. Phase 2 (`/code-embed`) computes embeddings over the same nodes for semantic search. Storage is **Turso/libSQL** with native `F32_BLOB` columns, DiskANN ANN indexes, and `vector_top_k()` SQL function — sub-millisecond KNN at 10K+ nodes.
4. **Researcher agent with free web search.** A `researcher` subagent that uses a DuckDuckGo-backed `websearch_free` tool by default, with the existing Exa/Parallel `websearch` as an opt-in fallback.

## How BanyanCode is layered on OpenCode

BanyanCode keeps the entire OpenCode architecture and adds services alongside it:

| OpenCode layer | BanyanCode addition |
|----------------|---------------------|
| Agent registry (`packages/opencode/src/agent/`) | `orchestrator`, `researcher`, `scout`, `coder`, `explore`, `general` agents registered under the `BANYANCODE_ENABLE=1` feature gate |
| Command shell (`packages/opencode/src/command/`) | `/codegraph-build`, `/code-embed`, `/codegraph-remove`, `/yolo`, `/embedding-model` slash commands |
| Tool registry (`packages/core/src/tool/`) | `memory_*`, `websearch_free`, `codegraph_*`, `code_*`, `system_*`, `mesh_*`, `systeminfo` tools |
| Provider plugin system (`packages/core/src/plugin/provider/`) | All upstream provider plugins kept; one test-only NIM embedding plugin added |
| Storage (`packages/core/src/database/`) | Turso/libSQL via `@libsql/client`. Project-local `.banyancode/banyancode.db` with 5+ tables (memory, codegraph, embeddings, subagent messages, subagent plans) and a single fresh-schema migration |
| Event bus (`packages/core/src/event/`) | 3 new event types (`banyancode.codegraph.build`, `banyancode.codeembed.build`, `banyancode.system.updated`) the TUI subscribes to |
| TUI (`packages/tui/`) | 6 tabs (Chat, Sessions, Agents, Graph, Memory, Settings), Obsidian-style force-directed Graph view, agent config wizard, full settings accordion |
| Config schema (`packages/core/src/v1/config/`) | Separate `BanyanConfig.Info` schema — never mixed with OpenCode's `ConfigV1.Info` |

The feature gate (`BANYANCODE_ENABLE`) keeps the additions opt-in. With the gate off, BanyanCode is a no-op and the OpenCode experience is unchanged.

## Project-local directory layout

BanyanCode stores per-project state under `<project>/.banyancode/`:

```
<project>/.banyancode/
├── banyancode.db        # libSQL/Turso: memory, codegraph, embeddings, subagent data
├── ignore               # codegraph ignore patterns (one per line)
└── agent/               # custom subagent definitions (.md with frontmatter)
    └── my-researcher.md # file-based, hot-reloadable
```

Project-local storage wins over the global default at `~/.local/share/banyancode/`. Both products can be installed side by side without interference — BanyanCode reads/writes only `.banyancode/`, OpenCode only `.opencode/`.

The resolved DB path is shown in the TUI's codegraph progress widget during `/codegraph-build`, so the user always sees where the index is being written.

## Quick start

```bash
bun install
bun dev
```

`bun dev` runs the TUI from `packages/opencode`. Set `BANYANCODE_ENABLE=1` to enable the BanyanCode additions.

To enable semantic code search after the codegraph is built:

1. Open the embedding model picker (`<leader>:embedding-model` in the TUI or the `/embedding-model` dialog).
2. Pick a model. The picker **probes** the endpoint with a test input to detect the dim at runtime — no hardcoded values.
3. Run `/code-embed`. A floating widget shows progress and a failed EmbedEvent surfaces in the same widget when the model is misconfigured or the API rejects the request.

To configure the orchestrator's parallel-subagent limit:

1. Open the Settings tab (last tab in the session route).
2. Expand "Orchestration" → adjust **Max Subagents** (1–20, default 5).
3. The change is picked up immediately by `MeshCoordinator` (hard cap) and the orchestrator's prompt template.

To add a custom subagent:

1. Open the Agents tab → click **+ Add**.
2. Fill the wizard: name → description → model (optional) → tools (grouped multi-select) → review.
3. Saves to `.banyancode/agent/<name>.md` with frontmatter (`name`, `description`, `mode: subagent`, `model`, `tools`).

## Architecture (one paragraph each)

**Storage (Turso/libSQL).** BanyanCode uses `@libsql/client` to talk to a local file DB (`<project>/.banyancode/banyancode.db`). libSQL is a drop-in SQLite fork with native vector search: `F32_BLOB(N)` typed columns, `vector_distance_cos` / `vector_distance_l2` SQL functions, and `vector_top_k(idx, vec, k)` table-valued function backed by a DiskANN ANN index (`libsql_vector_idx(column)`). Also bundles FTS5 for full-text search and a `jsonb` type for indexable JSON paths. The driver adapter lives at `packages/core/src/database/sqlite.libsql.ts` and works on both Bun and Node.

**Orchestrator + mesh.** The `orchestrator` agent decomposes a prompt into a plan, then `MeshCoordinator` issues bounded parallel `Effect.forkIn(scope, ...)` calls to subagents. The cap is `BanyanConfig.banyancode_max_subagents` (default 5, max 20) — rendered into the orchestrator prompt as `{{maxSubagents}}` and enforced as a hard runtime limit by `MeshCoordinator.tryReserveSubagentSlot` (which evicts the oldest ended subagent or refuses the spawn). Subagents talk back via `SubagentBus` (a fire-and-persist log in SQLite) with `markDelivered` on consume, so retries/replays see them as consumed. Shared memory is the coordination substrate for outputs that cross agent boundaries.

**Memory.** A Drizzle table (`memory_entries`) keyed by `id` and scoped to `global` or `session`. `value` and `tags` are stored as `jsonb` (Turso user-defined type). `memory_search` runs BM25 keyword match when no embedding model is configured, or cosine similarity over stored `Float32Array` blobs when one is. `update` uses optimistic concurrency (`UPDATE ... WHERE version = expected`) to avoid lost writes. `vacuum` enforces a TTL and entry-count cap.

**Code graph + embeddings.** `CodegraphBuildService` walks `<root>`, skips `.banyancode/` itself and patterns from `.banyancode/ignore` and `.gitignore`, parses with tree-sitter (TS/JS/Python) or regex fallback (everything else), and writes `codegraph_files`, `codegraph_nodes`, `codegraph_edges` to SQLite. `CodegraphEmbedder` then walks the nodes and embeds each via the `aisdk.embed` plugin trigger, writing the Float32 vector into a `F32_BLOB(N)` column with a `libsql_vector_idx` DiskANN index. Similarity search is a single SQL call: `vector_top_k('codegraph_embedding_vec_idx', vector32(?), k)`. The Obsidian-style Graph tab renders nodes with `d3-force` layout, layered by L0/L1/L2/L3 (focused / direct callers / transitive impact / reverse dependents). Pagination: `listAllNodes/Edges/Files` and `bumpVersion` use `countNodes/Edges/Files` (`SELECT COUNT(*)`) plus `searchNodes({ name?, kind?, limit })` with push-down `LIKE`/`=` filters — 50K-node codegraphs stay snappy.

**Embedding model picker.** `EmbeddingProviderService` reads `BANYANCODE_EMBEDDING_MODEL` (or `BanyanConfig.banyancode_embedding_model`) and fires the `aisdk.embed` plugin trigger. The `/embedding-model` command (TUI dialog or slash command) calls `EmbeddingProvider.detectAndSetModel(name)`, which **probes** the endpoint with a 1-char input to detect the dim at runtime — no hardcoded model→dim mapping. After probe, the picker persists both the model name and the detected dim to `BanyanConfig`, then calls `CodegraphRepo.resetEmbeddingsTable(dim, model)`. The reset is **non-destructive by default** — it only removes rows for the new model (none should exist yet) and preserves embeddings under any previously used model. Pass `{ force: true }` to wipe the whole table.

**Researcher + free websearch.** The `researcher` subagent prefers `websearch_free` (DuckDuckGo HTML scraping, no API key). `websearch` (Exa/Parallel) is opt-in via the `banyancode_disable_websearch` flag. Tool dispatch routes through the existing OpenCode tool registry.

**System info.** A `systeminfo` tool is registered for `orchestrator` and `general` agents to query CPU/memory/GPU/VRAM/platform at runtime. A TUI sidebar widget (`packages/tui/src/feature-plugins/sidebar/system-status.tsx`) subscribes to `banyancode.system.updated` (published every 1s) and renders bars with color-coded warnings.

## TUI UX

The TUI follows modern TUI design patterns (Charm, Ink, OpenTUI reference):
- **Modal dialogs** with opaque backdrop and a `<leader>:` palette. The command palette (`<leader>:commands`) and the prompt autocomplete (`/`) are the two ways to find actions; both share keybindings via the `keymap` registry.
- **Empty states** are designed, not blanked — every "No X" / "Loading…" surface renders the same shape: glyph (`◌ loading` / `∅ empty` / `✗ error` / `○ info`) + title + suggested next action. Reusable component at `packages/tui/src/ui/empty-state.tsx`; design tokens at `packages/tui/src/ui/tokens.ts`.
- **Status pills** carry both glyph and color (Charm-style 4-color status palette: `success`/`warning`/`error`/`info`).
- **Tabs** are `Tab` / `Shift+Tab` navigable (keybinds surfaced in the prompt footer).
- **Solid `<For>` everywhere** for keyed iteration; `.map()` in JSX is forbidden.

## Plan and design

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — repo layout, runtime layers, BanyanCode service architecture, V2/V3 changelog.
- [`specs/banyancode/`](specs/banyancode/) — per-feature design (storage, orchestrator, subagent mesh, memory, code graph, free web search).
- [`specs/banyancode/overview.md`](specs/banyancode/overview.md) — one-paragraph pitch and reuse map.
- [`packages/docs/src/content/docs/banyancode.mdx`](packages/docs/src/content/docs/banyancode.mdx) — user-facing feature overview.
- [`plan.md`](plan.md) — current implementation plan with todos.
- [`.banyancode/deep-codebase-review.md`](.banyancode/deep-codebase-review.md) — code review with 100+ findings, the source of the active refactor phases.

## Contributing and feedback

Issues and PRs are welcome at <https://github.com/EkagraAgarwal/BanyanCode>.

## License

MIT, same as the upstream OpenCode project.
