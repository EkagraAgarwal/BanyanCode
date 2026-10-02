# BanyanCode as an MCP server

Status: plan, not started. Owner: TBD. Branch when implemented: `mcp-server`.

## Goal

Let an outside agent (Claude Code, Codex, Cursor, another BanyanCode) use BanyanCode as an MCP server. The caller plans and reviews. BanyanCode does the token-heavy work on cheaper models, using its own routing, verification gates, codegraph, Jev reranking and memory. The caller gets back a **bounded summary**, not the subagents' full transcripts. That bound is what keeps the caller's usage low.

Non-goals:
- Putting a different vendor's model inside BanyanCode as its orchestrator. The server works with any client and adds no provider.
- Changing the behavior of the TUI or the HTTP API. MCP is a new adapter that sits on top of them.
- Desktop, web or app packages (out of scope per `AGENTS.md`).

## What already exists (and why this is mostly an adapter)

| Need | Existing piece |
|---|---|
| Protocol-bridge pattern | `packages/opencode/src/cli/cmd/acp.ts` already starts `Server.listen()` in-process, builds `createOpencodeClient` (SDK v2) against it, and bridges ACP over stdio. The MCP server copies this shape exactly. |
| MCP SDK | `@modelcontextprotocol/sdk@1.29.0` is already a dependency of `packages/opencode`. It is only used as a client today. It also ships `McpServer`, `StdioServerTransport` and `StreamableHTTPServerTransport`. |
| `mcp` CLI namespace | `packages/opencode/src/cli/cmd/mcp.ts` (`list/add/auth/logout/debug`). A `serve` subcommand fits there. |
| Delegation | Session routes in `groups/session.ts`: `POST /session`, `prompt_async`, `abort`, `message`, `diff`, `children`, `mesh`, `permissions/:id`. Subagent routing comes from `tool/task.ts` and Jev (`banyancode_jev_subagent_models`). |
| Code intelligence | `/global/code-find`, `/global/preflight`, `/global/blast-radius`, `/global/safe-rename`, `/global/repository/{query,explain,impact,trace,tests,symbols,relationships,ownership,architectural-slice}`, plus `/global/codegraph-{build,status}`. |
| Shared memory | `/global/memory/{recall,search,store,get,list,forget,summary,candidates,promote,reject}` |
| Verification | `/global/typecheck`, `/global/test-run`, `/global/lint` |
| Headless permission handling | `run.ts` already answers `permission.asked` events: it auto-rejects them, or auto-approves them with `--dangerously-skip-permissions`. |
| Auth | `server/auth.ts` (`OPENCODE_SERVER_PASSWORD`/`USERNAME`, `ServerAuth.headers()`) |

So no new business logic is needed. Every MCP tool is a typed call into an HTTP route that already exists. Permissions, Jev, verification and memory therefore behave the same as in the TUI.

### Zero-work stopgap (works today)

The second option in the pasted note is already available. A caller can shell out to:

```
banyancode run --format json --model <provider/model> --agent <agent> "<task>"
```

and read the JSON events. Add `--dangerously-skip-permissions` when edits are expected. Document this in the README as the "no MCP" path. The MCP server is the better version of the same thing: structured inputs, async lifecycle, compact results, and no stdout parsing.

## Architecture

```
caller (Claude Code etc.)
   │  MCP over stdio (default) or Streamable HTTP
   ▼
banyancode mcp serve  ──►  McpServer (tool registry, result shaping, task table)
                              │ SDK v2 client (createOpencodeClient + ServerAuth.headers)
                              ▼
                        in-process Server.listen(127.0.0.1:0)   ← or --attach <url>
                              │
             sessions · subagent mesh · Jev · codegraph · memory · verifier
```

