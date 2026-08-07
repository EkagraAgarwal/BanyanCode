import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const boolTrue = (name: string) => Config.boolean(name).pipe(Config.withDefault(true))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("OPENCODE_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

// Background subagents default to ON for BanyanCode installs. The precedence is:
//   1. Explicit OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true|false always wins.
//   2. OPENCODE_EXPERIMENTAL=true (umbrella) enables it.
//   3. Otherwise default to ON — BanyanCode users get background subagents out
//      of the box. Operators can still disable for a single install via
//      OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=false or BANYANCODE_ENABLE=0
//      (which falls back to BANYANCODE_ENABLE's existing boolTrue default).
const experimentalBackgroundSubagentsConfig = Config.all({
  enabled: Config.boolean("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS").pipe(Config.option),
  experimental,
  banyancodeEnable: Config.boolean("BANYANCODE_ENABLE").pipe(Config.withDefault(true)),
}).pipe(
  Config.map((flags) =>
    Option.getOrElse(flags.enabled, () => flags.experimental || flags.banyancodeEnable),
  ),
)

export class Service extends ConfigService.Service<Service>()("@opencode/RuntimeFlags", {
  autoShare: bool("OPENCODE_AUTO_SHARE"),
  banyancodeEnable: boolTrue("BANYANCODE_ENABLE"),
  banyancodeYoloMode: bool("BANYANCODE_YOLO_MODE"),
  pure: bool("OPENCODE_PURE"),
  disableDefaultPlugins: bool("OPENCODE_DISABLE_DEFAULT_PLUGINS"),
  disableEmbeddedWebUi: bool("OPENCODE_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("OPENCODE_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("OPENCODE_DISABLE_LSP_DOWNLOAD"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("OPENCODE_DISABLE_CLAUDE_CODE"),
    direct: bool("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("OPENCODE_DISABLE_CLAUDE_CODE"),
    direct: bool("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("OPENCODE_ENABLE_EXA"),
    legacy: bool("OPENCODE_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("OPENCODE_ENABLE_PARALLEL"),
    legacy: bool("OPENCODE_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("OPENCODE_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("OPENCODE_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("OPENCODE_EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: experimentalBackgroundSubagentsConfig,
  experimentalLspTy: bool("OPENCODE_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("OPENCODE_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("OPENCODE_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("OPENCODE_EXPERIMENTAL_PLAN_MODE"),
  experimentalEventSystem: enabledByExperimental("OPENCODE_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("OPENCODE_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("OPENCODE_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("OPENCODE_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("OPENCODE_EXPERIMENTAL_WEBSOCKETS"),
  client: Config.string("OPENCODE_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.defaultLayer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const defaultLayer = Service.defaultLayer.pipe(Layer.orDie)

export const node = LayerNode.make(defaultLayer, [])

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
