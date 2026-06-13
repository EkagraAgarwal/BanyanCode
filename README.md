# BanyanCode

BanyanCode is a CLI/TUI-only fork of [OpenCode](https://github.com/anomalyco/opencode) that adds a parallel subagent mesh, cross-session memory, a code graph + embeddings utility, and a free web search backend for a new researcher agent.

## What BanyanCode adds

1. **Orchestrator + subagent mesh.** A new primary `orchestrator` agent decomposes complex tasks, fans out to specialized subagents (`researcher`, `explore`, `coder`, `general`, `scout`) in parallel, and coordinates them via peer messaging and shared memory.
2. **Cross-session memory.** A persistent key-value store with optional embeddings, exposed as 5 tools (`memory_store`, `memory_recall`, `memory_list`, `memory_forget`, `memory_search`) and a `memory` skill.
3. **2-phase codebase utility.** Phase 1 (`/codegraph-build`) builds a polyglot code graph using tree-sitter. Phase 2 (`/code-embed`) computes embeddings over the same nodes for semantic search.
4. **Researcher agent with free web search.** A new subagent (`researcher`) that uses a DuckDuckGo-backed `websearch_free` tool as the default, with the existing Exa/Parallel `websearch` as an opt-in fallback.

BanyanCode is TUI/CLI only. The `desktop`, `app`, `web`, and `storybook` packages are explicitly out of scope.

## Quick start

```bash
bun install
bun dev
```

`bun dev` runs the TUI from `packages/opencode`. Usage, build instructions, and developer docs live in [`packages/opencode/README.md`](packages/opencode/README.md).

## Plan and design

- [`BANYANCODE_PLAN.md`](BANYANCODE_PLAN.md) — the master plan, phase by phase.
- [`specs/banyancode/`](specs/banyancode/) — per-feature design (storage, orchestrator, subagent mesh, memory, code graph, free web search).
- [`specs/banyancode/overview.md`](specs/banyancode/overview.md) — one-paragraph pitch and reuse map.

## Contributing and feedback

This is an early fork and is still landing the 4 features above. Issues and PRs are welcome at <https://github.com/EkagraAgarwal/BanyanCode>.

## License

MIT, same as the upstream OpenCode project.
