# Claude Agent routing

Phase 4 of `specs/banyancode/v2-migration-plan.md`. v2 ships the `claude-agent`
provider (`packages/core/src/plugin/provider/claude-agent/**`, spec
`specs/v2/claude-agent-provider.md`); BanyanCode does not build a provider. This
note records what the agent layer must know about it.

## Setup

1. Install and sign in to `claude` on the same machine (`claude` on `PATH`, or
   point `OPENCODE_CLAUDE_PATH` at it). The identity layer maps
   `BANYANCODE_CLAUDE_PATH` onto that variable at CLI entry.
2. The provider id is `claude-agent`; model refs look like
   `claude-agent/<model>` (for example `claude-agent/sonnet`).
3. Keep the product name "Claude Agent". The SDK branding rules do not allow
   calling it "Claude Code".
4. Nothing else is required: the provider turns Claude Code's built-in tools
   off and exposes BanyanCode's tools instead. If the tool list cannot be
   handed to Claude the request fails; it never falls back to Claude Code's
   tools.

## What Claude sees

- **Prompt.** Claude Code keeps its own base system prompt. The selected
  agent's `system` field (our `src/agents/prompt/*.txt`) is sent as that
  agent's *role*, not as a replacement for the base prompt
  (`claude-agent/instructions.ts` reads `agent.system` into
  `ClaudeSystemPrompt.AGENT_OPTION`). On other providers the same text
  replaces the provider prompt. This is why the orchestrator prompt is written
  as a role definition rather than a whole system prompt.
- **Instructions.** AGENTS.md files, skills, references and MCP instructions
  are passed through. Claude writes its own date and environment, so those
  parts are dropped (`SUPPLIED_BY_CLAUDE`).
- **Tools.** Every tool reaches Claude as an MCP tool named
  `mcp__opencode__<name>` (`tools/names.ts:6`). The `mcp__opencode__` prefix
  survives; the bare name is hashed/truncated only when it exceeds 64
  characters, so `banyan_*`, `repository_*`, `codegraph_*` and the rest keep
  their ids and descriptions. Descriptions are cut at 2048 characters; the
  `subagent` tool moves its "Available subagents:" block to the front so the
  list survives the cut.
- **Tool calls.** Claude's call is held by the plugin, executed by v2 (with the
  normal permission checks), and the result is returned. Calls to tools that
  were not offered (for example an unprefixed `glob`) are answered by Claude
  Code itself and ignored by the plugin.

## One tool at a time

`tools/pending.ts` remembers a single PreToolUse id (`next`) and the hooks never
mark tools safe to run in parallel. Consequences:

- Parallel tool calls in one assistant turn are serialized. Building
  throughput on them is wasted.
- Parallelism must be expressed as **parallel subagents** (`subagent` with
  `background: true`). The orchestrator prompt (`prompt/orchestrator.txt`)
  carries this rule in "Parallelism and tool calls".
- Changing the advertised tool list restarts the Claude process (the SDK cannot
  swap tools while running), so tool registration should settle before a
  session starts.

## Recommended routing

`banyancode.json` `agent.<id>.model` takes the usual `provider/model` form, so
mixed-provider meshes need no provider work:

```jsonc
{
  "agent": {
    "orchestrator": { "model": "claude-agent/sonnet" },
    "reviewer": { "model": "claude-agent/sonnet" },
    "coder": { "model": "deepseek/deepseek-v4.1" },
    "scout": { "model": "deepseek/deepseek-v4.1" }
  }
}
```

- Orchestrator and reviewer benefit most from Claude's reasoning and run far
  fewer tool calls than workers, so they are the cheap place to spend the
  subscription.
- Workers (`coder`, `scout`, `explore`, `researcher`) do the tool-heavy work;
  route them to cheaper providers.
- Subagents always go through v2's `subagent` tool, never Claude's own Task
  tool (Claude Code's built-ins are off).
- Reasoning effort: `agent.<id>.thinking` / `variant` maps onto the model
  variant (`Model.Ref.variant`), which the Claude Agent provider translates to
  the SDK `effort` option. `ultra` has no v2 variant and resolves to `max`.
  `thinking` only applies when the agent has a model pinned
  (`agent.<id>.model`), because a variant is part of the model ref.
- Nested fan-out: `coder` may spawn `explore`/`researcher` only when
  `experimental.subagent_depth` is at least 2. v2 defaults to 1 (no nested
  subagents), which silently turns those delegations into depth-limit errors.
  Raise it in `opencode.json` for coder-style meshes.

## Tests to keep (Phase 4 acceptance)

- `claude` present vs missing, and logged out.
- Tool-list changes restart the Claude process.
- A mesh run with mixed providers (orchestrator on `claude-agent`, workers on a
  cheaper provider).
- `banyancode.json` overrides targeting `claude-agent/<model>` set the agent's
  model ref and variant.
