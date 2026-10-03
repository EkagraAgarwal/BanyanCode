# BanyanCode MCP server: review and remaining-work plan (+ performance review)

> This file has two parts. **Part I (§1–§8)** covers the MCP server. **Part II (§9–§12)** is the RAM/CPU review and the other defects found along the way. Part II is independent, and §11 can be scheduled ahead of any MCP milestone.

Status: review of `5842a16191` (feat(opencode): serve BanyanCode over MCP with read-only code tools) and `81b5c91c55` (feat(core): add banyancode_mcp_server config keys), shipped in 26.10.1. Companion to [mcp-server-plan.md](./mcp-server-plan.md), which stays the design source of truth.

Review method: read every file in `packages/opencode/src/mcp-server/`, the CLI wiring, the config diff, the docs page and the three test suites. Ran `bun test test/mcp-server` (34 pass, 0 fail, ~118 s). Ran a live stdio smoke test that spawned `bun run src/index.ts mcp serve --cwd D:/OpenCode` and sent `initialize` → `tools/list` → two `tools/call`s. Findings marked **[verified]** were reproduced live or are unambiguous in the code. **[likely]** means the code path reads that way but needs a regression test to confirm.

---

## 1. Where things stand

| Area | Plan phase | State |
|---|---|---|
| `banyancode mcp serve` (stdio), in-process server, `--cwd`, `--attach`, stderr-only logging | 0 | **Shipped, works.** Stdout stayed pure JSON-RPC in the smoke test. |
| `banyan_code_find`, `banyan_repo`, `banyan_change_check`, `banyan_codegraph` | 0 | **Registered.** 2 of the 2 calls tried live failed (§2.1, §2.2). |
| Task lifecycle (`tasks.ts`), compact result (`result.ts`) | 1 | **Pure module only.** Not registered as MCP tools. No production `SessionClient`. Tested against a fake. |
| Permission policy, worktree tracker (`isolation.ts`) | 2 | **Pure module only.** Not wired. Worktree "allocation" just builds a string. No git worktree is created. |
| Verify/memory helpers (`tools-verify-memory.ts`) | 2 | **Pure module only.** No `banyan_verify` / `banyan_memory` tools are registered. |
| `banyancode_mcp_server` config | 4 | **Schema only.** Nothing reads it (`grep` finds only the definition). |
| Streamable HTTP, progress, MCP Tasks, elicitation, resources, prompts | 3 | Not started. |
| Telemetry `origin: mcp` | 4 | Not started. |
| Docs page `banyancode-mcp.mdx` | 4 | **Overclaims** (§2.10). |

Net: Phase 0 is shipped with defects. Phases 1–2 exist as tested building blocks but are invisible to any MCP client. The delegation feature, which is the reason for the whole effort, is not reachable.

---

## 2. Verified defects in what shipped

Severity: **P0** means it breaks a shipped tool or is a security issue. **P1** means it will break as soon as the dormant modules get wired. **P2** is quality.

### 2.1 P0: `banyan_code_find` fails unless the caller passes `includeKeywordFallback` [verified]
The live call `{intent:"definition", target:"createMcpServer", limit:3}` returned `BadRequest … Missing key at ["includeKeywordFallback"]`. The route schema (`packages/core/src/tool/code-find.ts:51`) declares it as required `Schema.Boolean`. The MCP zod schema marks it optional and omits it when absent (`tools-code.ts:248`). The tests pass because they always send it.
**Fix:** always send `includeKeywordFallback: args.includeKeywordFallback ?? true` (matching the documented default). Add a protocol test that omits every optional field on every tool.

### 2.2 P0: `banyan_codegraph` (both ops) fails without `root` [verified]
The live `{op:"status"}` returned `root is required`. `/global/*` routes run without the instance middleware, so `InstanceRef` is undefined and the handlers (`handlers/global.ts:315-321`, `:425-426`) need an explicit root. The MCP tool forwards `root` only when the caller supplies it, and then forwards it **relative**, which `identityForRoot` resolves against the server's `process.cwd()`, not `--cwd`.
**Fix:** always send `root: assertInsideRoot(cwd, args.root ?? ".")`, the absolute resolved path.

### 2.3 P0: tools target the wrong workspace when `--cwd` differs from the process cwd [verified by code; likely in practice]
- `createOpencodeClient` is built without `directory` (`server.ts:69`, `:83`), so session-scoped routes fall back to the server's process cwd.
- Global code-intel routes bind `CodegraphRepo` to the DB derived at server start (process cwd).
- `/global/typecheck|test-run|lint` use `payload.projectRoot ?? process.cwd()` (`handlers/global.ts:916,935,955`).
- `guardedPath` checks the path against `--cwd` but sends the *original relative* string, which the server resolves against a different base.

The result is that `banyancode mcp serve --cwd ../other-repo` validates paths against one repo and answers from another, with no error. It works by accident today because Claude Code launches the process in the project directory.
**Fix (all three):**
1. In in-process mode, `process.chdir(cwd)` before `Server.listen`.
2. Pass `directory: cwd` to `createOpencodeClient` (and the worktree path for worktree tasks).
3. Send absolute, resolved paths, and always pass `projectRoot`/`root` explicitly.

With `--attach`, call the attached server's current project/path endpoint at startup and refuse, with a clear message, if its worktree is not `cwd` (or is not an ancestor of it).

### 2.4 P0 (security): the server password is exported into the process environment [verified]
`server.ts:79` sets `process.env.OPENCODE_SERVER_PASSWORD`. Any `bash` tool child process spawned by an agent inside this process inherits it. An agent running under the `reject` policy, but with bash allowed by config, could `curl` the loopback server with that password and approve its own permission request (`POST /permission/:id/reply`), change `banyancode_yolo_mode`, or read other sessions. That defeats the "a caller/agent can never grant itself yolo" guarantee.
**Fix:**
- Pass the password to the listener through its per-listener `ConfigProvider` (the comment at `server.ts:76-77` says one exists) instead of the global env.
- If the env var must be used, delete it immediately after `listen` resolves, and scrub `OPENCODE_SERVER_PASSWORD`/`BANYANCODE_SERVER_PASSWORD` from the shell tool's spawn env.
- Add a test: a bash tool run inside an MCP-served session prints `$OPENCODE_SERVER_PASSWORD` and the output is empty.

### 2.5 P1: "random port" is actually 4096 first [verified]
`Server.listen({port: 0})` prefers 4096, then any free port (`server.ts:119-121`). The smoke run bound `127.0.0.1:4096`. An MCP process started before the TUI or `banyancode serve` takes the well-known port, so a later `--attach http://127.0.0.1:4096` (as the docs advise) attaches to the *MCP child's* server.
**Fix:** add an explicit "ephemeral" option to `ListenOptions` (or pick a free port first) so MCP never claims 4096.

### 2.6 P1: config struct repeats the `annotate({ identifier })` + array hazard [likely]
`McpServer` in `banyan-config.ts` is `.annotate({ identifier: "BanyanMcpServer" })` and contains `tools: Array<string>`. `BanyanConfig` is updated over HTTP (`PATCH /global/banyan-config`). This is the exact shape of the `AGENTS.md` lesson, where single-element arrays fail to decode through the HttpApi `$ref` path. `"tools": ["code"]` is the most likely real-world value.
**Fix:** drop the identifier (inline the struct). Add an HTTP-layer regression test that PATCHes `tools: ["code"]` and `tools: ["code","task"]`.

### 2.7 P2: output truncation produces invalid JSON [verified by code]
`capOutput` slices the pretty-printed JSON at 8,000 characters and appends a marker (`tools-code.ts:117-124`). Callers that parse the result get broken JSON. The limit is also hard-coded, ignoring `result_max_tokens`.
**Fix:** truncate structurally, trimming arrays and setting a `truncated: true` / `omitted: N` field, and return `structuredContent` alongside the text (see §4.6). Read the cap from config.

### 2.8 P2: path guard ignores symlinks and Windows case [verified by code]
`assertInsideRoot` uses `path.resolve`/`relative` only. A symlink inside the repo that points outside it passes. On Windows, `D:\Repo` vs `d:\repo` compare unequal in some `relative` edge cases.
**Fix:** `realpath` both sides (when the target exists; otherwise realpath the nearest existing ancestor). Compare case-insensitively on win32. There are currently **three** copies of this guard (`server.ts:49`, `tools-code.ts:103`, `isolation.ts:348`); collapse them into one.

### 2.9 P2: shutdown is incomplete
`transport-stdio.ts` stops the listener but disposes no instances, doesn't close the DB, and (once tasks exist) doesn't abort MCP-owned sessions, although the plan says stdio disconnect aborts them. In `--attach` mode, `cleanup` is a no-op, which is correct, but the code doesn't document that.

### 2.10 P2: the docs promise features that don't exist
`packages/docs/src/content/docs/banyancode-mcp.mdx`:
- Says "Streamable HTTP with `--http`". The flag doesn't exist.
- Describes `banyan_task_*`, `needs_input`, `banyan_task_reply`, and the orchestrator recipe. None of these are callable.
- Says "the JSON result [of `run --format json`] carries the same compact summary shape as `banyan_task_result`". That's false: `run` emits raw events.
- Recommends `--attach …:4096` (see §2.5).

**Fix now:** mark the unshipped features "coming in a later release" or remove them, and list the four tools that actually exist. Re-expand the page as each milestone lands.

---

## 3. Defects in the dormant modules (fix before or while wiring)

