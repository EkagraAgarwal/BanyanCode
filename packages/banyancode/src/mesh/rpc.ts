import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import { Rpc } from "@opencode/schema/rpc"
import { Effect, Result, Schema } from "effect"
import { MAX_SUBAGENTS_LIMIT, DEFAULT_MAX_SUBAGENTS, validateMaxSubagents } from "./limits.js"
import type { MeshService } from "./service.js"
import type { MeshNode } from "./types.js"

/**
 * `banyancode.mesh` RPC. Mirrors the v1 HTTP surface:
 *   GET  /global/mesh/status              → status
 *   GET  /session/{sessionID}/mesh        → sessionStatus
 *   POST /experimental/session/{id}/background → background
 *
 * The task contract additionally asks for a `status.updated` event emitted
 * from session events (no polling); the host publishes it under
 * `rpc.banyancode.mesh.status.updated`.
 */

const TokenSchema = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
  cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }),
})

const ModelSchema = Schema.Struct({
  providerID: Schema.String,
  id: Schema.String,
  variant: Schema.optional(Schema.String),
})

export const MeshNodeSchema: Schema.Codec<MeshNode> = Schema.Struct({
  sessionID: Schema.String,
  parentID: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(ModelSchema),
  state: Schema.Literals(["running", "retry", "idle", "failed", "interrupted", "unknown"]),
  cost: Schema.Number,
  tokens: TokenSchema,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  lastActivityAt: Schema.optional(Schema.Number),
  children: Schema.Array(Schema.suspend((): Schema.Codec<MeshNode> => MeshNodeSchema)),
})

export const MeshStatusOutput = Schema.Struct({
  roots: Schema.Array(MeshNodeSchema),
  generatedAt: Schema.Number,
  killed: Schema.optional(Schema.Array(Schema.String)),
})

export const LimitsOutput = Schema.Struct({
  maxSubagents: Schema.Number,
  backgroundSubagents: Schema.Boolean,
  swarmMode: Schema.Boolean,
  maxSubagentsLimit: Schema.Number,
  maxSubagentsDefault: Schema.Number,
})

export const LimitsSetInput = Schema.Struct({
  maxSubagents: Schema.optional(Schema.Number),
  swarmMode: Schema.optional(Schema.Boolean),
})

export const LimitsSetOutput = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  limits: LimitsOutput,
})

const limitsOutput = (limits: {
  readonly maxSubagents: number
  readonly backgroundSubagents: boolean
  readonly swarmMode: boolean
}): typeof LimitsOutput.Type => ({
  ...limits,
  maxSubagentsLimit: MAX_SUBAGENTS_LIMIT,
  maxSubagentsDefault: DEFAULT_MAX_SUBAGENTS,
})

export const SteerInput = Schema.Struct({
  parentSessionID: Schema.String,
  targetAgent: Schema.String,
  instruction: Schema.String.check(Schema.isMaxLength(50_000)),
  priority: Schema.optional(Schema.Literals(["low", "normal", "high"])),
})

export const KillInput = Schema.Struct({
  parentSessionID: Schema.String,
  /** Kills every descendant of this agent. */
  targetAgent: Schema.optional(Schema.String),
  /** Kills exactly this session; wins over `targetAgent` when both are present. */
  targetSessionID: Schema.optional(Schema.String),
  reason: Schema.String.check(Schema.isMaxLength(2_000)),
})

export const Definition = Rpc.define({
  id: "banyancode.mesh",
  methods: {
    status: {
      input: Schema.Struct({ sessionID: Schema.optional(Schema.String) }),
      output: MeshStatusOutput,
    },
    sessionStatus: {
      input: Schema.Struct({ sessionID: Schema.String }),
      output: MeshStatusOutput,
    },
    "limits.get": {
      input: Schema.Struct({}),
      output: LimitsOutput,
    },
    "limits.set": {
      input: LimitsSetInput,
      output: LimitsSetOutput,
    },
    // v1 `banyancode.mesh.background`: moved to the host's
    // `session.background` route, exposed on the plugin SessionDomain.
    background: {
      input: Schema.Struct({ sessionID: Schema.String }),
      output: Schema.Void,
    },
    steer: {
      input: SteerInput,
      output: Schema.Struct({ delivered: Schema.Number }),
    },
    kill: {
      input: KillInput,
      output: Schema.Struct({ killed: Schema.Number }),
    },
  },
  events: {
    "status.updated": {
      schema: Schema.Struct({
        rootSessionID: Schema.String,
        tree: MeshNodeSchema,
        killed: Schema.optional(Schema.Array(Schema.String)),
      }),
    },
  },
})

export interface HandlerDeps {
  readonly mesh: MeshService
  /** Stops the session's running work via the host `session.background` route. */
  readonly background: (sessionID: string) => Effect.Effect<void>
  /** Persists a limits change to `banyancode.json` (v1 behavior). */
  readonly persist?: (patch: {
    readonly banyancode_max_subagents?: number
    readonly banyancode_swarm_mode?: boolean
  }) => Effect.Effect<void, unknown>
  /** Re-publishes the status tree after a mutation that emits no session event. */
  readonly changed?: (sessionID: string) => Effect.Effect<void>
}

export const handlers = (deps: HandlerDeps): RpcHandlers<typeof Definition> => ({
  status: (input) =>
    deps.mesh
      .status(input.sessionID === undefined ? undefined : { sessionID: input.sessionID })
      .pipe(Effect.orDie),
  sessionStatus: (input) => deps.mesh.status({ sessionID: input.sessionID, scope: "session" }).pipe(Effect.orDie),
  "limits.get": () => deps.mesh.limits().pipe(Effect.map(limitsOutput), Effect.orDie),
  background: (input) => deps.background(input.sessionID).pipe(Effect.orDie),
  steer: (input) => deps.mesh.steer(input).pipe(Effect.orDie),
  kill: (input) =>
    Effect.gen(function* () {
      const result = yield* deps.mesh.kill(input)
      if (deps.changed !== undefined) yield* deps.changed(input.parentSessionID)
      return result
    }).pipe(Effect.orDie),
  "limits.set": (input) =>
    Effect.gen(function* () {
      if (input.maxSubagents !== undefined) {
        const validation = validateMaxSubagents(input.maxSubagents)
        if (!validation.ok) {
          return { ok: false, error: validation.error, limits: limitsOutput(yield* deps.mesh.limits()) }
        }
      }
      const patch = {
        ...(input.maxSubagents === undefined
          ? {}
          : { banyancode_max_subagents: input.maxSubagents }),
        ...(input.swarmMode === undefined ? {} : { banyancode_swarm_mode: input.swarmMode }),
      }
      if (deps.persist !== undefined && Object.keys(patch).length > 0) {
        const written = yield* deps.persist(patch).pipe(Effect.result)
        if (Result.isFailure(written)) {
          return {
            ok: false,
            error: `could not write banyancode.json: ${String(written.failure)}`,
            limits: limitsOutput(yield* deps.mesh.limits()),
          }
        }
      }
      if (input.maxSubagents !== undefined) yield* deps.mesh.setMaxSubagents(input.maxSubagents)
      if (input.swarmMode !== undefined) yield* deps.mesh.setSwarmMode(input.swarmMode)
      return { ok: true, limits: limitsOutput(yield* deps.mesh.limits()) }
    }).pipe(Effect.orDie),
})
