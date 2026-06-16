import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { EmbeddingProviderService, defaultLayer } from "../../../core/src/banyancode/embedding-provider"
import { Service as BanyanConfigService } from "../../../core/src/banyancode/banyan-config"
import type { BanyanConfig } from "../../../core/src/v1/config/banyan-config"

const makeMockConfig = (overrides: Partial<BanyanConfig.Info> = {}) =>
  Layer.succeed(BanyanConfigService, {
    get: () => Effect.succeed(overrides as BanyanConfig.Info),
    getGlobal: () => Effect.succeed(overrides as BanyanConfig.Info),
    update: (patch: Partial<BanyanConfig.Info>) => Effect.succeed({ ...overrides, ...patch } as BanyanConfig.Info),
  })

const makeMockHttpClient = (respond: (_request: HttpClientRequest.HttpClientRequest) => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => respond(request)).pipe(
        Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
      ),
    ),
  )

describe("embedding-model-picker", () => {
  test("setModel updates the provider model for live reload", async () => {
    const httpLayer = makeMockHttpClient(() =>
      new Response(JSON.stringify({ object: "list", data: [{ object: "embedding", embedding: [0.1], index: 0 }], model: "test", usage: { prompt_tokens: 1, total_tokens: 1 } }), { status: 200 }),
    )
    const configLayer = makeMockConfig({ banyancode_embedding_model: "test-model" })
    const testLayer = defaultLayer.pipe(Layer.provide(httpLayer), Layer.provide(configLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        yield* provider.setModel("openai/text-embedding-3-small")
        yield* provider.embed("hello world")
        expect(provider.model()).toBe("openai/text-embedding-3-small")
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("setModel with undefined clears the model", async () => {
    const httpLayer = makeMockHttpClient(() => new Response("{}", { status: 200 }))
    const configLayer = makeMockConfig({})
    const layer = defaultLayer.pipe(Layer.provide(httpLayer), Layer.provide(configLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        yield* provider.setModel("openai/text-embedding-3-small")
        yield* provider.setModel(undefined)
        const model = provider.model()
        expect(model).toBeUndefined()
      }).pipe(Effect.provide(layer)),
    )
  })
})
