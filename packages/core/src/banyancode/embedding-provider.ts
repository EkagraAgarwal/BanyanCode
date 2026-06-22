export * as EmbeddingProvider from "./embedding-provider"

import { Config, ConfigProvider, Context, Effect, Layer, Ref, Schema } from "effect"
import { PluginV2 } from "../plugin"
import { BanyanConfigService } from "./banyan-config"
import { CodegraphRepo } from "./codegraph-repo"

export class EmbeddingError extends Schema.TaggedErrorClass<EmbeddingError>()("Banyan/EmbeddingError", {
  message: Schema.String,
}) {}

export class EmbeddingProbeError extends Schema.TaggedErrorClass<EmbeddingProbeError>()("Banyan/EmbeddingProbeError", {
  endpoint: Schema.String,
  status: Schema.Number,
  message: Schema.String,
}) {}

export class EmbeddingDimensionError extends Schema.TaggedErrorClass<EmbeddingDimensionError>()("Banyan/EmbeddingDimensionError", {
  expected: Schema.Number,
  actual: Schema.Number,
  model: Schema.String,
}) {}

export interface Interface {
  readonly embed: (input: string | string[]) => Effect.Effect<Float32Array[], EmbeddingError | EmbeddingDimensionError>
  readonly model: () => string | undefined
  readonly setModel: (name: string | undefined) => Effect.Effect<void, EmbeddingError | EmbeddingDimensionError | EmbeddingProbeError | CodegraphRepo.CodegraphSearchError, CodegraphRepo.Service>
  readonly probe: (model: string) => Effect.Effect<{ dim: number; type: "F32" | "F16" | "F8" | "F1BIT" }, EmbeddingProbeError, never>
  readonly detectAndSetModel: (
    model: string,
  ) => Effect.Effect<{ dim: number }, EmbeddingProbeError | CodegraphRepo.CodegraphSearchError, CodegraphRepo.Service>
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

    const probe = Effect.fn("EmbeddingProvider.probe")(function* (modelName: string) {
      const result = yield* plugin
        .trigger("aisdk.embed", { model: modelName, input: ["x"] }, { embeddings: [[1 as number]] })
        .pipe(
          Effect.timeout(5000),
          Effect.mapError((e) => {
            if (process.env.BANYANCODE_DEBUG === "1") {
              console.error(`[turso.picker] probe failed endpoint=${modelName} error=${String(e)}`)
            }
            return new EmbeddingProbeError({ endpoint: modelName, status: 0, message: String(e) })
          }),
        )
      const embeddings = result.embeddings
      if (!embeddings || embeddings.length === 0 || !embeddings[0] || embeddings[0].length === 0) {
        return yield* new EmbeddingProbeError({ endpoint: modelName, status: 0, message: "No embedding returned" })
      }
      const dim = embeddings[0].length
      if (process.env.BANYANCODE_DEBUG === "1") {
        console.error(`[turso.picker] probe endpoint=${modelName} model=${modelName} -> dim=${dim}`)
      }
      return { dim, type: "F32" as const }
    })

    const detectAndSetModel = Effect.fn("EmbeddingProvider.detectAndSetModel")(function* (modelName: string) {
      const { dim } = yield* probe(modelName)
      if (configOpt._tag === "Some") {
        yield* configOpt.value.update({ banyancode_embedding_model: modelName, banyancode_embedding_dim: dim })
      }
      const repo = yield* CodegraphRepo.Service
      yield* repo.resetEmbeddingsTable(dim, modelName)
      if (process.env.BANYANCODE_DEBUG === "1") {
        console.error(`[turso.picker] resetTable dim=${dim} model=${modelName}`)
      }
      return { dim }
    })

    const embed = Effect.fn("EmbeddingProvider.embed")(function* (input: string | string[]) {
      const modelName = yield* Ref.get(modelRef)
      if (modelName === undefined) {
        return yield* new EmbeddingError({ message: "BANYANCODE_EMBEDDING_MODEL is not set" })
      }

      const texts = Array.isArray(input) ? input : [input]

      const result = yield* plugin
        .trigger("aisdk.embed", { model: modelName, input: texts }, { embeddings: [] as number[][] })
        .pipe(Effect.mapError((e) => new EmbeddingError({ message: String(e) })))

      const vectors = result.embeddings.map((e: number[]) => new Float32Array(e))
      if (configOpt._tag === "Some") {
        const config = yield* configOpt.value.get()
        const expectedDim = config.banyancode_embedding_dim
        const actualDim = vectors[0]?.length
        if (expectedDim && actualDim && actualDim !== expectedDim) {
          return yield* new EmbeddingDimensionError({
            expected: expectedDim,
            actual: actualDim,
            model: modelName,
          })
        }
        // If no expectedDim is configured, persist the actual dim so future checks work
        if (!expectedDim && actualDim) {
          yield* configOpt.value.update({ banyancode_embedding_dim: actualDim })
        }
      }
      return vectors
    })

    const setModel = Effect.fn("EmbeddingProvider.setModel")(function* (name: string | undefined) {
      if (name === undefined) {
        yield* Ref.set(modelRef, undefined)
        return
      }
      const repo = yield* CodegraphRepo.Service
      const { dim } = yield* probe(name)
      if (configOpt._tag === "Some") {
        yield* configOpt.value.update({ banyancode_embedding_model: name, banyancode_embedding_dim: dim })
      }
      yield* repo.resetEmbeddingsTable(dim, name)
      if (process.env.BANYANCODE_DEBUG === "1") {
        console.error(`[turso.picker] resetTable dim=${dim} model=${name}`)
      }
      yield* Ref.set(modelRef, name)
    })

    return EmbeddingProviderService.of({
      embed,
      model: () => Effect.runSync(Ref.get(modelRef)),
      setModel,
      probe,
      detectAndSetModel,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(configLayer),
  Layer.provide(BanyanConfigService.defaultLayer),
  Layer.provide(CodegraphRepo.defaultLayer),
)