import { Cause, Effect, Ref } from "effect"
import type { Interface as ConfigService } from "../config/service.js"
import type { Interface as Storage, StorageError } from "../storage/service.js"
import type { CheckinPeer, MeshSessionSnapshot, MeshStatus, PlanDefinition, SubagentMessage, SubagentReviewRequest } from "./types.js"
import { makeMessagesRepo } from "./messages-repo.js"
import { makePlansRepo } from "./plans-repo.js"
import { makeReviewsRepo } from "./review-repo.js"
import {
  readLimits,
  subagentLimitDecision,
  validateMaxSubagents,
  type LimitsConfigSnapshot,
  type LimitsState,
  type MaxValidation,
} from "./limits.js"
import { buildStatus, descendantsOf, rootOf, withoutKilled, type LiveState } from "./status.js"
import type { SessionPort } from "./session-port.js"
import { dispatchReview as runDispatchReview, formatReviewPrompt } from "./review.js"

export type MeshSnapshotMap = ReadonlyMap<string, MeshSessionSnapshot>

export interface AgentModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

export interface MeshDeps {
  readonly storage: Storage
  readonly config: ConfigService
  readonly sessions: SessionPort
  /** Agent model lookup (v2 `ctx.agent`); used as the first reviewer/swarm model choice. */
  readonly modelForAgent?: (agentID: string) => Effect.Effect<AgentModelRef | undefined>
  readonly now?: () => number
}

export interface ReviewSpec {
  readonly targetAgent: "reviewer"
  readonly diff?: string
  readonly description?: string
  readonly paths?: readonly string[]
  readonly priority?: "low" | "normal" | "high"
  readonly reason?: string
}

export interface PublishInput {
  readonly id?: string
  readonly sessionID: string
  readonly toSession?: string
  readonly toAgent?: string
  readonly kind: SubagentMessage["kind"]
  readonly payload: unknown
  readonly createdAt?: number
  /** Idempotent insert-or-fetch (tool path) instead of a full upsert (coordinator path). */
  readonly idempotent: boolean
}

export interface MeshService {
  readonly messages: ReturnType<typeof makeMessagesRepo>
  readonly plans: ReturnType<typeof makePlansRepo>
  readonly reviews: ReturnType<typeof makeReviewsRepo>
  readonly limitsState: Ref.Ref<LimitsState>
  readonly live: Ref.Ref<ReadonlyMap<string, LiveState>>
  /** Sessions killed through `mesh.kill`; hidden from status immediately. */
  readonly killed: Ref.Ref<ReadonlySet<string>>
  readonly limits: () => Effect.Effect<LimitsConfigSnapshot>
  readonly setMaxSubagents: (value: number) => Effect.Effect<MaxValidation & { readonly limits?: LimitsConfigSnapshot }>
  readonly setSwarmMode: (on: boolean) => Effect.Effect<LimitsConfigSnapshot>
  /** Root of the caller's orchestration tree (the shared mailbox id). */
  readonly resolveRoot: (sessionID: string) => Effect.Effect<string>
  readonly modelForAgent: (agentID: string) => Effect.Effect<AgentModelRef | undefined>
  readonly snapshotMap: () => Effect.Effect<MeshSnapshotMap>
  readonly status: (input?: { readonly sessionID?: string; readonly scope?: "root" | "session" }) => Effect.Effect<MeshStatus>
  readonly checkin: (sessionID: string) => Effect.Effect<readonly CheckinPeer[], StorageError>
  readonly publish: (input: PublishInput) => Effect.Effect<{
    readonly id: string
    readonly createdAt: number
    readonly created: boolean
  }, StorageError>
  readonly planFor: (input: {
    readonly parentSessionID: string
    readonly childSessionID?: string
    readonly targetAgent: string
    readonly plan: PlanDefinition
  }) => Effect.Effect<{ readonly planID: string }, StorageError>
  readonly steer: (input: {
    readonly parentSessionID: string
    /** Steers every descendant of this agent (v1 mailbox behavior). */
    readonly targetAgent?: string
    /** Steers exactly this session; the dialog uses this so one child does not steer its siblings. */
    readonly targetSessionID?: string
    readonly instruction: string
    readonly priority?: "low" | "normal" | "high"
  }) => Effect.Effect<{ readonly delivered: number }, StorageError>
  readonly kill: (input: {
    readonly parentSessionID: string
    /** Kills every descendant of this agent (v1 mailbox behavior). */
    readonly targetAgent?: string
    /** Kills exactly this session; the dialog uses this so one child does not take its siblings. */
    readonly targetSessionID?: string
    readonly reason: string
  }) => Effect.Effect<{ readonly killed: number }, StorageError>
  readonly queueReview: (input: {
    readonly parentSessionID: string
    readonly reviewSpec: ReviewSpec
  }) => Effect.Effect<{ readonly reviewID: string; readonly status: "dispatched" }, Error | StorageError>
  readonly dispatchReview: (request: SubagentReviewRequest) => Effect.Effect<void>
  readonly recoverReviews: () => Effect.Effect<number, StorageError>
}

