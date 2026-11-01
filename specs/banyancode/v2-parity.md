# BanyanCode v1 → v2 parity checklist

Status: **Phase 0 deliverable** · authored 2026-10-31 from the v1 tree
`D:\OpenCode` at `fe31467b89` (branch `fix-installer-resolve`).

This is the exhaustive inventory of user-visible BanyanCode v1 capabilities that the
v2 rebuild must reproduce. Every row is derived from v1 source, not from prose.
Rows are grouped by surface:

| Section | Surface |
|---|---|
| 1 | LLM-facing tools |
| 2 | Agents and system-prompt sources |
| 3 | Slash commands and command-palette entries |
| 4 | `BanyanConfig` keys and per-agent override fields |
| 5 | HTTP routes |
| 6 | MCP delegation-server tools |
| 7 | TUI surfaces |
| 8 | CLI commands, env vars and product identity |
| 9 | Published events |

## Column contract

| Column | Meaning |
|---|---|
| ID/name | The stable public name (tool id, agent name, command, config key, route, event type). |
| v1 source (path:line) | The v1 file and line that defines the capability. Paths are relative to the repo root. |
| Workstream | The migration-plan workstream that owns the port: `3a`–`3h`, `4`, `5`, or `1` for Phase 1 identity/base-platform items. |
| Status | `todo` while unported, `done` once shipped, `dropped` only for intentionally removed capabilities. |
| Test | Empty until a test exists. |

**Definition of done.** A row becomes `done` only when its `Test` cell names a real,
passing test (`path/to/file.test.ts::test name`) that proves the v1 behavior still
works in v2. A row with an empty `Test` cell stays `todo`, even if the code exists.
Dropped rows keep the reason in `Status`.

**Intentional removal.** Cross-session memory is removed per the migration plan
(decision of 2026-10-31). Every memory-related row is marked
`dropped — memory feature removed` and must not be ported. Adjacent capabilities
that merely mention memory (e.g. `shared_memory` for mesh coordination) are **not**
memory-feature rows and stay `todo`.

**Markers used in the ID/name cell.**
`(module only)` — the module exists in v1 but is not registered in
`packages/tui/src/feature-plugins/builtins.ts`, so it is not user-visible today.
`(stored only)` — the key is accepted and persisted but has no consumer in v1.
`(declared, unregistered)` — the command/tool constant exists but is never registered.

---

## 1. LLM-facing tools

Manifest and registration:
`packages/core/src/banyancode/banyan-tools-manifest.ts:26-53` (public ids,
internal ids, `banyanToolLayer()`), mounted through
`packages/opencode/src/effect/banyan-tools-mount.ts:177-205`. The v1 legacy
registry additionally exposes `systeminfo`
(`packages/opencode/src/tool/registry.ts:240`).

### 1a. Public tools registered for the model

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| codegraph_build | packages/core/src/tool/codegraph.ts:18 | 3a | todo | |
| codegraph_remove | packages/core/src/tool/codegraph.ts:19 | 3a | todo | |
| code_find | packages/core/src/tool/code-find.ts:25 | 3a | todo | |
| codegraph_staleness | packages/core/src/tool/codegraph-staleness.ts:15 | 3a | todo | |
| repository_query | packages/core/src/tool/repository-wave2.ts:25 | 3c | todo | |
| repository_explain | packages/core/src/tool/repository-wave2.ts:27 | 3c | todo | |
| repository_impact | packages/core/src/tool/repository-wave2.ts:28 | 3c | todo | |
| repository_trace | packages/core/src/tool/repository-wave2.ts:29 | 3c | todo | |
| repository_tests | packages/core/src/tool/repository-wave2.ts:30 | 3c | todo | |
| blast_radius | packages/core/src/tool/blast-radius.ts:24 | 3c | todo | |
| preflight | packages/core/src/tool/preflight.ts:27 | 3c | todo | |
| safe_rename | packages/core/src/tool/safe-rename.ts:22 | 3c | todo | |
| edit_plan | packages/core/src/tool/edit-plan.ts:18 | 3c | todo | |
| websearch_free | packages/core/src/tool/websearch-free.ts:15 | 3d | todo | |
| system_status | packages/core/src/tool/system-status.ts:9 | 3e | todo | |
| systeminfo | packages/opencode/src/tool/systeminfo.ts:12 | 3e | todo | |
| banyan_tool_search | packages/core/src/tool/tool-search.ts:17 | 3e | todo | |
| banyan_test | packages/core/src/tool/test.ts:17 | 3c | todo | |
| shared_memory | packages/core/src/tool/shared-memory.ts:11 | 3f | todo | |
| mesh_control | packages/core/src/tool/mesh-control.ts:12 | 3f | todo | |
| mesh_subscribe | packages/core/src/tool/mesh-subscribe.ts:16 | 3f | todo | |
| mesh_status | packages/core/src/tool/mesh-status.ts:12 | 3f | todo | |
| subagent_message | packages/core/src/tool/subagent-message.ts:12 | 3f | todo | |
| goal | packages/core/src/tool/goal.ts:15 | 3f | todo | |
| memory_store | packages/core/src/tool/memory.ts:16 | 3b | dropped — memory feature removed | |
| memory_recall | packages/core/src/tool/memory.ts:17 | 3b | dropped — memory feature removed | |
| memory_list | packages/core/src/tool/memory.ts:18 | 3b | dropped — memory feature removed | |
| memory_forget | packages/core/src/tool/memory.ts:19 | 3b | dropped — memory feature removed | |
| memory_search | packages/core/src/tool/memory.ts:20 | 3b | dropped — memory feature removed | |
| memory_candidate_emit | packages/core/src/tool/memory-candidate.ts:10 | 3b | dropped — memory feature removed | |
| memory_stats | packages/core/src/tool/memory-stats.ts:13 | 3b | dropped — memory feature removed | |

### 1b. Internal / advanced tools (registered, lower catalog visibility)

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| codegraph_query | packages/core/src/tool/codegraph.ts:20 | 3a | todo | |
| codegraph_impact | packages/core/src/tool/codegraph.ts:21 | 3a | todo | |
| codegraph_dependents | packages/core/src/tool/codegraph.ts:22 | 3a | todo | |
| codegraph_callers | packages/core/src/tool/codegraph.ts:23 | 3a | todo | |
| codegraph_search | packages/core/src/tool/codegraph-search-tool.ts:17 | 3a | todo | |
| codegraph_find_implementations | packages/core/src/tool/structural-queries-tool.ts:16 | 3a | todo | |
| codegraph_find_overrides | packages/core/src/tool/structural-queries-tool.ts:17 | 3a | todo | |
| codegraph_find_recursive | packages/core/src/tool/structural-queries-tool.ts:18 | 3a | todo | |
| codegraph_find_async | packages/core/src/tool/structural-queries-tool.ts:19 | 3a | todo | |
| codegraph_find_http_routes | packages/core/src/tool/structural-queries-tool.ts:20 | 3a | todo | |
| repository_symbols | packages/core/src/tool/repository-wave2.ts:31 | 3c | todo | |
| repository_relationships | packages/core/src/tool/repository-wave2.ts:32 | 3c | todo | |
| repository_ownership | packages/core/src/tool/repository-wave2.ts:33 | 3c | todo | |

