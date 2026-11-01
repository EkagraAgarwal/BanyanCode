import type { RpcHandlers, RpcRegistration } from "@opencode/plugin/effect/rpc"
import { Rpc } from "@opencode/schema/rpc"
import { Effect, Schema } from "effect"
import type { Interface as ConfigInterface } from "../config/service.js"
import { Info } from "../config/schema.js"
import type { WriteTarget } from "../config/writer.js"
import { saveAgent, update, updateAgentOverride, updateAgentPrompt } from "../config/writer.js"
import type { SystemMonitor, SystemStatus } from "./monitor.js"
import { lspStatus } from "./lsp.js"

/**
 * `banyancode.system` RPC: host health, LSP config state, the YOLO switch and
 * the agent config writers that used to be `/global/banyan-*` routes.
 *
 * Payload schemas are portable to `client.rpc(...)` (the TUI wraps them with
 * `Schema.toStandardSchemaV1`), and every write is comment-preserving and
 * file-locked through `../config/writer.ts`.
 */

export const SystemStatusSchema = Schema.Struct({
  cpuPercent: Schema.optional(Schema.Number),
  memoryUsedBytes: Schema.Number,
  memoryTotalBytes: Schema.Number,
  gpuPercent: Schema.optional(Schema.Number),
  vramUsedBytes: Schema.optional(Schema.Number),
  gpuTotalBytes: Schema.optional(Schema.Number),
  diskUsedBytes: Schema.optional(Schema.Number),
  diskTotalBytes: Schema.optional(Schema.Number),
  platform: Schema.Literals(["windows", "linux", "darwin"]),
}).annotate({ identifier: "Banyan.SystemStatus" })

export const LspServerSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["configured", "connected", "error"]),
  languages: Schema.optional(Schema.Array(Schema.String)),
  inert: Schema.optional(Schema.Boolean),
  disabled: Schema.optional(Schema.Boolean),
  disabledReason: Schema.optional(Schema.String),
})

export const LspStatusOutput = Schema.Struct({
  enabled: Schema.Boolean,
  idleTimeoutMs: Schema.Number,
  servers: Schema.Array(LspServerSchema),
}).annotate({ identifier: "Banyan.LspStatus" })

export const YoloStatus = Schema.Struct({
  enabled: Schema.Boolean,
  /** True when `BANYANCODE_YOLO_MODE` is set in the host environment. */
  env: Schema.Boolean,
  /** True when `banyancode_yolo_mode` is set in config. */
  config: Schema.Boolean,
}).annotate({ identifier: "Banyan.YoloStatus" })

const AgentName = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9._-]+$/),
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
)

const AgentModel = Schema.Struct({
  providerID: Schema.String.check(Schema.isMaxLength(128)),
  modelID: Schema.String.check(Schema.isMaxLength(128)),
})

export const AgentOverrideInput = Schema.Struct({
  name: AgentName,
  enabled: Schema.optional(Schema.Boolean),
  model: Schema.optional(Schema.Union([AgentModel, Schema.Null])),
  thinking: Schema.optional(Schema.Union([Schema.String.check(Schema.isMaxLength(128)), Schema.Null])),
  variant: Schema.optional(Schema.Union([Schema.String.check(Schema.isMaxLength(128)), Schema.Null])),
}).annotate({ identifier: "Banyan.AgentOverrideInput" })

export const AgentPromptInput = Schema.Struct({
  name: AgentName,
  prompt: Schema.String.check(Schema.isMaxLength(50_000)),
}).annotate({ identifier: "Banyan.AgentPromptInput" })