These don't affect users today, but each one would ship as a bug the moment the modules are registered.

### `tasks.ts`
1. **Queued tasks are never started, then get reported as `done`** [verified by code]. Over-cap starts are stored as `queued` and never get `promptAsync`, because nothing dequeues them (`tasks.ts:295-299`). On the first `task_status`, `refreshFromSession` sees an idle session with no pending items and marks it `done` with an empty result (`:229-243`).
2. **Race between `promptAsync` and the first status check** [likely]. `taskStart` refreshes right after `promptAsync`. If the run loop hasn't flipped the session to `busy` yet, the task reports `done` with no assistant message. "Done" has to mean that an assistant message newer than the prompt exists and the session is idle, or that a `session.idle` event for this prompt was observed.
3. **The `reject` policy doesn't auto-reject**. Every pending permission becomes `needs_input` and waits for the caller (`:211-218`), and a caller "approve" then collapses to reject anyway (`:352-357`). That's a pointless round-trip that also stalls the session. Under `reject`, permissions should be denied up front by the session ruleset (§4.2), so they never reach the caller. Only questions should surface.
4. **Question replies are sent twice** [verified by code]. `taskReply` sends `replyQuestion(text)` and then also `prompt(text)` (`:359-367`), injecting the answer a second time as a new user turn.
5. **The `needs_input` timeout fires only when the caller polls**. A caller that never polls leaves the session blocked forever. The timer belongs to the server, driven by events (§4.3).
6. **The task table is an in-memory `Map`**. With `--attach`, the docs promise that tasks "keep running … pickable again by task_id". But a restarted MCP process has an empty table, so it returns `unknown task_id`. Rehydrate from session metadata (§4.4).
7. **"approve" detection is string equality on free text** (`reply.answer === "approve" || reply.message === "approve"`). Use a typed `decision: "approve" | "reject"` field.
8. **Concurrency is implemented twice** (`TaskStore.runningCount` and `McpTaskTracker`) with different semantics. `tasks.ts` ignores `banyancode_max_subagents`. Keep one.
9. **`taskCancel`** doesn't release the concurrency slot, start the next queued task, or clean up the worktree.
10. **`PermissionPolicy`** is declared in both `tasks.ts:24` and `isolation.ts:8`.

### `result.ts`
11. **`worktree: task_id`** (`tasks.ts:408`) reports the session ID as the worktree path.
12. **`detail: "transcript"`** is accepted but renders the same as `summary`. There is no `cursor` paging, although the tool contract promises it.
13. **The cap isn't enforced for large changes**. The file list is counted as "overhead" but never trimmed. With 300 changed files, the summary budget drops to 0 and the result still exceeds `maxTokens`. Trim the list (top N by churn plus an `omittedFiles: N` count).
14. **`verification` and `memory` are never filled in**. `taskResult` never collects them.
15. **Token estimation is chars/4 on JSON-stringified fields**. That's acceptable, but name it `estimatedTokens`, so callers don't treat it as exact.

### `isolation.ts`
16. **`allocateWorktree` defaults to a fake relative path** (`worktrees/<id>`). Nothing calls the existing `/experimental/worktree` API (SDK `Experimental.worktree*`, `strategy: "git_worktree"`), so "two worktree tasks stay disjoint" is only true of two strings.
17. **`decidePermissionRequest` has no caller**. It's also built around replying to permission asks one at a time, not around rulesets (§4.2).
18. **`finish()` dequeue logic** has an unreachable branch and can re-queue the same ID. Rewrite it when consolidating with item 8.
19. **`onDisconnect` returns `"aborted"` without aborting anything.**

### `tools-verify-memory.ts`
20. It uses Effect `Schema` while `tools-code.ts` uses zod. MCP registration needs zod (SDK compat), so these schemas can't be registered as written.
21. **Memory `scope` is undefined for MCP callers.** Decide it (project scope by default) and validate it.
22. **`tagMemoryStore` adds an `origin` field the store route may not accept.** Check the `/global/memory/store` schema and keep only what it accepts. Tags are probably enough.

### Tests
23. **`tasks.test.ts` runs against `FakeSessionClient`**, against the repo rule "avoid mocks". There is no test of the production adapter.
24. **The "stdout hygiene" test monkey-patches `process.stdout.write` around pure functions.** It never starts the CLI, so it can't catch a real regression. The smoke script used for this review is the correct shape (§6).
25. **No test omits optional fields or exercises `--cwd` ≠ process cwd.** That is exactly how §2.1–§2.3 got through.

---

## 4. Design corrections (decide before Milestone B)

### 4.1 One production `SessionClient` over SDK v2
Create `mcp-server/session-client.ts`, which implements the `SessionClient` port with the real SDK:

| Port method | SDK call |
|---|---|
| `createSession` | `session.create({ title, agent, model: {providerID, id, variant}, metadata: {origin:"mcp", mcp_client, policy, isolation}, permission: ruleset })` |
| `promptAsync` | `session.promptAsync` (split `provider/model` → `{providerID, modelID}`) |
| `abort` | `session.abort` |
| `sessionStatus` | `session.status()` (map by id) |
| `messages` / `diff` / `todo` / `mesh` | `session.messages` / `session.diff` / `session.todo` / `session.mesh` |
| `pending` | `permission.list` + `question.list`, filtered by sessionID **including child sessions** (subagents ask too) |
| `replyPermission` / `replyQuestion` / `rejectQuestion` | `permission.reply`, `question.reply`, `question.reject` |
| `cost` | sum over assistant messages of the root and its children |

Every call goes through a client built with `directory: <cwd or worktree path>`.

### 4.2 Enforce permission policy with session rulesets, not by replying to asks
`session.create` accepts `permission: PermissionRuleset`, and `run.ts:377-395` already uses this to deny `question`/`plan_enter`/`plan_exit`. Build the ruleset from the policy at creation time:

| Policy | Ruleset appended after config (later rules win, `findLast`) |
|---|---|
| `reject` | deny `plan_enter`, `plan_exit`; `question` → **ask** (surfaces as `needs_input`); no extra allows, so everything else follows config, and any remaining `ask` is auto-rejected by the event loop (§4.3) |
| `edits` | the above, plus allow `edit`/`write`/`patch` with pattern `<root>/**` (root = cwd or worktree) |
| `yolo` (needs `--allow-yolo`) | allow `*`, except `question` → ask |

This makes the policy hold even when nobody polls, puts it in the same engine as the TUI, and uses no per-ask code. Note the `AGENTS.md` `findLast` lesson: append the policy rows **after** the agent's own rules, and test it against an agent with `"*": "deny"` (`explore`).

### 4.3 Event-driven task engine instead of poll-driven
One `event.subscribe` SSE stream per MCP process (or `global.event` with `--attach`) feeds a single drain that updates task records:
- `session.status` / `session.idle` → running/done, which fixes the race in §3 item 2
- `permission.asked` for an MCP-owned session tree → auto-reject under `reject`, or move to `needs_input` otherwise
- `question.asked` → `needs_input` and start the timeout timer
- `session.error` → failed

Follow the `AGENTS.md` rules: a bounded queue, a single consumer, and no `forkScoped` from a `runFork` fiber. `task_status`'s `wait_seconds` becomes "wait for the next state change or the deadline" rather than a 250 ms poll. Use the same stream to emit MCP `notifications/progress` when the caller sent a `progressToken`.

### 4.4 Tasks are sessions, so rehydrate them
The task record is derived state. The source of truth is the session (`metadata.origin === "mcp"`). On startup, or on an unknown `task_id`, look up the session. If its metadata marks it as MCP-owned, rebuild the record. This makes `--attach` reconnect work, and survives MCP process restarts (Claude Code restarts MCP servers freely). Queue state (not yet started) is the only process-local part. Persist it in session metadata (`mcp_state: "queued"`) so it survives too.

### 4.5 Worktrees through the existing API
Allocate with `experimental.worktree.create` and list/remove with the matching calls. The session gets `directory = worktreePath`. The result reports `{worktree: {path, branch}}`. Changes are left uncommitted (`MCP_NO_COMMIT`). Add `banyan_task_cleanup(task_id, remove_worktree)`, or a `cleanup` op on cancel. Worktrees are never deleted automatically while they hold uncommitted changes.

### 4.6 Tool result shape
Use the MCP SDK `outputSchema` + `structuredContent` for every tool (supported in 1.29), and keep a short `text` rendering for clients that ignore structured output. Errors use `isError: true` with a stable `code` (`POLICY_REJECTED`, `PATH_ESCAPE`, `UNKNOWN_TASK`, `NOT_INDEXED`, `UPSTREAM_ERROR`), so callers can branch without parsing prose.

### 4.7 One schema dialect
Everything MCP-facing uses zod (`zod/v3`, cast once via one shared helper rather than per tool). Domain constants (ops, kinds, limits) stay in plain `as const` arrays shared by zod and the tests. Delete the Effect `Schema` structs in `tools-verify-memory.ts`, or keep them only where an HTTP route consumes them.