### 1c. Tool modules present but never registered

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| banyan_typecheck (declared, unregistered) | packages/core/src/tool/typecheck.ts:17 | 3c / 3h | todo | |
| banyan_lint (declared, unregistered) | packages/core/src/tool/lint.ts:17 | 3c / 3h | todo | |

Note: the migration plan's 3h default is to finish both tools in v2; both already
exist as HTTP routes (`/global/typecheck`, `/global/lint`), so the gap is
registration plus agent permissions.

## 2. Agents and system-prompt sources

Agent table: `packages/opencode/src/agent/agent.ts:242-689`. Prompts:
`packages/opencode/src/agent/prompt/*.txt`. BanyanCode-specific permission
defaults: `agent.ts:190-226`, injected system blocks:
`packages/core/src/banyancode/banyan-orchestration-system-source.ts:119` and
`packages/core/src/banyancode/codegraph-system-source.ts:80`.

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| build (modified) — primary, default agent; task allowlist explore/scout/coder/researcher, banyan tools allowed, custom prompt not set (system block injected) | packages/opencode/src/agent/agent.ts:243 | 3d | todo | |
| plan (modified) — primary; edit only `.opencode/plans`, `.banyancode/plans` and the global plans dir; codegraph read tools allowed | packages/opencode/src/agent/agent.ts:272 | 3d | todo | |
| explore (modified) — subagent; read-only (`"*": "deny"`, bash deny), task deny, Banyan prompt template | packages/opencode/src/agent/agent.ts:319, packages/opencode/src/agent/prompt/explore.txt:1 | 3d | todo | |
| coder (new) — subagent; edit/write/bash/read allow, task only explore+researcher, todo/question allow | packages/opencode/src/agent/agent.ts:388, packages/opencode/src/agent/prompt/coder.txt:1 | 3d | todo | |
| scout (new) — subagent; read-only, single shot, websearch_free, todowrite deny, task deny | packages/opencode/src/agent/agent.ts:443, packages/opencode/src/agent/prompt/scout.txt:1 | 3d | todo | |
| reviewer (new) — subagent; read-only; edit/write/apply_patch/bash/websearch/task/todowrite/question deny; pass/fail/blocked verdict | packages/opencode/src/agent/agent.ts:498, packages/opencode/src/agent/prompt/reviewer.txt:1 | 3d | todo | |
| orchestrator (new) — primary; task allow all five subagents, shared_memory/mesh_control/mesh_subscribe/todowrite/question/systeminfo allow; maxSubagents template var | packages/opencode/src/agent/agent.ts:606, packages/opencode/src/agent/prompt/orchestrator.txt:1 | 3f | todo | |
| researcher (new) — subagent; edit/bash deny, websearch/webfetch allow, shared_memory allow | packages/opencode/src/agent/agent.ts:636, packages/opencode/src/agent/prompt/researcher.txt:1 | 3d | todo | |
| compaction (modified) — hidden primary; `"*": "deny"` plus codegraph_staleness/memory_stats/mesh_status allows | packages/opencode/src/agent/agent.ts:551 | 3d | todo | |
| title (modified) — hidden primary; same `"*": "deny"` plus status-tool allows; temperature 0.5 | packages/opencode/src/agent/agent.ts:569 | 3d | todo | |
| summary (modified) — hidden primary; same status-tool allow list | packages/opencode/src/agent/agent.ts:588 | 3d | todo | |
| BanyanCode orchestration system block — static policy + mesh/subagent rules, emitted for every agent | packages/core/src/banyancode/banyan-orchestration-system-source.ts:119 | 3f | todo | |
| Codegraph system policy + dynamic tool guide — repository-first search policy and per-tool guide rendered from the registry | packages/core/src/banyancode/codegraph-system-source.ts:80 | 3a | todo | |
| Custom agent markdown discovery — `{agent,agents}/**/*.md` under `.banyancode/` and config dirs | packages/opencode/src/config/agent.ts:40 | 3d | todo | |
| Per-agent overrides from `banyancode.json` — `enabled`, `model`, `thinking`, `variant` applied at `Agent.get`/`list` | packages/opencode/src/agent/agent.ts:48-91 | 3d | todo | |

## 3. Slash commands and command-palette entries

Server-side commands (prompt autocomplete):
`packages/opencode/src/command/index.ts:95-116` (names) and
`:206-667` (registrations). TUI palette / slash intercepts:
`packages/tui/src/app.tsx:697-950` and
`packages/tui/src/component/prompt/index.tsx:1216-1420`.

### 3a. Server slash commands

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| /codegraph-build | packages/opencode/src/command/index.ts:206 | 3a | todo | |
| /goal | packages/opencode/src/command/index.ts:252 | 3f | todo | |
| /repository-query | packages/opencode/src/command/index.ts:388 | 3c | todo | |
| /repository-explain | packages/opencode/src/command/index.ts:397 | 3c | todo | |
| /repository-trace | packages/opencode/src/command/index.ts:406 | 3c | todo | |
| /repository-impact | packages/opencode/src/command/index.ts:415 | 3c | todo | |
| /repository-tests | packages/opencode/src/command/index.ts:424 | 3c | todo | |
| /repository-symbols | packages/opencode/src/command/index.ts:433 | 3c | todo | |
| /repository-relationships | packages/opencode/src/command/index.ts:442 | 3c | todo | |
| /repository-ownership | packages/opencode/src/command/index.ts:451 | 3c | todo | |
| /websearch-free | packages/opencode/src/command/index.ts:460 | 3d | todo | |
| /yolo | packages/opencode/src/command/index.ts:469 | 3e | todo | |
| /swarm | packages/opencode/src/command/index.ts:497 | 3f | todo | |
| /max-subagents | packages/opencode/src/command/index.ts:527 | 3f | todo | |
| /lsp | packages/opencode/src/command/index.ts:587 | 3e | todo | |
| /refresh-models | packages/opencode/src/command/index.ts:569 | 1 | todo | |
| /import | packages/opencode/src/command/index.ts:640 | 1 | todo | |
| /codegraph-remove (declared, unregistered) | packages/opencode/src/command/index.ts:99 | 3a / 3h | todo | |
| /init | packages/opencode/src/command/index.ts:187 | 1 | todo | |
| /review | packages/opencode/src/command/index.ts:196 | 1 | todo | |

