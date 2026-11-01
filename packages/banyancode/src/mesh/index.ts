import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Cause, Effect, Option, Ref, Stream, type Scope } from "effect"
import type { Interface as ConfigInterface } from "../config/service.js"
import type { Interface as StorageInterface } from "../storage/service.js"
import { checkGoalCommand, registerCommands } from "./commands.js"
import { applySubagentPermissionDecision, subagentToolGuard, type NestedBudgetEntry } from "./limits.js"
import { makeMesh } from "./service.js"
import type { SessionPort } from "./session-port.js"
import { pluginSessionPort } from "./session-port.js"
import { makeSharedMemoryTool } from "./shared-memory.js"
import { buildMeshTools } from "./tools.js"
import { Definition, handlers } from "./rpc.js"
import { removeSnapshot, rootOf, treeFor, upsertSnapshot, type LiveState } from "./status.js"
import type { MeshSessionSnapshot } from "./types.js"

export { Definition as MeshRpcDefinition, handlers as meshRpcHandlers } from "./rpc.js"
export { makeMesh } from "./service.js"
export type { MeshService, PublishInput, ReviewSpec } from "./service.js"
export { makeMessagesRepo } from "./messages-repo.js"
export { makePlansRepo } from "./plans-repo.js"
export { makeReviewsRepo } from "./review-repo.js"
export { MESH_TOOL_NAMES, buildMeshTools } from "./tools.js"
export { parseSwarmCommand, SWARM_COMMAND, MAX_SUBAGENTS_COMMAND } from "./commands.js"
export {
  DEFAULT_MAX_SUBAGENTS,
  MAX_SUBAGENTS_LIMIT,
  MAX_NESTED_EXPLORE_PER_CODER,
  MAX_NESTED_EXPLORE_LIFETIME_PER_CODER,
  subagentLimitDecision,
  subagentToolGuard,
  validateMaxSubagents,
} from "./limits.js"
export { buildForest, buildStatus, countRunningDescendants, stateOf, treeFor } from "./status.js"
export type { MeshNode, MeshSessionSnapshot, MeshStatus, SubagentMessage, SubagentPlan, SubagentReviewRequest } from "./types.js"
export { AGENT } from "./types.js"

export interface MeshDeps {
  readonly storage: StorageInterface
  readonly config: ConfigInterface
}

const SUBAGENT_TOOL = "subagent"
const DEBUG_MESH = process.env.BANYANCODE_DEBUG === "mesh"

const SESSION_EVENT_TYPES = [
  "session.created",
  "session.deleted",
  "session.status",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.usage.updated",
  "session.renamed",
  "session.agent.selected",
  "session.model.selected",
  "session.step.ended",
] as const

/** Reads a tool-hook input record without trusting its shape. */
const inputRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/**
 * Register the mesh/orchestrator on v2's plugin API.
 *
 * Everything is owned by the plugin scope: tool transforms, the permission and
 * tool hooks, the RPC registration, the session-event subscription and the
 * command transforms all dispose when the host deactivates the plugin.
 */