### 4.8 Consolidate modules
Target layout:
```
mcp-server/
  server.ts            bootstrap (cwd, chdir, listen-ephemeral, sdk, config, register by group)
  transport-stdio.ts   unchanged + full shutdown
  transport-http.ts    Milestone D
  paths.ts             the one realpath-aware root guard
  policy.ts            PermissionPolicy, ruleset builder, yolo gate (from isolation.ts + tasks.ts)
  session-client.ts    SDK-backed port (4.1)
  task-engine.ts       record table, event drain, queue/cap, rehydrate (from tasks.ts + McpTaskTracker)
  result.ts            compact builder (fixed caps, file list trim, transcript paging)
  tools-code.ts        fixed (2.1–2.3, 2.7)
  tools-task.ts        banyan_task_* registration
  tools-verify.ts      banyan_verify
  tools-memory.ts      banyan_memory
  output.ts            structured result/err helpers, cap, codes
```

---

## 5. Milestones

Each milestone is one PR (or a small stack), follows the `type(scope): summary` convention, and runs `bun typecheck` plus `bun test test/mcp-server` from `packages/opencode`. Worker split per `CLAUDE.md`: coders get disjoint files, and the lead agent commits.

### Milestone A: make Phase 0 correct (hotfix, ship as 26.10.2)
| # | Task | Files | Acceptance |
|---|---|---|---|
| A1 | Always send `includeKeywordFallback` (default true) | `tools-code.ts` | The protocol test that omits optionals passes for code_find. |
| A2 | `banyan_codegraph` always sends an absolute `root` | `tools-code.ts` | `{op:"status"}` with no root returns status for `--cwd`. |
| A3 | `chdir(cwd)` in-process; `directory: cwd` on the SDK client; absolute paths everywhere; `--attach` project-mismatch check | `server.ts`, `tools-code.ts` | A test with `--cwd` = tmp repo A while process cwd = B answers from A. |
| A4 | Password not left in `process.env`; shell env scrubbed | `server.ts`, `server/auth.ts`/listener config, shell tool env | The bash-echo test (§2.4) prints nothing. |
| A5 | Ephemeral port (never 4096) | `server/server.ts` (`ListenOptions.ephemeral`), `server.ts` | Two concurrent `mcp serve` plus `banyancode serve` coexist; serve still gets 4096. |
| A6 | One realpath/case-aware path guard | new `paths.ts`, remove the 3 copies | Symlink escape and case tests. |
| A7 | Structural truncation + `structuredContent`/`outputSchema` for the 4 tools | new `output.ts`, `tools-code.ts` | Truncated output still parses as JSON; schema advertised. |
| A8 | Drop `identifier` on `McpServer` config struct; HTTP regression test | `banyan-config.ts`, new test in `packages/opencode/test/banyancode/` | PATCH with `tools:["code"]` round-trips. |
| A9 | Docs truthfulness pass (§2.10) | `banyancode-mcp.mdx` | Only shipped features are documented; the stopgap claim is fixed. |
| A10 | Real stdio e2e test (spawn CLI, initialize, list, call every tool with minimal args, assert every stdout line is JSON-RPC) | `test/mcp-server/stdio-e2e.test.ts` | Runs in CI. Fails if anything logs to stdout. |
| A11 | Default `--cwd` to `CLAUDE_PROJECT_DIR` when set, then `process.cwd()` (§8.4) | `cli/cmd/mcp.ts` | Launching from a subdirectory under Claude Code still targets the project root. |
| A12 | Tool metadata hygiene: `title` on every tool; full annotations (`readOnlyHint`, `idempotentHint`, `openWorldHint: false`, `destructiveHint` where relevant); deterministic `tools/list` order; per-tool `_meta["anthropic/maxResultSizeChars"]` matched to our own cap (§8.4) | `tools-code.ts`, `output.ts` | A snapshot test of `tools/list` is stable across runs. |
| A13 | Argument-validation failures come back as tool execution errors (`isError: true`), not JSON-RPC `-32602`, so the model can self-correct (SEP-1303) | `output.ts` | A call with a bad enum value returns `isError: true` with an actionable message. |

### Milestone B: delegation actually reachable (Phase 1)
| # | Task | Acceptance |
|---|---|---|
| B1 | `session-client.ts` (4.1), including child-session aggregation for pending/cost/subagents | Integration test against a real in-process server with a recorded provider (`packages/http-recorder`); no fakes. |
| B2 | `policy.ts` ruleset builder (4.2), `reject` only for this milestone | A permission ask under `reject` never reaches the caller. Tested with `build` and `explore` agents. |
| B3 | `task-engine.ts`: event drain (4.3), queue that actually dequeues, single cap = min(`max_concurrent_tasks`, `banyancode_max_subagents`), server-side `needs_input` timeout, rehydrate from metadata (4.4) | Fixes for §3 items 1, 2, 5, 6, 8, 9, each with a regression test. |
| B4 | Fix `result.ts` (§3 items 11–15) and add `transcript` paging with `cursor` | A 300-file synthetic diff stays ≤ cap; transcript pages are stable. |
| B5 | Register `banyan_task_start/status/result/reply/cancel` with zod schemas, typed `decision` field, `structuredContent` | Protocol test lists them; full lifecycle e2e over stdio with the recorded provider. |
| B6 | Read `banyancode_mcp_server` via `Banyan.BanyanConfigService` (`default_agent`, `default_model`, `permission`, caps, timeout, `tools` group allowlist); CLI flags override config | Disabling the `task` group hides the tools from `tools/list`. |
| B7 | `mcp_client` from `mcp.server.getClientVersion()?.name`; session title prefix `[mcp]` | The TUI session list shows MCP tasks on the same channel. |
| B8 | Shutdown: abort MCP-owned running sessions in stdio mode, keep them with `--attach`; dispose instances | A test kills the stdio client mid-task, and the session ends aborted. |
| B9 | `task_id` follows the spec's stateful-tool-handle guidance (§8.2): an opaque high-entropy handle mapped to the session ID (not the raw, partly time-ordered `ses_…` ID); lifetime stated in the tool description; a clear "expired/unknown task" tool error so the model can recover | Unknown and expired handles return `isError` with recovery text. |
| B10 | Interplay with Claude Code auto-backgrounding (§8.4): `banyan_task_start` with `wait_seconds` must stay well under the 120 s auto-background threshold (cap stays at 50 s), and `banyan_task_status` long-polls must not trip the 30-min stdio idle timeout | Documented and covered by a timing test. |

### Milestone C: safe writes (Phase 2)
| # | Task | Acceptance |
|---|---|---|
| C1 | `edits` and `yolo` rulesets; `--allow-yolo` gate; config can't express yolo | Permission matrix e2e: reject/edits/yolo × edit-inside/edit-outside/bash/network. |
| C2 | Worktree isolation via `experimental.worktree.*` (4.5); per-task SDK `directory`; second shared writer rejected with a suggestion | Two parallel worktree tasks modify the same file without conflict; `git worktree list` shows both; cleanup removes only clean worktrees. |
| C3 | `banyan_verify` (typecheck/test/lint) with `projectRoot` = cwd or a worktree path; summarized output | Runs against a tmp repo with a failing test and returns first-N failures. |
| C4 | `banyan_memory` (recall/search/get/summary/store), project scope, size limits, `origin:mcp` tag | A store from MCP is recallable by an agent inside a task, and the memory ID appears in `task_result.memory`. |
| C5 | Fill `verification` in task results from verifier/verify tool parts in the session | A task that runs tests reports pass/fail in its summary. |
| C6 | Per-task USD cap (open question 5 → decide yes) reusing the Jev budget accounting pattern; task aborted with `status: failed, code: BUDGET` | Test with a tiny cap. |

### Milestone D: protocol depth, rebuilt on spec 2026-07-28 (Phase 3)

This milestone was originally written against the 2025-11-25 spec. The current spec (2026-07-28) removes the handshake and sessions, moves Tasks into an extension, and replaces server-initiated elicitation with MRTR. See §8 for the research. The rows below replace the original D1–D7.