### 3b. Command-palette and prompt intercepts

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| agent.tree / `/agent-tree` — opens the agent-tree dialog | packages/tui/src/app.tsx:697 | 3f | todo | |
| agent.model / `/agent-model` — per-agent model picker (orchestrator default) | packages/tui/src/app.tsx:715 | 3d | todo | |
| codegraph.build — palette action, starts a build over the worktree | packages/tui/src/app.tsx:842 | 3a | todo | |
| codegraph.cancel / `/codegraph-cancel` — cancels the build | packages/tui/src/app.tsx:831 | 3a | todo | |
| codegraph.remove / `/codegraph-remove` — removes the index | packages/tui/src/app.tsx:871 | 3a | todo | |
| models.refresh — palette action calling `/refresh-models` | packages/tui/src/app.tsx:902 | 1 | todo | |
| yolo.toggle — palette action calling `/yolo` | packages/tui/src/app.tsx:916 | 3e | todo | |
| swarm.toggle — palette action calling `/swarm` | packages/tui/src/app.tsx:930 | 3f | todo | |
| subagents.max_subagents — opens the max-subagents dialog | packages/tui/src/app.tsx:944 | 3f | todo | |
| `/codegraph-force-kill` — prompt intercept, force-kills a wedged build | packages/tui/src/component/prompt/index.tsx:1244 | 3a | todo | |
| `/lsp` — prompt intercept with instant toast (server command remains canonical) | packages/tui/src/component/prompt/index.tsx:1330 | 3e | todo | |
| `/thinking` / `/variant` / `/reasoning` — prompt intercept that reads or sets the reasoning variant (off/low/medium/high/max/xhigh/ultra) | packages/tui/src/component/prompt/index.tsx:1054 | 3d | todo | |
| `/repo-find-subsystem` (never worked) — calls missing `/global/repo/find-subsystem` | packages/tui/src/component/prompt/index.tsx:1263 | 3h | todo | |
| `/codegraph-search` (never worked) — calls missing `/global/codegraph/search` | packages/tui/src/component/prompt/index.tsx:1287 | 3h | todo | |
| `/codegraph-find-routes` (never worked) — calls missing `/global/codegraph/find-http-routes` | packages/tui/src/component/prompt/index.tsx:1311 | 3h | todo | |

## 4. `BanyanConfig` keys and per-agent override fields

Schema: `packages/core/src/v1/config/banyan-config.ts:109-318`. Consumers read via
`Banyan.BanyanConfigService`; v2 must accept and validate the same keys in
`banyancode.json`. `(stored only)` marks keys with no consumer in v1.

### 4a. Top-level keys

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| $schema | packages/core/src/v1/config/banyan-config.ts:110 | 1 | todo | |
| banyancode_openai_compatible_endpoints (`name`, `base_url`, `api_key?`, `models?`) | packages/core/src/v1/config/banyan-config.ts:111 | 3e | todo | |
| banyancode_yolo_mode | packages/core/src/v1/config/banyan-config.ts:112 | 3e | todo | |
| banyancode_background_subagents | packages/core/src/v1/config/banyan-config.ts:117 | 3f | todo | |
| banyancode_disable_websearch | packages/core/src/v1/config/banyan-config.ts:118 | 3d | todo | |
| banyancode_telemetry (`on`/`off`) | packages/core/src/v1/config/banyan-config.ts:121 | 3e | todo | |
| banyancode_agent_telemetry (`on`/`off`) | packages/core/src/v1/config/banyan-config.ts:125 | 3e | todo | |
| banyancode_agent_telemetry_retention_days | packages/core/src/v1/config/banyan-config.ts:126 | 3e | todo | |
| banyancode_agent_telemetry_max_events | packages/core/src/v1/config/banyan-config.ts:127 | 3e | todo | |
| banyancode_telegram_enabled (stored only) | packages/core/src/v1/config/banyan-config.ts:128 | 3h | todo | |
| banyancode_telegram_bot_token (stored only) | packages/core/src/v1/config/banyan-config.ts:129 | 3h | todo | |
| banyancode_telegram_webhook_secret (stored only) | packages/core/src/v1/config/banyan-config.ts:130 | 3h | todo | |
| banyancode_telegram_default_session (stored only) | packages/core/src/v1/config/banyan-config.ts:131 | 3h | todo | |
| banyancode_max_subagents (default 5, cap 20) | packages/core/src/v1/config/banyan-config.ts:135 | 3f | todo | |
| banyancode_router (`off`/`rules`) | packages/core/src/v1/config/banyan-config.ts:140 | 3e | todo | |
| banyancode_route_grep | packages/core/src/v1/config/banyan-config.ts:146 | 3e | todo | |
| banyancode_route_read | packages/core/src/v1/config/banyan-config.ts:147 | 3e | todo | |
| banyancode_route_glob | packages/core/src/v1/config/banyan-config.ts:148 | 3e | todo | |
| banyancode_router_trace | packages/core/src/v1/config/banyan-config.ts:152 | 3e | todo | |
| banyancode_augment_read | packages/core/src/v1/config/banyan-config.ts:157 | 3e | todo | |
| banyancode_goal_evaluator_model | packages/core/src/v1/config/banyan-config.ts:159 | 3f | todo | |
| banyancode_max_goal_iterations | packages/core/src/v1/config/banyan-config.ts:161 | 3f | todo | |
| banyancode_goal_max_time_ms (stored only) | packages/core/src/v1/config/banyan-config.ts:163 | 3f / 3h | todo | |
| banyancode_goal_auto_retry_on_block (stored only) | packages/core/src/v1/config/banyan-config.ts:165 | 3f / 3h | todo | |
| banyancode_git_author_email (stored only) | packages/core/src/v1/config/banyan-config.ts:166 | 3h | todo | |
| banyancode_codegraph_exclude_patterns | packages/core/src/v1/config/banyan-config.ts:167 | 3a | todo | |
| banyancode_codegraph_concurrency (stored only) | packages/core/src/v1/config/banyan-config.ts:168 | 3a / 3h | todo | |
| banyancode_codegraph_batch_size (stored only) | packages/core/src/v1/config/banyan-config.ts:169 | 3a / 3h | todo | |
| banyancode_codegraph_watch_enabled | packages/core/src/v1/config/banyan-config.ts:174 | 3a | todo | |
| banyancode_codegraph_watch_debounce_ms | packages/core/src/v1/config/banyan-config.ts:175 | 3a | todo | |
| banyancode_trace_max_days (stored only) | packages/core/src/v1/config/banyan-config.ts:176 | 3e / 3h | todo | |
| banyancode_trace_max_events (stored only) | packages/core/src/v1/config/banyan-config.ts:177 | 3e / 3h | todo | |
| banyancode_mesh_default_provider (stored only) | packages/core/src/v1/config/banyan-config.ts:178 | 3f / 3h | todo | |
| banyancode_mesh_default_model (stored only) | packages/core/src/v1/config/banyan-config.ts:179 | 3f / 3h | todo | |
| banyancode_mesh_subagent_cooldown (stored only) | packages/core/src/v1/config/banyan-config.ts:180 | 3f / 3h | todo | |
| banyancode_thinking_default | packages/core/src/v1/config/banyan-config.ts:184 | 3d | todo | |
| banyancode_swarm_mode | packages/core/src/v1/config/banyan-config.ts:187 | 3f | todo | |
| banyancode_prompt_cache_key (`auto`/`off`/string) | packages/core/src/v1/config/banyan-config.ts:192 | 3e | todo | |
| banyancode_prompt_cache_mode (`implicit`/`explicit`/`off`) | packages/core/src/v1/config/banyan-config.ts:201 | 3e | todo | |
| banyancode_prompt_cache_diagnostics | packages/core/src/v1/config/banyan-config.ts:208 | 3e | todo | |
| banyancode_prompt_cache_stable_prefix | packages/core/src/v1/config/banyan-config.ts:213 | 3e | todo | |
| banyancode_prompt_cache_prewarm | packages/core/src/v1/config/banyan-config.ts:215 | 3e | todo | |
| banyancode_reasoning_configuration_update | packages/core/src/v1/config/banyan-config.ts:222 | 3e | todo | |
| banyancode_tool_search_defer | packages/core/src/v1/config/banyan-config.ts:232 | 3e | todo | |
| banyancode_lsp (boolean or per-server record) | packages/core/src/v1/config/banyan-config.ts:237 | 3e | todo | |
| banyancode_lsp_idle_timeout_ms | packages/core/src/v1/config/banyan-config.ts:241 | 3e | todo | |
| commands (see 4b) | packages/core/src/v1/config/banyan-config.ts:250 | 3c | todo | |
| banyancode_subagents (see 4c) | packages/core/src/v1/config/banyan-config.ts:259 | 3d | todo | |
| agent (see 4d) | packages/core/src/v1/config/banyan-config.ts:278 | 3d | todo | |
| banyancode_mcp_server (see 4e) | packages/core/src/v1/config/banyan-config.ts:305 | 5 | todo | |

