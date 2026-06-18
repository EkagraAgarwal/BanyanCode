# BanyanCode — Overview

BanyanCode is a CLI/TUI-only fork of OpenCode that adds four features on top of the existing agent, tool, and command systems:

1. **Orchestrator + subagent mesh.** A new primary agent (`orchestrator`) decomposes complex tasks, fans them out to specialized subagents (`researcher`, `explore`, `coder`, `general`, `scout`) in parallel, and coordinates them via peer messaging and shared memory.
2. **Cross-session memory.** A persistent key-value store with optional embeddings, exposed as 5 tools (`memory_store`, `memory_recall`, `memory_list`, `memory_forget`, `memory_search`) and a `memory` skill.
3. **2-phase codebase utility.** Phase 1 (`/codegraph-build`) builds a polyglot code graph using tree-sitter. Phase 2 (`/code-embed`) computes embeddings over the same nodes for semantic search.
4. **Researcher agent with free web search.** A new subagent (`researcher`) that uses a DuckDuckGo-backed `websearch_free` tool as the default, with the existing Exa/Parallel `websearch` as an opt-in fallback.

BanyanCode reuses every existing OpenCode system that fits:

| BanyanCode concept | Reuses | File |
|---|---|---|
| New agents | `Agent.Service` + the `agents` table | `packages/opencode/src/agent/agent.ts:138-263` |
| Parallel subagents | `task` tool with `background: true` | `packages/opencode/src/tool/task.ts` |
| Background job waiting | `BackgroundJob.wait` | `packages/opencode/src/background/job.ts` |
| New tools | `Tool.make` + `Tools.Service.register` | `packages/core/src/tool/tool.ts`, `tools.ts` |
| Permission keys | `PermissionV1.Ruleset` + `Permission.fromConfig` merge | `packages/core/src/permission/permission.ts` |
| New commands | `Command.Service` + `cfg.command` loop | `packages/opencode/src/command/index.ts:98-111` |
| Skills | `Skill.discovery` | `packages/opencode/src/skill/discovery.ts` |
| Bus events | `bus.subscribe` / `bus.publish` | `packages/opencode/src/bus/` |
| Drizzle tables | existing schema barrel + migration runner | `packages/core/src/database/schema/` |
| Effect runtime | `makeRuntime`, `InstanceState`, `EffectBridge` | `packages/opencode/src/effect/` |
| Embeddings | `ai` SDK | `packages/opencode/src/session/llm.ts` |
| Tree-sitter | `web-tree-sitter` (already vendored) | `packages/opencode/package.json` |
| HTTP client | `HttpClient.HttpClient` from `effect/unstable/http` | `packages/core/src/tool/websearch.ts:154-177` |
| HTML parsing | `htmlparser2` | `packages/opencode/package.json` |
| Test helpers | `testEffect`, `it.effect`, `it.live`, `it.instance`, `tmpdir` | `packages/opencode/test/AGENTS.md` |

## Sub-specs

- `storage.md` — Drizzle tables for memory, code graph, embeddings, and subagent messages.
- `orchestrator.md` — Orchestrator agent design and mesh coordinator.
- `subagent-mesh.md` — Inter-agent message protocol and routing.
- `memory.md` — Cross-session memory tools, embedding provider, and skill.
- `codegraph.md` — Code graph + embeddings indexer, tools, and slash commands.
- `websearch-free.md` — DuckDuckGo-backed `websearch_free` tool.

## Out of scope

- `packages/desktop`, `packages/app`, `packages/web`, `packages/storybook`, `packages/console`, `packages/enterprise`, `packages/stats`, `packages/slack`, `packages/identity`, `packages/containers`. BanyanCode is TUI/CLI only.
- Binary rename (`opencode` → `banyancode`). Defer.
- Renaming `@opencode-ai/*` workspace packages. Defer.
- A new config file format. All BanyanCode options live in `opencode.json` (or `jsonc`).

## Status

The architecture overview lives in `ARCHITECTURE.md`. The detailed design for each feature lives in this directory.
