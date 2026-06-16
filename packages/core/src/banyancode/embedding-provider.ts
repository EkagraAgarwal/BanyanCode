export * as EmbeddingProvider from "./embedding-provider"

import { createHash } from "crypto"
import { ConfigProvider, Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { BanyanConfig } from "../v1/config/banyan-config"
import { Service as BanyanConfigService } from "./banyan-config"

export class EmbeddingError extends Schema.TaggedErrorClass<EmbeddingError>()("Banyan/EmbeddingError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly embed: (input: string | string[]) => Effect.Effect<Float32Array[], EmbeddingError>
  readonly model: () => string | undefined
  readonly setModel: (name: string | undefined) => Effect.Effect<void>
  readonly inputHash: (text: string) => string
  readonly config: () => {
    baseUrl: string
    apiKey: string | undefined
    dimensions: number | undefined
    batchSize: number
  }
}

export class EmbeddingProviderService extends Context.Service<EmbeddingProviderService, Interface>()(
  "@banyancode/EmbeddingProvider",
) {}

const DEFAULT_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_API_KEY_ENV = "BANYANCODE_EMBEDDING_API_KEY"
const DEFAULT_BATCH_SIZE = 64

const configLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({}))

export const defaultLayer = Layer.effect(
  EmbeddingProviderService,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient

    const configOpt = yield* Effect.serviceOption(BanyanConfigService)
    const banyanConfig: BanyanConfig.Info = Option.isSome(configOpt)
      ? yield* configOpt.value.getGlobal()
      : ({} as BanyanConfig.Info)

    const initialName = banyanConfig.banyancode_embedding_model
    const modelRef = yield* Ref.make<string | undefined>(initialName)

    const resolveConfig = () => ({
      baseUrl: banyanConfig.banyancode_embedding_base_url ?? DEFAULT_BASE_URL,
      apiKey: banyanConfig.banyancode_embedding_api_key_env
        ? (process.env[banyanConfig.banyancode_embedding_api_key_env] as string | undefined)
        : process.env[DEFAULT_API_KEY_ENV],
      dimensions: banyanConfig.banyancode_embedding_dimensions,
      batchSize: banyanConfig.banyancode_embedding_batch_size ?? DEFAULT_BATCH_SIZE,
    })

    const inputHash = (text: string): string => createHash("sha256").update(text).digest("hex")

    const doRequest = (
      baseUrl: string,
      apiKey: string | undefined,
      modelName: string,
      texts: string[],
      dimensions: number | undefined,
    ): Effect.Effect<Float32Array[], EmbeddingError> =>
      Effect.gen(function* () {
        const url = `${baseUrl.replace(/\/+$/, "")}/embeddings`
        const body: Record<string, unknown> = {
          model: modelName,
          input: texts,
          encoding_format: "float",
        }
        if (dimensions !== undefined) body.dimensions = dimensions

        const headers: Record<string, string> = { "Content-Type": "application/json" }
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`

        const req = yield* Effect.mapError(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeaders(headers),
            HttpClientRequest.schemaBodyJson(
              Schema.Struct({
                model: Schema.String,
                input: Schema.Array(Schema.String),
                encoding_format: Schema.String,
                dimensions: Schema.optional(Schema.Number),
              }),
            )(body as { model: string; input: string[]; encoding_format: string; dimensions?: number }),
          ),
          (e: unknown) => new EmbeddingError({ message: `body encoding failed: ${String(e)}` }),
        )

        const response = yield* httpClient.execute(req).pipe(
          Effect.mapError((e) => new EmbeddingError({ message: `Embedding request failed: ${String(e)}` })),
        )
        const status = response.status
        if (status === 429 || (status >= 500 && status < 600)) {
          return yield* new EmbeddingError({ message: `Retryable status ${status}` })
        }
        if (status < 200 || status >= 300) {
          const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
          return yield* new EmbeddingError({ message: `Embedding request failed: ${status} ${text}` })
        }
        const json = yield* response.json.pipe(
          Effect.mapError((e) => new EmbeddingError({ message: `Invalid JSON: ${String(e)}` })),
        )
        const data = (json as { data: Array<{ index: number; embedding: number[] }> }).data
        for (let i = 0; i < data.length; i++) {
          if (data[i].index !== i) {
            return yield* new EmbeddingError({ message: `Response data[${i}].index !== ${i}` })
          }
        }
        if (dimensions !== undefined) {
          for (let i = 0; i < data.length; i++) {
            if (data[i].embedding.length !== dimensions) {
              return yield* new EmbeddingError({
                message: `Embedding dimension mismatch: expected ${dimensions}, got ${data[i].embedding.length}`,
              })
            }
          }
        }
        for (let i = 0; i < data.length; i++) {
          for (let j = 0; j < data[i].embedding.length; j++) {
            if (!Number.isFinite(data[i].embedding[j])) {
              return yield* new EmbeddingError({ message: `Non-finite value at data[${i}].embedding[${j}]` })
            }
          }
        }
        return data.map((d) => new Float32Array(d.embedding))
      })

    const postEmbeddings = (
      baseUrl: string,
      apiKey: string | undefined,
      modelName: string,
      texts: string[],
      dimensions: number | undefined,
    ): Effect.Effect<Float32Array[], EmbeddingError> => {
      const delays = [100, 400, 1600]
      let attempt = doRequest(baseUrl, apiKey, modelName, texts, dimensions)
      for (const delay of delays) {
        attempt = attempt.pipe(
          Effect.catchTag("Banyan/EmbeddingError", (err: EmbeddingError) =>
            err.message.startsWith("Retryable status")
              ? Effect.sleep(delay).pipe(Effect.flatMap(() => doRequest(baseUrl, apiKey, modelName, texts, dimensions)))
              : Effect.fail(err),
          ),
        )
      }
      return attempt
    }

    const embed = Effect.fn("EmbeddingProvider.embed")(function* (input: string | string[]) {
      const modelName = yield* Ref.get(modelRef)
      if (modelName === undefined) {
        return yield* new EmbeddingError({ message: "BANYANCODE_EMBEDDING_MODEL is not set" })
      }

      const cfg = resolveConfig()
      const isSingle = !Array.isArray(input)
      const texts = isSingle ? [input] : input

      const batchSize = cfg.batchSize
      const allVectors: Float32Array[] = []

      for (let i = 0; i < texts.length; i += batchSize) {
        const chunk = texts.slice(i, i + batchSize)
        const vectors = yield* postEmbeddings(cfg.baseUrl, cfg.apiKey, modelName, chunk, cfg.dimensions)
        allVectors.push(...vectors)
      }

      return isSingle ? [allVectors[0]] : allVectors
    })

    const setModel = Effect.fn("EmbeddingProvider.setModel")(function* (name: string | undefined) {
      yield* Ref.set(modelRef, name)
    })

    return EmbeddingProviderService.of({
      embed,
      model: () => Effect.runSync(Ref.get(modelRef)),
      setModel,
      inputHash,
      config: resolveConfig,
    })
  }),
).pipe(Layer.provide(configLayer))