### 4b. `commands` sub-keys (verifier shell overrides)

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| commands.typecheck | packages/core/src/v1/config/banyan-config.ts:51 | 3c | todo | |
| commands.test | packages/core/src/v1/config/banyan-config.ts:52 | 3c | todo | |
| commands.lint | packages/core/src/v1/config/banyan-config.ts:53 | 3c | todo | |
| commands.compile | packages/core/src/v1/config/banyan-config.ts:54 | 3c | todo | |

### 4c. `banyancode_subagents[]` item fields (metadata only)

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| banyancode_subagents[].name | packages/core/src/v1/config/banyan-config.ts:262 | 3d | todo | |
| banyancode_subagents[].description | packages/core/src/v1/config/banyan-config.ts:263 | 3d | todo | |
| banyancode_subagents[].model {providerID, modelID} | packages/core/src/v1/config/banyan-config.ts:264 | 3d | todo | |
| banyancode_subagents[].tools | packages/core/src/v1/config/banyan-config.ts:270 | 3d | todo | |
| banyancode_subagents[].mode (`subagent`/`primary`) | packages/core/src/v1/config/banyan-config.ts:271 | 3d | todo | |
| banyancode_subagents[].enabled | packages/core/src/v1/config/banyan-config.ts:272 | 3d | todo | |
| banyancode_subagents[].filePath | packages/core/src/v1/config/banyan-config.ts:273 | 3d | todo | |

### 4d. Per-agent override fields (`agent.<name>.*`)

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| agent.<name>.mode (stored only) | packages/core/src/v1/config/banyan-config.ts:289 | 3d | todo | |
| agent.<name>.model | packages/core/src/v1/config/banyan-config.ts:290 | 3d | todo | |
| agent.<name>.thinking | packages/core/src/v1/config/banyan-config.ts:293 | 3d | todo | |
| agent.<name>.variant | packages/core/src/v1/config/banyan-config.ts:295 | 3d | todo | |
| agent.<name>.permission (stored only) | packages/core/src/v1/config/banyan-config.ts:296 | 3d | todo | |
| agent.<name>.options (stored only) | packages/core/src/v1/config/banyan-config.ts:297 | 3d | todo | |
| agent.<name>.prompt (stored only — never applied in v1) | packages/core/src/v1/config/banyan-config.ts:298 | 3d | todo | |
| agent.<name>.enabled | packages/core/src/v1/config/banyan-config.ts:299 | 3d | todo | |

### 4e. `banyancode_mcp_server` sub-keys

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| banyancode_mcp_server.default_agent | packages/core/src/v1/config/banyan-config.ts:67 | 5 | todo | |
| banyancode_mcp_server.default_model | packages/core/src/v1/config/banyan-config.ts:68 | 5 | todo | |
| banyancode_mcp_server.permission (`reject`/`edits`) | packages/core/src/v1/config/banyan-config.ts:69 | 5 | todo | |
| banyancode_mcp_server.max_concurrent_tasks | packages/core/src/v1/config/banyan-config.ts:70 | 5 | todo | |
| banyancode_mcp_server.task_budget_usd | packages/core/src/v1/config/banyan-config.ts:74 | 5 | todo | |
| banyancode_mcp_server.result_max_tokens | packages/core/src/v1/config/banyan-config.ts:75 | 5 | todo | |
| banyancode_mcp_server.needs_input_timeout_seconds | packages/core/src/v1/config/banyan-config.ts:76 | 5 | todo | |
| banyancode_mcp_server.output_max_chars | packages/core/src/v1/config/banyan-config.ts:80 | 5 | todo | |
| banyancode_mcp_server.allowed_agents | packages/core/src/v1/config/banyan-config.ts:85 | 5 | todo | |
| banyancode_mcp_server.allowed_models | packages/core/src/v1/config/banyan-config.ts:88 | 5 | todo | |
| banyancode_mcp_server.tools (group allowlist: task/code/memory/verify) | packages/core/src/v1/config/banyan-config.ts:93 | 5 | todo | |

Gap note: `banyancode_codegraph_enabled` is read by the TUI status pill
(`packages/tui/src/feature-plugins/header/status-pills.tsx:196`) but is **not** in
`BanyanConfig.Info`; v1 silently ignores it. Decide in 3h whether to add it or
remove the read.

## 5. HTTP routes

Group files: `packages/opencode/src/server/routes/instance/httpapi/groups/`.
v2 replaces these with plugin RPC (`banyancode.{codegraph,intel,verify,mesh,config,usage}.*`)
and `rpc.banyancode.*` events. Memory routes have no v2 replacement.

### 5a. `/global/*` BanyanCode endpoints (`groups/global.ts`)

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| GET /global/banyan-config → RPC banyancode.config.get | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:419 | 1 | todo | |
| PATCH /global/banyan-config → RPC banyancode.config.update | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:428 | 1 | todo | |
| PATCH /global/banyan-agent-override → RPC banyancode.config.agentOverride | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:438 | 3d | todo | |
| PATCH /global/banyan-agent-prompt → RPC banyancode.config.agentPrompt | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:449 | 3d | todo | |
| POST /global/banyan-agent/save → RPC banyancode.config.agentSave | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:599 | 3d | todo | |
| POST /global/codegraph-build → RPC banyancode.codegraph.build | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:497 | 3a | todo | |
| POST /global/codegraph-cancel → RPC banyancode.codegraph.cancel | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:460 | 3a | todo | |
| POST /global/codegraph-force-kill → RPC banyancode.codegraph.forceKill | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:469 | 3a | todo | |
| POST /global/codegraph-remove → RPC banyancode.codegraph.remove | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:485 | 3a | todo | |
| GET /global/codegraph-status → RPC banyancode.codegraph.status | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:514 | 3a | todo | |
| GET /global/codegraph-nodes → RPC banyancode.codegraph.nodes | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:541 | 3a | todo | |
| GET /global/codegraph-edges → RPC banyancode.codegraph.edges | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:557 | 3a | todo | |
| GET /global/tool-usage → RPC banyancode.usage.toolUsage | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:530 | 3e | todo | |
| GET /global/provider-usage → RPC banyancode.usage.providerList | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:716 | 3g | todo | |
| POST /global/provider-usage/refresh → RPC banyancode.usage.providerRefresh | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:726 | 3g | todo | |
| POST /global/startup (bridge bootstrap) → no v2 equivalent; plugin activation replaces it | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:590 | 1 | todo | |
| POST /global/websearch-free → RPC banyancode.websearch.free (name to confirm) | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:610 | 3d | todo | |
| POST /global/code-find → RPC banyancode.intel.codeFind | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:622 | 3c | todo | |
| POST /global/preflight → RPC banyancode.intel.preflight | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:634 | 3c | todo | |
| POST /global/blast-radius → RPC banyancode.intel.blastRadius | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:646 | 3c | todo | |
| POST /global/safe-rename → RPC banyancode.intel.safeRename | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:658 | 3c | todo | |
| POST /global/typecheck → RPC banyancode.verify.typecheck | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:670 | 3c | todo | |
| POST /global/test-run → RPC banyancode.verify.test | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:682 | 3c | todo | |
| POST /global/lint → RPC banyancode.verify.lint | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:693 | 3c | todo | |
| GET /global/mesh/status → RPC banyancode.mesh.status | packages/opencode/src/server/routes/instance/httpapi/groups/global.ts:705 | 3f | todo | |

