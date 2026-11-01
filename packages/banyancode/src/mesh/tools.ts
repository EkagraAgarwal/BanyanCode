import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { descendantsOf, flattenTree } from "./status.js"
import type { MeshService, ReviewSpec } from "./service.js"
import type { SessionPort } from "./session-port.js"
import { idempotencyKeyFor } from "./payload.js"
import { MESSAGE_KINDS, type PlanDefinition, type PlanStepStatus, type SubagentMessage } from "./types.js"

/**
 * LLM-facing mesh tools. IDs, parameters and descriptions are copied from v1
 * (`packages/core/src/tool/mesh-*.ts`, `subagent-message.ts`) so agents see the
 * same surface after the re-platform.
 */

const permission = (
  ctx: Context,
  input: {
    readonly action: string
    readonly resources: readonly string[]
    readonly metadata: Record<string, unknown>
    readonly context: Tool.Context
  },
) =>
  ctx.permission.assert({
    action: input.action,
    resources: [...input.resources],
    save: ["*"],
    metadata: input.metadata,
    sessionID: input.context.sessionID,
    agent: input.context.agent,
    source: { type: "tool", messageID: input.context.messageID, id: input.context.id },
  })

const fail = (message: string) => new Tool.Error({ message })

// ── subagent_message ────────────────────────────────────────────────────────

export const SubagentMessageInput = Schema.Struct({
  to: Schema.optional(Schema.String),
  kind: Schema.Literals(["request", "inform", "answer", "poll", "steer", "checkpoint", "plan", "kill"]),
  payload: Schema.Unknown,
  idempotencyKey: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Number),
})

export const SubagentMessageOutput = Schema.Struct({
  delivered: Schema.Boolean,
  pending: Schema.Number,
  idempotencyKey: Schema.String,
  createdAt: Schema.Number,
})

const planFromPayload = (payload: unknown): PlanDefinition | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined
  const value = payload as Record<string, unknown>
  if (typeof value.title !== "string" || !Array.isArray(value.steps) || typeof value.exitCriteria !== "string") {
    return undefined
  }
  const steps = value.steps.flatMap((step) => {
    if (typeof step !== "object" || step === null) return []
    const item = step as Record<string, unknown>
    if (typeof item.content !== "string") return []
    const status = item.status
    if (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "cancelled") return []
    return [{ content: item.content, status: status as PlanStepStatus }]
  })
  return { title: value.title, steps, exitCriteria: value.exitCriteria }
}

const targetSession = (mesh: MeshService, root: string, agent: string) =>
  mesh.snapshotMap().pipe(
    Effect.map((map) => descendantsOf(map, root).filter((session) => session.agent === agent)),
  )

