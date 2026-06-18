import { Config, ConfigProvider, Context, Effect, Layer } from "effect"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const boolTrue = (name: string) => Config.boolean(name).pipe(Config.withDefault(true))

const banyancodeEnable = boolTrue("BANYANCODE_ENABLE")

export interface Info {
  readonly banyancodeEnable: boolean
}

class ConfigTag extends Context.Service<ConfigTag, Info>()("@opencode/RuntimeFlags") {
  static get defaultLayer() {
    return Layer.effect(
      ConfigTag,
      Effect.gen(function* () {
        const config = yield* Config.all({ banyancodeEnable })
        return ConfigTag.of(config)
      }),
    )
  }
}

const emptyConfigLayer = ConfigTag.defaultLayer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    ConfigTag,
    Effect.gen(function* () {
      const flags = yield* ConfigTag
      return ConfigTag.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const defaultLayer = ConfigTag.defaultLayer.pipe(Layer.orDie)

export const Service = ConfigTag

export * as RuntimeFlags from "./runtime-flags"