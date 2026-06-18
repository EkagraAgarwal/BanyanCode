# BanyanCode — Orchestrator + subagent mesh

> See `ARCHITECTURE.md` for the broader design. This file covers the orchestrator and researcher agent prompts.

The orchestrator is a new primary agent that fans tasks out to specialized subagents and coordinates them through shared memory and peer messaging. The mesh is the bus they communicate over.

## Mental model

```
                     user
                      │
                      ▼
               ┌──────────────┐
               │ orchestrator │  primary agent
               └──────┬───────┘
                      │ task (background: true)
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   ┌─────────┐  ┌──────────┐  ┌──────────┐
   │researcher│  │  explore │  │   coder  │  subagents (child sessions)
   └────┬─────┘  └────┬─────┘  └────┬─────┘
        │             │             │
        └──────── shared_memory ◀──┘
        └───────── subagent_message ◀──┘
                      │
                      ▼
              orchestrator reads,
              synthesizes, responds
```

The orchestrator is just another primary agent. The only difference from `build` or `plan` is its system prompt and its permission set.

## Orchestrator system prompt

`packages/opencode/src/agent/prompt/orchestrator.txt` (load with `import PROMPT_ORCHESTRATOR from "./prompt/orchestrator.txt"`). Key rules:

1. **Decompose.** Read the user's task. Identify 1-3 subagents that can run in parallel. If a step depends on a previous step, do it in the next turn, not in parallel.
2. **Fan out via `task`.** Always use `background: true` for fan-out. Each invocation passes a precise prompt and the right `subagent_type`.
3. **Do not poll sleep.** Never use `Effect.sleep` or wall-clock waits. Use `BackgroundJob.wait` (exposed as a tool) or `pollWithTimeout`.
4. **Use `shared_memory` for results.** Each subagent writes its findings to `shared_memory` with descriptive keys. The orchestrator reads them in the next turn.
5. **Use `subagent_message` for live coordination.** If a subagent is mid-task and discovers something another subagent needs, it sends a peer message. The orchestrator subscribes to the bus.
6. **Escalate.** If a subagent returns nothing useful, or if a subagent fails, the orchestrator retries once or escalates back to the user.
7. **Synthesize.** When all subagents complete, the orchestrator writes a single coherent response. Do not paste raw subagent output.

## Researcher system prompt

`packages/opencode/src/agent/prompt/researcher.txt`:

1. **Use `websearch_free` first.** It is free, no key, no rate limit. Only fall back to `websearch` (Exa/Parallel) when explicitly asked.
2. **Cite sources.** Always return a list of `{ title, url, snippet }` for every fact.
3. **Write to `shared_memory`.** Findings are tagged with `[researcher]` so the orchestrator can filter.
4. **Read-only.** Never modify files. Never run shell commands.
5. **One question per search.** Do not chain 5 searches before reporting. Report incrementally.

## Permissions

`orchestrator` and `researcher` are added to the `agents` table at `packages/opencode/src/agent/agent.ts:138-263` **before** the user-config loop. The user can still override or disable them.

The orchestrator's `task` permission uses the wildcard rules from the OpenCode docs (Agents → Task permissions): `task: { "*": "deny", "researcher": "allow", "coder": "allow", "explore": "allow", "general": "allow", "scout": "allow" }`. Last matching rule wins.

## Subagent bus

`packages/core/src/effect/subagent-bus.ts` exposes a small Effect service:

```ts
export class SubagentBus extends Context.Service<SubagentBus, {
  readonly publish: (msg: SubagentMessage) => Effect.Effect<void>
  readonly subscribe: (sessionID: string) => Effect.Effect<Queue.Dequeue<SubagentMessage>>
  readonly peers: (parentSessionID: string) => Effect.Effect<PeerInfo[]>
}>()("@banyancode/SubagentBus") {}
```

The bus is **scoped to the parent session**. A new orchestrator session creates a new mesh; closing the parent session disposes the mesh's `Scope`.

Delivery semantics:

- `publish` writes to the `subagent_messages` table first (durable), then to the in-memory queue (hot).
- `subscribe` first drains the table for unread messages (where `delivered_at IS NULL AND (to_session = ? OR to_agent = ?)`), then attaches the in-memory queue.
- `markDelivered` updates `delivered_at` after the consumer processes the message.

## Mesh coordinator

`packages/opencode/src/effect/mesh-coordinator.ts` is the TUI-side coordinator. It:

- Polls `subagent_messages` for unread messages addressed to the current session.
- Forwards each message to the assistant's next turn as a system message.
- Emits a `bus` event for the TUI sidebar to render.

Polling interval: 1 s by default. Debounce: if 10+ messages arrive within 100 ms, the coordinator collapses them into a single "batch" event with a list of message IDs.

## Concurrency invariants (from `packages/opencode/AGENTS.md` and `packages/opencode/test/AGENTS.md`)

- The orchestrator must **never** use `Effect.sleep` to wait for a subagent. Use `BackgroundJob.wait` (via a tool wrapper) or `pollWithTimeout`.
- All subagent invocations go through `task` with `background: true` so they run in `Scope.Scope`. The orchestrator's session scope owns the lifetimes.
- `subagent_message` writes are durable; even if the process crashes mid-delivery, the next subscribe drains the table.

## Open question (deferred)

- Should the orchestrator's fan-out cap (default 3) be configurable in `opencode.json` under `agent.orchestrator.options.maxFanout`? **Yes, in Phase 7.**
