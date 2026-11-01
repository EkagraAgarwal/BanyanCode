import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import { Rpc } from "@opencode/schema/rpc"
import { Effect, Schema } from "effect"
import { MAX_SUBAGENTS_LIMIT, DEFAULT_MAX_SUBAGENTS } from "./limits.js"
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
  },
  events: {
    "status.updated": {
      schema: Schema.Struct({ rootSessionID: Schema.String, tree: MeshNodeSchema }),
    },
  },
})

export interface HandlerDeps {
  readonly mesh: MeshService
}

export const handlers = (deps: HandlerDeps): RpcHandlers<typeof Definition> => ({
  status: (input) =>
    deps.mesh
      .status(input.sessionID === undefined ? undefined : { sessionID: input.sessionID })
      .pipe(Effect.orDie),
  sessionStatus: (input) => deps.mesh.status({ sessionID: input.sessionID, scope: "session" }).pipe(Effect.orDie),
  "limits.get": () => deps.mesh.limits().pipe(Effect.map(limitsOutput), Effect.orDie),
  "limits.set": (input) =>
    Effect.gen(function* () {
      if (input.maxSubagents !== undefined) {
        const result = yield* deps.mesh.setMaxSubagents(input.maxSubagents)
        if (!result.ok) {
          return { ok: false, error: result.error, limits: limitsOutput(yield* deps.mesh.limits()) }
        }
      }
      if (input.swarmMode !== undefined) yield* deps.mesh.setSwarmMode(input.swarmMode)
      return { ok: true, limits: limitsOutput(yield* deps.mesh.limits()) }
    }).pipe(Effect.orDie),
})