const makeSubagentMessageTool = (deps: {
  readonly ctx: Context
  readonly mesh: MeshService
  readonly sessions: SessionPort
}): Tool.Info<typeof SubagentMessageInput, typeof SubagentMessageOutput> => ({
  name: "subagent_message",
  description:
    `Send a message to a peer subagent or the orchestrator. Kinds:
- "request" — ask a peer to perform an action. payload: { action: string, ...args }
- "inform" — notify a peer of something. payload: { ... }
- "answer" — respond to a request. payload: { result: any }
- "poll" — check peer status. payload: {}
- "steer" — orchestrator injects an instruction into a subagent's current plan. payload: { instruction: string, priority?: "low"|"normal"|"high" }
- "checkpoint" — subagent reports its current state. payload: { summary: string, todos: Array<{content, status}>, blockers?: string[] }
- "plan" — orchestrator hands a subagent its initial plan at spawn time. payload: { title: string, steps: Array<{content, status}>, exitCriteria: string }
- "kill" — orchestrator terminates a subagent gracefully. payload: { reason: string }

Retry contract: if this tool is called again with the same \`idempotencyKey\` (and
\`createdAt\` if it was set on the first call), the server returns the original
\`id\` and \`createdAt\` without creating a duplicate row. If \`idempotencyKey\` is
omitted, the tool derives a STABLE fallback key from the message content
(sessionID, kind, to, payload), so retries of the same logical message
deduplicate even with a fresh tool call id. For any retry, you MUST echo back both
\`idempotencyKey\` and \`createdAt\` from the first call's response.`,
  input: SubagentMessageInput,
  output: SubagentMessageOutput,
  options: { permission: "subagent_message" },
  execute: (input, context) =>
    Effect.gen(function* () {
      yield* permission(deps.ctx, {
        action: "subagent_message",
        resources: [input.kind],
        metadata: input,
        context,
      })

      const idempotencyKey =
        input.idempotencyKey ??
        idempotencyKeyFor({
          sessionID: context.sessionID,
          kind: input.kind,
          to: input.to,
          payload: input.payload,
        })
      const createdAt = input.createdAt ?? Date.now()
      const result = yield* deps.mesh.publish({
        id: idempotencyKey,
        sessionID: context.sessionID,
        ...(input.to === undefined ? {} : { toAgent: input.to }),
        kind: input.kind,
        payload: input.payload,
        createdAt,
        idempotent: true,
      })
      const root = yield* deps.mesh.resolveRoot(context.sessionID)

      // Kinds that represent work rather than mailbox traffic are executed
      // here and marked delivered; the mailbox keeps only peer notes.
      if (input.kind === "plan") {
        const plan = planFromPayload(input.payload)
        if (plan !== undefined) {
          const target = input.to === undefined ? [] : yield* targetSession(deps.mesh, root, input.to)
          const planID =
            typeof (input.payload as { planID?: unknown })?.planID === "string"
              ? ((input.payload as { planID: string }).planID)
              : result.id
          const now = Date.now()
          yield* deps.mesh.plans.put({
            id: planID,
            parentSessionID: root,
            agent: input.to ?? context.agent,
            sessionID: target[0]?.sessionID ?? context.sessionID,
            title: plan.title,
            steps: plan.steps,
            exitCriteria: plan.exitCriteria,
            status: "active",
            createdAt: now,
            updatedAt: now,
          })
        }
        yield* deps.mesh.messages.markDelivered(result.id, Date.now())
      }

      if (input.kind === "steer" && input.to !== undefined) {
        const payload = input.payload as { instruction?: unknown; priority?: unknown } | null
        if (typeof payload?.instruction !== "string") {
          return yield* Effect.fail(fail("steer payload requires instruction"))
        }
        const targets = (yield* targetSession(deps.mesh, root, input.to)).filter(
          (target) => target.sessionID !== context.sessionID,
        )
        yield* Effect.forEach(
          targets,
          (target) =>
            deps.sessions
              .prompt({
                sessionID: target.sessionID,
                text: `[mesh steer]\n${payload.instruction as string}`,
                delivery: "steer",
              })
              .pipe(Effect.catchCause(() => Effect.void)),
          { discard: true },
        )
      }

      if (input.kind === "kill" && input.to !== undefined) {
        const targets = (yield* targetSession(deps.mesh, root, input.to)).filter(
          (target) => target.sessionID !== context.sessionID,
        )
        yield* Effect.forEach(
          targets,
          (target) => deps.sessions.interrupt(target.sessionID).pipe(Effect.catchCause(() => Effect.void)),
          { discard: true },
        )
      }

      // Steer/kill are executed above (directly or as an unaddressed mailbox
      // note); either way they are not peer traffic and must not stay pending.
      if (input.kind === "steer" || input.kind === "kill") {
        yield* deps.mesh.messages.markDelivered(result.id, Date.now())
      }

      const pending = yield* deps.mesh.messages.countPending(root)
      const output = { delivered: true, pending, idempotencyKey: result.id, createdAt: result.createdAt }
      return {
        output,
        content: `delivered=${output.delivered}, pending=${output.pending}, idempotencyKey=${output.idempotencyKey}`,
      }
    }).pipe(
      Effect.mapError((error) => (error instanceof Tool.Error ? error : fail("subagent_message failed"))),
    ),
})

// ── mesh_control ────────────────────────────────────────────────────────────

