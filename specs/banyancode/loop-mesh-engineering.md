# Loop Engineering & Mesh Engineering for AI Coding Harnesses

Comparative research report covering BanyanCode, Anthropic Claude Code, Cognition Devin, Cursor, and OpenAI Codex CLI. Compiled 2026-07-24.

This document is the deliverable for a research spike on **how production AI coding harnesses structure (a) the inner agent loop, (b) the inter-agent mesh, and (c) the user-facing goal primitive**. Its intent is to inform a BanyanCode design discussion on whether to introduce a first-class `/goal` command, an automated reviewer, and an end-to-end exit-condition contract on top of the existing subagent mesh.

---

## 1. Executive summary

Three findings stand out across the surveyed tools:

1. **All production harnesses converge on the same loop primitive**: a `while (canContinue) { modelResponse -> toolBatches -> toolResults }` cycle whose continuation depends on (a) a session budget, (b) a user-set goal, (c) an evaluator verdict, or (d) the model itself deciding it is done. None of the tools remove the model's "I am done" path; they all add additional gates on top of it.

2. **Multi-agent meshes split into two architectural philosophies**:
   - **Writes-are-single-threaded, intelligence-is-multi-agent** (Cognition's post-April-2026 stance; Anthropic's "orchestrator-workers" workflow; Devin's Managed Devins). The agent that mutates state is single-threaded; reviewers and researchers run as separate agents with clean contexts.
   - **Fully meshed, peer-to-peer** (BanyanCode's `SubagentBus` mesh; Claude Code's parallel `Agent` calls; LangGraph DAGs). Any agent can spawn and message any other; reconciliation is the orchestrator's responsibility.

   Both work. The single-writer pattern is currently winning on long-horizon tasks (Devin, Sonnet 4.5 agent); the mesh pattern is currently winning on tool breadth and subagent parallelism (Claude Code, BanyanCode).

3. **A `/goal` command is rare but valuable.** Only two production tools ship one: Claude Code (since v2.1.139) and Codex CLI. Both phrase the goal as a *completion condition* evaluated by a smaller model after every turn. Everything else routes the goal through sidecar files (`CLAUDE.md`, `AGENTS.md`, `CONVENTIONS.md`, `memory-bank/*.md`, `.windsurf/rules/*.md`). The sidecar approach is more durable across sessions; the `/goal` approach is more responsive within a session. The two are complementary, not competing.

**BanyanCode positioning**: mesh engineering is mature (SubagentBus, MeshCoordinator, idempotent messages, peer tools, GC, bounded concurrency). Loop engineering is shallow (V1 `while(true)` with per-agent `agent.steps` cap; V2 hard `MAX_STEPS=25`). Goal engineering is absent — there is no `/goal`, no goal table, no goal agent, no `goal_*` schema in `BanyanConfig.Info`. The closest primitive is `SubagentPlan.exitCriteria` (free-text, not consulted by the consumer loop).

---

## 2. BanyanCode baseline (where we are today)

Source: internal reconnaissance via the explorer agent on `D:\OpenCode`. File references are line-precise.

### 2.1 Subagent mesh (mature)

The mesh is layered on a Drizzle-backed SQLite store (`banyancode-local.db`) plus an Effect-native in-memory fanout.

| Component | File | Lines | Purpose |
|---|---|---|---|
| `SubagentBus` | `packages/core/src/banyancode/subagent-bus.ts` | 1-119 | `publish` / `publishOrFetch` (idempotent insert via `ON CONFLICT(id) DO UPDATE` returning inserted-vs-fetched), `subscribe(sessionID)` returns `Queue.Dequeue<SubagentMessage>`, `peers(parentSessionID)` |
| `SubagentMessagesRepo` | `packages/core/src/banyancode/subagent-messages-repo.ts` | 1-153 | CRUD, `markDelivered(id, ts)`, `listByParent`, `listPending` |
| `SubagentPlans` | `packages/core/src/banyancode/subagent-plans-repo.ts` | 1-89 | `{title, steps[], exitCriteria, status}` |
| `SubagentConsumer` | `packages/core/src/banyancode/subagent-consumer.ts` | 1-97 | `start({sessionID, agent, plan?})` forks a drain loop; dispatches on `MessageKind` (`"request" \| "inform" \| "answer" \| "poll" \| "steer" \| "checkpoint" \| "plan" \| "kill"`) |
| `MeshCoordinator` | `packages/core/src/banyancode/mesh-coordinator.ts` | 1-583 | `status`, `watch`, `subscribe`, `checkin`, `steer`, `kill`, `planFor`, `tryReserveSubagentSlot`, `trackParent`, `runGarbageCollection` (hourly, scoped fork) |
| `MaxSubagents` | `packages/core/src/banyancode/max-subagents.ts` | 1-52 | `MAX_NESTED_EXPLORE_PER_CODER=1`, `MAX_NESTED_EXPLORE_LIFETIME_PER_CODER=5` |
| `NestedSpawnRegistry` | `packages/core/src/banyancode/nested-spawn-registry.ts` | 1-196 | per-coder budget: concurrent=1, lifetime=5/hr |
| `task` tool | `packages/opencode/src/tool/task.ts` | 1-465 | orchestrator's spawn entry; creates child session with `parentID`, calls `SubagentConsumer.start`, optionally publishes a `plan` message, calls `ctx.extra.promptOps.prompt(...)` |
| `mesh_control` | `packages/core/src/tool/mesh-control.ts` | 1-116 | orchestrator-only: `checkin` / `steer` / `kill` / `plan_for` |
| `mesh_subscribe` | `packages/core/src/tool/mesh-subscribe.ts` | 1-86 | filtered stream |
| `subagent_message` | `packages/core/src/tool/subagent-message.ts` | 1-120 | fire-and-forget to a peer |
| `shared_memory` | `packages/core/src/tool/shared-memory.ts` | 1-231 | global-write allowlist `["build", "orchestrator"]` |
| `memory_*` | `packages/core/src/tool/memory.ts` + `memory-candidate.ts` | — | cross-session memory |

### 2.2 Main agent loop (shallow)

**V1 — `packages/opencode/src/session/prompt.ts:1149-1448`.** `runLoop`, outer `while (true)` at line 1156. Per-agent `maxSteps = agent.steps ?? Infinity` at line 1276. Exit conditions (only paths to `break`):
1. Assistant finished with no tool calls AND user-id <= assistant-id (line 1179-1198).
2. `model` undefined after `getModel` failure (line 1239).
3. `compaction.process` returns `"stop"` (line 1255).
4. Structured output requested and produced (line 1407-1411).
5. JSON-schema mode and model did not produce structured output (line 1416-1422).
6. Provider error (line 1394-1404).
7. Inner-gen `outcome === "break"` (line 1441).

**V2 — `packages/core/src/session/runner/llm.ts`.** Outer `while (openActivity)`, inner unbounded `while (needsContinuation)` loop. Step caps were removed from both runtimes in the TUI/CLI-only strip (agents run until completion, `maxTime`, or the no-progress guard).

**No reviewer / critic step in either runtime.** Plan-mode approval gate exists for `plan` agent via `task/plan.ts:15-78` (`plan_exit` Yes/No).

### 2.3 Goal / objective (absent)

- **No `/goal` command.** `packages/opencode/src/command/index.ts:80-99` enumerates every default slash command; `init`, `review`, `codegraph-build`, `codegraph-remove`, `repository-*`, `websearch-free`, `yolo`, `max-subagents`, `refresh-models`, `lsp`, `import` — none are goal-related. CLI commands (`packages/opencode/src/cli/cmd/`) have no `goal.ts`.
- **No goal table / agent / tool.** No `Banyan.GoalService`, no `Banyan.GoalRepo`, no `goal_*` schema in `BanyanConfig.Info`.
- **Closest primitive**: `SubagentPlan.exitCriteria` — free-text string describing what success looks like for a subagent plan. Currently **not consulted** by `subagent-consumer.ts`. Steps have a `status: pending|in_progress|completed|cancelled` field but **no consumer code updates `steps[*].status`** — the field is write-only.

### 2.4 Cross-session memory (mature, separate from goals)

`memory_entries` with versioned JSONB envelope (`{_v:1, data}`), FTS5 full-text search, multi-signal retrieval, significance scoring, projection (`activeDecisions`, `decisionDigest`, `warningDigest`), hygiene (`expire`, `prune`, `reconcile`). See `packages/core/src/banyancode/memory-*.ts`. Decision kinds include `todo`, `decision`, `constraint`, `observation` — these are *stored facts*, not active goals.

---

## 3. Loop engineering (comparative)

### 3.1 Loop unit

| Tool | Loop unit | Outer frame | Inner cycle |
|---|---|---|---|
| **BanyanCode V1** | turn | `while (true)` (`prompt.ts:1156`) | one model response + zero-or-more tool calls + tool-result feedback |
| **BanyanCode V2** | step | `while (openActivity)` (`llm.ts:383`) | `for (let step = 0; step < 25; step++)` |
| **Claude Code** | turn (one model response + tool batch) | "until Claude produces a response with no tool calls" | model response -> tool batch (parallel read-only, serial writes) -> tool-result messages -> next model call |
| **Devin** | session (single long-lived) | the entire task lifetime; Devin can run "indefinitely"; SWE-bench eval capped at 45 min; recommended <=3 hr | model response -> shell/browser/IDE tool -> result -> next model call |
| **Cursor** | multi-file edit session (Composer) or single edit (Cmd+I) | until model stops returning tool calls or hits explicit stop | parallel tool calls (read-only parallel, state-changing serial); no documented hard turn cap |
| **Codex CLI** | `SessionTask` for one turn (`codex-rs/core/src/tasks/mod.rs`) | `Session::start_task` | completion / cancellation / `TurnAborted` / unexpected error |

### 3.2 Exit conditions

| Tool | Hard cap | Soft cap | Goal-conditioned exit | Verifier-driven exit | Brick-wall detector |
|---|---|---|---|---|---|
| **BanyanCode V1** | none (removed in the strip) | none | none | none | none |
| **BanyanCode V2** | none (removed in the strip) | none | none | none | none |
| **Claude Code** | optional `maxTurns` per agent (default "No limit" for CLI; configurable per-subagent) | `CLAUDE_CODE_MAX_RETRIES=10` (transport only) | `/goal` evaluator (Haiku, session-scoped Stop hook) | `/verify`, `/review`, `/code-review`, `/security-review`, `/simplify`, `/advisor`, dynamic workflows (adversarial verifier / evaluator-optimizer) | thrashing detector: stops compacting after repeated immediate refill/compact cycles; auto-mode falls back after 3 consecutive blocks or 20 total |
| **Devin** | none in product; 45 min in SWE-bench eval; recommended <=3 hr | session-size classifier (L/XL flagged "unhealthy") | confidence gating (🟢 auto-execute; 🟡/🔴 wait for approval); "interactive plan" editable before execution | Devin Review (clean-context reviewer, catches ~2 bugs/PR, ~58% severe); Auto-Fix (closes the loop without human); Security Swarm (runtime exploitability check) | none documented; "Awaiting instructions" sidebar chip and post-hoc session-insights categorization (build failure, environment, scope ambiguity) |
| **Cursor** | none documented | none | none | `/review` skill (Cursor 0.49+) — Bugbot, code review | none |
| **Codex CLI** | none for turn (source default 10s for shell-tool execution only) | none | `/goal` on supported surfaces (ChatGPT desktop/Codex app; CLI confirmation not found) | `/review` as dedicated `review.rs` task | none documented |
| **AutoGPT classic** | iteration counter (configurable) | none | "task_complete" command | self-eval | none |
| **Reflexion** | none | none | none | heuristic `h_t`: inefficient planning OR consecutive identical actions | yes — explicit |
| **MetaGPT** | per-role rounds (SOP cardinality) | none | none | SOP step completion | implicit (round count) |
| **SWE-agent** | none | none | none | pytest / test runner | none |
| **GPT-Engineer** | clarification handshake gates execution | none | clarification loop | user confirmation | implicit (no progress = no commit) |

### 3.3 Stop-hook / evaluator pattern (the most important new primitive)

Three tools have made the Stop hook a first-class loop-control primitive. It is the cleanest answer to "how do you bound a long-running agent loop without capping it at N turns?"

| Tool | Mechanism | Cost |
|---|---|---|
| **Claude Code** | `Stop` hook (`type: "prompt"`) evaluates a condition with Haiku after every turn; "no" => continue; `{"ok":false, "reason": ...}` becomes next-turn feedback | one small-model call per turn |
| **Anthropic evaluator-optimizer** | two LLM roles in a loop (generator + evaluator); continues until evaluator says done | one small-model call per turn |
| **Devin confidence gating** | 🟢/🟡/🔴 score at session start, after planning, on Q&A; 🟢 auto-executes, 🟡/🔴 waits for user | zero (model-internal) |
| **BanyanCode** | not present | n/a |

`/goal` is just this primitive wrapped in a slash command.

### 3.4 Compaction / context management

| Tool | Trigger | Method | Loss profile |
|---|---|---|---|
| **BanyanCode V1** | `compaction.isOverflow` after `handle.process` returns | full conversation compaction via hidden `compaction` agent (`prompt/compaction.txt`) | aggressive |
| **BanyanCode V2** | `overflowFailure` field | `runAfterOverflowCompaction` recovery | aggressive |
| **Claude Code** | model-default (Sonnet 5: ~967K of 1M) or `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | "discards or clears older tool outputs and then summarizes older conversation history while preserving recent exchanges" | preserves `CLAUDE.md` (re-injected every session) and stable prefixes (prompt-cached) |
| **Devin** | custom-trained compaction model | fine-tuned smaller model; cache-miss piggy-back to switch routing models during compaction | preserves `!knowledge` items (cross-session memory) |
| **Cursor** | not documented | not documented | n/a |
| **Codex CLI** | dedicated `compact.rs` task | separate task implementation under `SessionTask` lifecycle | not documented |

### 3.5 Hooks as loop control

| Tool | Lifecycle hooks | Loop-controlling hooks |
|---|---|---|
| **Claude Code** | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, session events, worktree events | `PreToolUse` (deny/allow/ask/defer/rewrite), `Stop` (block = continue; `decision: "block"` adds reason), `SubagentStop` (block keeps child working), `{"continue": false, "stopReason": ...}` terminates |
| **Cursor** | `subagentStart`, `subagentStop`, `afterAgentResponse`, `afterAgentThought`, `stop` | hook can surface lifecycle events but private model-level stopping algorithm is not published |
| **Devin** | none exposed as user hooks (Devin Review is the closest pattern) | n/a |
| **Codex CLI** | none exposed at the same granularity | n/a |
| **BanyanCode** | none — `bus.on(...)` patterns exist in `EventV2Bridge` but no first-class lifecycle hook system | n/a |

---

## 4. Mesh engineering (comparative)

### 4.1 Architectural philosophies

| Tool | Topology | Isolation per subagent | Memory / context sharing |
|---|---|---|---|
| **BanyanCode** | peer-to-peer mesh on `SubagentBus`; orchestrator can spawn any subagent; any subagent can `subagent_message` any peer; `mesh_control` is orchestrator-only | per-session (child session with own conversation); inherits only the `parentID` linkage and any `plan` message | `shared_memory` (global-write allowlist); cross-session `memory_*`; no conversation-history inheritance |
| **Claude Code** | `Agent` (formerly `Task`) tool; parent can spawn multiple `Agent` calls in one turn (parallel) | clean context by default (no parent conversation history); `fork` mode inherits parent's full system prompt + tool pool + model + message history; `isolation: worktree` provides filesystem isolation in a temp git worktree | parent receives only the final report (not the transcript); auto-memory not inherited; custom subagents can have `memory: user/project/local` + `MEMORY.md` |
| **Devin (Managed Devins)** | Manager Devin spawns child Devins, coordinates via internal MCP, reads child trajectories | full VM per child (own kernel, terminal, browser, dev env); parent and child do not share conversation history; child reads parent's notes via shared memory store | trajectories + notes + `Knowledge` items (`!macro`) survive across sessions; parent reads child trajectories post-hoc |
| **Devin (Devin Review)** | separate agent with zero shared context with the coder | clean context (intentional, see "Context Rot" / Chroma research) | none — reviewer's only input is the diff |
| **Cursor Cloud Agents** | "run as many agents as you want in parallel" — each in its own VM with cloned repo, deps, secrets, startup commands, network access | full VM | repo state visible across the workspace; verification artifacts (screenshots, videos, logs) |
| **Codex CLI subagents** | `agents.enabled: true` by default; parallel child threads, parent consolidates | inherits parent runtime permissions (sandbox mode, approval policy, `/permissions` overrides, `--yolo`); child definition may impose narrower sandbox (e.g. read-only) | parent reads child summaries; concurrency capped by `agents.max_concurrent_threads_per_session` (default unspecified) |

### 4.2 Concurrency bounds

| Tool | Concurrent | Per-session | Per-agent | Per-tool |
|---|---|---|---|---|
| **BanyanCode** | `MaxSubagents.tryReserveSubagentSlot`; `NestedSpawnRegistry` enforces per-coder budget (concurrent=1, lifetime=5/hr) | `BanyanConfig.Info.banyancode_max_subagents` | agent-level `task` allowlists (e.g. `scout -> deny`, `explore -> {scout}`, `coder -> {explore, scout}`) | not documented |
| **Claude Code** | `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` = 10 (default for read-only/subagent); since v2.1.217, 21st running subagent rejected unless raised | `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` = 200 (default; can raise but not disable); nesting depth `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` = 1 (subagents cannot spawn subagents by default) | optional `maxTurns` per agent | WebSearch: 200/session across parent + all subagents |
| **Devin** | unlimited managed Devins (recommended ~10/batch in examples) | one long session per task (or parallel managed sessions) | none | none |
| **Cursor Cloud Agents** | unlimited (run-level parallelism) | per-session | n/a | n/a |
| **Codex CLI** | `agents.max_concurrent_threads_per_session` (default unspecified) | per-session | sandbox narrowing per child | n/a |

### 4.3 Communication channels

| Tool | Channel | Persistence |
|---|---|---|
| **BanyanCode** | `SubagentBus` (in-memory `Queue.Dequeue<SubagentMessage>`) + `subagent_messages` table (Drizzle SQLite); envelope `{_v:1, data}`; idempotent on `msg.id` | durable until `markDelivered`; GC hourly |
| **Claude Code** | parent receives Agent tool result (foreground) OR completion notification in a later turn (background); resumable subagents via `agentId`; `parent_tool_use_id` for transcript correlation | child transcript is private; parent's `MEMORY.md` is the durable cross-session record |
| **Devin** | internal MCP (manager can read/write child trajectories); shared notes/knowledge store; child returns summarized text to parent's chat surface | durable across sessions via `Knowledge` items + notes |
| **Cursor Cloud Agents** | verification artifacts (screenshots, videos, logs); PRs opened per repo; parent consolidates | durable on remote VM until cleanup |
| **Codex CLI** | parent waits on requested children, receives summaries; no documented deterministic scheduler or result-merge ordering | child thread ephemeral |

### 4.4 Message kinds

| Tool | Kinds |
|---|---|
| **BanyanCode** | `request`, `inform`, `answer`, `poll`, `steer`, `checkpoint`, `plan`, `kill` (8) |
| **Claude Code** | tool result (foreground) + completion notification (background) + `parent_tool_use_id` for correlation |
| **Devin** | trajectory writes (parent reads), note writes, MCP events, Auto-Fix ping-pong |
| **Codex CLI** | child summary + per-child `parent_tool_use_id` |

### 4.5 Reviewer / critic topology

This is the dimension where the surveyed tools diverge most sharply.

| Tool | Reviewer exists? | Topology | Context sharing |
|---|---|---|---|
| **BanyanCode** | not built-in; closest is human via `plan_exit` | n/a | n/a |
| **Claude Code** | yes — `/review`, `/code-review`, `/security-review`, `/simplify`, `/verify`, `/advisor` (cross-model), `/ultrareview`, dynamic workflows (`adversarial_verifier`, `evaluator_optimizer`, `tournament`) | typically same-context (single model reflects on its own output); `/code-review --ultra` is a deep cloud review (multi-agent) | mostly same; dynamic workflows can spawn fresh-context agents |
| **Devin (Devin Review)** | yes, first-class product | dedicated agent with clean context | zero shared context with coder |
| **Cursor** | yes — Bugbot, `/review`, Cursor 0.49+ review | dedicated agent on the diff | fresh context on the diff |
| **Codex CLI** | yes — `/review` as dedicated `review.rs` task under `SessionTask` | read-only by default; prioritized findings | fresh agent |
| **Reflexion** | same model | verbal reflection appended to working memory (up to 3 kept) | full self-context |
| **Constitutional AI** | same model | prompted self-critic against rule list | full self-context |
| **Anthropic evaluator-optimizer** | second LLM role | independent evaluator | clean context |

**Key insight** (Cognition's "Multi-Agents: What's Actually Working", April 2026): *"We've found this technique to work best when the coding and review agents do not share any context beforehand ... The dedicated review agent gets to skip this extraneous context, only look at the diff, and re-discover any context it needs as it reads the code from scratch."* This contradicts the assumption that more context helps — the "Context Rot" research (Chroma) shows attention dilution as context grows. **Implication for BanyanCode**: if we ship a reviewer, it should be a separate agent with clean context, not the coder re-reading its own diff.

---

## 5. `/goal` command and goal engineering (comparative)

### 5.1 Inventory

| Tool | `/goal`? | What it does |
|---|---|---|
| **Claude Code** (v2.1.139+) | YES | Sets a completion condition (up to 4,000 chars). After every turn, Haiku (default) judges the conversation against the condition; "no" starts another turn with the reason as next-turn guidance. Survives `--resume`/`--continue` (elapsed timer / token baseline reset). Sub-commands: `/goal <condition>`, `/goal` (status), `/goal clear | stop | off | reset | none | cancel`. No built-in turn ceiling — user must include one in the condition (`"or stop after 20 turns"`). |
| **Codex CLI / ChatGPT desktop-app Codex** | YES (on supported surfaces) | "Set a persistent goal for ChatGPT to work toward; use `/plan` first to shape it." Progress widget above composer. `/goal edit | pause | resume | clear`. Goal persists until task finishes, pauses, or requires input. **Native Codex CLI TUI support not conclusively documented.** |
| **Cursor** | Not documented | `/plan` is a documented workflow; no `/goal` in the public docs index. |
| **Devin (cloud)** | Not a slash command | Goal = initial session prompt; surfaced as "Interactive Plan" (editable before execution). Confidence (🟢/🟡/🔴) gates approval: auto when confident, manual when not. |
| **Windsurf / Cascade** | Not as `/goal`, but `/plan` exists | User-defined workflows at `.windsurf/workflows/*.md` become `/[name]` slash commands. Built-ins include `/plan`. |
| **Aider** | NO | 30+ slash commands — none for goal-setting. Goals live in `CONVENTIONS.md` or chat transcript. |
| **Cline** | NO | `/newtask`, `/smol` (compact), `/newrule`, `/deep-planning`, `/reportbug`. Goals live in `Memory Bank` (six structured markdown files). |
| **Roo Code / Roomote** | NO | Inherits Cline's command surface. |
| **Continue** | NO built-in | User-defined prompts in `config.yaml` exposed as `/prompts:<name>`. |
| **OpenHands / OpenDevin** | NO | Goal = `task.inputs.goal` textbox. |
| **BanyanCode** | NO | No `/goal`, no goal table, no goal agent, no `goal_*` schema in `BanyanConfig.Info`. |

### 5.2 Goal representation patterns

Eight canonical patterns appear across the field:

1. **System prompt `GOALS:` block (AutoGPT classic)** — numbered goals header at the top of the system message; `task_complete` shutdown command. Lilian Weng notes this is brittle: "A lot of code in AutoGPT is about format parsing."
2. **Memory stream + reflection (Generative Agents, Park et al.)** — implicit goal in biography; retrieved on demand; reflection synthesizes higher-level inferences.
3. **ReAct Thought-Action-Observation** — short-horizon goal as the top-of-step `Thought:`.
4. **Reflexion verbal reflection** — failed-attempt reflection appended to episodic memory buffer (up to 3 kept); next attempt's prompt includes the reflections.
5. **Sidecar markdown files** — `CLAUDE.md`, `AGENTS.md`, `CONVENTIONS.md`, `memory-bank/*.md`, `.windsurf/rules/*.md`, `.devin/rules/*.md`. Survive sessions; injected at session start; the dominant pattern for cross-session goals.
6. **LLM-generated auto-memory** (Claude Code Auto Memory) — model-written learnings about build commands, debugging insights; complementary to manual sidecars.
7. **Verification-driven goal representation** (SWE-agent, AutoCodeRover) — the goal becomes a search-tree over files: issue -> explore -> patch -> test passes. The verifier is the test runner.
8. **Multi-agent goal decomposition** (MetaGPT) — "one line requirement" -> role tree (ProductManager -> Architect -> ProjectManager -> Engineer -> QA); `Code = SOP(Team)`.

**Claude Code's `/goal`** is a 9th pattern: **a session-scoped prompt-based Stop hook**. It is implemented as `type: "prompt"` hook that runs after each turn. The user composes the Stop hook; `/goal` is just a thin wrapper that installs one.

### 5.3 Goal persistence (where the goal lives)

| Pattern | File / storage | Lifetime | Used by |
|---|---|---|---|
| System prompt goal block | `<conversation context>` | current session | every tool |
| `CLAUDE.md` | repo-root markdown | persistent | Claude Code (also AutoGPT, others) |
| `.claude/rules/*.md` | per-dir, frontmatter-globbed | persistent | Claude Code |
| Auto Memory | LLM-managed | persistent | Claude Code |
| `AGENTS.md` | repo-root markdown | persistent | Codex CLI, Cascade, OpenHands, AutoGPT repo root |
| `CONVENTIONS.md` | static markdown, read-only via `/read` | persistent | Aider |
| `memory-bank/*.md` (six files) | structured markdown tree | persistent | Cline |
| `.windsurf/rules/*.md`, `.devin/rules/*.md` | per-rule file with `always_on | glob | model_decision | manual` frontmatter | persistent | Windsurf/Cascade/Devin |
| `!macro` reference | inside `Knowledge` | persistent per workspace | Devin |
| `/goal` runtime state | session memory | current session (survives `--resume`) | Claude Code, Codex |
| AutoGPT `ai_settings.yaml` + file-based long-term memory | filesystem | persistent | AutoGPT Classic |

### 5.4 Loop-bound primitives

The field agrees an unbounded tool-use loop is unsafe. The disagreement is on **what to measure**:

| Primitive | Used by | Cost |
|---|---|---|
| Explicit max-turn / max-iteration | Claude Code (`maxTurns`), BanyanCode V2 (`MAX_STEPS=25`), Codex CLI `SessionTask` | zero |
| Evaluator-decision (prompt-based Stop hook) | Claude Code `/goal` (Haiku), Anthropic evaluator-optimizer | one small-model call per turn |
| Monotonic-no-progress detector | Reflexion heuristic `h_t`: inefficient planning (too long without success) OR consecutive identical actions -> same observation | zero |
| Per-role round limit | MetaGPT (SOP cardinality) | zero |
| Wall-clock cap | Devin (45 min SWE-bench eval; ~3 hr recommended) | zero |
| Confidence gate (model-internal) | Devin 🟢/🟡/🔴 | zero |
| Session-size classifier | Devin (L/XL flagged unhealthy) | zero |
| User clarification handshake | GPT-Engineer | variable |
| External signal (test/CI result) | SWE-agent, OpenHands, Codex `/goal` (CLI) | per-signal |

**Anthropic's "Building Effective Agents" explicitly endorses stopping conditions + maximum iterations**: *"it's also common to include stopping conditions (such as a maximum number of iterations) to maintain control."* And the verifier should consume **external** signals: *"Code solutions are verifiable through automated tests; Agents can iterate on solutions using test results as feedback."*

**Huang et al. (Google, ICLR 2024) warn against intrinsic self-correction** without external feedback: *"LLMs struggle to self-correct their responses without external feedback, and at times, their performance even degrades after self-correction."* This is the case for evaluator-optimizer loops where the same model reflects on its own output.

---

## 6. Synthesis: recommended BanyanCode architecture

A loop-engineering + mesh-engineering + goal-engineering design that combines the strongest patterns from the survey, plus the BanyanCode baseline.

### 6.1 Loop engineering changes

**Keep**: V1 `runLoop` shape; per-agent `agent.steps`; compaction on overflow.

**Add**:

1. **Per-prompt goal ID.** Extend `PromptInput` (`prompt.ts:1680-1702`) with an optional `goalID` discriminator that the loop consults each iteration.
2. **Outcome shape extension.** Replace `Outcome = "break" | "continue"` (`prompt.ts:1319`) with `Outcome = "continue" | "achieved" | "blocked" | "maxSteps" | "maxTime" | "noProgress"`. Each path is observable; the TUI can surface them.
3. **Stop-hook evaluator.** A new layer in `prompt.ts` that runs *between iterations* (not between tool calls) — equivalent to Claude Code's `type: "prompt"` Stop hook. The hook reads `transcript + goal.condition + recent tool calls` and returns `{continue: bool, reason?: string}`. Default model: cheap & fast (Claude Haiku or local model). Wired via `MeshCoordinator.evaluateGoal(...)` so a subagent (e.g. `reviewer`) can be the evaluator.
4. **Max-time + max-turns + max-tokens cap** as last-resort bounds. Each surfaces a distinct outcome.
5. **No-progress detector** in the loop: track the last N tool calls; if `N` identical actions produced `N` identical observations (Reflexion heuristic), surface `noProgress` outcome.
6. **Lifecycle hooks layer.** Expose `BeforeTool` / `AfterTool` / `BeforeTurn` / `AfterTurn` / `BeforeStop` / `AfterStop` event surfaces so plugins (and a future `goal_*` tool) can subscribe. This is the Banyan equivalent of Claude Code's hooks.

### 6.2 Mesh engineering changes

**Keep**: SubagentBus, MeshCoordinator, idempotent messages, GC, bounded concurrency, peer tools, `task` tool.

**Add**:

1. **A dedicated `reviewer` agent.** New entry in `packages/opencode/src/agent/agent.ts` (mode: primary, allow `task: { *: deny, reviewer: allow }`). Pattern: dedicated agent, clean context, given a diff and the original goal. The reviewer reports `Outcome` — pass / fail / blocked — and the orchestrator decides whether to retry, accept, or surface to user. Reference: Devin Review (clean context) + Cursor 0.49 Review (Bugbot).
2. **SubagentPlans step-status stamping.** `subagent-consumer.ts` currently ignores `steps[*].status`; fix to advance each step's status as `inform`/`answer` messages arrive. This makes the plan a live progress tracker, not a write-only artifact.
3. **Cross-mesh goal-link.** A `goalID` column on `subagent_messages` and `subagent_plans` so the orchestrator can filter the bus by goal. MeshCoordinator gains `subscribeByGoal(goalID)`.

### 6.3 Goal engineering additions

This is the largest new surface. Eight components:

1. **`goal` slash command.** Add `Default.GOAL = "goal"` to `packages/opencode/src/command/index.ts:80`. Two modes: `template` (LLM-driven "set goal" — the model turns a free-form request into a `goal.condition`) and `execute` (side-effecting — writes a row to a new `goals` table). Mirror the `codegraph-build` pattern at `command/index.ts:161-203`.
2. **`GoalRepo` + `GoalService`.** New layer under `packages/core/src/banyancode/goal-{payload,repo,service}.ts`. Natural-key idempotency on `(parentSessionID, goalID)` per the AGENTS.md "deterministic natural key" lesson. Mirror `memory-{payload,repo,service}.ts`.
3. **`goals` table.** `{goalID, parentSessionID, condition (text), exitCriteria (jsonb), steps (jsonb), status (active|achieved|blocked|cancelled), createdAt, updatedAt, achievedAt?, deadlineMs?}` on `banyancode-local.db`. Versioned JSONB envelope (`{_v:1, data}`) per the AGENTS.md "versioned JSONB payloads" lesson.
4. **`goal_*` tool kit.** `goal_set`, `goal_status`, `goal_advance` (step transition), `goal_complete`, `goal_block`, `goal_subscribe` (live status stream). Reuse the mesh tool layer pattern (`packages/core/src/tool/`).
5. **`GoalEvaluator` layer.** A new layer that runs after each orchestrator turn (and after each subagent turn that the orchestrator is monitoring). Reads `transcript + goal.condition + recent tool calls`; returns `{continue: bool, reason?: string, achieved: bool, suggestedNextStep?: string}`. Implementation: a small model call (Haiku equivalent) by default; user-configurable.
6. **TUI surface.** A `tabs/tab-goals.tsx` and a `dialog-goal.tsx` (parallel to `dialog-agent-control.tsx`). Goal list, active goal, achieved/blocked history. Plus a sidebar widget showing live `goal.steps[*].status`.
7. **CLI surface.** `banyancode goal set <condition>`, `banyancode goal status`, `banyancode goal list`. File: `packages/opencode/src/cli/cmd/goal.ts`.
8. **`BanyanConfig.Info` extension.** Add `banyancode_goal_evaluator_model` (default: cheap/fast), `banyancode_max_goal_turns`, `banyancode_max_goal_time_ms` (default wall-clock), `banyancode_max_goal_no_progress` (Reflexion threshold), `banyancode_goal_auto_retry_on_block` (default true). All snake_case per AGENTS.md style.

### 6.4 How the pieces interlock

```
                                  user
                                   |
                                   v
                       /goal <condition>  (slash command)
                                   |
                                   v
                        GoalRepo.put(goal)
                                   |
                          orchestrator session
                                   |
        +--------------------------+--------------------------+
        |                          |                          |
        v                          v                          v
   TaskTool.spawn            SubagentBus              Stop hook evaluator
   (coder, reviewer,         (peer messaging,          (GoalEvaluator:
    general, ...)             plan updates)              small model on
        |                                                transcript +
        v                                                goal.condition)
   SubagentConsumer                                            |
   (forkDetached drain loop)                                   v
        |                                              continue / achieved
        v                                              / blocked
   subagent_messages  ---------------------------->   runLoop.next
   (idempotent,                                       (Outcome shape)
    versioned payload)
        |
        v
   GoalRepo.advanceStep(stepID, status)
        |
        v
   TUI sidebar / tab-goals / dialog-goal
```

The orchestrator session owns the loop. Each turn, the orchestrator:
1. Runs the model.
2. Receives tool calls (mix of mesh tools, repository tools, codegraph tools, `goal_*` tools, `task` tool).
3. Settles tool results.
4. Triggers `GoalEvaluator` against the transcript (if an active goal exists).
5. Applies the evaluator's verdict to the `Outcome` — continue / achieved / blocked.
6. If continue, loops. If achieved, marks the goal, surfaces to user, optionally spins down subagents via `mesh_control` `kill`. If blocked, surfaces to user with the evaluator's reason.

### 6.5 Concrete file path / line additions

| New file | Purpose |
|---|---|
| `packages/core/src/banyancode/goal-payload.ts` | versioned JSONB envelope (`encodeGoalValue` / `unwrapGoalValue` / `normalizeGoalValue`) — mirror `memory-payload.ts` |
| `packages/core/src/banyancode/goal-repo.ts` | Drizzle CRUD with natural-key idempotency — mirror `memory-repo.ts` |
| `packages/core/src/banyancode/goal-service.ts` | `setGoal`, `advanceStep`, `completeGoal`, `blockGoal`, `listGoals`, `subscribeToGoal` — mirror `memory-service.ts` |
| `packages/core/src/banyancode/goal-evaluator.ts` | small-model `evaluate(transcript, goal): {continue, achieved, reason}` |
| `packages/core/src/banyancode/goal-events.ts` | `GoalSet` / `GoalAdvanced` / `GoalAchieved` / `GoalBlocked` / `GoalCancelled` event types |
| `packages/core/src/tool/goal.ts` | LLM-facing `goal_set`, `goal_status`, `goal_advance`, `goal_complete`, `goal_block`, `goal_subscribe` |
| `packages/core/src/tool/goal-evaluator-tool.ts` | LLM-facing `goal_evaluate` (manually invoke the evaluator mid-loop) |
| `packages/opencode/src/agent/prompt/reviewer.txt` | reviewer agent system prompt — clean-context, diff-only, return `Outcome` |
| `packages/opencode/src/agent/agent.ts` (modify ~line 459) | add `reviewer` agent entry near `orchestrator` |
| `packages/opencode/src/session/prompt.ts` (modify ~line 1319) | extend `Outcome` shape; wire `GoalEvaluator` after each turn |
| `packages/opencode/src/command/index.ts` (modify line 80-99) | add `Default.GOAL = "goal"`; add `codegraph-build`-style execute |
| `packages/opencode/src/cli/cmd/goal.ts` | new CLI command file |
| `packages/tui/src/tabs/tab-goals.tsx` | goal list / active / history |
| `packages/tui/src/component/dialog-goal.tsx` | parallel to `dialog-agent-control.tsx` |
| `packages/core/src/v1/config/banyan-config.ts` | extend `BanyanConfig.Info` with `banyancode_goal_*` keys |

---

## 7. Open design questions

These are the questions a follow-up spec / RFC should answer before implementation begins:

1. **Evaluator model identity.** Default to a fast/cheap model (Haiku-class) or use the orchestrator's own model in a separate context? Trade-off: cost vs. calibration. Cognition runs the reviewer in a *clean context* of the same model class — we can do the same.
2. **Goal vs Plan.** Is `goal.condition` distinct from `SubagentPlan.exitCriteria`? Or is `SubagentPlan` a refinement of `Goal`? The current `SubagentPlan` is a per-subagent artifact; a `Goal` is per-session and per-parent. Recommendation: keep them separate but reference — `Goal.steps[*]` map to `SubagentPlan.steps` when a subagent is spawned for that step.
3. **Goal failure ownership.** When `GoalEvaluator` returns `blocked`, who decides what to do — auto-retry, steer the agent, surface to user? Pattern from Claude Code: the evaluator's reason is fed back as next-turn guidance; pattern from Devin: 🟡/🔴 confidence waits for user. Recommendation: hybrid — auto-retry up to `banyancode_max_goal_no_progress`, then surface to user with the evaluator's reason and `subagent_message` trail.
4. **Multi-goal sessions.** Can a session have multiple active goals? Claude Code restricts to one; BanyanCode could allow more but UX complexity rises sharply. Recommendation: one active goal per session; archived goals live in the table for the session's history.
5. **Goal scope across sessions.** Should `/goal` survive session restart like `--resume`? Recommendation: `/goal` is session-scoped; cross-session goals live in `CLAUDE.md` / `AGENTS.md` / `BanyanConfig.Info` (we can ship a `banyancode_default_goal` for the latter).
6. **Reviewer as separate agent or stop hook?** Two architectures:
   - **Dedicated `reviewer` agent** (Devin, Cursor pattern): clean context, separate model call, parallel-friendly. Higher latency, more accurate.
   - **Stop-hook evaluator** (Claude Code pattern): lightweight, in-loop, one model call per turn. Cheaper, less rigorous.
   - Recommendation: ship both — a Stop-hook evaluator for fast bounds and a `reviewer` agent for thorough review on demand (and on `GoalAchieved`).
7. **Compaction interaction with goal.** When the loop compacts the transcript, does the evaluator lose the evidence it needs? Pattern from Claude Code: `CLAUDE.md` is re-injected every session; the goal condition lives in the Stop hook and is not subject to compaction. Recommendation: `Goal.condition` lives outside the conversation context (in `goals` table); only `Goal.history` (step transitions, evaluator reasons) lives in the transcript and is subject to compaction.
8. **Time / cost / token budget representation.** Anthropic's `/goal` lets the user write "or stop after 20 turns". BanyanCode should expose structured fields: `maxTurns`, `maxTimeMs`, `maxTokens`, `maxCostUsd`, `maxNoProgress`. Recommendation: structured fields in `goals` table; surface in the goal UX as sliders/spinners.
9. **Goal -> memory promotion.** When a goal is achieved, what happens to the journey? Pattern from `memory_extractor`: write a `decision` / `observation` entry summarizing what worked. Recommendation: auto-extract on `GoalAchieved`; user can reject via `memory_reject`.
10. **Sandboxing the evaluator.** The evaluator must not have edit tools (otherwise it's a reviewer). Recommendation: evaluator tool surface = `read` only.

---

## 8. Sources

### Claude Code
- https://code.claude.com/docs/en/agent-sdk/agent-loop — main loop, maxTurns, parallel tool execution
- https://code.claude.com/docs/en/how-claude-code-works — gather-context/act/verify phases, auto-compaction
- https://code.claude.com/docs/en/context-window — context simulation
- https://code.claude.com/docs/en/model-config — Sonnet 5 1M context / 967K auto-compact
- https://code.claude.com/docs/en/env-vars — `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_MAX_RETRIES=10`, `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=10`
- https://code.claude.com/docs/en/permission-modes — manual/acceptEdits/plan/auto/dontAsk/bypassPermissions; auto-mode fallback (3 consecutive / 20 total)
- https://code.claude.com/docs/en/permissions — deny > ask > allow precedence; hooks can block but not override deny
- https://code.claude.com/docs/en/sub-agents — Agent tool, Explore/Plan/general-purpose, `isolation: worktree`, memory scopes, parallel/background modes
- https://code.claude.com/docs/en/agent-sdk/subagents — context isolation, `parent_tool_use_id`, resume via `agentId`
- https://code.claude.com/docs/en/tools-reference — EndConversation, EnterPlanMode/ExitPlanMode, TaskCreate/TaskGet/TaskList/TaskUpdate, WebSearch 200/session limit
- https://code.claude.com/docs/en/hooks — full lifecycle incl. PreToolUse, PostToolUse, PostToolBatch, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact
- https://code.claude.com/docs/en/goal — `/goal` v2.1.139+; Haiku evaluator; up to 4,000 chars; survives `--resume`; "or stop after 20 turns"
- https://code.claude.com/docs/en/commands — full slash-command inventory (98 commands)
- https://code.claude.com/docs/en/errors — automatic retries, `continue` response after partial output
- https://code.claude.com/docs/en/memory — CLAUDE.md + Auto Memory
- https://code.claude.com/docs/en/hooks-guide — prompt-based Stop hook (`type: "prompt"`), agent-based hook
- https://code.claude.com/docs/en/skills — `/code-review`, `/verify`, ultrareview
- https://code.claude.com/docs/en/troubleshooting — auto-compaction thrashing error
- https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code — dynamic workflows (adversarial_verifier, evaluator_optimizer, tournament)
- https://www.anthropic.com/engineering/building-effective-agents — workflow patterns incl. Evaluator-Optimizer, orchestrator-workers, max-iteration stopping conditions
- https://www.anthropic.com/engineering/multi-agent-research-system — multi-agent research, retry/checkpoint/resumable state
- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents — durable progress via git history + feature list + progress log + end-to-end verification
- https://www.latent.space/p/claude-code — Boris Cherny + Cat Wu interview (May 2025, pre-`/goal`)
- https://github.com/anthropics/claude-code — public repo

### Devin (Cognition)
- https://www.cognition.ai/blog/introducing-devin — Scott Wu launch (Mar 2024)
- https://www.cognition.ai/blog/swe-bench-technical-report — 45-min SWE-bench cap; "Devin can run indefinitely"
- https://www.cognition.ai/blog/devin-generally-available — "Keep sessions under ~3 hours"
- https://www.cognition.ai/blog/devin-2 — Interactive Planning (Apr 2025)
- https://www.cognition.ai/blog/devin-2-1 — 🟢/🟡/🔴 confidence (May 2025)
- https://www.cognition.ai/blog/devin-sonnet-4-5-lessons-and-challenges — 1M token cap-at-200k trick, model self-compression
- https://www.cognition.ai/blog/devin-annual-performance-review-2025 — "ambiguous coding project" weakness
- https://www.cognition.ai/blog/devin-review — Devin Review launch (Jan 2026)
- https://www.cognition.ai/blog/closing-the-agent-loop-devin-autofixes-review-comments — Auto-Fix loop
- https://www.cognition.ai/blog/introducing-devin-2-2 — self-verify, auto-fix (Feb 2026)
- https://www.cognition.ai/blog/how-cognition-uses-devin-to-build-devin — internal usage
- https://www.cognition.ai/blog/devin-can-now-manage-devins — Managed Devins (Mar 2026)
- https://www.cognition.ai/blog/devin-can-now-schedule-devins — Scheduled Devins, cross-session memory
- https://www.cognition.ai/blog/devin-in-windsurf — minutes-to-hours cadence (Apr 2026)
- https://www.cognition.ai/blog/multi-agents-working — Walden Yan's reversal (Apr 2026); clean-context reviewer; "Context Rot"
- https://www.cognition.ai/blog/what-we-learned-building-cloud-agents — VM snapshot, suspend/resume (Apr 2026)
- https://www.cognition.ai/blog/how-to-automate-failure-triages-and-10x-test-generation-what-weve-learned-deploying-ai-across-hilsil-workflows — HIL/SIL (May 2026)
- https://www.cognition.ai/blog/auto-triage — webhook-driven agents (May 2026)
- https://www.cognition.ai/blog/devin-fusion — Devin Fusion + sidekick (Jun 2026)
- https://www.cognition.ai/blog/introducing-devin-security-swarm — security map-reduce (Jul 2026)
- https://www.cognition.ai/blog/dont-build-multi-agents — Walden Yan's original (Jun 2025)
- https://www.cognition.ai/blog/kevin-32b — RL research, serial vs parallel (May 2025)
- https://www.cognition.ai/blog/swe-1-7 — in-house frontier model
- https://docs.devin.ai/cli/subagents — subagent profiles (`subagent_explore`, `subagent_general`), nesting policy, foreground/background
- https://docs.devin.ai/cli/handoff — `/handoff` cloud sync
- https://docs.devin.ai/work-with-devin/devin-review — Auto-Review triggers, severity model
- https://docs.devin.ai/work-with-devin/devin-session-tools — Progress tab, sidebar status chips
- https://docs.devin.ai/product-guides/knowledge — `!macro`, `Knowledge` items
- https://docs.devin.ai/product-guides/session-insights — L/XL unhealthy threshold, retry-loop flagging
- https://docs.devin.ai/essential-guidelines/when-to-use-devin — "explicit completion criteria"
- https://docs.devin.ai/release-notes/overview — Slack `!normal`, `!ultra`, `!fast`, `!unsync`, Tasks tab, plan header
- https://devin.ai/agents101 — Coding Agents 101 ("Be willing to cut your losses earlier")

### Cursor
- https://cursor.com/docs/cloud-agent.md — Cloud Agents (= Background Agents); isolated VMs; run-level parallelism; lifecycle hooks (subagentStart/Stop, afterAgentResponse/Thought, stop); verification artifacts (screenshots, videos, logs); multi-repo
- https://cursor.com/docs — docs root
- https://cursor.com/blog — blog index
- https://cursor.com/changelog — release notes

### Codex CLI (OpenAI)
- https://github.com/openai/codex/blob/main/codex-rs/core/src/tasks/mod.rs — `SessionTask`, `Session::start_task`, completion/cancellation/abortion/error
- https://github.com/openai/codex/blob/main/codex-rs/core/src/tasks/review.rs — `/review` dedicated task
- https://github.com/openai/codex/blob/main/codex-rs/core/src/tasks/compact.rs — compaction task
- https://github.com/openai/codex/blob/main/codex-rs/core/src/exec.rs — shell-tool 10s default timeout, sandbox denial, process termination
- https://github.com/openai/codex/blob/main/AGENTS.md — Codex's own AGENTS.md
- https://developers.openai.com/codex/reference/slash-commands — `/goal`, `/plan`, `/review`, `/init`, `/prompts:<name>`
- https://developers.openai.com/codex/prompting — `/plan -> /goal` sequencing
- https://developers.openai.com/codex/code-review — `/review` read-only, prioritized findings
- https://developers.openai.com/codex/agent-configuration/subagents — subagent concurrency, sandbox inheritance
- https://developers.openai.com/codex/agent-configuration/agents-md — AGENTS.md chain, override files
- https://developers.openai.com/codex/agent-approvals-security — approval workflow, fail-closed reviewer
- https://developers.openai.com/codex/long-running-work — goal mode reference

### Other tools and patterns
- https://aider.chat/docs/usage/commands.html — Aider 30+ slash commands (no /goal)
- https://aider.chat/docs/usage/conventions.html — `CONVENTIONS.md`
- https://aider.chat/docs/usage/modes.html — `/code`, `/architect`, `/ask`, `/help`
- https://docs.cline.bot/core-workflows/using-commands.md — Cline slash commands
- https://docs.cline.bot/core-workflows/plan-and-act.md — Cline Plan/Act separation
- https://docs.cline.bot/best-practices/memory-bank.md — six-file Memory Bank
- https://docs.devin.ai/desktop/cascade/workflows — `.windsurf/workflows/*.md` slash commands, `/plan`
- https://docs.devin.ai/desktop/cascade/memories — Cascade Memories vs Rules vs AGENTS.md vs Workflows vs Skills
- https://docs.all-hands.dev/usage/key-features — OpenHands chat panel + browser + terminal + VS Code
- https://github.com/All-Hands-AI/OpenHands — OpenHands Agent Canvas pivot
- https://github.com/FoundationAgents/MetaGPT — "Code = SOP(Team)" multi-agent; per-role round caps
- https://github.com/SWE-agent/SWE-agent — Agent-Computer Interfaces, NeurIPS 2024
- https://github.com/SWE-agent/mini-swe-agent — ~100 LOC, 65% SWE-bench Verified
- https://lilianweng.github.io/posts/2023-06-23-agent/ — canonical reference for planning + ReAct + Reflexion + CoH + AD + Generative Agents + AutoGPT system prompt
- https://arxiv.org/abs/2303.11366 — Reflexion paper
- https://arxiv.org/abs/2310.01798 — "Large Language Models Cannot Self-Correct Reasoning Yet" (Huang et al., ICLR 2024)
- https://github.com/Significant-Gravitas/AutoGPT — classic `GOALS:` block, `task_complete` shutdown
- https://github.com/yoheinakajima/babyagi — task-planning-as-goal-driven-loop

### BanyanCode (internal)
- `packages/opencode/src/session/prompt.ts:1149-1448` — V1 `runLoop`
- `packages/opencode/src/session/prompt.ts:1179-1198` — primary exit condition
- `packages/opencode/src/session/run-state.ts` — `SessionRunState.ensureRunning`
- `packages/opencode/src/agent/agent.ts:174-532` — V1 agent registry
- `packages/opencode/src/agent/prompt/orchestrator.txt` — orchestrator system prompt
- `packages/opencode/src/tool/task.ts:104-465` — orchestrator's spawn entry
- `packages/opencode/src/tool/plan.ts:15-78` — `plan_exit` Yes/No gate
- `packages/opencode/src/tool/registry.ts:373-431` — `baseBanyanToolLayers`
- `packages/opencode/src/command/index.ts:80-99` — `Default` enum (no goal)
- `packages/opencode/src/command/index.ts:161-203` — `codegraph-build` execute pattern
- `packages/opencode/src/cli/cmd/*.ts` — CLI commands (no `goal.ts`)
- `packages/opencode/src/session/system.ts:110-124` — V1 system prompt `codegraph()` source
- `packages/core/src/agent.ts:13` — V2 default agent registry (selection-only)
- `packages/core/src/session/runner/llm.ts` — V2 unbounded continuation loop (step cap removed in the strip)
- `packages/core/src/session/runner/index.ts` — runner error types
- `packages/core/src/banyancode/subagent-bus.ts:1-119` — bus + idempotent publish
- `packages/core/src/banyancode/subagent-messages-repo.ts:1-153` — Drizzle CRUD
- `packages/core/src/banyancode/subagent-plans-repo.ts:1-89` — `SubagentPlan` repo
- `packages/core/src/banyancode/subagent-types.ts:1-57` — `MessageKind` union + envelope
- `packages/core/src/banyancode/subagent-consumer.ts:1-97` — drain loop
- `packages/core/src/banyancode/mesh-coordinator.ts:1-583` — `Interface` at 62-90; `planFor` at 379; `runGarbageCollection` at 489
- `packages/core/src/banyancode/max-subagents.ts:1-52` — concurrency caps
- `packages/core/src/banyancode/nested-spawn-registry.ts:1-196` — per-coder budget
- `packages/core/src/banyancode/memory-{payload,repo,service,significance,extractor,retrieval,projection,hygiene,events}.ts` — memory stack
- `packages/core/src/tool/{mesh-control,mesh-subscribe,subagent-message,shared-memory,memory,memory-candidate}.ts` — mesh + memory tools
- `packages/core/src/v1/config/banyan-config.ts` — `BanyanConfig.Info`
- `specs/banyancode/agents-dump.md` — agent permission matrix
- `specs/banyancode/memory.md` — memory architecture
- `specs/banyancode/versioning.md` — CalVer versioning
- `ARCHITECTURE.md` — repo layout