| # | Task | Acceptance |
|---|---|---|
| D0 | **SDK migration.** Move from `@modelcontextprotocol/sdk@1.29.0` to the v2 split packages (`@modelcontextprotocol/server` 2.x, zod v4), and run the official `v1-to-v2` codemod first. Serve **dual-era**: modern per-request `_meta` and `server/discover` for 2026-07-28 clients, and `initialize` for legacy clients (via the v2 legacy support, confirming whether that needs `server-legacy`). This also removes the zod 4.1.8 vs 4.4.3 split and the `AnyObjectSchema` casts in `tools-code.ts`. | The protocol test suite runs twice, as a legacy client (initialize) and as a modern client (`server/discover` then per-request `_meta`); both pass. A legacy-only server is no longer an option, because modern-only clients fail against it (spec compatibility matrix). |
| D1 | **Tasks extension** (`io.modelcontextprotocol/tasks`, SEP-2663). When the per-request client capabilities include the extension, `banyan_task_start` returns `resultType: "task"` with `taskId`, `status: "working"`, `ttlMs`, `pollIntervalMs`. Implement `tasks/get`, `tasks/update` (answers for `input_required`), `tasks/cancel`, and `notifications/tasks` over `subscriptions/listen`. Map states: running→`working`, needs_input→`input_required` (with `inputRequests`), done→`completed` (with the compact result), failed→`failed`, cancelled→`cancelled`. **Keep the `banyan_task_*` tools** as the fallback for clients without the extension. | One engine (§4.3) serves both surfaces. `CreateTaskResult` is returned only after the session exists (spec: "durably created"). No `tasks/list` (the spec removed it on purpose, to avoid leaking task IDs). |
| D2 | **MRTR for questions and approvals** (SEP-2322), replacing "elicitation when supported". When a task hits a question the policy can't decide: (a) in the Tasks path, `status: input_required` with an `elicitation/create` form request; (b) in the tool path, `banyan_task_status`/`banyan_task_reply` may return `InputRequiredResult` with `inputRequests` + `requestState`. Only send request kinds the client declared. Never send sampling or roots (deprecated, §8.1). | `requestState` is HMAC/AEAD-protected and binds principal, task handle, request ID and a short expiry. Tampered or replayed state is rejected (spec MUST). |
| D3 | **Streamable HTTP, stateless.** `mcp serve --http [--port] [--hostname]`: no `Mcp-Session-Id`; require and validate the `Mcp-Method`/`Mcp-Name` headers (`HeaderMismatchError` `-32020`); return 403 on a bad `Origin` (DNS rebinding); loopback by default; bearer token required; refuse non-loopback without `--hostname` plus a token. Cross-call state lives only in explicit handles (task IDs), which is already the design. | HTTP client tests: 401 without the token, 403 on a foreign Origin, 400 on a header mismatch; two requests on different connections can use the same `task_id`. |
| D4 | Optionally mount `/mcp` on the `banyancode serve`/TUI server so several callers share one process and tasks appear live in the TUI. | Claude Code connects by URL (`type: "http"`) and the tasks are visible in the TUI. |
| D5 | **Progress.** Emit `notifications/progress` on the request's own response stream (the spec keeps request-scoped notifications there, not on `subscriptions/listen`). Note that Claude Code does **not** extend the wall-clock timeout on progress (§8.4), so progress is purely for display. | The progress token receives updates per subagent state change. |
| D6 | **Caching metadata.** Return `ttlMs` and `cacheScope: "private"` on `tools/list`, `resources/list`, `resources/read` and `prompts/list` (now required by SEP-2549). Emit `notifications/tools/list_changed` only when the config group allowlist changes. | Schema test asserts both fields are present. |
| D7 | Resources `banyan://task/{id}/diff`, `banyan://task/{id}/transcript`, `banyan://memory/{id}` (paged, capped). Tool results return `resource_link` items pointing at them instead of inlining large diffs. Prompt `delegate-plan`, which Claude Code exposes as a `/mcp__banyancode__delegate-plan` slash command. | Reading a resource respects the cap; `resource_link` round-trips. |
| D8 | Auto-attach: discover a running local server (mDNS / well-known port, plus a project and channel match) before starting one in-process. | Avoids two indexers on one DB; opt out with `--no-auto-attach`. |
| D9 | **OpenTelemetry propagation**: read `traceparent`/`tracestate`/`baggage` from request `_meta` (SEP-414) and continue the trace into the BanyanCode session spans, so a caller's trace shows the delegated work end to end. | A test with a supplied `traceparent` produces child spans with the same trace ID. |

### Milestone E: ship (Phase 4)
- Distribution (§8.6):
  - Add `mcpName` to the published `banyancode` npm package and publish a `server.json` to the official MCP Registry with `mcp-publisher`. The name must be `io.github.<owner>/…` for GitHub auth, and the npm version that is live at publish time must already carry `mcpName`. Gate this in `publish.yml` after npm succeeds.
  - Ship a Claude Code plugin (`.mcp.json` using `${CLAUDE_PROJECT_DIR}`) so `/plugin install` sets everything up, including the `delegate-plan` prompt.
- Telemetry: `origin: "mcp"`, `mcp_client`, tasks started/completed/failed/cancelled, `needs_input` rate, and the "delegation leverage" ratio (result tokens returned ÷ tokens spent inside). Make no savings claims (Jev rule).
- Docs: the full page, a README section, client recipes (Claude Code, Codex, Cursor), and the channel/DB note.
- SDK regeneration only if any HTTP route or schema changed (A5's `ListenOptions` isn't HTTP; A8 changes the config schema, so regenerate).
- Release `dev` canary first, then stable.

---

## 6. Test plan additions (summary)

| Test | Catches |
|---|---|
| `stdio-e2e.test.ts`: spawn the real CLI, JSON-RPC only on stdout, every tool called with **minimal** args | §2.1, §2.2, stdout regressions |
| `cwd-mismatch.test.ts`: process cwd ≠ `--cwd` | §2.3 |
| `password-leak.test.ts`: bash inside an MCP session cannot see the server password | §2.4 |
| `port.test.ts`: MCP never binds 4096 | §2.5 |
| `banyan-config-mcp-http.test.ts`: single-element `tools` array through PATCH | §2.6 |
| `paths.test.ts`: symlink escape, win32 case | §2.8 |
| `task-engine.test.ts`: real server + recorded provider; queue dequeues, race, reject-without-poll, timeout without poll, rehydrate after restart, cancel frees the slot | §3 items 1–9 |
| `result-cap.test.ts`: 300-file diff, transcript paging | §3 items 12–13 |
| `policy-matrix.test.ts`: rulesets × agents incl. `explore` (`"*": "deny"`) | §4.2, the `findLast` lesson |
| `worktree.test.ts`: real git worktrees, parallel writes, cleanup | §3 item 16 |

Delete `FakeSessionClient` once `task-engine.test.ts` covers the same behavior against the real server.

---

## 7. Open questions (need an owner decision)

1. **Default to auto-attach (D7) or in-process?** Every Claude Code session currently spawns a full BanyanCode server with its own codegraph watcher on the same DB. Recommendation: auto-attach when a same-project, same-channel server is found.
2. **Commit policy for worktree tasks.** The current constant says never commit. Should there be an opt-in `commit: true` that commits to the task branch (not main) for easy `git merge`?
3. **Should `question` under `reject` surface to the caller or be denied?** `run.ts` denies it. This plan surfaces it as `needs_input` with a timeout. Surfacing is more useful but can stall a caller that ignores it.
4. **Agent and model allowlist.** Should callers be able to pick any configured agent/model, or only `default_*` plus an explicit list? Recommendation: add `allowed_agents` / `allowed_models` to the config struct in B6.
5. **Should A4's env scrubbing go further** and generalize to "never expose any `*_SERVER_PASSWORD` / `*_API_KEY` to agent shells by default"? That would be a broader change than MCP alone.
6. **When to do D0 (SDK v2 + dual-era).** Today's legacy-only server works with every major client, because they are dual-era. Recommendation: do D0 at the start of Milestone D, before D1–D3, so the Tasks extension and MRTR are built once on the new SDK rather than twice. Pull it forward if a modern-only client matters.
7. **Should `banyan_task_*` stay once the Tasks extension lands?** Recommendation: yes, for at least the 12-month deprecation horizon. They are the only path for clients without the extension, and they work over stdio with no protocol features.
8. **Channels push (§8.5):** worth a small experimental `--channel` mode? Recommendation: no for now. It is a research preview, custom channels need `--dangerously-load-development-channels`, and Claude Code won't register a channel server that negotiates 2026-07-28.

---

## 8. Protocol landscape (research, October 2026)

Sources are listed at the end. Every item has a "so what" for this plan.

### 8.1 MCP spec 2026-07-28 is the current revision, and it is a breaking one
- **Stateless.** No `initialize` handshake and no protocol sessions (`Mcp-Session-Id` is gone). Each request carries `_meta`: `io.modelcontextprotocol/protocolVersion`, `.../clientCapabilities` and `.../clientInfo`. Servers **must** implement `server/discover` (SEP-2567, SEP-2575).
  - *So what:* `mcp_client` (B7) has to come from per-request `clientInfo`, not from a connection-level `getClientVersion()`. Concurrency, rehydration and task ownership can't hang off a "connection". §4.4's "sessions are the source of truth" design already fits.
- **Server-to-client requests are gone.** Elicitation, sampling and roots now use **Multi Round-Trip Requests**: the server returns `resultType: "input_required"` with `inputRequests` and an opaque `requestState`, and the client retries with `inputResponses` (SEP-2322). `requestState` is attacker-controlled input: it must be integrity-protected and bound to the principal, the request and an expiry.
  - *So what:* this replaces the original D5 "elicitation" item (now D2). It also fits the `needs_input` model directly.
- **Tasks moved to an extension**, `io.modelcontextprotocol/tasks` (SEP-2663). There's no `tasks/result` or `tasks/list`. It has `tasks/get` (poll), `tasks/update` (mid-flight input), `tasks/cancel`, and `notifications/tasks`. Statuses are `working | input_required | completed | cancelled | failed`. The server decides per request whether to create a task, and must not return one until it is durably created.
  - *So what:* this is almost exactly `banyan_task_*`. D1 maps one onto the other with a single engine.
- **All results carry `resultType`.** List and read results must carry `ttlMs` and `cacheScope` (SEP-2549). `tools/list` order **should** be deterministic, for prompt-cache hits. → A12, D6.
- **Streamable HTTP**: the `Mcp-Method`/`Mcp-Name` headers are required; the GET stream is replaced by `subscriptions/listen`; SSE resumability is removed (a broken stream loses the request, and the client re-issues it). → D3. Also: a long `wait_seconds` on HTTP risks losing the call, which is another reason to keep it ≤ 50 s and use Tasks.
- **Deprecated** (≥ 12-month window): Roots, Sampling, Logging, the HTTP+SSE transport, and DCR in favor of Client ID Metadata Documents (SEP-2577, SEP-2596).
  - *So what:* don't build sampling-based features, for example "let the caller's model judge a BanyanCode result". Directories come in as tool parameters (`--cwd` and `cwd` arguments), not roots. Logs go to stderr and OpenTelemetry.