export const MeshControlInput = Schema.Struct({
  action: Schema.Literals(["checkin", "steer", "kill", "plan_for", "review"]),
  targetAgent: Schema.optional(Schema.String),
  instruction: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.Literals(["low", "normal", "high"])),
  reason: Schema.optional(Schema.String),
  plan: Schema.optional(
    Schema.Struct({
      title: Schema.String,
      steps: Schema.Array(
        Schema.Struct({
          content: Schema.String,
          status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]),
        }),
      ),
      exitCriteria: Schema.String,
    }),
  ),
  reviewSpec: Schema.optional(
    Schema.Struct({
      targetAgent: Schema.Literals(["reviewer"]),
      diff: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
      paths: Schema.optional(Schema.Array(Schema.String)),
      priority: Schema.optional(Schema.Literals(["low", "normal", "high"])),
      reason: Schema.optional(Schema.String),
    }),
  ),
})

export const MeshControlOutput = Schema.Struct({
  result: Schema.Unknown,
})

const makeMeshControlTool = (deps: {
  readonly ctx: Context
  readonly mesh: MeshService
}): Tool.Info<typeof MeshControlInput, typeof MeshControlOutput> => ({
  name: "mesh_control",
  description:
    "Control subagents in the orchestrator's mesh. Actions: checkin (get status of all subagents), steer (inject an instruction into a subagent's current plan), kill (terminate a subagent gracefully), plan_for (hand a subagent its initial plan), review (dispatch the reviewer subagent with paths/description/reason — returns reviewID).",
  input: MeshControlInput,
  output: MeshControlOutput,
  options: { permission: "mesh_control" },
  execute: (input, context) =>
    Effect.gen(function* () {
      yield* permission(deps.ctx, { action: "mesh_control", resources: ["*"], metadata: input, context })

      switch (input.action) {
        case "checkin": {
          return { output: { result: yield* deps.mesh.checkin(context.sessionID) }, content: "mesh checkin" }
        }
        case "steer": {
          if (input.targetAgent === undefined) return yield* Effect.fail(fail("targetAgent is required for steer"))
          if (input.instruction === undefined) return yield* Effect.fail(fail("instruction is required for steer"))
          yield* deps.mesh.steer({
            parentSessionID: context.sessionID,
            targetAgent: input.targetAgent,
            instruction: input.instruction,
            ...(input.priority === undefined ? {} : { priority: input.priority }),
          })
          return { output: { result: `steered ${input.targetAgent}` }, content: `steered ${input.targetAgent}` }
        }
        case "kill": {
          if (input.targetAgent === undefined) return yield* Effect.fail(fail("targetAgent is required for kill"))
          if (input.reason === undefined) return yield* Effect.fail(fail("reason is required for kill"))
          yield* deps.mesh.kill({
            parentSessionID: context.sessionID,
            targetAgent: input.targetAgent,
            reason: input.reason,
          })
          return { output: { result: `killed ${input.targetAgent}` }, content: `killed ${input.targetAgent}` }
        }
        case "plan_for": {
          if (input.targetAgent === undefined) return yield* Effect.fail(fail("targetAgent is required for plan_for"))
          if (input.plan === undefined) return yield* Effect.fail(fail("plan is required for plan_for"))
          yield* deps.mesh.planFor({
            parentSessionID: context.sessionID,
            targetAgent: input.targetAgent,
            plan: {
              title: input.plan.title,
              steps: input.plan.steps.map((step) => ({ content: step.content, status: step.status })),
              exitCriteria: input.plan.exitCriteria,
            },
          })
          return {
            output: { result: `planned for ${input.targetAgent}` },
            content: `planned for ${input.targetAgent}`,
          }
        }
        case "review": {
          if (input.reviewSpec === undefined) return yield* Effect.fail(fail("reviewSpec is required for review"))
          // The reviewer runs in a normal v2 subagent session, so it passes
          // through the same `subagent` permission action every child spawn does.
          yield* permission(deps.ctx, {
            action: "subagent",
            resources: [input.reviewSpec.targetAgent],
            metadata: input.reviewSpec,
            context,
          })
          const review = yield* deps.mesh
            .queueReview({
              parentSessionID: context.sessionID,
              reviewSpec: input.reviewSpec as ReviewSpec,
            })
            .pipe(
              Effect.mapError((error) =>
                error instanceof Tool.Error ? error : fail(error instanceof Error ? error.message : String(error)),
              ),
            )
          const request = yield* deps.mesh.reviews.getByID(review.reviewID)
          if (request !== undefined) yield* Effect.forkDetach(deps.mesh.dispatchReview(request))
          return { output: { result: review }, content: JSON.stringify(review) }
        }
      }
    }).pipe(Effect.mapError((error) => (error instanceof Tool.Error ? error : fail("mesh_control failed")))),
})