export const register = (ctx: Context, deps: MeshDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const sessions: SessionPort = pluginSessionPort(ctx.session)
    const modelForAgent = (agentID: string) =>
      ctx.agent.get({ agentID: agentID as never }).pipe(
        Effect.option,
        Effect.map((result) =>
          Option.isNone(result) || result.value.data.model === undefined
            ? undefined
            : {
                providerID: result.value.data.model.providerID,
                id: result.value.data.model.id,
                ...(result.value.data.model.variant === undefined
                  ? {}
                  : { variant: result.value.data.model.variant }),
              },
        ),
      )
    const mesh = yield* makeMesh({ storage: deps.storage, config: deps.config, sessions, modelForAgent })

    // ── tools ──────────────────────────────────────────────────────────────
    const tools = [
      ...buildMeshTools({ ctx, mesh, sessions }),
      makeSharedMemoryTool({ ctx, sessions, projectID: ctx.location.project.id }),
    ]
    yield* ctx.tool
      .transform((editor) => {
        editor.namespace({
          name: "banyan",
          description: "BanyanCode repository intelligence, verification and orchestration tools.",
        })
        for (const tool of tools) editor.add(tool)
      })
      .pipe(Effect.orDie)

    // ── limit enforcement: permission gate (max subagents) ─────────────────
    // The v2 subagent tool asserts `subagent` permission for follow-ups too,
    // and the permission event carries no sessionID/input. `execute.before`
    // therefore marks fresh-spawn call ids; the permission hook enforces the
    // breadth cap only for those, so continuing a child is never blocked.
    const freshSpawnCalls = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.gen(function* () {
        if (event.action !== SUBAGENT_TOOL || event.effect === "deny") return
        const source = event.source
        if (source?.type !== "tool") return
        const marked = (yield* Ref.get(freshSpawnCalls)).get(source.id)
        if (marked === undefined) return
        yield* Ref.update(freshSpawnCalls, (current) => {
          const next = new Map(current)
          next.delete(source.id)
          return next
        })
        const map = yield* mesh.snapshotMap()
        const live = yield* Ref.get(mesh.live)
        const limits = yield* mesh.limits()
        applySubagentPermissionDecision(event, {
          sessions: map,
          live,
          maxSubagents: limits.maxSubagents,
        })
      }).pipe(Effect.catchCause(() => Effect.void)),
    )

    // ── limit enforcement: tool gate (background + nested budget + max) ────
    const nestedBudget = yield* Ref.make<ReadonlyMap<string, NestedBudgetEntry>>(new Map())
    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        if (event.tool !== SUBAGENT_TOOL) return
        const input = inputRecord(event.input)
        if (input === undefined) return
        const targetAgent = typeof input.agent === "string" ? input.agent : undefined
        if (targetAgent === undefined) return
        const map = yield* mesh.snapshotMap()
        const live = yield* Ref.get(mesh.live)
        const limits = yield* mesh.limits()
        const nested = (yield* Ref.get(nestedBudget)).get(event.sessionID)
        const followUp =
          typeof input.sessionID === "string" && input.sessionID.length > 0 ? input.sessionID : undefined
        const decision = subagentToolGuard({
          tool: event.tool,
          callerSessionID: event.sessionID,
          callerAgent: event.agent,
          targetAgent,
          followUpSessionID: followUp,
          background: input.background === true,
          backgroundEnabled: limits.backgroundSubagents,
          sessions: map,
          live,
          maxSubagents: limits.maxSubagents,
          nestedEntry: nested,
          now: Date.now(),
        })
        if (DEBUG_MESH) {
          yield* Effect.logDebug("mesh.subagent.guard", {
            sessionID: event.sessionID,
            callerAgent: event.agent,
            targetAgent,
            nested: nested?.lifetimeCount ?? 0,
            deny: decision.deny,
          })
        }
        if (decision.deny) {
          return yield* Effect.fail(new Tool.Error({ message: decision.message ?? "Subagent spawn denied" }))
        }
        if (decision.nested !== undefined) {
          yield* Ref.update(nestedBudget, (current) => {
            const next = new Map(current)
            next.set(event.sessionID, decision.nested!)
            return next
          })
        }
        if (followUp === undefined) {
          yield* Ref.update(freshSpawnCalls, (current) => {
            const now = Date.now()
            const next = new Map([...current].filter(([, at]) => now - at < 60_000))
            next.set(event.id, now)
            return next
          })
        }
      }),
    )

    // ── RPC + status events ────────────────────────────────────────────────
    const rpc = yield* ctx.rpc
      .register(
        Definition,
        handlers({
          mesh,
          // v1 `banyancode.mesh.background` is the host's session.background route in v2.
          background: (sessionID) =>
            ctx.session
              .background({ sessionID: sessionID as never })
              .pipe(Effect.orDie, Effect.asVoid),
        }),
      )
      .pipe(Effect.orDie)
    const cache = yield* Ref.make<ReadonlyMap<string, MeshSessionSnapshot>>(new Map())

    yield* ctx.event
      .subscribe({ types: [...SESSION_EVENT_TYPES] })
      .pipe(
        Stream.runForEach((event) => {
          const type = event.type
          if (!type.startsWith("session.")) return Effect.void
          const sessionID = (event.data as { sessionID?: unknown }).sessionID
          if (typeof sessionID !== "string") return Effect.void
          const handler = Effect.gen(function* () {
            const current = yield* Ref.get(cache)
            if (type === "session.deleted") {
              const root = rootOf(current, sessionID) ?? sessionID
              const next = removeSnapshot(current, sessionID)
              yield* Ref.set(cache, next)
              yield* emitStatus(rpc, next, root, yield* Ref.get(mesh.live))
              return
            }
            if (type === "session.status") {
              const status = (event.data as { status?: { type?: unknown } }).status?.type
              if (status === "busy" || status === "idle" || status === "retry") {
                yield* Ref.update(mesh.live, (live) => {
                  const next = new Map(live)
                  next.set(sessionID, status)
                  return next
                })
              }
            } else if (type === "session.execution.started") {
              yield* Ref.update(mesh.live, (live) => {
                const next = new Map(live)
                next.set(sessionID, "busy")
                return next
              })
            } else if (
              type === "session.execution.succeeded" ||
              type === "session.execution.failed" ||
              type === "session.execution.interrupted"
            ) {
              yield* Ref.update(mesh.live, (live) => {
                const next = new Map(live)
                next.set(sessionID, "idle")
                return next
              })
            }
            const snapshot = yield* sessions.get(sessionID)
            if (snapshot === undefined) return
            const next = upsertSnapshot(yield* Ref.get(cache), snapshot)
            yield* Ref.set(cache, next)
            yield* emitStatus(rpc, next, rootOf(next, sessionID) ?? sessionID, yield* Ref.get(mesh.live))
          })
          return handler.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("mesh: status event handling failed", {
                    type,
                    sessionID,
                    cause: Cause.pretty(cause),
                  }),
            ),
          )
        }),
        Effect.forkScoped({ startImmediately: true }),
      )

    // Seed the cache so the first event can resolve a root without a fresh list.
    yield* Effect.gen(function* () {
      const existing = yield* Ref.get(cache)
      if (existing.size > 0) return
      const listed = yield* sessions.list(200)
      const seeded = new Map(existing)
      for (const session of listed) seeded.set(session.sessionID, session)
      yield* Ref.set(cache, seeded)
    }).pipe(Effect.catchCause(() => Effect.void))

    // ── commands (/swarm, /max-subagents; /goal stays with v2 GoalPlugin) ──
    yield* registerCommands(ctx, { mesh, sessions })
    yield* checkGoalCommand(ctx)

    // ── crash recovery for queued review requests ──────────────────────────
    yield* Effect.forkDetach(mesh.recoverReviews())
  })

const emitStatus = (
  rpc: import("@opencode/plugin/effect/rpc").RpcRegistration<typeof Definition>,
  cache: ReadonlyMap<string, MeshSessionSnapshot>,
  rootSessionID: string,
  live: ReadonlyMap<string, LiveState>,
) =>
  Effect.gen(function* () {
    const tree = treeFor(cache, rootSessionID, live)
    if (tree === undefined) return
    yield* rpc.events.emit("status.updated", { rootSessionID, tree })
  }).pipe(Effect.catchCause(() => Effect.void))