- **Other useful pieces:**
  - The extensions framework (`extensions` in capabilities).
  - OpenTelemetry `traceparent` propagation in `_meta` (SEP-414) → D9.
  - `inputSchema`/`outputSchema` may use any JSON Schema 2020-12, and `structuredContent` may be any JSON value (SEP-2106).
  - From 2025-11-25 and still current: tool name rules (1–128 characters, `[A-Za-z0-9_.-]`), tool `icons`, `title`, input-validation errors as tool errors (SEP-1303) → A12, A13.

### 8.2 Tool-design guidance that directly shapes our tools
- **Stateful handles.** With no sessions, cross-call state is an explicit handle returned by a tool and passed back as an argument. That is what `task_id` is. The spec asks for:
  - authorization checked on every call (a handle is a name, not a capability)
  - high-entropy opaque IDs for unauthenticated servers
  - the lifetime stated in the tool description
  - an actionable "expired or unknown handle" error

  → B9. Over HTTP, bind handles to the authenticated principal ("State Handle Hijacking").
- **Annotations are hints that clients must treat as untrusted.** They're still worth setting correctly, because clients use them for UI and auto-approval heuristics. → A12.
- **Structured output.** If `outputSchema` is declared, `structuredContent` **must** conform, and servers **should** also send a serialized text block. → §4.6.

### 8.3 TypeScript SDK v2
- `@modelcontextprotocol/sdk` 1.x (1.30.x on npm; we pin 1.29.0) is handshake-era. It gets bug fixes and security updates for at least 6 months after v2.
- v2 (2.0.0, July 2026) is split into `@modelcontextprotocol/core`, `/server`, `/client`, `/node`, `/express`, `/hono`, `/fastify` and `/server-legacy`. It requires zod v4 (the repo catalog already has zod 4), and changes the `registerTool` signature and how per-request client info is read. A codemod, `npx @modelcontextprotocol/codemod@latest v1-to-v2`, does the mechanical renames. Adopting 2026-07-28 itself (MRTR, `_meta`) is manual.
- **Compatibility matrix:** a legacy-only server fails with modern-only clients. A dual-era server works with everyone. → D0.

### 8.4 Claude Code as the main client: concrete constraints
- **`CLAUDE_PROJECT_DIR`** is set in the environment of stdio MCP servers. → A11, the default `--cwd`.
- **Output limits.** `MAX_MCP_OUTPUT_TOKENS` defaults to 25,000, with a fixed 10,000-token warning. Beyond the limit, Claude Code writes the output to a file and hands Claude a path. A per-tool `_meta["anthropic/maxResultSizeChars"]` (up to 500,000) overrides this. Our compact results are far below these limits by design. Declare the cap so behavior is predictable, and keep `detail: "diff"` paging rather than relying on the file spill. → A12.
- **Timeouts.**
  - `MCP_TOOL_TIMEOUT` and per-server `timeout` are hard wall-clock limits.
  - The idle timeout (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`) is 30 min for stdio and 5 min for HTTP.
  - **Progress notifications do not extend the wall-clock timeout.**

  → Long work must go through the task handle or Tasks path, never a single blocking call. D5 progress is display-only.
- **Auto-backgrounding.** A main-conversation MCP call still running after **120 s** (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`) becomes a Claude Code background task, and its result arrives later as a notification (not for subagent calls or `-p` mode). → B10: keep `wait_seconds` ≤ 50 so our own polling stays predictable. Document that a raw long call would be backgrounded by Claude Code.
- **Tool search is on by default.** MCP tools are deferred and found via `ToolSearch`, so tool `title`/`description` quality directly affects whether Claude finds `banyan_task_start`. Keep the `banyan_` prefix and descriptive first sentences. → A12.
- **Prompts become slash commands** and **resources become `@` mentions**. → D7 (the `delegate-plan` prompt, `banyan://` resources).
- **Scopes and plugins.** Plugin-scoped servers get the `mcp__plugin_<plugin>_<server>__<tool>` naming and `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PROJECT_DIR}` substitution. → E (plugin packaging).
- **Claude Code is a dual-era client** (`MCP_SDK_GENERATION` v1/v2, `MCP_PROTOCOL_NEGOTIATION` auto/legacy). Our current legacy server keeps working. → D0 isn't urgent, but it is required for modern-only clients.

### 8.5 Claude Code channels (push into a session)
- Channels let an MCP server push events into a running Claude Code session (capability `claude/channel`, opted in with `--channels`). It's a research preview: Anthropic-allowlisted plugins only, and custom channels need `--dangerously-load-development-channels`. Claude Code won't register a channel server that negotiates 2026-07-28.
- *So what:* pushing "task finished" into the caller's session would be ideal, but it's not shippable now (open question 8). Re-check after the preview ends.

### 8.6 Distribution: MCP Registry
- The official MCP Registry is populated with the `mcp-publisher` CLI from a `server.json` (schema `…/schemas/2025-12-11/server.schema.json`). Ownership is proved by an `mcpName` field in the published npm package's `package.json`, and the name must match `server.json` (`io.github.<user>/…` with GitHub auth). The live npm version must already include `mcpName`. → E.

### 8.7 Precedents: other coding agents served over MCP
- **Codex.** `codex mcp-server` exposed two tools: `codex` (prompt, cwd, model, `approval-policy` ∈ untrusted/on-failure/on-request/never, `sandbox` ∈ read-only/workspace-write/danger-full-access) and `codex-reply` (continue by `threadId`). Approvals went through elicitation, and sessions kept running past client timeouts. It has since been **removed**. OpenAI points integrators to its app-server JSON-RPC protocol "for integrations that need authentication, conversation history, approvals, and streamed agent events", and notes the app server is not MCP.
  - **Lesson:** blocking request/response MCP is a poor fit for a long-running coding agent. Our design avoids the specific failure modes:
    - handles plus polling or Tasks, not one blocking call
    - compact results, not streamed transcripts
    - policy fixed at session creation, not per-ask approvals

    Our equivalent of Codex's app server (the BanyanCode HTTP API + SDK, and ACP) already exists for rich integrations. Position MCP as the **delegation surface for other agents**, not a replacement for those. Also: Codex's `approval-policy` × `sandbox` split is a clearer contract than one `permission` enum. Consider exposing `sandbox: read-only | workspace-write` (≈ reject/edits) as the caller-facing name.
- **Claude Code.** `claude mcp serve` exposes Claude Code's *tools* (not a delegated agent), and leaves per-call confirmation to the client. That's a different shape; ours delegates whole tasks with server-side policy.

