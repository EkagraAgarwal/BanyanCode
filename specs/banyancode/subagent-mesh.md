# BanyanCode — Subagent message protocol

> Companion to `BANYANCODE_PLAN.md` Phase 3.

The mesh is the bus that carries `subagent_message` tool calls between running subagents. This spec defines the wire format, the routing rules, and the delivery semantics.

## Wire format

```ts
// packages/core/src/tool/subagent-message.ts
Schema.Struct({
  to: Schema.optional(Schema.String),        // agent name, e.g. "researcher". Omit for broadcast.
  kind: Schema.Literals(["request", "inform", "answer", "poll"]),
  payload: Schema.Unknown,                    // JSON-serializable
})
```

`kind` semantics:

- `request` — "please do X and reply". Recipient must respond with `answer` or with their own `inform`.
- `inform` — "FYI, here is some context you may need". Fire-and-forget.
- `answer` — reply to a `request`. The `payload` should reference the original message ID (best-effort; recipients are not required to track).
- `poll` — "are you still working? any progress?". Recipient answers with `inform`.

## Routing

- The `subagent_messages` table is the source of truth.
- A message is delivered to a subagent if:
  - `to_session = <subagent session>` (targeted), OR
  - `to_session IS NULL AND to_agent = <subagent agent name>` (broadcast to a named agent), OR
  - `to_session IS NULL AND to_agent IS NULL AND parent_session_id = <subagent parent session>` (broadcast to all).
- Delivery is **durable**: every published message is in the table before the in-memory queue fires.
- `markDelivered` is idempotent. The coordinator can call it after each consume.

## Concurrency rules

- `subagent_message` is **non-blocking** for the sender. The tool returns immediately after the row is committed and the in-memory queue fires.
- The recipient's next tool-call description includes a summary of unread messages.
- If the recipient is sleeping (i.e. not invoking tools), the message waits. There is no push notification. The recipient must call any tool to surface the next batch.

## Failure modes

- A `request` without a reply does not fail the mesh. The sender can re-send with `kind: "poll"` if it cares.
- A message addressed to a non-running agent is dropped silently. The sender receives `delivered: false` in the tool result if the agent name is not in the parent session's peer set.
- If the process crashes between commit and queue-fan-out, the next `subscribe` drains the table.

## Capacity

- `unreadFor` returns up to `limit` messages (default 50).
- The in-memory queue is bounded to 1000 messages. Overflow drops oldest with a `degraded: true` flag in the next `subscribe` return.

## Future

- Phase 12 (deferred): add a `subagent_message.subscribe` tool that lets a subagent block on a specific reply instead of polling.
- Phase 13 (deferred): persist message bodies in a separate `subagent_message_bodies` table once payloads exceed 1 KB on average.

## Acceptance criteria (from the master plan)

- `subagent-mesh.test.ts` asserts: orchestrator-style test that runs 3 background subagents (`it.live`); all 3 publish to shared memory; orchestrator reads them back; subagent-message delivery is observed at the TUI bus level.
- `shared-memory.test.ts` asserts: 3 concurrent writes do not lose data; reads see latest write; `list` returns keys with the right tags; `delete` removes only the named key.
- `Effect.sleep` is **never** used to wait for a forked fiber (per `packages/opencode/test/AGENTS.md`). Use `pollWithTimeout`, `awaitWithTimeout`, or `BackgroundJob.wait`.
