# Goal

FULL prompt-caching plan (`specs/banyancode/prompt-caching-optimization-plan.md` v4) — user overrode measure gate: implement ALL workstreams, then **dev-channel release** (push `origin/dev` → auto-canary `banyancode@dev`).

Verbatim condition: Entire prompt-caching plan implemented (PR1′, PR2, WS4 configuration_update, WS5 sticky tools/allowed_tools, WS6 prewarm, WS7 observability incl TUI, tool_search defer) — tests + typecheck green, lead commits each slice separately, push to origin/dev, publish.yml canary succeeds (npm view banyancode@dev shows new version).

## Waves (serialized around transform.ts / banyan-config.ts contention)

**Wave 1 (RUNNING)** — two coders:
1. PR1′: config mode+diagnostics, prompt_cache_options implicit, comparison_response_id, native schema, cache_write usage, tests. Files: banyan-config.ts, transform.ts, openai-responses.ts, tests.
2. PR2: system stable/dynamic split + stable_prefix key + golden tests. Files: system.ts, banyan-config.ts (one key), tests.

**Wave 2 (after Wave 1 file lists land)** — two coders, disjoint files:
3. WS5 sticky tools + tool_choice.allowed_tools / none + prompt-guide freeze. Files: session/tools.ts, request.ts resolveTools, tool registry, CodegraphSystemSource. Emit via transform only if Wave 1 left a clear seam; else native + TODO.
4. WS4 configuration_update: base/effective effort state, append input item, message-v2 round-trip, compaction guard, TUI/ACP hooks, local-state telemetry. Files: message-v2, variant/effort path, dialog-thinking, acp, compaction. Do NOT re-edit config keys Wave 1 added; add only banyancode_reasoning_configuration_update.

**Wave 3 (after Wave 2)** — two coders:
5. WS6 prewarm (banyancode_prompt_cache_prewarm, first-prompt warm call, hash idempotency) + WS7b TUI session-cost hit-rate readout.
6. tool_search / defer_loading: banyancode_tool_search_defer, <20 eager + namespaces, end-of-context injection, input_tokens measurement notes.

**Phase Z (lead)**: serialized `bun turbo typecheck --force` or per-pkg typecheck; full package tests; mesh review dispatch; fix findings; separate commits per slice (`feat(opencode): ...`); push `origin/dev`; verify publish.yml run + `npm view banyancode@dev version`.

## Parallel-work rules

- Subagents NEVER commit — return file lists via subagent_message.
- banyan-config.ts: each wave adds only its own keys; lead resolves conflicts.
- transform.ts / openai-responses.ts: only Wave 1 + explicit later handoff.
- No v2-tools changes. No Anthropic wire changes (applyCaching, utils/cache.ts, bedrock, anthropic-messages untouched).
- RAM: children run targeted tests only; lead runs serialized typecheck after each wave.

## Exit criteria / reviewer pass when

1. All workstreams implemented per plan acceptance criteria (see plan.md sections WS0–WS7, tool_search).
2. typecheck green across packages/core, packages/opencode, packages/tui, packages/llm; package tests green.
3. Anthropic fixtures green; OpenAI-only fields provider-gated.
4. Lead made separate commits per logical slice; pushed origin/dev; publish.yml canary succeeded; npm view banyancode@dev shows new version.
5. Reviewer pass on the full diff before push.