### 8.8 Adjacent protocols
- **ACP (Agent Client Protocol).** BanyanCode already speaks it (`banyancode acp`, `src/acp/`). It is the editor→agent protocol (Zed, JetBrains and others) with streaming and permission prompts. MCP is the agent→agent tool surface. Keep both; they share the same in-process-server bridge pattern.
- **A2A (Agent2Agent).** Linux Foundation, v1.0.0 (Jan 2026), with signed Agent Cards at `/.well-known/agent-card.json`, adopted across Google, Microsoft and AWS. MCP and A2A now both sit under the Agentic AI Foundation. A2A targets cross-organization agent coordination. *So what:* out of scope for this plan. The task engine (§4.3) is protocol-neutral, so an A2A adapter could reuse it later if remote orchestration is ever wanted.
- **MCP Apps** (`io.modelcontextprotocol/ui`: `ui://` resources, `text/html;profile=mcp-app`, sandboxed iframes, linked via a tool's `_meta.ui.resourceUri`). A later, optional option is a live task dashboard (subagents, diffstat, cost) for clients that render apps. It isn't needed for Claude Code CLI use, so it's not scheduled.

### 8.9 Security guidance that applies
- **Local server compromise / DNS rebinding.** Local servers should prefer stdio. If they use HTTP, they should require a token and validate `Origin` (403). → D3, plus the existing loopback-only default.
- **Token passthrough is forbidden.** Never forward a caller's bearer token to providers or other services. In HTTP mode, the token authenticates the caller to BanyanCode only.
- **State handle hijacking.** → B9.
- **Human in the loop.** The spec says clients *should* keep a human able to deny tool calls. Our server-side policy (§4.2) is the backstop for when the caller is another agent with no human attached. That's another reason the default stays `reject`.

### Sources
- [MCP versioning (current = 2026-07-28)](https://modelcontextprotocol.io/specification/versioning)
- [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) and [2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)
- [2026-07-28 release post](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [breaking-change rundown](https://stacktr.ee/blog/mcp-2026-spec-changes), [4sysops summary](https://4sysops.com/archives/2026-07-28-model-context-protocol-mcp-stateless-multi-round-trip-routable-headers-authorization-hardening/)
- [MRTR pattern](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr), [Tasks extension spec](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks), [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension)
- [Versioning and dual-era compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [Tools spec](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [Security best practices](https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices)
- [TypeScript SDK v2 docs](https://ts.sdk.modelcontextprotocol.io/v2/), [migration](https://ts.sdk.modelcontextprotocol.io/v2/migration), [releases](https://github.com/modelcontextprotocol/typescript-sdk/releases)
- [Claude Code MCP docs](https://code.claude.com/docs/en/mcp), [Claude Code channels](https://code.claude.com/docs/en/channels)
- [MCP Registry quickstart](https://modelcontextprotocol.io/registry/quickstart)
- [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps)
- [Codex MCP server (removed)](https://learn.chatgpt.com/docs/mcp-server), [Codex-as-MCP-server writeup](https://codex.danielvaughan.com/2026/03/30/codex-cli-as-mcp-server/)
- [A2A one-year announcement](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)

---

# Part II: RAM / CPU review

Method:
- **Live measurement** of the installed 26.10.1 binary: `banyancode serve` on this repo, process tree sampled every 5 s for about 3.5 minutes, idle and with the project instance loaded.
- **Direct inspection of the on-disk databases** with `bun:sqlite` (`dbstat`, event-type breakdown, largest-row field analysis).
- **Three parallel read-only code audits** (core/banyancode, TUI, opencode runtime), reconciled against the prior fix commit `f7d33184f7`.

Tags: **[measured]** came from the live/DB numbers; **[verified]** I re-read the code myself; **[audit]** comes from an audit with file:line evidence that I didn't independently re-run. Treat [audit] items as strong leads that need a regression test before or with the fix.

## 9. What was measured

### 9.1 The idle server is not the problem
| State | Working set | Private | CPU |
|---|---|---|---|
| `serve`, no instance | ~250 MB | ~450 MB | 0.02–0.33 s per 5 s (≈ 0.5–6 % of one core) |
| + this repo's instance loaded (`/project/current`, `/session`, `/config`, codegraph status) | ~245 MB | ~430 MB | same |

A bare idle server costs a few hundred MB and a steady trickle of wakeups (the 1 Hz system monitor among them). The "really high" usage people see therefore comes from four things:
1. the **TUI process**: three JS heaps plus JSON transport (§10.2);
2. **active sessions**: durable DB writes per streamed chunk and O(N²) history work (§10.1);
3. **indexing** (§10.3);
4. **database bloat**, which drags every write, checkpoint and cache (§9.2).

### 9.2 The database is the largest single measurable problem [measured]
- `.banyancode/` for this one repo holds about **7 GB** of SQLite across 10 DB families. The breakdown:
  - stable `banyancode-3abae43a0c41.db`: **2.6 GB**
  - `-dev`: 1.6 GB
  - `-main`: 0.8 GB
  - **orphaned branch-named or legacy DBs** that nothing cleans up: `banyancode-mesh-phase0-complete.db` 593 MB, `banyancode-main.db` 731 MB, `banyancode-sync-upstream-providers.db` 331 MB, and others
- Inside the 2.6 GB stable DB (`dbstat`):

| Object | Size |
|---|---|
| **`event` table** | **1,841 MB (70 %)** |
| `codegraph_fts_data` | 308 MB |
| `part` | 273 MB |
| `message` | 73 MB |
| event indexes (3) | 38 MB |
| codegraph nodes + edges + indexes | ~60 MB |

- `event` rows by type:

| Type | Rows | Bytes | Largest single row |
|---|---|---|---|
| `message.updated.1` | 58,434 | **1,184 MB** | **17.9 MB** |
| `message.part.updated.1` | 173,101 | 568 MB | 427 KB |
| `session.updated.1` | 16,282 | 10 MB | 1 KB |

- **Root cause of the `message.updated` bloat: `info.summary.diffs`.** The largest event is 17.9 MB, and all of it is `info.summary.diffs`: more than 700 per-file diff entries, one of them 3.5 MB. The message's summary embeds full file diffs, and the **whole message info is re-snapshotted into the event log on every update**. Worst sessions:

| Session | `message.updated` events | Total |
|---|---|---|
| `ses_01d1968…` | 684 | **175 MB** |
| `ses_01fa2dc…` | 980 | 131 MB |
| `ses_f4eace4…` | 466 | 72 MB |

- Overall: 249k events for 591 sessions and 75k parts, i.e. about 3.3 event rows and 24 KB of event JSON per existing part. The event log is 5× larger than the `part` + `message` tables it describes.
- `auto_vacuum = 0` and `freelist_count = 4`: the file never shrinks, so deleting sessions doesn't return space.

This costs RAM and CPU, not only disk:
- Each `message.updated` encodes, writes and broadcasts megabytes. It is `JSON.stringify`'d again per SSE client and again through the TUI worker, doubled by R3.
- Every durable publish runs a transaction against multi-GB tables and indexes.
- The SQLite page cache (16 MB × several connections, C8) churns, and WAL checkpoints copy large pages.

## 10. Culprits, ranked

### 10.1 Server / session runtime (`packages/opencode`)
| # | Sev | Culprit | Evidence | Fix |
|---|---|---|---|---|
| R0 | **Critical** | **`message.updated` carries `summary.diffs` (full file diffs) and is persisted plus broadcast on every update** (§9.2). A long session writes hundreds of MB and serializes multi-MB payloads to every subscriber. | [measured] largest-row field analysis | Don't put patch bodies in `message.info.summary`: keep only `{path, additions, deletions}` there and serve patches on demand (the `/session/:id/diff` route already exists). Never re-emit an unchanged summary. Check the TUI/SDK consumers of `summary.diffs` first. |
| R1 | **High** | **Streaming tool output is a durable DB write per chunk.** `shell.ts` calls `ctx.metadata` on every stdout chunk → `updatePart` → `structuredClone` + durable `PartUpdated` (schema encode, IMMEDIATE txn, seq select, projector writes, sequence upsert, an `EventTable` insert of the full part JSON incl. tool `input`). `Buffer.byteLength(full)` runs over the whole accumulated output every chunk (O(n²) up to `maxBytes`). | [verified] `tool/shell.ts:508-538`; [audit] `session/processor.ts:247`, `session.ts:691-697`, `core/event.ts:268-363` | Throttle `ctx.metadata` (trailing, 150–250 ms). Send in-flight progress as a **non-durable** event (like `PartDelta`) and persist only the final state. Keep a running byte counter. |
| R2 | **High** | **The event log is never compacted.** Rows are deleted only with their aggregate (`core/event.ts:523`), so every intermediate snapshot stays forever. | [measured] + [verified] | Keep only the latest row per (aggregate, type) beyond the sync horizon, or apply size/age retention. A non-destructive batched compaction migration, then a one-time `VACUUM` plus `auto_vacuum=INCREMENTAL`. |
| R3 | **High** | **Every event is emitted to `GlobalBus` twice** (plain + a `sync` copy carrying the same `data`). Each SSE client and the TUI worker then serialize it, so big payloads go out at least 2× per subscriber. | [verified] `event-v2-bridge.ts:38-65` | Emit once with an optional sync envelope; drop `sync` before serialization in the TUI worker (T1). |
| R4 | **High** | **The `/global/event` SSE queue is unbounded** (`Stream.callback` + `offerUnsafe`, no `bufferSize`). A stalled client grows memory without limit, and this stream carries every directory's events. The instance stream got a 512 sliding bound in `f7d33184f7`; this one didn't. | [verified] `handlers/global.ts:64-72` | `{ bufferSize: 512, strategy: "sliding" }` plus a regression test mirroring `sse-queue-bounded.test.ts`. |
| R5 | **High** | **`Server.listen` builds a second copy of the whole service graph.** `startListener` uses a fresh `Layer.makeMemoMapUnsafe()`, so `createRoutes()` gets new `Database`, `EventV2`, `InstanceStore`, codegraph AutoUpdate (a second watcher and indexer), SystemMonitor, LSP/MCP/plugins, alongside `AppRuntime`'s copy (shared memoMap). It also splits events: a codegraph build forked in `AppRuntime` publishes on a bus that the listener's instance SSE never reads. The port fallback (4096 → 0) can build the graph twice. **Affects** `serve`, `web`, `acp`, `mcp serve`, and the TUI with `--port`/`--mdns`; the default TUI path (`webHandler`) already uses the shared memoMap. | [verified] `server/server.ts:118-127` vs `httpapi/server.ts:364-371` | Pass the shared `memoMap`; pick the port before building layers. |
| R6 | **High** | **O(N²) history per session.** Every loop step re-streams all messages and parts from SQLite (pre-compaction tool outputs included, filtered only afterwards), re-runs `toModelMessages` over the full history and rebuilds the system prompt. Extra full passes happen in `compaction.prune` and `summary.summarize`. | [audit] `session/prompt.ts:1183,1508,1599`, `message-v2.ts:526-545,632`, `compaction.ts:260`, `summary.ts:116` | Per-run in-memory history appended from processor results; `stream()` stops at the newest compaction boundary; prefix cache for converted model messages. |
| R7 | **High** | **Instances are never evicted.** `InstanceStore` keeps one per directory forever, and `InstanceState` uses `ScopedCache` with `capacity: Infinity`. Each holds LSP clients, MCP child processes, plugins, a VCS watcher, snapshot state and an hourly gc fiber. | [audit] `project/instance-store.ts:44`, `effect/instance-state.ts:31` | Idle-TTL/LRU eviction (e.g. 15 min idle, no busy session) via `disposeDirectory`. |
| R8 | Med | **Per-step system-prompt work.** Instruction discovery, re-reading every AGENTS.md/CLAUDE.md, an **HTTP fetch of each remote instruction URL (5 s timeout) on every step**, and re-materializing the tool catalog and `mcp.tools()` on every step. | [audit] `session/instruction.ts:166-178`, `session/tools.ts:83-234`, `prompt.ts:1505-1527` | Cache per run/turn; invalidate on watcher/config events; TTL cache for remote instructions. |
| R9 | Med | **Snapshot git cost per step**, plus a correctness bug. `track()` always spawns `write-tree`; `add()` runs `diff-files` + `ls-files --others` + `check-ignore` + `stat` per candidate. The 3 s throttle returns `true` **without staging**, so `write-tree` snapshots a stale index and edits within 3 s are missing from diff/revert. | [audit] `snapshot/index.ts:53,357-418`, `processor.ts:804,880,1007` | On throttle, reuse the previous tree hash (correctness first); then drive `add()` from the watcher's dirty set and enable `core.untrackedCache`/fsmonitor. |
| R10 | Med | **Duplicate telemetry service**: `agentEfficiencyTelemetryDefaultLayer()` is a factory called in two places (two queues, two drain fibers). | [audit] `app-runtime.ts:113`, `httpapi/server.ts:276` | Hoist to a module constant; audit other `…DefaultLayer()` factories. |
| R11 | Med | **LSP idle shutdown is lazy** (checked only on the next file touch), so tsserver/pyright RSS lingers. | [audit] `lsp/lsp.ts:424-438` | A periodic 60 s sweep fiber. |
| R12 | Med | **Quadratic compaction tail selection** (full `toModelMessages` + stringify per candidate start). | [audit] `compaction.ts:124-136,191-197` | Per-message sizes once, then prefix sums. |
| R13 | Low | Unbounded module-level maps (sticky snapshots, effort, prewarm, per-file edit semaphores, snapshot locks); `realpathSync` per request; a serial `stat` of every indexed file at boot; per-call `ManagedRuntime.make` in ACP that is never disposed. | [audit] | Clear on session delete or instance dispose; memoize; batch; reuse. |

### 10.2 TUI (`packages/tui` + `cli/cmd/tui.ts`)
| # | Sev | Culprit | Evidence | Fix |
|---|---|---|---|---|
| T1 | **High** | **Three JS heaps plus JSON transport per event.** The server runs in a `Worker` (a separate heap) and opentui's tree-sitter has its own Worker. Every `GlobalBus` event for **all** sessions, including per-token `message.part.delta` and the duplicate `sync` copies, goes through `JSON.stringify` → `postMessage(string)` → `JSON.parse`, and is filtered only after parsing. Responses are JSON-in-JSON. With R0, multi-MB `message.updated` payloads cross this boundary repeatedly. | [verified] `util/rpc.ts:20-31`; [audit] `cli/cmd/tui.ts:134`, `context/event.ts:49` | Filter and coalesce in the worker (drop `sync`, drop sessions that aren't displayed, merge deltas per part every 33 ms); `postMessage(object)`; spike running the server in-process (V6). |
| T2 | **High** | **Orphaned `part` entries leak.** Eviction frees only parts reachable from `store.message[session]`. A still-streaming evicted session (common with more than 4 concurrent subagents) recreates parts without their message, and those are never freed. | [audit] `context/sync.tsx:167-207,476-487` | Index parts by session and evict by session; ignore part events for non-retained sessions. |
| T3 | **High** | **Spinners animate forever on stale state.** Each `<spinner>` is its own 80–100 ms interval → full redraw, gated on the part's status. A crashed or aborted turn leaving a tool `running`, a reasoning part without `time.end`, or a Jev part `running` redraws about 12×/s while idle, even off-screen. N parallel tools mean N intervals. | [audit] `routes/session/index.tsx:1748,1855,2208,2295,2346,2473,2606`, `component/jev-tree.tsx:211`, `prompt/index.tsx:1804` | Gate on `session_status !== idle` and the message not being completed; one shared frame clock while ≥ 1 spinner is mounted; reconcile dangling parts server-side (§12 item 8). |
| T4 | **High** | **Full `session.list` on every `session.updated`.** The always-mounted `status-pills.tsx` fetches all sessions (no limit) on any session's update, then reads a non-existent `state.session_status`, so the "active" pill is **always 0**. Same pattern in two tabs. | [audit] `feature-plugins/header/status-pills.tsx:32,70`, `tabs/tab-sessions.tsx:69`, `tabs/tab-agent-tree.tsx:174` | Derive from the live `sync.data.session_status`; tabs derive from the store or debounce with an in-flight guard. |
| T5 | High | **Reasoning parts aren't coalesced.** Full-text `replace`/`trim`, summary re-parse and tree-sitter markdown re-highlight on every 16 ms flush. Each reasoning part allocates its **own native SyntaxStyle**, kept for up to 100 messages. | [audit] `routes/session/index.tsx:1790-1832,1803` | `createCoalescedAccessor`, as already used for text parts; shared `theme.subtleSyntax`. |
| T6 | Med | **The 1 Hz system-monitor event runs regardless of viewers**: one RPC round-trip and a full redraw per second forever; `statfs` every 5 s; `nvidia-smi` every 30 s indefinitely on NVIDIA machines (non-ENOENT failures retry forever). | [audit] `core/banyancode/system-monitor.ts:124-185,255-257`, `effect/banyancode-system-bridge.ts:26-28` | Sample only while a subscriber exists; publish on change; 2–5 s period; a GPU probe circuit-breaker. |
| T7 | Med | The context sidebar recomputes token categories over the whole transcript (`JSON.stringify` of every tool input) on each message/part change. | [audit] `sidebar/context.tsx:133-200,270` | Cache per part ID + status; recompute only the tail. |
| T8 | Med | A 16 ms event batch against 30 fps rendering (two store passes per frame); markdown re-lexed at 50 ms regardless of length; bash output fully re-stripped and re-split per update; Write/Edit `<code>`/`<diff>` stay mounted for 100 messages. | [audit] `context/sdk.tsx:84-95`, `index.tsx:1887-1898,2310-2314,2415,2675,2732` | 33 ms trailing batch; length-scaled coalescing; render only the last ~200 output lines; mount diffs lazily. |
| T9 | Med | **KV writes not debounced** (`structuredClone` + lock + atomic write on every `set`, including every mouse move while dragging the sidebar). The **Windows console-mode enforcer** runs `setInterval(100 ms)` forever. | [audit] `context/kv.tsx:59-66`, `terminal-win32.ts:112` | 250 ms debounce; enforcer at 1 s or event-driven. |
| T10 | Low | Inspector 5 s tick; provider-usage 60 s poll + 30 s countdown; autocomplete anchor poll every 50 ms; a codegraph-progress 1 s tick that runs forever if a build looks stuck; `sidebar/jev.tsx` scans all parts per insert; the experimental data store keeps a second transcript copy nobody reads; BgPulse renders at 30 fps while the retry dialog is open. | [audit] | Gate each on visibility/activity; hard-stop stuck timers. |

### 10.3 Core / codegraph / database (`packages/core`)
| # | Sev | Culprit | Evidence | Fix |
|---|---|---|---|---|
| C1 | **High** | **Tree-sitter grammar LRU thrash leaks wasm memory.** `MAX_HOT_GRAMMAR_FAMILIES = 4`, but a normal repo touches more families under concurrency 8, so families are constantly evicted and reloaded. Each `Language.load` instantiates a new side module in wasm memory, **which never shrinks**. `QUERY_CACHE` pins the old `Language`. `HEAP_INITIAL_PAGES`/`HEAP_MAX_PAGES` are dead constants, so nothing caps the heap. | [verified] `langs/tree-sitter.ts:102-109,288-295`; [audit] the leak mechanics | Load each family once and never evict (≤ 16); or sort files by family; delete the dead constants. Test: RSS growth across two identical index runs ≈ 0. |
| C2 | **High** | **The repository gateway loads the whole graph on every `read`/`grep`/`glob`**: `listAllFiles()` + `searchNodesLight({limit:100000})` + `getMeta` per tool call. | [audit] `tool/registry.ts:36`, `gateway/augment.ts:127-131`, `repository-intelligence/layer.ts:599-611,871-877` | Cache the context by `graphVersion`; name-filtered SQL stem lookup. |
| C3 | **High** | **Auto-update does full-table work before filtering**: tree-sitter init, recompiling every ignore file, `listAllFiles()`, dependents, and a full-table `listParseErrors()` sliced to 50. Remove and index are two `applyChanges` runs (two `wal_checkpoint(TRUNCATE)` and two `bumpVersion`). `.git/` churn isn't ignored, so every git command wakes it. | [audit] `codegraph-indexer.ts:1684-1712,1964`, `codegraph-auto-update.ts:367-415,456-481`, `watcher.ts:170-178` | Pre-filter; single `applyChanges({added, removed})`; path-keyed lookups; SQL `LIMIT`; cached ignore context; ignore `.git/**`; PASSIVE checkpoint. |
| C4 | **High** | **Per-watcher-event config reads.** `BanyanConfig.get()` has no cache (up to 3 file reads + a schema decode) and runs per file event, together with a `getMeta()` query and an O(n) `new Map(pending)` copy, inline on the publisher fiber. | [audit] `codegraph-auto-update.ts:456-474`, `banyan-config.ts:36-65` | Cache config (mtime/explicit invalidation); `indexedRoot` in a Ref; mutate pending in place. |
| C5 | Med–High | **Watcher back-pressure creates unbounded fibers**: each Parcel batch `runFork`s an offer; with the queue full, every fiber holds its batch. Raw watcher events fan out to every SSE client and the TUI. | [audit] `filesystem/watcher.ts:127-143` | Sliding queue + `offerUnsafe`; coalesce; no raw watcher events on SSE. |
| C6 | Med | **Full rebuilds hold every node's code in RAM** (`SELECT *` with `limit 100_000`). The cap **silently truncates bigger graphs**. There are O(N×dir) and O(G·F) scans, and indexing runs on the main thread, blocking the server and TUI. | [audit] `codegraph-indexer.ts:994,1112-1205,1318` | Stream per file; page without a cap; precompute indexes; Worker for parse/derive. |
| C7 | Med | `edit-planner` and `/global/codegraph-nodes|edges` page through all rows including `code`. | [audit] `edit-planner.ts:117,161`, `handlers/global.ts:499,521` | Light projections + filtered SQL. |
| C8 | Med | **Too many SQLite connections, migrations per request.** `Database.defaultLayer` and `Database.node` are two clients on one file; there is one more per root in `banyan-tools-mount`; `/global/codegraph-status` opens a fresh connection **per request** and re-runs PRAGMAs, checkpoint and **migrations** (and the TUI polls it). Each connection has a 16 MB cache and `temp_store=MEMORY`. `path()` runs at import and creates `.banyancode/` in the cwd as a side effect. | [audit] `database.ts:39,261,267`, `sqlite.libsql.ts:153-171`, `handlers/global.ts:471-479` | One shared layer; a root-keyed cached read-only status connection with no migrations; lazy `path()`; benchmark `bun:sqlite` against libsql on the hot paths. |
| C9 | Low–Med | `trace-collector`: `getMeta()` per event and an O(n²) map copy. `agent-efficiency-telemetry`: one INSERT per event and a 1 ms-sleep flush spin. `tool-telemetry` (latent): unbounded raw-input arrays, and `flush` drops events. `EventV2`: `PubSub.unbounded`. | [audit] | Batch; cache; bounded sliding PubSub for non-durable events. |

## 11. Optimization plan

Ordered by impact per effort. Each step is one PR, gated by the benchmark in §11.6 plus the listed correctness tests.

### 11.1 Quick wins (≈ 2 days)
| # | Change | Expected effect |
|---|---|---|
| Q0 | **R0: drop patch bodies from `message.info.summary.diffs`** (counts only; patches via `/session/:id/diff`); skip `message.updated` when the summary is unchanged | Largest single cut in event bytes, DB growth and per-update serialization (§9.2) |
| Q1 | R5: shared `memoMap` in `Server.listen`; pick the port first | Halves resident services in `serve`/`acp`/`mcp serve`/`--port`; fixes the split bus |
| Q2 | R4: bound `/global/event` (sliding 512) | Removes unbounded growth for slow clients |
| Q3 | R1: throttle `ctx.metadata`; running byte counter | Streaming bash: ≤ 5 durable writes/s instead of one per chunk; no O(n²) |
| Q4 | C1: never evict grammar families; delete dead constants | No wasm growth during indexing; no repeated compiles |
| Q5 | T3: gate spinners on session busy + one shared clock | Idle TUI CPU near zero even with stale parts |
| Q6 | T4: status pill from the live store | Removes a full session-list fetch per update; fixes "active = 0" |
| Q7 | T6: system monitor on demand, change-only, GPU circuit-breaker | Removes the permanent 1 Hz wakeup chain |
| Q8 | C4: cache `BanyanConfig.get` + `indexedRoot` | No file reads or decode per watcher event |
| Q9 | T9: debounce KV; Windows enforcer to 1 s | No disk writes per mouse move; 9 fewer wakeups/s |
| Q10 | R10: a single telemetry layer instance | One fewer queue and fiber |

### 11.2 Storage (≈ 3–5 days; follow the migration lessons in `AGENTS.md`: non-destructive, batched)
| # | Change |
|---|---|
| S1 | R2: event-log compaction (latest-per-aggregate beyond the sync horizon), batched migration over existing logs, one-time `VACUUM` at startup with a progress toast, then `auto_vacuum=INCREMENTAL` + periodic `incremental_vacuum`. |
| S2 | A migration that strips patch bodies from existing `message.summary.diffs` (pairs with Q0) and from the corresponding historical events. |
| S3 | **`banyancode db gc`**: list `.banyancode/*.db` families that match no current worktree hash or channel, with sizes; delete **only on confirmation**. Never touch the current worktree's other-channel DBs (canary isolation is deliberate). On this machine it would offer about 2.3 GB of branch-named and legacy DBs. Add a startup hint when stale DBs exceed 500 MB. |
| S4 | C8: one shared connection layer, cached read-only status connection, lazy `path()`. |
| S5 | `codegraph_fts_data` (308 MB) is larger than nodes + edges combined. Review what's indexed (full `code` bodies under a trigram tokenizer?) and move to names, signatures and docs, or a contentless FTS table. |

### 11.3 Session runtime (≈ 1 week)
| # | Change |
|---|---|
| U1 | R3: single `GlobalBus` emit; non-durable progress events (with Q3) |
| U2 | R6: incremental history; `stream()` stops at the compaction boundary; model-message prefix cache |
| U3 | R8: per-run/turn caches (instructions with a remote TTL, tool catalog, MCP tools) |
| U4 | R9: snapshot throttle correctness fix first, then a watcher-driven dirty set |
| U5 | R7 + R11: instance idle eviction; LSP sweep |
| U6 | R12: prefix-sum compaction estimate |

### 11.4 Codegraph (≈ 1 week)
| # | Change |
|---|---|
| G1 | C3: pre-filter, single `applyChanges`, no `listAllFiles`, `.git/**` ignore, PASSIVE checkpoint, bounded parse-error query |
| G2 | C2: gateway context cache keyed by `graphVersion` |
| G3 | C5: sliding watcher queue, no per-batch forks, no raw watcher events on SSE |
| G4 | C6: streaming full rebuild with no 100k truncation; parse/derive in a Worker |
| G5 | C7: light projections |
| G6 | §12 item 1: incremental-scope regression fix (same PR as G1) |

### 11.5 TUI (≈ 1 week)
| # | Change |
|---|---|
| V1 | T1: worker-side filtering and coalescing; structured-clone `postMessage`; drop `sync` |
| V2 | T2: session-indexed part eviction |
| V3 | T5 + T8: coalesce reasoning, shared SyntaxStyle, 33 ms trailing batch, length-scaled markdown window, output tail cap, lazy diffs |
| V4 | T7: incremental context-sidebar accounting |
| V5 | T10 timer cleanup |
| V6 | Spike: server in-process instead of a Worker (one heap). Measure before committing. |

### 11.6 Measure before and after (non-blocking perf CI job)
- **`script/perf-probe.ts`**: start `serve` (and the TUI under a fake terminal), sample RSS, private bytes and CPU each second for 60 s idle, then replay a recorded session (http-recorder cassette: a long bash output plus a 50-turn conversation with many file edits), then incrementally index 200 changed files. Output peak/steady RSS, CPU-seconds, DB bytes written, and event rows/bytes written.
- **`banyancode debug db`**: the `dbstat` breakdown, event-type sizes and largest-row field analysis used in §9.2 (this review's scratch scripts, productized).
- **Starting targets** (re-baseline after Q0–Q3):
  - idle CPU < 0.5 % of one core with the TUI open
  - idle TUI+server RSS −30 %
  - ≤ 5 durable writes/s while streaming bash
  - event bytes per session −90 % (Q0 + S1)
  - no RSS growth across two identical indexing runs

## 12. Other defects found along the way (not performance)

1. **Incremental codegraph edits silently shrink the graph** [audit]. The scoped rebuild loads only changed + already-dependent files, so a newly added import of a previously unlinked file gets no edge, the same-dir peer fallback finds nothing, and the old edges were already deleted (`codegraph-indexer.ts:1091,1102,1142-1155,1348`). Fix in G6.
2. **Snapshot throttle loses edits** (R9). Diff and revert can miss changes made within 3 s of the previous snapshot.
3. **Codegraph full rebuild truncates at 100k nodes** (C6).
4. **Split event bus in `serve`/`acp`/`mcp serve`** (R5). Build progress can go missing on instance SSE.
5. **The status pill's "active sessions" is always 0** (T4).
6. **`sidebar/agent-tree.tsx` calls `useEvent()` after an `await`** in `onMount`. The owner is lost and the error is swallowed. That file and others (`codebase-tree.tsx`, `codegraph-panel.tsx`, `codegraph-intel-panel.tsx`, `intel-trace-panel.tsx`, `header/session-cost.tsx`, `GoLogo`) are unregistered dead code. Delete them, or fix and register them.
7. **`MAX_PARTS_PER_MESSAGE = 50` drops the oldest parts of a long assistant message**, so the start of a long reply disappears from view (`sync.tsx:498-504`). Window the view instead of dropping data.
8. **Dangling `running` parts after a crash or abort** keep spinners alive (T3) and misreport state. Reconcile them on startup and abort (`error: interrupted`).
9. **`nestedGitignoreCache.clear()` races** between a concurrent `index` and `applyChanges` (`codegraph-indexer.ts:273`).
10. **`tool-telemetry.flush` drops events** recorded during the append (latent).
11. **The `AGENTS.md` plugin guidance** shows `useEvent().on(...)` in Views without `onCleanup`, inviting the leak pattern its own hard-won lessons warn about. Fix the example.
12. **The size and layout of `.banyancode/` (7 GB here) is undocumented.** Document the data locations, the channel split, and `db gc` (S3).
13. **MCP overlap.** R5 (fresh memoMap) hits `mcp serve` directly. Fixing Q1 before Part I's Milestone B avoids building a second service graph inside every MCP server process.