- **Transport.** Phase 1 uses stdio, because that is what `claude mcp add` uses by default. Phase 3 adds Streamable HTTP, either standalone (`--http --port`) or mounted on the existing server at `/mcp`, so a long-running `banyancode serve` or TUI can be shared by several callers.
- **`--attach <url>`.** Reuse an already-running BanyanCode server (for example the TUI's) instead of starting a new one. MCP-started sessions then show up live in the user's TUI. This mirrors `run --attach`.
- **`--cwd`.** Sets the project the server operates on. It is validated as an existing directory, and every per-request path argument is checked so it resolves inside it (see the path-traversal lesson in `AGENTS.md`).
- **Stdout discipline.** In stdio mode, stdout belongs to the protocol. All logs go to stderr or the log file. This includes the "server is unsecured" warning in `serve.ts`, which would otherwise corrupt the stream. That warning is irrelevant here anyway, because the in-process server binds loopback and gets a random per-process password generated at startup.
- **Channel/DB.** The server uses the DB of whichever binary channel it runs as (stable vs `-dev`). Sessions created over MCP are visible only in a TUI on the same channel (see the session-partition lesson in `AGENTS.md`). Document this.

## Tool surface

Keep it small. Every tool's schema is paid for in the caller's context on every turn. That means about 10 tools, with related operations merged behind an `op` enum. All tools are prefixed `banyan_`. A config allowlist can hide groups.

### Delegation (the core value)

| Tool | Input | Returns |
|---|---|---|
| `banyan_task_start` | `prompt`, `agent?` (default `build`/configured), `model?` (`provider/model`), `plan?` (same shape as the task tool's `plan`), `files?`, `isolation?: "shared" \| "worktree"`, `permission?: "reject" \| "edits" \| "yolo"`, `wait_seconds?` (0–50) | `{ task_id, status }`. If it finishes within `wait_seconds`, it returns the full compact result inline. |
| `banyan_task_status` | `task_id`, `wait_seconds?` | `{ status: queued\|running\|needs_input\|done\|failed\|cancelled, elapsed, cost, tokens, last_activity (1 line), subagents: [{agent, model, status}] , pending_question? }` |
| `banyan_task_result` | `task_id`, `detail: "summary" \| "diff" \| "transcript"`, `cursor?` | The compact result (see below), or a paged diff/transcript with a hard token cap |
| `banyan_task_reply` | `task_id`, `message` or `answer` (for a pending question/permission) | the new status. It continues the same session, so follow-ups keep context without the caller re-sending it. |
| `banyan_task_cancel` | `task_id` | final status (calls `session.abort`) |

`task_id` is the root session ID. A task is a normal session tagged `origin: "mcp"` and given the client's `clientInfo.name`. It therefore appears in the TUI session list, telemetry and `/session/:id/mesh`.

**Compact result shape.** This is what keeps the caller cheap. It defaults to ≤ about 1.5K tokens, configurable.
- the final assistant message, truncated with a marker
- the files changed, with `+/-` counts (from `/session/:id/diff`), with no patch content unless `detail: "diff"`
- verification outcome, if the agent ran typecheck/test/lint or the verifier gate fired
- open questions or unresolved todos (`/session/:id/todo`)
- cost and tokens per model, and number of subagents
- any memory entries written during the task (IDs and titles), so the caller can recall them later instead of re-reading output

**Long-running work.** MCP tool calls are request/response, and callers enforce timeouts (Claude Code: `MCP_TOOL_TIMEOUT`, with large outputs capped by `MAX_MCP_OUTPUT_TOKENS`). So:
1. The default is start-then-poll, with a bounded long-poll (`wait_seconds` ≤ 50).
2. Send `notifications/progress` when the caller supplied a `progressToken`. Map them from session/mesh bus events.
3. Phase 3: if the client advertises MCP **Tasks** support (an experimental part of the 2025-11 spec), run `banyan_task_start` as a native MCP task. Polling stays as the fallback, because client support is uneven.

### Code intelligence (cheap, read-only, no LLM)

| Tool | Backed by |
|---|---|
| `banyan_code_find` | `/global/code-find` |
| `banyan_repo` (`op`: query, explain, impact, trace, tests, symbols, relationships, ownership, slice) | `/global/repository/*` |
| `banyan_change_check` (`op`: preflight, blast_radius) | `/global/preflight`, `/global/blast-radius` |
| `banyan_codegraph` (`op`: status, build) | `/global/codegraph-status`, `/global/codegraph-build` |

These let the caller ask graph questions without spending its own tokens on grep and file reads. Even without delegation, they are useful on their own.

### Shared memory

| Tool | Backed by |
|---|---|
| `banyan_memory` (`op`: recall, search, store, get, summary) | `/global/memory/*` |

Memory is the hand-off channel. The caller stores decisions or the plan once. BanyanCode agents recall it with their existing memory retrieval, and their results are written back as memory entries the caller can fetch by ID. `forget`/`promote`/`reject` stay TUI-only at first because they are destructive or curation operations.

### Verification

| Tool | Backed by |
|---|---|
| `banyan_verify` (`kind`: typecheck, test, lint; `path?`) | `/global/typecheck`, `/global/test-run`, `/global/lint` |

The output is summarized: pass/fail, counts, and the first N failures.

### Resources and prompts (Phase 3, optional)

- Resources: `banyan://task/{id}/diff` and `banyan://task/{id}/transcript`, so clients that support resources can pull large artifacts outside the tool-result budget. Also `banyan://memory/{id}`.
- Prompts: `delegate-plan`, a template that turns a caller's `PLAN.md` section into a `banyan_task_start` call.

## Permissions and human-in-the-loop

No human sits at the BanyanCode end, so every `permission.asked`/`question.asked` event needs a policy:

- `reject` (default): auto-reject anything not already allowed by config. This is the same as `run` without the flag. It is safe for read-only and analysis tasks.
- `edits`: auto-approve edit/write inside `--cwd` (or inside the task worktree). Bash and network still follow the existing config rules, and anything else is rejected.
- `yolo`: maps to `banyancode_yolo_mode`. It is only available when the server was started with `--allow-yolo`. A caller cannot turn it on by itself.

Questions (the `question` tool) and permissions that the policy cannot decide do not block silently. The task moves to `needs_input`, the status payload carries the question, and the caller answers with `banyan_task_reply`. If the caller supports MCP **elicitation**, the same question can be forwarded as an elicitation request (Phase 3). Unanswered `needs_input` times out to reject after a configurable interval.

Decisions made by Jev or by the caller never grant permissions beyond the policy above. This keeps the existing Jev rule ("model decisions never grant permissions").

## Concurrency and isolation

- `isolation: "worktree"` creates a git worktree per task (reusing `worktree-context.ts` / the existing worktree plumbing), so parallel write tasks cannot clobber each other. The result reports the worktree path and branch. Merging stays with the caller or user. BanyanCode never commits or merges on MCP's behalf unless the task prompt says so and the policy allows bash.
- `isolation: "shared"` (default for read-only agents) runs in `--cwd`. If more than one *write-capable* shared task is running at once, the server rejects the start with a clear error that suggests `worktree`.
- Concurrent tasks are capped by `banyancode_max_subagents` (the existing service), with a separate `max_concurrent_tasks` for top-level MCP tasks. Over-cap starts queue (`status: queued`) instead of failing.
- On MCP disconnect: in stdio mode, running tasks are aborted when the process exits. With `--attach`, tasks keep running on the attached server and can be picked up again by `task_id`.

## Configuration

New `BanyanConfig.Info` keys (in `packages/core/src/v1/config/banyan-config.ts`, **not** `ConfigV1`):

```jsonc
{
  "banyancode_mcp_server": {
    "default_agent": "build",
    "default_model": "provider/model",   // optional; falls back to agent/model config
    "permission": "reject",              // reject | edits  (yolo needs --allow-yolo)
    "max_concurrent_tasks": 4,
    "result_max_tokens": 1500,
    "needs_input_timeout_seconds": 600,
    "tools": ["task", "code", "memory", "verify"] // group allowlist
  }
}
```

CLI flags override config for a single run. Env: `BANYANCODE_MCP_*` for the same keys, if needed.

## Client setup (docs deliverable)

- Claude Code: `claude mcp add banyancode -- banyancode mcp serve --cwd .`, or a project `.mcp.json` entry. Recommend `--attach http://127.0.0.1:<port>` when the TUI is open, so tasks show up live.
- Codex / Cursor / generic stdio clients: an equivalent config snippet.
- A short "orchestrator recipe" covering: caller writes the plan into memory or `PLAN.md`, then calls `banyan_task_start` per task with `isolation: worktree`, polls `banyan_task_status`, reads `banyan_task_result(detail: "summary")`, and fetches the diff only for review.

## Security

- Stdio mode trusts only the parent process. The in-process HTTP server binds `127.0.0.1` on a random port, with a random password generated per process and never printed.
- HTTP mode requires `OPENCODE_SERVER_PASSWORD` (or a bearer token), binds loopback by default, and refuses non-loopback binding without an explicit `--hostname` and a password.
- All path-shaped inputs (`cwd`, `files`, `path`) are schema-pattern constrained and resolved-path checked against the project root.
- Results from cheap models are **untrusted data** for the caller. The tool descriptions say so, to reduce the risk of the caller following injected instructions in results.
- Memory `store` from MCP is tagged with its origin, and size limits apply to it the same way they apply to agent writes.

## Telemetry

Add `origin: "mcp"` and `mcp_client` (from `clientInfo.name`) to existing session/tool telemetry. Track tasks started, completion rate, `needs_input` rate, result tokens returned compared with tokens spent inside BanyanCode (the "delegation leverage" ratio), and cancellations. Following the Jev spec's rule, make no claims about cost savings until matched end-to-end workloads show it.

## Testing

Follow repo rules: no mocks, real DB via `tmpdir()` + `Database.layerFromPath`.

- Protocol tests: use the SDK's in-memory client/server transport pair against the real `McpServer` wired to a real in-process server. Assert the tool list, schemas, and the output cap.
- Lifecycle: start, then status, then result, then cancel, using a deterministic recorded provider (`packages/http-recorder`) so no live model is needed.
- Permission policy matrix: reject, edits and yolo cases; `needs_input`, then reply, then resume; the `needs_input` timeout.
- Isolation: two concurrent write tasks in `worktree` mode stay disjoint, and a second write task in `shared` mode is rejected.
- Path traversal: `cwd`/`files` containing `..` or absolute escapes are rejected (lesson in `AGENTS.md`).
- Stdout hygiene: in stdio mode, no non-JSON-RPC bytes appear on stdout during startup or a full task.
- Single-element array regression: a test through the real HTTP layer for any array fields (see the `annotate({ identifier })` lesson in `AGENTS.md`).

## Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Spike** | `banyancode mcp serve` over stdio, in-process server, read-only tools `banyan_code_find`, `banyan_repo`, `banyan_memory(recall)`. | Claude Code lists the tools and calls them against this repo. Stdout hygiene test passes. |
| **1. Delegation** | `banyan_task_start/status/result/cancel/reply`, compact result builder, `origin: mcp` tagging, `reject` permission policy, `--attach`. | End-to-end with a recorded provider. The summary stays under the token cap on a real multi-file task. |
| **2. Safe writes** | `edits`/`yolo` policies, `needs_input` flow, worktree isolation, concurrency caps and queueing, `banyan_verify`, `banyan_change_check`, `banyan_memory(store)`. | Permission matrix and isolation tests pass. Two parallel worktree tasks complete without conflicts. |
| **3. Protocol depth** | Streamable HTTP (`--http` and the `/mcp` mount), progress notifications, MCP Tasks when the client supports them, elicitation for questions, resources/prompts. | Works with at least two different MCP clients. Falls back to polling cleanly. |
| **4. Ship** | `BanyanConfig` keys, docs and client recipes, telemetry, README "use BanyanCode from another agent" section, regenerate the SDK if any route changed. | Released on `dev` canary first, then stable. |

Each phase is its own PR using the `type(scope)` convention, with `bun typecheck` and the relevant tests run from `packages/opencode`.

## Open questions

1. **In-process vs attach default.** Starting a fresh server per MCP process is simple, but it duplicates codegraph indexing and memory caches when the TUI is already running. Should `serve` auto-detect a running local server (mDNS is already in `server/mdns.ts`) and attach to it?
2. **Where the adapter lives.** Should it be a new `packages/opencode/src/mcp-server/` directory, or sit under `acp/`-style siblings? The recommendation is a new directory, so the client-side `src/mcp/` stays untouched.
3. **Exposing the raw task tool vs a curated agent list.** Should callers be able to pick any agent and model, or only an allowlist from config? The recommendation is an allowlist, with `default_*` used when nothing is given.
4. **Commit policy for worktree tasks.** Should BanyanCode leave changes uncommitted (the safest option, and the current recommendation), or commit to the task branch so the caller can `git merge` directly?
5. **Cost guardrails.** Should there be a per-task USD cap enforced server-side (reusing the Jev budget accounting pattern), so a caller loop cannot run up cheap-model spend unattended?