// ── mesh_subscribe ──────────────────────────────────────────────────────────

const SubagentMessageSchema = Schema.Struct({
  id: Schema.String,
  parentSessionID: Schema.String,
  fromSession: Schema.String,
  fromAgent: Schema.String,
  toSession: Schema.optional(Schema.String),
  toAgent: Schema.optional(Schema.String),
  kind: Schema.Literals(MESSAGE_KINDS),
  planID: Schema.optional(Schema.String),
  reviewID: Schema.optional(Schema.String),
  payload: Schema.Unknown,
  deliveredAt: Schema.optional(Schema.Number),
  createdAt: Schema.Number,
})

export const MeshSubscribeInput = Schema.Struct({
  parentSessionID: Schema.String,
  agentName: Schema.optional(Schema.String),
  maxMessages: Schema.optional(Schema.Number),
  timeoutMs: Schema.optional(Schema.Number),
})

export const MeshSubscribeOutput = Schema.Struct({
  messages: Schema.Array(SubagentMessageSchema),
  streamActive: Schema.Boolean,
  timedOut: Schema.optional(Schema.Boolean),
})

const DEFAULT_TIMEOUT_MS = 30_000

const makeMeshSubscribeTool = (deps: {
  readonly ctx: Context
  readonly mesh: MeshService
  readonly sessions: SessionPort
}): Tool.Info<typeof MeshSubscribeInput, typeof MeshSubscribeOutput> => ({
  name: "mesh_subscribe",
  description:
    "Subscribe to peer subagent activity for this parent session. " +
    "Returns the first N messages as an initial batch; the stream " +
    "remains active for the session lifetime. Use this in place of " +
    "polling mesh_control.status to wait for specific subagent results. " +
    "If the parent session does not exist, the tool fails fast with a " +
    "ToolFailure rather than blocking indefinitely.",
  input: MeshSubscribeInput,
  output: MeshSubscribeOutput,
  options: { permission: "mesh_subscribe" },
  execute: (input, context) =>
    Effect.gen(function* () {
      yield* permission(deps.ctx, {
        action: "mesh_subscribe",
        resources: [input.parentSessionID],
        metadata: input,
        context,
      })
      const parent = yield* deps.sessions.get(input.parentSessionID)
      if (parent === undefined) {
        return yield* Effect.fail(fail(`mesh_subscribe: parent session ${input.parentSessionID} not found`))
      }
      const root = yield* deps.mesh.resolveRoot(input.parentSessionID)
      const maxMessages = Math.max(1, Math.trunc(input.maxMessages ?? 10))
      const timeoutMs = Math.max(0, input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const started = Date.now()
      const filter = (message: SubagentMessage) => {
        if (message.fromSession === context.sessionID) return false
        if (input.agentName === undefined) return true
        return message.fromAgent === input.agentName || message.toAgent === input.agentName
      }
      const take = Effect.gen(function* () {
        while (true) {
          const pending = (yield* deps.mesh.messages.listPending(root)).filter(filter)
          if (pending.length > 0) return { messages: pending.slice(0, maxMessages), timedOut: false }
          if (Date.now() - started >= timeoutMs) return { messages: [] as readonly SubagentMessage[], timedOut: true }
          yield* Effect.sleep(100)
        }
      })
      const result = yield* take
      yield* Effect.forEach(
        result.messages,
        (message) => deps.mesh.messages.markDelivered(message.id, Date.now()),
        { discard: true },
      )
      return {
        output: { messages: [...result.messages], streamActive: !result.timedOut, timedOut: result.timedOut },
        content: `messages=${result.messages.length} streamActive=${!result.timedOut}`,
      }
    }).pipe(
      Effect.mapError((error) =>
        error instanceof Tool.Error ? error : fail("mesh_subscribe failed"),
      ),
    ),
})

// ── mesh_status ─────────────────────────────────────────────────────────────

export const MeshStatusInput = Schema.Record(Schema.String, Schema.Unknown).annotate({
  description:
    "Report the subagent mesh state for the current orchestration tree: " +
    "peer agents and their statuses, plus recent peer activity. Read-only " +
    "diagnostic; returns an empty shape when no mesh coordinator is active.",
})

export const MeshStatusOutput = Schema.Struct({
  agents: Schema.Array(
    Schema.Struct({
      agent: Schema.String,
      status: Schema.String,
    }),
  ),
  recentActivity: Schema.Array(
    Schema.Struct({
      at: Schema.Number,
      from: Schema.String,
    }),
  ),
})

const EMPTY_STATUS = { agents: [], recentActivity: [] }

const makeMeshStatusTool = (deps: {
  readonly ctx: Context
  readonly mesh: MeshService
}): Tool.Info<typeof MeshStatusInput, typeof MeshStatusOutput> => ({
  name: "mesh_status",
  description:
    "Use when:\n" +
    "  you need a snapshot of the subagent mesh: which peer agents are " +
    "  active/idle/disconnected for the current orchestration tree and what " +
    "  recent peer activity looks like.\n" +
    "Examples\n" +
    '  - "What\'s the state of the mesh?"\n' +
    '  - "Are any subagents still running?"\n' +
    "Returns\n" +
    "  { agents: [{ agent, status }], recentActivity: [{ at, from }] }\n" +
    "Avoid when\n" +
    "  you need to control subagents — use mesh_control.\n" +
    "Note\n" +
    "  Read-only diagnostic. Never fails: returns an empty shape when no " +
    "  coordinator is active or the status read hiccups.",
  input: MeshStatusInput,
  output: MeshStatusOutput,
  options: { permission: "mesh_status" },
  execute: (_input, context) =>
    Effect.gen(function* () {
      yield* permission(deps.ctx, { action: "mesh_status", resources: ["*"], metadata: {}, context })
      const status = yield* deps.mesh.status({ sessionID: context.sessionID })
      const roots = status.roots.flatMap((node) => flattenTree(node))
      const peers = roots.filter((node) => node.sessionID !== context.sessionID)
      const root = yield* deps.mesh.resolveRoot(context.sessionID)
      const recent = yield* deps.mesh.messages.listByParent(root)
      const cutoff = Date.now() - 5 * 60 * 1000
      return {
        output: {
          agents: peers.map((node) => ({
            agent: node.agent ?? "subagent",
            status:
              node.state === "running" || node.state === "retry"
                ? "active"
                : node.state === "failed" || node.state === "interrupted"
                  ? "failed"
                  : "idle",
          })),
          recentActivity: recent
            .filter((message) => message.createdAt >= cutoff)
            .map((message) => ({ at: message.createdAt, from: message.fromAgent })),
        },
        content: `agents=${peers.length}`,
      }
    }).pipe(
      // Diagnostic tool: never fail (v1 behaviour), including a permission
      // denial — the model gets an empty shape instead of a hard error.
      Effect.catchCause(() => Effect.succeed({ output: EMPTY_STATUS, content: "agents=0" })),
    ),
})

export const buildMeshTools = (deps: {
  readonly ctx: Context
  readonly mesh: MeshService
  readonly sessions: SessionPort
}): readonly Tool.Info[] => [
  makeSubagentMessageTool(deps),
  makeMeshControlTool(deps),
  makeMeshSubscribeTool(deps),
  makeMeshStatusTool(deps),
]

export const MESH_TOOL_NAMES = ["subagent_message", "mesh_control", "mesh_subscribe", "mesh_status"] as const