### 5b. Repository-intel endpoints (`groups/repository-intel.ts`)

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| POST /global/repository/query → RPC banyancode.intel.query | packages/opencode/src/server/routes/instance/httpapi/groups/repository-intel.ts:176 | 3c | todo | |
| POST /global/repository/explain → RPC banyancode.intel.explain | packages/opencode/src/server/routes/instance/httpapi/groups/repository-intel.ts:187 | 3c | todo | |
| POST /global/repository/impact → RPC banyancode.intel.impact | packages/opencode/src/server/routes/instance/httpapi/groups/repository-intel.ts:197 | 3c | todo | |
| POST /global/repository/trace → RPC banyancode.intel.trace | packages/opencode/src/server/routes/instance/httpapi/groups/repository-intel.ts:207 | 3c | todo | |
| POST /global/repository/tests → RPC banyancode.intel.tests | packages/opencode/src/server/routes/instance/httpapi/groups/repository-intel.ts:217 | 3c | todo | |
| POST /global/repository/symbols → RPC banyancode.intel.symbols | packages/opencode/src/server/routes/instance/httpapi/groups/repository-intel.ts:227 | 3c | todo | |
| POST /global/repository/relationships → RPC banyancode.intel.relationships | packages/opencode/src/server/routes/instance/httpapi/groups/repository-intel.ts:237 | 3c | todo | |
| POST /global/repository/ownership → RPC banyancode.intel.ownership | packages/opencode/src/server/routes/instance/httpapi/groups/repository-intel.ts:247 | 3c | todo | |
| GET /global/repository/architectural-slice → RPC banyancode.intel.slice | packages/opencode/src/server/routes/instance/httpapi/groups/repository-intel.ts:257 | 3c | todo | |

### 5c. Memory endpoints (`groups/memory.ts`) — intentionally dropped

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| POST /global/memory/list | packages/opencode/src/server/routes/instance/httpapi/groups/memory.ts:204 | 3b | dropped — memory feature removed | |
| POST /global/memory/get | packages/opencode/src/server/routes/instance/httpapi/groups/memory.ts:214 | 3b | dropped — memory feature removed | |
| POST /global/memory/recall | packages/opencode/src/server/routes/instance/httpapi/groups/memory.ts:224 | 3b | dropped — memory feature removed | |
| POST /global/memory/search | packages/opencode/src/server/routes/instance/httpapi/groups/memory.ts:234 | 3b | dropped — memory feature removed | |
| POST /global/memory/store | packages/opencode/src/server/routes/instance/httpapi/groups/memory.ts:245 | 3b | dropped — memory feature removed | |
| POST /global/memory/forget | packages/opencode/src/server/routes/instance/httpapi/groups/memory.ts:256 | 3b | dropped — memory feature removed | |
| POST /global/memory/candidates | packages/opencode/src/server/routes/instance/httpapi/groups/memory.ts:266 | 3b | dropped — memory feature removed | |
| POST /global/memory/promote | packages/opencode/src/server/routes/instance/httpapi/groups/memory.ts:277 | 3b | dropped — memory feature removed | |
| POST /global/memory/reject | packages/opencode/src/server/routes/instance/httpapi/groups/memory.ts:288 | 3b | dropped — memory feature removed | |
| POST /global/memory/summary | packages/opencode/src/server/routes/instance/httpapi/groups/memory.ts:299 | 3b | dropped — memory feature removed | |

### 5d. Session / import / experimental endpoints

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| GET /session/{sessionID}/mesh → RPC banyancode.mesh.sessionStatus | packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:170 | 3f | todo | |
| POST /experimental/session/{sessionID}/background → RPC banyancode.mesh.background | packages/opencode/src/server/routes/instance/httpapi/groups/experimental.ts:220 | 3f | todo | |
| POST /global/session/import → verify v2 session-import parity | packages/opencode/src/server/routes/instance/httpapi/groups/import.ts:26 | 1 | todo | |

## 6. MCP delegation server

Implementation: `packages/opencode/src/mcp-server/`. Tool names are exported as
constants in `tools-code.ts`, `tools-task.ts`, `tools-verify-memory.ts`; server
instructions at `server.ts:433-441`; transports at `transport-stdio.ts` and
`transport-http.ts`; CLI entry at `packages/opencode/src/cli/cmd/mcp.ts:670`.

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| banyan_code_find {intent: definition\|callers\|dependents\|impact\|find_file, target, includeKeywordFallback?, limit?} | packages/opencode/src/mcp-server/tools-code.ts:36 | 5 | todo | |
| banyan_repo {op: query\|explain\|impact\|trace\|tests\|symbols\|relationships\|ownership\|slice, query?, symbol?, path?, nodeID?, focus?, depth?, limit?} | packages/opencode/src/mcp-server/tools-code.ts:37 | 5 | todo | |
| banyan_change_check {op: preflight\|blast_radius, target, action?, depth?} | packages/opencode/src/mcp-server/tools-code.ts:38 | 5 | todo | |
| banyan_codegraph {op: status\|build, root?, force?} | packages/opencode/src/mcp-server/tools-code.ts:39 | 5 | todo | |
| banyan_verify {kind: typecheck\|test\|lint, path?} | packages/opencode/src/mcp-server/tools-verify-memory.ts:163 | 5 | todo | |
| banyan_task_start {prompt, agent?, model?, isolation? (shared\|worktree), permission? (reject\|edits\|yolo), wait_seconds?} | packages/opencode/src/mcp-server/tools-task.ts:40 | 5 | todo | |
| banyan_task_status {task_id, wait_seconds?} | packages/opencode/src/mcp-server/tools-task.ts:41 | 5 | todo | |
| banyan_task_result {task_id, detail? (summary\|diff\|transcript), cursor?} | packages/opencode/src/mcp-server/tools-task.ts:39 | 5 | todo | |
| banyan_task_reply {task_id, decision: approve\|reject, message?} | packages/opencode/src/mcp-server/tools-task.ts:38 | 5 | todo | |
| banyan_task_cancel {task_id} | packages/opencode/src/mcp-server/tools-task.ts:37 | 5 | todo | |
| banyan_memory {op: recall\|search\|store\|get\|summary, key?, query?, id?, value?, context?, tags?, scope?, sessionID?, limit?, maxItems?, kind?, status?} | packages/opencode/src/mcp-server/tools-verify-memory.ts:164 | 3b | dropped — memory feature removed | |
| stdio transport (`banyancode mcp serve`) | packages/opencode/src/mcp-server/transport-stdio.ts:1 | 5 | todo | |
| Streamable HTTP transport (`banyancode mcp serve --http`) | packages/opencode/src/mcp-server/transport-http.ts:1 | 5 | todo | |
| Server instructions (delegate-then-poll loop) | packages/opencode/src/mcp-server/server.ts:433 | 5 | todo | |
| Tool-group allowlist (`task`/`code`/`memory`/`verify`) | packages/opencode/src/mcp-server/policy.ts:1 | 5 | todo | |

