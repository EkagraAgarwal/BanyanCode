# BanyanCode Agents Dump

Generated snapshot of all visible agents, their system prompts, tools, and mesh wiring as of `mesh-phase0-complete`. Use this when:
- Adding a new tool (verify it shows up in agent prompts and permission blocks)
- Debugging "agent X can't do Y" (cross-reference this table with `packages/opencode/src/agent/agent.ts`)
- Documenting the mesh permission model
- Auditing which prompts reference codegraph-first search

## Per-agent table

| Name | Mode | Native | Hidden | First-line description | Prompt file |
|---|---|---|---|---|---|
| `build` | primary | yes | no | "The default agent. Executes tools based on configured permissions." | **none** (provider default) |
| `plan` | primary | yes | no | "Plan mode. Disallows all edit tools." | **none** (provider default) |
| `general` | subagent | yes | no | "General-purpose agent for researching complex questions and executing multi-step tasks." | `packages/opencode/src/agent/prompt/general.txt` |
| `orchestrator` | primary | yes | no | "Decomposes complex tasks, fans out to parallel subagents, coordinates via shared memory and peer messages." | `packages/opencode/src/agent/prompt/orchestrator.txt` |
| `coder` | subagent | yes | no | "Focused executor agent. Makes targeted code changes using codegraph-first analysis. Single task, no delegation." | `packages/opencode/src/agent/prompt/coder.txt` |
| `explore` | subagent | yes | no | "Fast agent specialized for exploring codebases." | `packages/opencode/src/agent/prompt/explore.txt` |
| `scout` | subagent | yes | no | "Fast reconnaissance agent. Single shot, return within 3 tool calls." | `packages/opencode/src/agent/prompt/scout.txt` |
| `researcher` | subagent | yes | no | "Read-only subagent. Performs free web search via DuckDuckGo and reads external docs." | `packages/opencode/src/agent/prompt/researcher.txt` |
| `compaction` | primary | yes | yes | (hidden system agent for context compaction) | `packages/opencode/src/agent/prompt/compaction.txt` |
| `title` | primary | yes | yes | (hidden system agent for session title generation) | `packages/opencode/src/agent/prompt/title.txt` |
| `summary` | primary | yes | yes | (hidden system agent for session summary generation) | `packages/opencode/src/agent/prompt/summary.txt` |

Hidden agents (`compaction`, `title`, `summary`) are excluded from the TUI agent registry and do not appear in the AGENTS tab. They run server-side only for compaction/title/summary generation.

## Mesh permission matrix (post PR D)

| Agent | `task` (spawn) | `subagent_message` | `mesh_control` | `mesh_subscribe` |
|---|---|---|---|---|
| `orchestrator` | researcher/coder/explore/general/scout | allow | allow | allow |
| `coder` | explore, scout | allow | deny | allow |
| `explore` | scout | allow | deny | allow |
| `scout` | deny | allow | deny | allow |
| `researcher` | scout | allow | deny | allow |
| `general` | explore, scout, researcher | allow | deny | allow |
| `build` (default) | explore, scout, general | allow | deny | allow |
| `plan` | deny | deny | deny | deny |

## Key notes

- All visible agents (primary + subagent) now reference codegraph-first search in their effective system prompt via `SystemPrompt.codegraph()` (PR C).
- The `build` agent prompt is the upstream provider default (anthropic.txt / gpt.txt / etc.). It picks up the codegraph block from the system prompt pipeline at runtime.
- `coder` no longer denies `subagent_message` or `mesh_subscribe`. It can reply to the orchestrator and listen to peer streams.
- `mesh_control` (steer / kill / plan_for) remains orchestrator-only. Subagents can subscribe to messages but cannot steer or kill peers.

## File path reference

- Agent registry: `packages/opencode/src/agent/agent.ts`
- Agent prompts: `packages/opencode/src/agent/prompt/*.txt`
- Provider default prompts: `packages/opencode/src/session/prompt/*.txt`
- System prompt assembly: `packages/opencode/src/session/llm/request.ts:56-78`
- System prompt service: `packages/opencode/src/session/system.ts`
- Environment + skills: `packages/opencode/src/session/system.ts`
- Tool registry: `packages/opencode/src/tool/registry.ts`
- Tool base type: `packages/core/src/tool/tool.ts`
- Tool registration: `packages/core/src/tool/tools.ts`
- BanyanCode service namespace: `packages/core/src/banyancode/index.ts`
- AGENTS tab UI: `packages/tui/src/feature-plugins/tabs/tab-agents.tsx`
- SETTINGS tab UI: `packages/tui/src/feature-plugins/tabs/tab-settings.tsx`