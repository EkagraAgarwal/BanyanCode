export * as EmbeddingProvider from "./embedding-provider"

import { Config, ConfigProvider, Context, Effect, Layer, Schema } from "effect"
import { PluginV2 } from "../plugin"

export class EmbeddingError extends Schema.TaggedErrorClass<EmbeddingError>()("Banyan/EmbeddingError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly embed: (input: string | string[]) => Effect.Effect<Float32Array[], EmbeddingError>
  readonly model: () => string | undefined
}

export class EmbeddingProviderService extends Context.Service<EmbeddingProviderService, Interface>()("@banyancode/EmbeddingProvider") {}

const configLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({}))

export const defaultLayer = Layer.effect(
  EmbeddingProviderService,
  Effect.gen(function* () {
    const plugin = yield* PluginV2.Service
    const modelName = yield* Config.string("BANYANCODE_EMBEDDING_MODEL").pipe(
      Config.withDefault(""),
      Effect.map((s) => (s === "" ? undefined : s)),
      Effect.orDie,
    )

    const embed = Effect.fn("EmbeddingProvider.embed")(function* (input: string | string[]) {
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

    return EmbeddingProviderService.of({ embed, model: () => modelName })
  }),
).pipe(Layer.provide(configLayer))