## 7. TUI surfaces

Registration list: `packages/tui/src/feature-plugins/builtins.ts:36-73`. Slots:
`sidebar_content`, `sidebar_footer`, `session_inspector`, `session_footer`,
`session_attention_strip`, `app_top`, `session_main_tabs`, `session_tab_*`,
`home_footer`, `home_bottom`. Memory surfaces are dropped.

### 7a. Registered surfaces

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| Header brand / wordmark | packages/tui/src/feature-plugins/header/brand.tsx:9 | 1 | todo | |
| Header status pills — active agents, LSP state, graph state (built/stale/building/not built/failed/disabled, syncing/paused) | packages/tui/src/feature-plugins/header/status-pills.tsx:11 | 3g | todo | |
| Sidebar: agents panel (per-agent peers, status dots) | packages/tui/src/feature-plugins/sidebar/agents.tsx:8 | 3g | todo | |
| Sidebar: performance panel (tokens/s, TTFT, output tokens) | packages/tui/src/feature-plugins/sidebar/performance.tsx:9 | 3g | todo | |
| Sidebar: context panel (token breakdown, cache read/write, cost) | packages/tui/src/feature-plugins/sidebar/context.tsx:8 | 3g | todo | |
| Sidebar: system panel (CPU, memory, disk, GPU/VRAM when available) | packages/tui/src/feature-plugins/sidebar/system-status.tsx:8 | 3g | todo | |
| Sidebar: provider usage panel (quota/rate-limit windows per provider) | packages/tui/src/feature-plugins/sidebar/provider-usage.tsx:10 | 3g | todo | |
| Sidebar: tool usage panel (codegraph_tool_usage counts) | packages/tui/src/feature-plugins/sidebar/tool-usage.tsx:8 | 3g | todo | |
| Sidebar: MCP panel | packages/tui/src/feature-plugins/sidebar/mcp.tsx:6 | 3g | todo | |
| Sidebar: modified files panel | packages/tui/src/feature-plugins/sidebar/files.tsx:7 | 3g | todo | |
| Sidebar footer (version / getting-started hints) | packages/tui/src/feature-plugins/sidebar/footer.tsx:8 | 1 | todo | |
| Inspector: agent details (status, tokens, cost, elapsed, model picker) | packages/tui/src/feature-plugins/inspector/agent-details.tsx:9 | 3g | todo | |
| Inspector: todo list | packages/tui/src/feature-plugins/inspector/todo.tsx:8 | 3g | todo | |
| Session footer: workspace, git branch, YOLO indicator, swarm indicator, attention count | packages/tui/src/feature-plugins/footer/session-footer.tsx:13 | 3g | todo | |
| YOLO indicator (`[yolo]`, re-reads config on `banyancode.config.updated`) | packages/tui/src/component/yolo-indicator.tsx:1 | 3e | todo | |
| Swarm indicator (`[swarm]`) | packages/tui/src/component/swarm-indicator.tsx:1 | 3f | todo | |
| Attention strip (pending permissions/questions, blocked peers, LSP issues) | packages/tui/src/component/attention-strip.tsx:131 | 3f | todo | |
| Codegraph progress widget (done/total, current file, stuck detection, quick action when idle) | packages/tui/src/component/codegraph-progress.tsx:1 | 3a | todo | |
| Home: codegraph tip + progress placement | packages/tui/src/routes/home.tsx:92 | 3g | todo | |
| Home: footer | packages/tui/src/feature-plugins/home/footer.tsx:10 | 3g | todo | |
| Home: tips + quick actions (Banyan tips variant) | packages/tui/src/feature-plugins/home/tips.tsx:8 | 3g | todo | |
| Tabs: CHAT/SESSIONS/AGENTS/CONFIG/MEMORY bar (ctrl+] / ctrl+[) | packages/tui/src/feature-plugins/tabs/tab-bar.tsx:12 | 3g | todo | |
| Tab: SESSIONS | packages/tui/src/feature-plugins/tabs/tab-sessions.tsx:19 | 3g | todo | |
| Tab: AGENTS (agent tree) | packages/tui/src/feature-plugins/tabs/tab-agent-tree.tsx:10 | 3f | todo | |
| Tab: CONFIG (agent config editor, thinking picker) | packages/tui/src/feature-plugins/tabs/tab-agents.tsx:15 | 3d | todo | |
| Tab: MEMORY | packages/tui/src/feature-plugins/tabs/tab-memory.tsx:13 | 3b | dropped — memory feature removed | |
| Dialog: agent config editor (model/thinking/prompt/save) | packages/tui/src/component/dialog-agent-config.tsx:1 | 3d | todo | |
| Dialog: agent control / agent tree (steer, kill) | packages/tui/src/component/dialog-agent-control.tsx:1 | 3f | todo | |
| Dialog: per-agent model picker | packages/tui/src/component/dialog-agent-model.tsx:1 | 3d | todo | |
| Dialog: thinking-level picker | packages/tui/src/component/dialog-thinking.tsx:1 | 3d | todo | |
| Dialog: max concurrent subagents (1-20) | packages/tui/src/component/dialog-max-subagents.tsx:1 | 3f | todo | |
| Dialog: status (MCP servers, provider/session summary) | packages/tui/src/component/dialog-status.tsx:1 | 3g | todo | |
| Dialog: memory add / kind filter | packages/tui/src/component/dialog-memory-add.tsx:1 | 3b | dropped — memory feature removed | |
| Session view: in-session tool cards with codegraph glyph for read/grep/glob | packages/tui/src/routes/session/index.tsx:2331 | 3e | todo | |

### 7b. Modules present but not registered in v1 (`(module only)`)