const uuid = () => crypto.randomUUID()

export const makeMesh = (deps: MeshDeps): Effect.Effect<MeshService> =>
  Effect.gen(function* () {
    const now = deps.now ?? Date.now
    const messages = makeMessagesRepo(deps.storage)
    const plans = makePlansRepo(deps.storage)
    const reviews = makeReviewsRepo(deps.storage)
    const limitsState = yield* Ref.make<LimitsState>({})
    const live = yield* Ref.make<ReadonlyMap<string, LiveState>>(new Map())
    // Kills are durable `kill` messages, so a restarted plugin still reports the
    // child as finished instead of resurrecting it from the session list.
    const persistedKilled = yield* messages
      .killedSessions()
      .pipe(Effect.catchCause(() => Effect.succeed([] as readonly string[])))
    const killed = yield* Ref.make<ReadonlySet<string>>(new Set(persistedKilled))
    const modelForAgent = deps.modelForAgent ?? (() => Effect.succeed(undefined))

    const limits = () =>
      Effect.gen(function* () {
        const state = yield* Ref.get(limitsState)
        const loaded = yield* deps.config.get()
        return readLimits(loaded.config, state)
      })

    const snapshotMap = () =>
      deps.sessions.list(200).pipe(
        Effect.map((sessions) => {
          const map = new Map<string, MeshSessionSnapshot>()
          for (const session of sessions) map.set(session.sessionID, session)
          return map as MeshSnapshotMap
        }),
      )

    const resolveRoot = (sessionID: string) =>
      Effect.gen(function* () {
        const start = yield* deps.sessions.get(sessionID)
        if (start === undefined) return sessionID
        let current: MeshSessionSnapshot = start
        const seen = new Set<string>()
        while (current.parentID !== undefined) {
          if (seen.has(current.sessionID)) break
          seen.add(current.sessionID)
          const parent = yield* deps.sessions.get(current.parentID)
          if (parent === undefined) break
          current = parent
        }
        return current.sessionID
      })

    const publish: MeshService["publish"] = (input) =>
      Effect.gen(function* () {
        const root = yield* resolveRoot(input.sessionID)
        const createdAt = input.createdAt ?? now()
        const caller = yield* deps.sessions.get(input.sessionID)
        const message: SubagentMessage = {
          id: input.id ?? uuid(),
          parentSessionID: root,
          fromSession: input.sessionID,
          fromAgent: caller?.agent ?? "unknown",
          ...(input.toSession === undefined ? {} : { toSession: input.toSession }),
          ...(input.toAgent === undefined ? {} : { toAgent: input.toAgent }),
          kind: input.kind,
          payload: input.payload,
          createdAt,
        }
        if (input.idempotent) return yield* messages.publishOrFetch(message)
        yield* messages.put(message)
        return { id: message.id, createdAt, created: true }
      })

    const status: MeshService["status"] = (input) =>
      Effect.gen(function* () {
        const map = withoutKilled(yield* snapshotMap(), yield* Ref.get(killed))
        const states = yield* Ref.get(live)
        const target =
          input?.sessionID === undefined
            ? undefined
            : input.scope === "session"
              ? input.sessionID
              : (rootOf(map, input.sessionID) ?? input.sessionID)
        return { ...buildStatus(map, states, target), killed: [...(yield* Ref.get(killed))] }
      })

    const checkin: MeshService["checkin"] = (sessionID) =>
      Effect.gen(function* () {
        const root = yield* resolveRoot(sessionID)
        const map = yield* snapshotMap()
        const peers = descendantsOf(map, root)
        const sent = yield* messages.listByParent(root)
        const checkpoints = new Map<string, { summary: string; todos: unknown }>()
        // Rows are ordered oldest first, so the last checkpoint per sender wins.
        for (const message of sent) {
          if (message.kind !== "checkpoint") continue
          const payload = message.payload as { summary?: unknown; todos?: unknown } | null
          if (payload === null || typeof payload?.summary !== "string") continue
          checkpoints.set(message.fromSession, { summary: payload.summary, todos: payload.todos })
        }
        return peers.map((peer) => {
          const checkpoint = checkpoints.get(peer.sessionID)
          return {
            agent: peer.agent ?? "subagent",
            sessionID: peer.sessionID,
            lastSeenAt: peer.updatedAt,
            ...(checkpoint === undefined ? {} : { lastCheckpoint: checkpoint }),
          }
        })
      })

    const planFor: MeshService["planFor"] = (input) =>
      Effect.gen(function* () {
        const planID = uuid()
        const createdAt = now()
        yield* plans.put({
          id: planID,
          parentSessionID: input.parentSessionID,
          agent: input.targetAgent,
          sessionID: input.childSessionID ?? input.parentSessionID,
          title: input.plan.title,
          steps: [...input.plan.steps],
          exitCriteria: input.plan.exitCriteria,
          status: "active",
          createdAt,
          updatedAt: createdAt,
        })
        yield* messages.put({
          id: uuid(),
          parentSessionID: yield* resolveRoot(input.parentSessionID),
          fromSession: input.parentSessionID,
          fromAgent: "orchestrator",
          toAgent: input.targetAgent,
          kind: "plan",
          planID,
          payload: { planID, ...input.plan },
          createdAt,
          // The plan row above is the durable artifact; the raw copy is a
          // notification for live subscribers, not mailbox traffic.
          deliveredAt: createdAt,
        })
        return { planID }
      })

    const targetSessions = (
      root: string,
      parentSessionID: string,
      target: { readonly agent?: string; readonly sessionID?: string },
    ) =>
      snapshotMap().pipe(
        Effect.map((map) =>
          descendantsOf(map, root).filter(
            (session) =>
              session.sessionID !== parentSessionID &&
              (target.sessionID === undefined ? session.agent === target.agent : session.sessionID === target.sessionID),
          ),
        ),
      )

    const steer: MeshService["steer"] = (input) =>
      Effect.gen(function* () {
        const root = yield* resolveRoot(input.parentSessionID)
        const createdAt = now()
        // Killed sessions are finished for good (durable kill row, hidden from
        // status), so a steer must not revive one.
        const gone = yield* Ref.get(killed)
        const targets = (
          yield* targetSessions(root, input.parentSessionID, {
            ...(input.targetAgent === undefined ? {} : { agent: input.targetAgent }),
            ...(input.targetSessionID === undefined ? {} : { sessionID: input.targetSessionID }),
          })
        ).filter((target) => !gone.has(target.sessionID))
        // Address each row with `toSession` (like kill) so a session-ID steer
        // lands in exactly one mailbox; the agent-name path keeps a single
        // unaddressed note when no descendant matched.
        const messageTargets: ReadonlyArray<MeshSessionSnapshot | undefined> =
          targets.length > 0 ? targets : input.targetSessionID === undefined ? [undefined] : []
        yield* Effect.forEach(
          messageTargets,
          (target) =>
            messages.put({
              id: uuid(),
              parentSessionID: root,
              fromSession: input.parentSessionID,
              fromAgent: "orchestrator",
              ...(target === undefined ? {} : { toSession: target.sessionID }),
              toAgent: target?.agent ?? input.targetAgent ?? input.targetSessionID ?? "subagent",
              kind: "steer",
              payload: { instruction: input.instruction, priority: input.priority },
              createdAt,
              deliveredAt: createdAt,
            }),
          { discard: true },
        )
        // `prompt` without `resume: false` wakes the session: an idle, done or
        // failed child starts a new turn instead of leaving the steer in its inbox.
        yield* Effect.forEach(
          targets,
          (target) =>
            deps.sessions
              .prompt({
                sessionID: target.sessionID,
                text: `[mesh steer]\n${input.instruction}`,
                delivery: "steer",
              })
              .pipe(Effect.catchCause(() => Effect.void)),
          { discard: true },
        )
        return { delivered: targets.length }
      })

    const kill: MeshService["kill"] = (input) =>
      Effect.gen(function* () {
        const root = yield* resolveRoot(input.parentSessionID)
        const createdAt = now()
        const targets = yield* targetSessions(root, input.parentSessionID, {
          ...(input.targetAgent === undefined ? {} : { agent: input.targetAgent }),
          ...(input.targetSessionID === undefined ? {} : { sessionID: input.targetSessionID }),
        })
        // One durable kill row per target keeps the killed set after a restart.
        // The agent-name path also records the mailbox signal when nothing matched.
        const messageTargets: ReadonlyArray<MeshSessionSnapshot | undefined> =
          targets.length > 0 ? targets : input.targetSessionID === undefined ? [undefined] : []
        yield* Effect.forEach(
          messageTargets,
          (target) =>
            messages.put({
              id: uuid(),
              parentSessionID: root,
              fromSession: input.parentSessionID,
              fromAgent: "orchestrator",
              ...(target === undefined ? {} : { toSession: target.sessionID }),
              toAgent: target?.agent ?? input.targetAgent ?? input.targetSessionID ?? "subagent",
              kind: "kill",
              payload: { reason: input.reason },
              createdAt,
              deliveredAt: createdAt,
            }),
          { discard: true },
        )
        yield* Ref.update(killed, (current) => {
          const next = new Set(current)
          for (const target of targets) next.add(target.sessionID)
          return next
        })
        yield* Effect.forEach(
          targets,
          (target) => deps.sessions.interrupt(target.sessionID).pipe(Effect.catchCause(() => Effect.void)),
          { discard: true },
        )
        return { killed: targets.length }
      })

    const queueReview: MeshService["queueReview"] = (input) =>
      Effect.gen(function* () {
        const root = yield* resolveRoot(input.parentSessionID)
        const map = yield* snapshotMap()
        const state = yield* Ref.get(limitsState)
        const loaded = yield* deps.config.get()
        const limit = subagentLimitDecision({
          sessions: map,
          live: yield* Ref.get(live),
          sessionID: root,
          maxSubagents: readLimits(loaded.config, state).maxSubagents,
        })
        if (limit.deny) return yield* Effect.fail(new Error(limit.message ?? "Max subagents reached"))
        const reviewID = uuid()
        const createdAt = now()
        const request: SubagentReviewRequest = {
          id: reviewID,
          parentSessionID: root,
          targetAgent: input.reviewSpec.targetAgent,
          diff: input.reviewSpec.diff ?? null,
          description: input.reviewSpec.description ?? null,
          paths: input.reviewSpec.paths === undefined ? null : [...input.reviewSpec.paths],
          priority: input.reviewSpec.priority ?? null,
          reason: input.reviewSpec.reason ?? null,
          status: "pending",
          createdAt,
          updatedAt: createdAt,
          result: null,
        }
        yield* reviews.put(request)
        yield* messages.put({
          id: uuid(),
          parentSessionID: root,
          fromSession: input.parentSessionID,
          fromAgent: "orchestrator",
          toAgent: input.reviewSpec.targetAgent,
          kind: "review",
          reviewID,
          payload: { reviewID, ...input.reviewSpec },
          createdAt,
          deliveredAt: createdAt,
        })
        return { reviewID, status: "dispatched" as const }
      })

    const dispatchReview: MeshService["dispatchReview"] = (request) =>
      runDispatchReview({
        sessions: deps.sessions,
        reviews,
        modelForAgent,
        evaluatorModel: () =>
          deps.config.get().pipe(Effect.map((loaded) => loaded.config.banyancode_goal_evaluator_model)),
      })(request).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("mesh: review dispatch failed", { reviewID: request.id, cause: Cause.pretty(cause) }).pipe(
            Effect.andThen(reviews.markFailed({ id: request.id, result: { error: Cause.pretty(cause) } })),
            Effect.ignore,
          ),
        ),
      )

    const recoverReviews: MeshService["recoverReviews"] = () =>
      Effect.gen(function* () {
        const pending = yield* reviews.listPending()
        let dispatched = 0
        for (const request of pending) {
          const parent = yield* deps.sessions.get(request.parentSessionID)
          if (parent === undefined) {
            yield* reviews.markFailed({
              id: request.id,
              result: { error: `parent session not found: ${request.parentSessionID}` },
            })
            continue
          }
          yield* Effect.forkDetach(dispatchReview(request))
          dispatched++
        }
        return dispatched
      })

    const setMaxSubagents: MeshService["setMaxSubagents"] = (value) =>
      Effect.gen(function* () {
        const validation = validateMaxSubagents(value)
        if (!validation.ok) return validation
        yield* Ref.update(limitsState, (state) => ({ ...state, maxSubagents: validation.value }))
        return { ...validation, limits: yield* limits() }
      })

    const setSwarmMode: MeshService["setSwarmMode"] = (on) =>
      Effect.gen(function* () {
        yield* Ref.update(limitsState, (state) => ({ ...state, swarmMode: on }))
        return yield* limits()
      })

    return {
      messages,
      plans,
      reviews,
      limitsState,
      live,
      killed,
      limits,
      setMaxSubagents,
      setSwarmMode,
      resolveRoot,
      modelForAgent,
      snapshotMap,
      status,
      checkin,
      publish,
      planFor,
      steer,
      kill,
      queueReview,
      dispatchReview,
      recoverReviews,
    }
  })

export { formatReviewPrompt }
