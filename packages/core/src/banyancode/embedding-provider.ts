export * as EmbeddingProvider from "./embedding-provider"

import { Config, ConfigProvider, Context, Effect, Layer, Ref, Schema } from "effect"
import { PluginV2 } from "../plugin"
import { BanyanConfigService } from "./banyan-config"
import { CodegraphRepo } from "./codegraph-repo"
import { ProviderLookupService } from "./provider-lookup"

export class EmbeddingError extends Schema.TaggedErrorClass<EmbeddingError>()("Banyan/EmbeddingError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly embed: (input: string | string[]) => Effect.Effect<Float32Array[], EmbeddingError>
  readonly model: () => Effect.Effect<string | undefined, never, never>
  readonly setModel: (name: string | undefined) => Effect.Effect<void, never, never>
}

export class EmbeddingProviderService extends Context.Service<EmbeddingProviderService, Interface>()("@banyancode/EmbeddingProvider") {}

export const configLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({}))

export const layer = Layer.effect(
  EmbeddingProviderService,
  Effect.gen(function* () {
    const plugin = yield* PluginV2.Service
    const configOpt = yield* Effect.serviceOption(BanyanConfigService.Service)
    let initialName: string | undefined
    if (configOpt._tag === "Some") {
      const config = yield* configOpt.value.get()
      initialName = config.banyancode_embedding_model
    }
    if (!initialName) {
      initialName = yield* Config.string("BANYANCODE_EMBEDDING_MODEL").pipe(
        Config.withDefault(""),
        Effect.map((s) => (s === "" ? undefined : s)),
        Effect.orDie,
      )
    }
    const modelRef = yield* Ref.make<string | undefined>(initialName)

    const setModel: Interface["setModel"] = (name) =>
      Effect.gen(function* () {
        yield* Ref.set(modelRef, name)
        if (configOpt._tag === "Some" && name !== undefined) {
          yield* configOpt.value.update({ banyancode_embedding_model: name })
        }
      })

    const embed = Effect.fn("EmbeddingProvider.embed")(function* (input: string | string[]) {
      const modelName = yield* Ref.get(modelRef)
      if (modelName === undefined) {
        return yield* new EmbeddingError({ message: "BANYANCODE_EMBEDDING_MODEL is not set" })
      }

      const texts = Array.isArray(input) ? input : [input]

      // Look up provider options if ProviderLookup is available (opencode layer)
      let options: { baseURL: string; apiKey?: string; headers?: Record<string, string> } | undefined
      const lookupOpt = yield* Effect.serviceOption(ProviderLookupService)
      if (lookupOpt._tag === "Some") {
        const slash = modelName.indexOf("/")
        if (slash > 0) {
          const providerID = modelName.slice(0, slash)
          options = yield* lookupOpt.value.getProviderOptions(providerID)
        }
      }

      const result = yield* plugin
        .trigger("aisdk.embed", { model: modelName, input: texts, options }, { embeddings: [] as number[][] })
        .pipe(Effect.mapError((e) => new EmbeddingError({ message: String(e) })))

      if (result.error) {
        return yield* Effect.fail(new EmbeddingError({ message: result.error }))
      }

      return result.embeddings.map((e: number[]) => new Float32Array(e))
    })

    return EmbeddingProviderService.of({
      embed,
      model: () => Ref.get(modelRef),
      setModel,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(configLayer),
  Layer.provide(BanyanConfigService.defaultLayer),
  Layer.provide(CodegraphRepo.defaultLayer),
)