These ship as files but are absent from `builtins.ts`, so they are not
user-visible in v1. Port only after confirming the intent was deliberate.

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| Sidebar: agent tree (module only) | packages/tui/src/feature-plugins/sidebar/agent-tree.tsx:8 | 3f | todo | |
| Sidebar: codebase tree (module only, removed by declutter test) | packages/tui/src/feature-plugins/sidebar/codebase-tree.tsx:8 | 3a | todo | |
| Sidebar: codegraph panel (module only) | packages/tui/src/feature-plugins/sidebar/codegraph-panel.tsx:9 | 3a | todo | |
| Sidebar: codegraph intel panel (module only) | packages/tui/src/feature-plugins/sidebar/codegraph-intel-panel.tsx:7 | 3a | todo | |
| Sidebar: intel trace panel (module only) | packages/tui/src/feature-plugins/sidebar/intel-trace-panel.tsx:7 | 3a | todo | |
| Sidebar: LSP panel (module only) | packages/tui/src/feature-plugins/sidebar/lsp.tsx:7 | 3e | todo | |
| Sidebar: todo panel (module only) | packages/tui/src/feature-plugins/sidebar/todo.tsx:7 | 3g | todo | |
| Inspector: graph explorer (module only) | packages/tui/src/feature-plugins/inspector/graph-explorer.tsx:7 | 3a | todo | |
| Inspector: pending actions (module only) | packages/tui/src/feature-plugins/inspector/pending-actions.tsx:7 | 3f | todo | |
| Tab: graph (module only) | packages/tui/src/feature-plugins/tabs/tab-graph.tsx:12 | 3a | todo | |
| Header: session cost (module only) | packages/tui/src/feature-plugins/header/session-cost.tsx:13 | 3g | todo | |

## 8. CLI, env vars and identity

Entry point and command list: `packages/opencode/src/index.ts:52-117`.
First-run dirs: `packages/opencode/src/cli/cmd/init-banyan.ts:6` called from
`packages/opencode/src/cli/cmd/run.ts:241`.

### 8a. CLI commands and flags

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| banyancode codegraph build --root --force --watch --timeout | packages/opencode/src/cli/cmd/codegraph.ts:98 | 3a | todo | |
| banyancode codegraph status | packages/opencode/src/cli/cmd/codegraph.ts:173 | 3a | todo | |
| banyancode codegraph cancel | packages/opencode/src/cli/cmd/codegraph.ts:188 | 3a | todo | |
| banyancode codegraph remove --drop-file | packages/opencode/src/cli/cmd/codegraph.ts:209 | 3a | todo | |
| banyancode codegraph force-kill | packages/opencode/src/cli/cmd/codegraph.ts:238 | 3a | todo | |
| banyancode codegraph path | packages/opencode/src/cli/cmd/codegraph.ts:254 | 3a | todo | |
| banyancode codegraph trace | packages/opencode/src/cli/cmd/codegraph.ts:334 | 3a | todo | |
| banyancode goal set <condition> --plan --priority --session | packages/opencode/src/cli/cmd/goal.ts:12 | 3f | todo | |
| banyancode goal status --session | packages/opencode/src/cli/cmd/goal.ts:48 | 3f | todo | |
| banyancode goal list --session | packages/opencode/src/cli/cmd/goal.ts:74 | 3f | todo | |
| banyancode goal cancel --session | packages/opencode/src/cli/cmd/goal.ts:100 | 3f | todo | |
| banyancode repository query <query> --limit | packages/opencode/src/cli/cmd/repository.ts:41 | 3c | todo | |
| banyancode repository explain <symbol> | packages/opencode/src/cli/cmd/repository.ts:64 | 3c | todo | |
| banyancode repository trace <symbol> --depth | packages/opencode/src/cli/cmd/repository.ts:83 | 3c | todo | |
| banyancode repository impact <path> | packages/opencode/src/cli/cmd/repository.ts:104 | 3c | todo | |
| banyancode repository tests <symbol> | packages/opencode/src/cli/cmd/repository.ts:123 | 3c | todo | |
| banyancode repository relationships | packages/opencode/src/cli/cmd/repository.ts:141 | 3c | todo | |
| banyancode repository ownership | packages/opencode/src/cli/cmd/repository.ts:161 | 3c | todo | |
| banyancode websearch-free <query> --num | packages/opencode/src/cli/cmd/websearch-free.ts:12 | 3d | todo | |
| banyancode tools --category | packages/opencode/src/cli/cmd/tools.ts:41 | 3e | todo | |
| banyancode telemetry status\|on\|off | packages/opencode/src/cli/cmd/telemetry.ts:29 | 3e | todo | |
| banyancode telemetry agent-report --run-id --session-id --since --json | packages/opencode/src/cli/cmd/telemetry.ts:219 | 3e | todo | |
| banyancode telemetry agent-export --run-id --session-id --since | packages/opencode/src/cli/cmd/telemetry.ts:255 | 3e | todo | |
| banyancode stats --days --tools --models --project --heatmap (multi-DB Banyan stats) | packages/opencode/src/cli/cmd/stats.ts:285 | 3e | todo | |
| banyancode db gc --yes --dry-run --root | packages/opencode/src/cli/cmd/db-gc.ts:203 | 1 | todo | |
| banyancode mcp serve --cwd --attach --allow-yolo --http --port --hostname --token | packages/opencode/src/cli/cmd/mcp.ts:670 | 5 | todo | |
| banyancode upgrade [target] (installs npm `banyancode`) | packages/opencode/src/cli/cmd/upgrade.ts:13 | 1 | todo | |
| banyancode memory list/get/search/recall/store/forget/candidates/approve/reject/vacuum/sweep | packages/opencode/src/cli/cmd/memory.ts:16 | 3b | dropped — memory feature removed | |

### 8b. Environment variables

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| BANYANCODE_ENABLE (`0` disables all BanyanCode tools/policy) | packages/core/src/banyancode/banyan-orchestration-system-source.ts:119 | 1 | todo | |
| BANYANCODE_CONFIG_DIR | packages/core/src/flag/flag.ts:83 | 1 | todo | |
| BANYANCODE_CONFIG | packages/core/src/flag/flag.ts:82 | 1 | todo | |
| BANYANCODE_CONFIG_CONTENT (declared; no consumer found) | packages/core/src/flag/flag.ts:84 | 1 | todo | |
| BANYANCODE_DISABLE_PROJECT_CONFIG | packages/core/src/flag/flag.ts:88 | 1 | todo | |
| BANYANCODE_TUI_CONFIG | packages/core/src/flag/flag.ts:85 | 1 | todo | |
| BANYANCODE_PROJECT_DB_DIR (test hermeticity override) | packages/core/src/database/banyan-db-path.ts:41 | 1 | todo | |
| BANYANCODE_LEGACY_DB_PATH | packages/core/src/database/banyan-db-path.ts:13 | 1 | todo | |
| BANYANCODE_YOLO_MODE | packages/opencode/src/effect/runtime-flags.ts:37 | 3e | todo | |
| BANYANCODE_DISABLE_WEBSEARCH | packages/core/src/tool/websearch-free/config.ts:6 | 3d | todo | |
| BANYANCODE_TELEMETRY (`off`, and `DO_NOT_TRACK=1`) | packages/opencode/src/installation/telemetry.ts:68 | 3e | todo | |
| BANYANCODE_TELEMETRY_ENDPOINT | packages/opencode/src/installation/telemetry.ts:18 | 3e | todo | |
| BANYANCODE_POSTHOG_KEY | packages/opencode/src/installation/telemetry.ts:166 | 3e | todo | |
| BANYANCODE_AGENT_TELEMETRY_KEY | packages/core/src/banyancode/agent-efficiency-telemetry.ts:71 | 3e | todo | |
| BANYANCODE_ROUTER_TRACE | packages/core/src/banyancode/gateway/gateway.ts:152 | 3e | todo | |
| BANYANCODE_INDEX_CONCURRENCY | packages/core/src/banyancode/codegraph-indexer.ts:154 | 3a | todo | |
| BANYANCODE_INDEX_ADAPTIVE | packages/core/src/banyancode/codegraph-indexer.ts:156 | 3a | todo | |
| BANYANCODE_INDEX_PERSIST_BATCH | packages/core/src/banyancode/codegraph-indexer.ts:174 | 3a | todo | |
| BANYANCODE_TS_EDGES | packages/core/src/banyancode/codegraph-indexer.ts:566 | 3a | todo | |
| BANYANCODE_CODEGRAPH_READY_WAIT_MS | packages/core/src/banyancode/codegraph-readiness.ts:139 | 3a | todo | |
| BANYANCODE_SNAPSHOT_LIST_TIMEOUT_MS | packages/opencode/src/snapshot/index.ts:62 | 1 | todo | |
| BANYANCODE_MCP_TOKEN | packages/opencode/src/cli/cmd/mcp.ts:704 | 5 | todo | |
| BANYANCODE_MCP_OUTPUT_CHARS | packages/core/src/v1/config/banyan-config.ts:79 | 5 | todo | |
| BANYANCODE_MCP_ALLOW_YOLO | packages/opencode/src/mcp-server/server.ts:146 | 5 | todo | |
| BANYANCODE_SERVER_PASSWORD | packages/opencode/src/mcp-server/server.ts:94 | 5 | todo | |
| BANYANCODE_DEBUG (`mesh` enables spawn debug) | packages/core/src/banyancode/nested-spawn-registry.ts:51 | 3f | todo | |
| DO_NOT_TRACK (telemetry opt-out) | packages/opencode/src/installation/telemetry.ts:69 | 3e | todo | |