export const AgentSaveInput = Schema.Struct({
  name: AgentName,
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(280))),
  mode: Schema.optional(Schema.Literals(["primary", "subagent", "all"])),
  hidden: Schema.optional(Schema.Boolean),
  model: Schema.optional(AgentModel),
  permission: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(128)))),
  tools: Schema.optional(
    Schema.Array(
      Schema.String.check(
        Schema.isPattern(/^[a-zA-Z0-9_]+$/),
        Schema.isMaxLength(128),
      ),
    ),
  ),
  prompt: Schema.optional(Schema.String.check(Schema.isMaxLength(50_000))),
  thinking: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
}).annotate({ identifier: "Banyan.AgentSaveInput" })

export const AgentSaveResult = Schema.Struct({
  ok: Schema.Literal(true),
  filePath: Schema.String,
}).annotate({ identifier: "Banyan.AgentSaveResult" })

export const Definition = Rpc.define({
  id: "banyancode.system",
  methods: {
    status: { input: Schema.Struct({}), output: SystemStatusSchema },
    "lsp.status": { input: Schema.Struct({}), output: LspStatusOutput },
    "yolo.get": { input: Schema.Struct({}), output: YoloStatus },
    "yolo.set": { input: Schema.Struct({ enabled: Schema.Boolean }), output: YoloStatus },
    "config.agentOverride": { input: AgentOverrideInput, output: Info },
    "config.agentPrompt": { input: AgentPromptInput, output: Info },
    "config.agentSave": { input: AgentSaveInput, output: AgentSaveResult },
  },
  events: {
    /** v1 `banyancode.system.updated` (sampled host health). */
    updated: { schema: SystemStatusSchema },
  },
})

export type Definition = typeof Definition

export interface HandlerDeps {
  readonly config: ConfigInterface
  readonly monitor: SystemMonitor
  readonly target: WriteTarget
  readonly env?: NodeJS.ProcessEnv
  /** Re-materialize agents after a config write (v2 `ctx.agent.reload`). */
  readonly reloadAgents?: () => Effect.Effect<void>
  readonly now?: () => number
}

const yoloStatus = (config: {
  readonly banyancode_yolo_mode?: boolean
}, env: NodeJS.ProcessEnv): typeof YoloStatus.Type => {
  const fromEnv = /^(?:1|true|yes|on)$/i.test(env.BANYANCODE_YOLO_MODE ?? "")
  const fromConfig = config.banyancode_yolo_mode === true
  return { enabled: fromConfig || fromEnv, env: fromEnv, config: fromConfig }
}

export const handlers = (deps: HandlerDeps): RpcHandlers<typeof Definition> => {
  const env = deps.env ?? process.env
  return {
    status: () => Effect.promise(() => deps.monitor.status()),
    "lsp.status": () =>
      deps.config.get().pipe(Effect.map((loaded) => lspStatus(loaded.config))),
    "yolo.get": () => deps.config.get().pipe(Effect.map((loaded) => yoloStatus(loaded.config, env))),
    "yolo.set": (input) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => update(deps.target, { banyancode_yolo_mode: input.enabled }))
        yield* (deps.reloadAgents?.() ?? Effect.void)
        const loaded = yield* deps.config.get()
        return yoloStatus(loaded.config, env)
      }),
    "config.agentOverride": (input) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          updateAgentOverride(deps.target, input.name, {
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
            ...(input.variant === undefined ? {} : { variant: input.variant }),
          }),
        )
        yield* (deps.reloadAgents?.() ?? Effect.void)
        const loaded = yield* deps.config.get()
        return loaded.config
      }),
    "config.agentPrompt": (input) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => updateAgentPrompt(deps.target, input.name, input.prompt))
        yield* (deps.reloadAgents?.() ?? Effect.void)
        const loaded = yield* deps.config.get()
        return loaded.config
      }),
    "config.agentSave": (input) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => saveAgent(deps.target, input))
        yield* (deps.reloadAgents?.() ?? Effect.void)
        return result
      }),
  }
}

export const publishStatus = (
  registration: RpcRegistration<typeof Definition>,
  status: SystemStatus,
): Effect.Effect<void> =>
  registration.events.emit("updated", status).pipe(Effect.catchCause(() => Effect.void))
