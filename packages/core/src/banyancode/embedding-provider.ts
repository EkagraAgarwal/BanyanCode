export * as EmbeddingProvider from "./embedding-provider"

import { Config, ConfigProvider, Context, Effect, Layer, Ref, Schema } from "effect"
import { PluginV2 } from "../plugin"
import { BanyanConfigService } from "./banyan-config"

export class EmbeddingError extends Schema.TaggedErrorClass<EmbeddingError>()("Banyan/EmbeddingError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly embed: (input: string | string[]) => Effect.Effect<Float32Array[], EmbeddingError>
  readonly model: () => string | undefined
  readonly setModel: (name: string | undefined) => Effect.Effect<void>
}

export class EmbeddingProviderService extends Context.Service<EmbeddingProviderService, Interface>()("@banyancode/EmbeddingProvider") {}

export const configLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({}))

export const layer = Layer.effect(
  EmbeddingProviderService,
  Effect.gen(function* () {
    const plugin = yield* PluginV2.Service
    const configOpt = yield* Effect.serviceOption(BanyanConfigService.Service)
    let initialName = yield* Config.string("BANYANCODE_EMBEDDING_MODEL").pipe(
      Config.withDefault(""),
      Effect.map((s) => (s === "" ? undefined : s)),
      Effect.orDie,
    )
    if (!initialName && configOpt._tag === "Some") {
      const config = yield* configOpt.value.get()
      initialName = config.banyancode_embedding_model
    }
    const modelRef = yield* Ref.make<string | undefined>(initialName)

    const embed = Effect.fn("EmbeddingProvider.embed")(function* (input: string | string[]) {
      const modelName = yield* Ref.get(modelRef)
      if (modelName === undefined) {
        return yield* new EmbeddingError({ message: "BANYANCODE_EMBEDDING_MODEL is not set" })
      }

      const texts = Array.isArray(input) ? input : [input]

      const result = yield* plugin
         .trigger(
          "aisdk.embed",
          { model: modelName, input: texts },
          { embeddings: [] },
        )
        .pipe(Effect.mapError((e) => new EmbeddingError({ message: String(e) })))

      return result.embeddings.map((e: number[]) => new Float32Array(e))
    })

    const setModel = Effect.fn("EmbeddingProvider.setModel")(function* (name: string | undefined) {
      yield* Ref.set(modelRef, name)
    })

    return EmbeddingProviderService.of({
      embed,
      model: () => Effect.runSync(Ref.get(modelRef)),
      setModel,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(configLayer),
  Layer.provide(BanyanConfigService.defaultLayer),
)