### 8c. Product identity

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| App name `banyancode` (all XDG paths) | packages/core/src/global.ts:10 | 1 | todo | |
| Config dir `~/.config/banyancode` | packages/core/src/global.ts:20 | 1 | todo | |
| Data dir `~/.local/share/banyancode` | packages/core/src/global.ts:18 | 1 | todo | |
| Cache/state/tmp dirs `banyancode` | packages/core/src/global.ts:19-25 | 1 | todo | |
| Per-user dirs: bin, log, repos | packages/core/src/global.ts:44-47 | 1 | todo | |
| Project marker dir `.banyancode/` | packages/opencode/src/config/paths.ts:64 | 1 | todo | |
| Project config files `banyancode.json` / `banyancode.jsonc` | packages/opencode/src/config/paths.ts:49 | 1 | todo | |
| Config schema URL `https://banyan.dev/schema/banyancode.json` | packages/core/src/v1/config/banyan-config.ts:16 | 1 | todo | |
| Codegraph ignore file `.banyancode/ignore` | packages/core/src/banyancode/codegraph-indexer.ts:289 | 3a | todo | |
| DB filename `banyancode-<12-char-hash><channel>.db` | packages/core/src/database/banyan-db-path.ts:68 | 1 | todo | |
| Channel suffix: `latest`/`beta`/`prod` none; other channels `-<channel>` | packages/core/src/database/banyan-db-path.ts:50 | 1 | todo | |
| Legacy DB filename `banyancode.db` | packages/core/src/database/banyan-db-path.ts:13 | 1 | todo | |
| CLI script name `banyancode` | packages/opencode/src/index.ts:54 | 1 | todo | |
| CalVer version `26.10.9` | packages/opencode/package.json:3 | 1 | todo | |
| First-run directory creation + default `banyancode.json` | packages/opencode/src/cli/cmd/init-banyan.ts:6 | 1 | todo | |
| Agent markdown dirs `.banyancode/agent(s)/*.md` | packages/opencode/src/config/agent.ts:40 | 3d | todo | |
| TUI config file discovery | packages/opencode/src/config/tui.ts:170 | 1 | todo | |

## 9. Published events

All are `EventV2` definitions or equivalent publishes; v2 emits them as
`rpc.banyancode.*` per the migration plan.

| ID/name | v1 source (path:line) | Workstream | Status | Test |
|---|---|---|---|---|
| banyancode.codegraph.build → rpc.banyancode.codegraph.build | packages/core/src/banyancode/codegraph-build-service.ts:69 | 3a | todo | |
| banyancode.codegraph.auto-update → rpc.banyancode.codegraph.autoUpdate | packages/core/src/banyancode/codegraph-auto-update.ts:25 | 3a | todo | |
| banyancode.codegraph.auto-update.progress → rpc.banyancode.codegraph.autoUpdateProgress | packages/core/src/banyancode/codegraph-auto-update.ts:42 | 3a | todo | |
| banyancode.config.updated → rpc.banyancode.config.updated | packages/core/src/v1/config/banyan-config.ts:9 | 1 | todo | |
| banyancode.goal.set → rpc.banyancode.goal.set | packages/core/src/banyancode/goal-service.ts:159 | 3f | todo | |
| banyancode.goal.review_recorded → rpc.banyancode.goal.reviewRecorded | packages/core/src/banyancode/goal-service.ts:193 | 3f | todo | |
| banyancode.goal.achieved → rpc.banyancode.goal.achieved | packages/core/src/banyancode/goal-service.ts:259 | 3f | todo | |
| banyancode.goal.blocked → rpc.banyancode.goal.blocked | packages/core/src/banyancode/goal-service.ts:275 | 3f | todo | |
| banyancode.goal.cancelled → rpc.banyancode.goal.cancelled | packages/core/src/banyancode/goal-service.ts:291 | 3f | todo | |
| banyancode.mesh.status → rpc.banyancode.mesh.status | packages/core/src/banyancode/mesh-coordinator.ts:124 | 3f | todo | |
| banyancode.system.updated → rpc.banyancode.system.updated | packages/core/src/banyancode/system-monitor.ts:33 | 3e | todo | |
| banyancode.memory.committed | packages/core/src/banyancode/memory-events.ts:15 | 3b | dropped — memory feature removed | |
| banyancode.memory.candidate_emitted | packages/core/src/banyancode/memory-events.ts:28 | 3b | dropped — memory feature removed | |
| banyancode.memory.promoted | packages/core/src/banyancode/memory-events.ts:40 | 3b | dropped — memory feature removed | |
| banyancode.memory.rejected | packages/core/src/banyancode/memory-events.ts:50 | 3b | dropped — memory feature removed | |

## Coverage summary

| Section | Rows | Dropped |
|---|---|---|
| 1. Tools (1a+1b+1c) | 46 | 7 |
| 2. Agents and prompt sources | 15 | 0 |
| 3. Commands (3a+3b) | 35 | 0 |
| 4. Config keys (4a+4b+4c+4d+4e) | 80 | 0 |
| 5. HTTP routes (5a+5b+5c+5d) | 47 | 10 |
| 6. MCP tools and server features | 15 | 1 |
| 7. TUI (7a+7b) | 45 | 2 |
| 8. CLI, env, identity (8a+8b+8c) | 72 | 1 |
| 9. Events | 15 | 4 |
| **Total** | **370** | **25** |
