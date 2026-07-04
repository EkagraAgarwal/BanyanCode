# BanyanCode

BanyanCode is a CLI/TUI-only fork of [OpenCode](https://github.com/anomalyco/opencode) that adds a parallel subagent mesh, cross-session memory, a tree-sitter code graph utility, and a free web search backend for a new researcher agent.

The TUI/CLI experience stays close to OpenCode; BanyanCode is a sequence of additions, not a rewrite. Desktop, web, app, and Storybook packages are explicitly out of scope.

## What BanyanCode adds over OpenCode

1. **Orchestrator + subagent mesh.** A primary `orchestrator` agent decomposes complex tasks, fans out to specialized subagents (`researcher`, `explore`, `coder`, `general`, `scout`) in parallel, and coordinates them via peer messaging and shared memory. The max-parallel limit is **user-configurable** via the Settings tab.
2. **Cross-session memory.** A persistent key-value store with **indexable JSONB payloads**, exposed as tools (`memory_store`, `memory_recall`, `memory_list`, `memory_forget`, `memory_search`) and a `memory` skill.
3. **Codebase utility.** `/codegraph-build` builds a polyglot code graph using tree-sitter. Storage is **Turso/libSQL**.
4. **Researcher agent with free web search.** A `researcher` subagent that uses a DuckDuckGo-backed `websearch_free` tool by default, with the existing Exa/Parallel `websearch` as an opt-in fallback.
5. **Repository intelligence (Wave 1 + Wave 2).** A graph-first retrieval stack on top of the codegraph. Wave 1 landed the 7-method `RepositoryIntelligence` (`findSymbol`, `findSubsystem`, `findEntrypoints`, `findTests`, `findRelated`, `estimateImpact`, `traceExecution`) plus hybrid `Search` (exact, prefix, BM25, fuzzy, camelCase, snake_case, qualified) and `StructuralQueries` (implementations, overrides, recursive, async, HTTP routes). Wave 2 reshaped it to a stable **9-method public surface** (`query`, `slice`, `explain`, `impact`, `trace`, `tests`, `symbols`, `relationships`, `ownership`) returning a typed `ArchitecturalSlice` (`{ summary, entrypoints, importantSymbols, relatedTests, relatedDocs, configs, routes, dependencies }`). The LLM sees 9 `repository_*` tool wrappers, every call is trace-recorded as paired JSONL events in `.banyancode/trace/<sessionID>.jsonl` with a 7-day / 10k-event rolling cap. Served over `/global/repository/*` HTTP routes, `/global/websearch-free`, and the new `opencode repository {query,explain,impact,trace,tests,relationships,ownership}` CLI subcommands. See [`ARCHITECTURE.md`](ARCHITECTURE.md) and the Wave 2 entry in [`plan.md`](plan.md).

## How BanyanCode is layered on OpenCode

BanyanCode keeps the entire OpenCode architecture and adds services alongside it:

| OpenCode layer | BanyanCode addition |
|----------------|---------------------|
| Agent registry (`packages/opencode/src/agent/`) | `orchestrator`, `researcher`, `scout`, `coder`, `explore`, `general` agents registered under the `BANYANCODE_ENABLE=1` feature gate |
| Command shell (`packages/opencode/src/command/`) | `/codegraph-build`, `/codegraph-remove`, `/yolo` slash commands; Wave 1 adds `/repo-find-subsystem`, `/repo-find-tests`, `/codegraph-search`, `/codegraph-find-routes`, `/codegraph-find-async`, `/codegraph-find-overrides`, `/codegraph-find-recursive`, `/codegraph-find-implementations`, `/codegraph-trace-execution`; Wave 2 adds `/repository-query`, `/repository-explain`, `/repository-trace`, `/repository-impact`, `/repository-tests`, `/repository-symbols`, `/repository-relationships`, `/repository-ownership`, `/websearch-free` |
| Tool registry (`packages/core/src/tool/`) | `memory_*`, `websearch_free`, `codegraph_*`, `code_*`, `system_*`, `mesh_*`, `systeminfo` tools; Wave 1 adds 7 `repo_*` tools and 5 `codegraph_find_*` / `codegraph_search` tools (13 in total); Wave 2 adds 9 `repository_*` tool wrappers (`repository_query`, `repository_slice`, `repository_explain`, `repository_impact`, `repository_trace`, `repository_tests`, `repository_symbols`, `repository_relationships`, `repository_ownership`) |
| CLI (`packages/opencode/src/cli/`) | Wave 1 adds `opencode codegraph {build,status,cancel,force-kill,path,trace}`; Wave 2 adds `opencode repository {query,explain,impact,trace,tests,relationships,ownership}` and `opencode websearch-free <query>` |
| Provider plugin system (`packages/core/src/plugin/provider/`) | All upstream provider plugins kept |
| Storage (`packages/core/src/database/`) | Turso/libSQL via `@libsql/client`. Project-local `.banyancode/banyancode.db` with 5+ tables (memory, codegraph, subagent messages, subagent plans) and a single fresh-schema migration |
| Event bus (`packages/core/src/event/`) | 2 new event types (`banyancode.codegraph.build`, `banyancode.system.updated`) the TUI subscribes to |
| TUI (`packages/tui/`) | 6 tabs (Chat, Sessions, Agents, Graph, Memory, Settings), Obsidian-style force-directed Graph view, agent config wizard, full settings accordion |
| Config schema (`packages/core/src/v1/config/`) | Separate `BanyanConfig.Info` schema — never mixed with OpenCode's `ConfigV1.Info` |
| Permissions (`packages/opencode/src/effect/permission-bridge.ts`) | Wave 2 adds a `PermissionV2.Service` bridge over the opencode `Permission.Service` so core consumers can stay Effect-native without leaking v1 types |

The feature gate (`BANYANCODE_ENABLE`) keeps the additions opt-in. With the gate off, BanyanCode is a no-op and the OpenCode experience is unchanged.

## Project-local directory layout

BanyanCode stores per-project state under `<project>/.banyancode/`:

```
<project>/.banyancode/
├── banyancode.db        # libSQL/Turso: memory, codegraph, subagent data
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

To configure the orchestrator's parallel-subagent limit:

1. Open the Settings tab (last tab in the session route).
2. Expand "Orchestration" → adjust **Max Subagents** (1–20, default 5).
3. The change is picked up immediately by `MeshCoordinator` (hard cap) and the orchestrator's prompt template.

To add a custom subagent:

1. Open the Agents tab → click **+ Add**.
2. Fill the wizard: name → description → model (optional) → tools (grouped multi-select) → review.
3. Saves to `.banyancode/agent/<name>.md` with frontmatter (`name`, `description`, `mode: subagent`, `model`, `tools`).

### Codegraph CLI

With `BANYANCODE_ENABLE=1`, build and inspect the index from the shell (no TUI required):

```bash
opencode codegraph build --force          # index cwd, stream progress
opencode codegraph build --root ./packages/core --force
opencode codegraph status                 # current build state
opencode codegraph cancel                 # cancel in-flight build
opencode codegraph force-kill             # interrupt stuck build (Windows: taskkill fallback)
opencode codegraph path                   # print .banyancode/banyancode.db path
opencode codegraph trace --session <id>   # tail the .banyancode/trace/<id>.jsonl file
```

### Repository intelligence CLI (Wave 2)

```bash
opencode repository query <query>                 # unified repository context
opencode repository explain <symbol>              # ArchitecturalSlice for a symbol
opencode repository trace <symbol> [--depth N]    # downstream entrypoints
opencode repository impact <path>                 # dependents of a file
opencode repository tests <symbol>                # tests referencing a symbol
opencode repository relationships <nodeID>         # BFS from a node
opencode repository ownership <path>              # most active git author

opencode websearch-free <query>                   # DuckDuckGo HTML; gated by BANYANCODE_DISABLE_WEBSEARCH
```

## Architecture (one paragraph each)

**Storage (Turso/libSQL).** BanyanCode uses `@libsql/client` to talk to a local file DB (`<project>/.banyancode/banyancode.db`). libSQL is a drop-in SQLite fork with FTS5 for full-text search and a `jsonb` type for indexable JSON paths. The driver adapter lives at `packages/core/src/database/sqlite.libsql.ts` and works on both Bun and Node.

**Orchestrator + mesh.** The `orchestrator` agent decomposes a prompt into a plan, then `MeshCoordinator` issues bounded parallel `Effect.forkIn(scope, ...)` calls to subagents. The cap is `BanyanConfig.banyancode_max_subagents` (default 5, max 20) — rendered into the orchestrator prompt as `{{maxSubagents}}` and enforced as a hard runtime limit by `MeshCoordinator.tryReserveSubagentSlot` (which evicts the oldest ended subagent or refuses the spawn). Subagents talk back via `SubagentBus` (a fire-and-persist log in SQLite) with `markDelivered` on consume, so retries/replays see them as consumed. Shared memory is the coordination substrate for outputs that cross agent boundaries.

**Memory.** A Drizzle table (`memory_entries`) keyed by `id` and scoped to `global` or `session`. `value` and `tags` are stored as `jsonb` (Turso user-defined type). `memory_search` runs BM25 keyword match. `update` uses optimistic concurrency (`UPDATE ... WHERE version = expected`) to avoid lost writes. `vacuum` enforces a TTL and entry-count cap.

**Code graph.** `CodegraphBuildService` walks `<root>`, skips `.banyancode/` itself and patterns from `.banyancode/ignore` and `.gitignore`, parses with tree-sitter (TS/JS/Python/Go/Rust) or regex fallback (everything else), and writes `codegraph_files`, `codegraph_nodes`, `codegraph_edges` to SQLite. Parsing runs with 8 concurrent fibers feeding a bounded producer-consumer queue; edge inserts are batched (1000 per transaction). A full workspace index (~3K files) completes in ~30s on a typical dev machine. Build from the TUI (`/codegraph-build`), HTTP (`POST /global/codegraph-build`), or CLI (`opencode codegraph build --force`). Cancel with `/codegraph-cancel`, `opencode codegraph cancel`, or force-kill a stuck build with `opencode codegraph force-kill`. The Obsidian-style Graph tab renders nodes with `d3-force` layout, layered by L0/L1/L2/L3 (focused / direct callers / transitive impact / reverse dependents). Pagination: `listAllNodes/Edges/Files` and `bumpVersion` use `countNodes/Edges/Files` (`SELECT COUNT(*)`) plus `searchNodes({ name?, kind?, limit })` with push-down `LIKE`/`=` filters — 50K-node codegraphs stay snappy.

**Researcher + free websearch.** The `researcher` subagent prefers `websearch_free` (DuckDuckGo HTML scraping, no API key). `websearch` (Exa/Parallel) is opt-in via the `banyancode_disable_websearch` flag. Tool dispatch routes through the existing OpenCode tool registry.

**System info.** A `systeminfo` tool is registered for `orchestrator` and `general` agents to query CPU/memory/GPU/VRAM/platform at runtime. A TUI sidebar widget (`packages/tui/src/feature-plugins/sidebar/system-status.tsx`) subscribes to `banyancode.system.updated` (published every 1s) and renders bars with color-coded warnings.

**Wave 1 — Repository intelligence.** Three new services sit on top of the codegraph:
- `RepositoryIntelligence` — 7 high-level retrieval APIs (`findSymbol`, `findSubsystem`, `findEntrypoints`, `findTests`, `findRelated`, `estimateImpact`, `traceExecution`). The BFS in `walkSubsystem`/`findRelated`/`traceExecution` is depth-bounded (`current.depth < maxDepth`); `findTests` walks `edgesFrom(testNode)` to follow the `test → symbol` direction. All functions return ranked `CodegraphNode[]`.
- `Search` — hybrid lexical/structural search with modes: exact, prefix, BM25 (with a startsWith+shorter-name tie-break), fuzzy (Levenshtein), camelCase, snake_case, qualified. Multi-mode calls merge + dedup + rank.
- `StructuralQueries` — tree-sitter-driven structural patterns: `findImplementations`, `findOverrides`, `findRecursiveFunctions`, `findAsyncFunctions`, `findHTTPRoutes`. The TS regex parser (`packages/core/src/banyancode/langs/typescript.ts`) captures `async function`, arrow-function consts, and class methods so these queries have nodes to match.

The indexer was extended in Wave 1 to emit 6 new file-level node kinds (`test`, `route`, `config`, `build`, `package`, `generated`) with full file `code` carried in the node, plus 5 new edge kinds (`tested_by`, `configured_by`, `built_by`, `mounts`, `generated_from`). File-level nodes are what `findHTTPRoutes` scans for `app.METHOD(path, handler)` registrations.

Every wave-1 tool call is wrapped in `traced(worktree, sessionID, tool, input, summary, effect)` from `packages/core/src/observability/trace.ts`. Two JSONL lines are appended per call to `.banyancode/trace/<sessionID>.jsonl` — one `phase:"start"` and one `phase:"end"` with `ms` duration. The trace file is the input for the evaluation harness planned in Wave 7 of the roadmap.

**Wave 2 — Repository intelligence v2.** The three Wave-1 services were reshaped into a single stable public surface:
- `RepositoryIntelligence` is now 9 methods (`query`, `slice`, `explain`, `impact`, `trace`, `tests`, `symbols`, `relationships`, `ownership`). The complex Wave-1 helpers (`findSymbol`, `findSubsystem`, ...) became private layer internals so the public surface stays coherent.
- All four "slice-returning" methods (`explain`, `impact`, `trace`, `slice`) return the new `ArchitecturalSlice` shape — `{ summary, entrypoints, importantSymbols, relatedTests, relatedDocs, configs, routes, dependencies }`. `summary` and the four populated arrays are always present; the optional arrays default to `[]`. This shape is the wire format the LLM sees in tool output and the SDK consumer sees in `RepositoryContext`.
- `Search` gains `searchAuto(query, opts)` for a public Exact→Qualified→Prefix→Graph→BM25→Fuzzy cascade, plus a `mode: "manual"` escape hatch for SDK/CLI callers who want to override the cascade.
- `StructuralQueries` adds `findInterfaces`, `findExports`, `findImports` (3 new methods; the existing 5 Wave-1 methods are unchanged).
- The codegraph indexer's classifier now distinguishes `ci | docker | env | doc` file kinds so markdown and Dockerfile content contributes to slices via `relatedDocs`. Parsers in `packages/core/src/banyancode/langs/{markdown,docker}.ts`.
- 9 new HTTP endpoints under `/global/repository/*` (mounted on `RootHttpApi`, not session-scoped, so they work without an active session); handlers rewritten to call the new 9-method service surface.
- 9 new LLM tool wrappers in `packages/core/src/tool/repository-wave2.ts`: every call passes through `traced(...)` and `PermissionV2.assert(...)` and returns the schema-validated `ArchitecturalSlice`/`RepositoryContext`/`CodegraphNode[]`/`owner` shape.
- 9 new slash commands + templates, and 2 new top-level CLI groups (`opencode repository ...`, `opencode websearch-free <query>`).
- `PermissionV2.Service` is implemented on top of opencode's `Permission.Service` (`packages/opencode/src/effect/permission-bridge.ts`), so core services can request permissions without depending on the v1 schema.
- `TraceEvent` got optional `cache?: CacheLayer<...>` and `workspace?: WorkspaceContext` slots, plus a 7-day / 10k-event rolling cap on the JSONL file. The CLI subcommand `opencode codegraph trace --session <id>` tails the trace file.

See [`plan.md`](plan.md) for the Wave 3+ outline (caching layer, semantic code search, evaluator harness).

## TUI UX

The TUI follows modern TUI design patterns (Charm, Ink, OpenTUI reference):
- **Modal dialogs** with opaque backdrop and a `<leader>:` palette. The command palette (`<leader>:commands`) and the prompt autocomplete (`/`) are the two ways to find actions; both share keybindings via the `keymap` registry.
- **Empty states** are designed, not blanked — every "No X" / "Loading…" surface renders the same shape: glyph (`◌ loading` / `∅ empty` / `✗ error` / `○ info`) + title + suggested next action. Reusable component at `packages/tui/src/ui/empty-state.tsx`; design tokens at `packages/tui/src/ui/tokens.ts`.
- **Status pills** carry both glyph and color (Charm-style 4-color status palette: `success`/`warning`/`error`/`info`).
- **Tabs** are `Tab` / `Shift+Tab` navigable (keybinds surfaced in the prompt footer).
- **Solid `<For>` everywhere** for keyed iteration; `.map()` in JSX is forbidden.
- **Codegraph Intel sidebar panel** (Wave 1): keeps the last 8 repository-intelligence, search, and routes queries in a recent-queries strip so the user can see what the LLM has been asking. Populated by the wave-1 slash commands listed above; clickable results route back through the same HTTP endpoints.

## Design docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — repo layout, runtime layers, BanyanCode service architecture, V2/V3/Wave-1/Wave-2 changelog.
- [`plan.md`](plan.md) — Wave-2 shipped snapshot and the Wave-3+ outline.
- [`specs/banyancode/`](specs/banyancode/) — per-feature design (storage, orchestrator, subagent mesh, memory, code graph, free web search, types).
- [`specs/banyancode/overview.md`](specs/banyancode/overview.md) — one-paragraph pitch and reuse map.
- [`packages/docs/src/content/docs/banyancode.mdx`](packages/docs/src/content/docs/banyancode.mdx) — user-facing feature overview.

## Contributing and feedback

Issues and PRs are welcome at <https://github.com/EkagraAgarwal/BanyanCode>.

## License

MIT, same as the upstream OpenCode project.
