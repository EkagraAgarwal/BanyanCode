# BanyanCode

BanyanCode is a CLI/TUI-only fork of [OpenCode](https://github.com/anomalyco/opencode) that adds a parallel subagent mesh, cross-session memory, a code graph + embeddings utility, and a free web search backend for a new researcher agent.

The TUI/CLI experience stays close to OpenCode; BanyanCode is a sequence of additions, not a rewrite. Desktop, web, app, and Storybook packages are explicitly out of scope.

## What BanyanCode adds over OpenCode

1. **Orchestrator + subagent mesh.** A primary `orchestrator` agent decomposes complex tasks, fans out to specialized subagents (`researcher`, `explore`, `coder`, `general`, `scout`) in parallel, and coordinates them via peer messaging and shared memory.
2. **Cross-session memory.** A persistent key-value store with optional embeddings, exposed as 5 tools (`memory_store`, `memory_recall`, `memory_list`, `memory_forget`, `memory_search`) and a `memory` skill.
3. **2-phase codebase utility.** Phase 1 (`/codegraph-build`) builds a polyglot code graph using tree-sitter. Phase 2 (`/code-embed`) computes embeddings over the same nodes for semantic search.
4. **Researcher agent with free web search.** A `researcher` subagent that uses a DuckDuckGo-backed `websearch_free` tool by default, with the existing Exa/Parallel `websearch` as an opt-in fallback.

## How BanyanCode is layered on OpenCode

BanyanCode keeps the entire OpenCode architecture and adds services alongside it:

| OpenCode layer | BanyanCode addition |
|----------------|---------------------|
| Agent registry (`packages/opencode/src/agent/`) | `orchestrator`, `researcher`, `scout` agents registered under the `BANYANCODE_ENABLE=1` feature gate |
| Command shell (`packages/opencode/src/command/`) | `/codegraph-build`, `/code-embed`, `/codegraph-remove`, `/yolo` slash commands |
| Tool registry (`packages/core/src/tool/`) | `memory_*`, `websearch_free`, `codegraph_*`, `code_*`, `system_*`, `mesh_*` tools |
| Provider plugin system (`packages/core/src/plugin/provider/`) | All upstream provider plugins kept; one test-only NIM embedding plugin added |
| Storage (`packages/core/src/database/`) | Project-local `.banyancode/banyancode.db` with 4 new tables (memory, codegraph, subagent messages, subagent plans) |
| Event bus (`packages/core/src/event/`) | 2 new event types (`banyancode.codegraph.build`, `banyancode.codeembed.build`) the TUI subscribes to |
| TUI (`packages/tui/`) | Codegraph progress widget, embedding-model picker dialog, sidebar plugin |
| Config schema (`packages/core/src/v1/config/`) | Separate `BanyanConfig.Info` schema — never mixed with OpenCode's `ConfigV1.Info` |

The feature gate (`BANYANCODE_ENABLE`) keeps the additions opt-in. With the gate off, BanyanCode is a no-op and the OpenCode experience is unchanged.

## Project-local directory layout

BanyanCode stores per-project state under `<project>/.banyancode/`:

```
<project>/.banyancode/
├── banyancode.db        # SQLite: memory, codegraph, subagent data
└── ignore               # codegraph ignore patterns (one per line)
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
2. Pick a model. The default TUI catalog only lists models whose provider exposes an embedding implementation.
3. Run `/code-embed`. A floating widget shows progress and a failed EmbedEvent surfaces in the same widget when the model is misconfigured or the API rejects the request.

## Architecture (one paragraph each)

**Orchestrator + mesh.** The `orchestrator` agent decomposes a prompt into a plan, then `MeshCoordinator` issues bounded parallel `Effect.forkIn(scope)` calls to subagents with `MAX_PARALLEL_SUBAGENTS=3` (hard cap 5). Subagents talk back via `SubagentBus` (a fire-and-persist message log in SQLite). Shared memory is the coordination substrate for outputs that cross agent boundaries.

**Memory.** A 6-column Drizzle table (`memory_entries`) keyed by `id` and scoped to `global` or `session`. `memory_search` runs BM25 keyword match when no embedding model is configured, or cosine similarity over stored `Float32Array` blobs when one is. `vacuum` enforces a TTL and entry-count cap.

**Code graph + embeddings.** `CodegraphBuildService` walks `<root>`, skips `.banyancode/` itself and patterns from `.banyancode/ignore` and `.gitignore`, parses with tree-sitter (TS/JS/Python) or regex fallback (everything else), and writes `codegraph_files`, `codegraph_nodes`, `codegraph_edges` to SQLite. `CodegraphEmbedder` then walks the nodes and embeds each via the `aisdk.embed` plugin trigger. Embeddings are stored as `BLOB` in `codegraph_embeddings`.

**Embedding provider.** `EmbeddingProviderService` reads `BANYANCODE_EMBEDDING_MODEL` (or `BanyanConfig.banyancode_embedding_model`) and fires the `aisdk.embed` plugin trigger. Upstream provider plugins handle the request via their normal SDK. For the test-only NVIDIA NIM path, a gated plugin (`NvidiaEmbedTestPlugin`, enabled by `BANYANCODE_NVIDIA_TEST=1`) constructs an `@ai-sdk/openai-compatible` SDK against `https://integrate.api.nvidia.com/v1` and calls `embeddingModel().doEmbed()`. Production providers use the same trigger through their normal chat plugins.

**Researcher + free websearch.** The `researcher` subagent prefers `websearch_free` (DuckDuckGo HTML scraping, no API key). `websearch` (Exa/Parallel) is opt-in via the `banyancode_disable_websearch` flag. Tool dispatch routes through the existing OpenCode tool registry.

## Plan and design

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — repo layout, runtime layers, and BanyanCode service architecture.
- [`specs/banyancode/`](specs/banyancode/) — per-feature design (storage, orchestrator, subagent mesh, memory, code graph, free web search).
- [`specs/banyancode/overview.md`](specs/banyancode/overview.md) — one-paragraph pitch and reuse map.
- [`packages/docs/src/content/docs/banyancode.mdx`](packages/docs/src/content/docs/banyancode.mdx) — user-facing feature overview.

## Contributing and feedback

Issues and PRs are welcome at <https://github.com/EkagraAgarwal/BanyanCode>.

## License

MIT, same as the upstream OpenCode project.