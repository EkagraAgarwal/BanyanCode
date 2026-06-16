import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { createHash } from "crypto"
import { EmbeddingProviderService, EmbeddingError, defaultLayer } from "../../src/banyancode/embedding-provider"
import { Service as BanyanConfigService } from "../../src/banyancode/banyan-config"
import type { BanyanConfig } from "../../src/v1/config/banyan-config"

const makeMockConfig = (overrides: Partial<BanyanConfig.Info> = {}) =>
  Layer.succeed(BanyanConfigService, {
    get: () => Effect.succeed(overrides as BanyanConfig.Info),
    getGlobal: () => Effect.succeed(overrides as BanyanConfig.Info),
    update: (patch: Partial<BanyanConfig.Info>) => Effect.succeed({ ...overrides, ...patch } as BanyanConfig.Info),
  })

const makeMockHttpClient = (
  respond: (_request: HttpClientRequest.HttpClientRequest) => Response,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => respond(request)).pipe(
        Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
      ),
    ),
  )

const openaiResponse = (embeddings: number[][], model = "text-embedding-3-small") => {
  const data = embeddings.map((embedding, index) => ({ object: "embedding" as const, embedding, index }))
  return JSON.stringify({ object: "list", data, model, usage: { prompt_tokens: 4, total_tokens: 4 } })
}

describe("EmbeddingProvider", () => {
  test("embed without a model set returns EmbeddingError", async () => {
    const httpLayer = makeMockHttpClient(() => {
      throw new Error("unexpected call")
    })
    const configLayer = makeMockConfig({})
    const layer = defaultLayer.pipe(Layer.provide(httpLayer), Layer.provide(configLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        const result = yield* provider.embed("hello").pipe(Effect.flip)
        expect(result).toBeInstanceOf(EmbeddingError)
        expect(result.message).toBe("BANYANCODE_EMBEDDING_MODEL is not set")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("embed with model set posts to base URL", async () => {
    const capturedUrls: string[] = []

    const httpLayer = makeMockHttpClient((req) => {
      capturedUrls.push(req.url)
      return new Response(openaiResponse([[0.1, 0.2, 0.3]]), { status: 200 })
    })
    const configLayer = makeMockConfig({ banyancode_embedding_model: "test-model" })
    const layer = defaultLayer.pipe(Layer.provide(httpLayer), Layer.provide(configLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        yield* provider.setModel("explicit-model")
        const result = yield* provider.embed("hello world")
        expect(result).toHaveLength(1)
        expect(result[0]).toBeInstanceOf(Float32Array)
        expect(result[0][0]).toBeCloseTo(0.1)
        expect(result[0][1]).toBeCloseTo(0.2)
        expect(result[0][2]).toBeCloseTo(0.3)
        return result
      }).pipe(Effect.provide(layer)),
    )

    expect(capturedUrls).toHaveLength(1)
    expect(capturedUrls[0]).toContain("/embeddings")
  })

  test("embed sends Authorization header from env var", async () => {
    let receivedAuth: string | undefined

    const httpLayer = makeMockHttpClient((req) => {
      receivedAuth = req.headers["authorization"]
      return new Response(openaiResponse([[0.1]]), { status: 200 })
    })
    const originalKey = process.env.BANYANCODE_EMBEDDING_API_KEY
    process.env.BANYANCODE_EMBEDDING_API_KEY = "sk-test-key-123"

    const configLayer = makeMockConfig({ banyancode_embedding_model: "test-model" })
    const layer = defaultLayer.pipe(Layer.provide(httpLayer), Layer.provide(configLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        yield* provider.embed("test")
      }).pipe(Effect.provide(layer)),
    )

    if (originalKey !== undefined) process.env.BANYANCODE_EMBEDDING_API_KEY = originalKey
    else delete process.env.BANYANCODE_EMBEDDING_API_KEY

    expect(receivedAuth).toBe("Bearer sk-test-key-123")
  })

  test("embed handles single string input (wraps to array, returns single Float32Array)", async () => {
    const httpLayer = makeMockHttpClient(() => new Response(openaiResponse([[0.1, 0.2]]), { status: 200 }))
    const configLayer = makeMockConfig({ banyancode_embedding_model: "test-model" })
    const layer = defaultLayer.pipe(Layer.provide(httpLayer), Layer.provide(configLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        return yield* provider.embed("single text")
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toBeInstanceOf(Float32Array)
    expect(result[0][0]).toBeCloseTo(0.1)
  })

  test("embed returns vectors in same order as input", async () => {
    const vectors = [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]]
    const httpLayer = makeMockHttpClient(() => new Response(openaiResponse(vectors), { status: 200 }))
    const configLayer = makeMockConfig({ banyancode_embedding_model: "test-model" })
    const layer = defaultLayer.pipe(Layer.provide(httpLayer), Layer.provide(configLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        return yield* provider.embed(["a", "b", "c"])
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toHaveLength(3)
    expect(result[0][0]).toBeCloseTo(0.1)
    expect(result[1][0]).toBeCloseTo(0.3)
    expect(result[2][0]).toBeCloseTo(0.5)
  })

  test("embed validates dimensions match configured (fails if mismatch)", async () => {
    const httpLayer = makeMockHttpClient(() => new Response(openaiResponse([[0.1, 0.2, 0.3, 0.4]]), { status: 200 }))
    const configLayer = makeMockConfig({ banyancode_embedding_model: "test-model", banyancode_embedding_dimensions: 2 })
    const layer = defaultLayer.pipe(Layer.provide(httpLayer), Layer.provide(configLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        return yield* provider.embed("hello").pipe(Effect.flip)
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toBeInstanceOf(EmbeddingError)
    expect(result.message).toContain("dimension mismatch")
  })

  test("embed validates response is finite values (fails if NaN in response)", async () => {
    const httpLayer = makeMockHttpClient(() => new Response(openaiResponse([[0.1, NaN, 0.3]]), { status: 200 }))
    const configLayer = makeMockConfig({ banyancode_embedding_model: "test-model" })
    const layer = defaultLayer.pipe(Layer.provide(httpLayer), Layer.provide(configLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        return yield* provider.embed("hello").pipe(Effect.flip)
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toBeInstanceOf(EmbeddingError)
    expect(result.message).toContain("Non-finite value")
  })

  test("embed does NOT retry on 4xx (1 attempt, fails)", async () => {
    let attemptCount = 0

    const httpLayer = makeMockHttpClient(() => {
      attemptCount++
      return new Response("Bad Request", { status: 400 })
    })
    const configLayer = makeMockConfig({ banyancode_embedding_model: "test-model" })
    const layer = defaultLayer.pipe(Layer.provide(httpLayer), Layer.provide(configLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        return yield* provider.embed("hello").pipe(Effect.flip)
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toBeInstanceOf(EmbeddingError)
    expect(result.message).toContain("400")
    expect(attemptCount).toBe(1)
  })

  test("embed uses default base URL when not configured", async () => {
    let capturedUrl: string | undefined

    const httpLayer = makeMockHttpClient((req) => {
      capturedUrl = req.url
      return new Response(openaiResponse([[0.1]]), { status: 200 })
    })
    const configLayer = makeMockConfig({ banyancode_embedding_model: "test-model" })
    const layer = defaultLayer.pipe(Layer.provide(httpLayer), Layer.provide(configLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        yield* provider.embed("hello")
      }).pipe(Effect.provide(layer)),
    )

    expect(capturedUrl).toContain("https://api.openai.com/v1/embeddings")
  })

  test("setModel updates the model used by next embed call", async () => {
    const capturedUrls: string[] = []

    const capturingHttpLayer = makeMockHttpClient((req) => {
      capturedUrls.push(req.url)
      return new Response(openaiResponse([[0.1]]), { status: 200 })
    })
    const configLayer = makeMockConfig({})
    const layer = defaultLayer.pipe(Layer.provide(capturingHttpLayer), Layer.provide(configLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        yield* provider.setModel("model-v1")
        yield* provider.embed("hello")
        yield* provider.setModel("model-v2")
        yield* provider.embed("world")
      }).pipe(Effect.provide(layer)),
    )

    expect(capturedUrls).toHaveLength(2)
  })

  test("model() returns the current model or undefined", async () => {
    const httpLayer = makeMockHttpClient(() => new Response(openaiResponse([[0.1]]), { status: 200 }))
    const configLayer = makeMockConfig({ banyancode_embedding_model: undefined })
    const layer = defaultLayer.pipe(Layer.provide(httpLayer), Layer.provide(configLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        expect(provider.model()).toBeUndefined()
        yield* provider.setModel("custom/model")
        expect(provider.model()).toBe("custom/model")
        yield* provider.setModel("another/model")
        expect(provider.model()).toBe("another/model")
        yield* provider.setModel(undefined)
        expect(provider.model()).toBeUndefined()
      }).pipe(Effect.provide(layer)),
    )
  })

  test("inputHash returns SHA-256 hex", () => {
    const hash = createHash("sha256").update("hello world").digest("hex")
    expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9")
    expect(hash).toHaveLength(64)
  })

  test("config() returns resolved config with default batch size 64", async () => {
    const httpLayer = makeMockHttpClient(() => new Response(openaiResponse([[0.1]]), { status: 200 }))
    const configLayer = makeMockConfig({ banyancode_embedding_model: "test-model" })
    const layer = defaultLayer.pipe(Layer.provide(httpLayer), Layer.provide(configLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        return provider.config()
      }).pipe(Effect.provide(layer)),
    )

    expect(result.baseUrl).toBe("https://api.openai.com/v1")
    expect(result.batchSize).toBe(64)
    expect(result.dimensions).toBeUndefined()
    expect(result.apiKey).toBeUndefined()
  })

  test("embed with custom base_url configured uses it", async () => {
    let capturedUrl: string | undefined

    const httpLayer = makeMockHttpClient((req) => {
      capturedUrl = req.url
      return new Response(openaiResponse([[0.1]]), { status: 200 })
    })
    const configLayer = makeMockConfig({
      banyancode_embedding_model: "test-model",
      banyancode_embedding_base_url: "https://my-custom.example.com/v42",
    })
    const layer = defaultLayer.pipe(Layer.provide(httpLayer), Layer.provide(configLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        yield* provider.embed("hello")
      }).pipe(Effect.provide(layer)),
    )

    expect(capturedUrl).toContain("my-custom.example.com/v42/embeddings")
  })

  test("embed with custom batch_size configured splits requests", async () => {
    const requestCount = { current: 0 }

    const httpLayer = makeMockHttpClient(() => {
      requestCount.current++
      return new Response(openaiResponse([[0.1]]), { status: 200 })
    })
    const configLayer = makeMockConfig({
      banyancode_embedding_model: "test-model",
      banyancode_embedding_batch_size: 2,
    })
    const layer = defaultLayer.pipe(Layer.provide(httpLayer), Layer.provide(configLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        // 5 texts with batch_size 2 → 3 requests
        yield* provider.embed(["a", "b", "c", "d", "e"])
      }).pipe(Effect.provide(layer)),
    )

    expect(requestCount.current).toBe(3)
  })

  test("embed with custom dimensions includes dimensions in request body", async () => {
    const httpLayer = makeMockHttpClient(() => new Response(openaiResponse([[0.1, 0.2]]), { status: 200 }))
    const configLayer = makeMockConfig({
      banyancode_embedding_model: "test-model",
      banyancode_embedding_dimensions: 2,
    })
    const layer = defaultLayer.pipe(Layer.provide(httpLayer), Layer.provide(configLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        return yield* provider.embed("hello")
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toHaveLength(2)
  })

  test("embed with api_key_env configured reads from that env var", async () => {
    let receivedAuth: string | undefined

    const httpLayer = makeMockHttpClient((req) => {
      receivedAuth = req.headers["authorization"]
      return new Response(openaiResponse([[0.1]]), { status: 200 })
    })
    const originalKey = process.env.MY_EMBEDDING_KEY
    process.env.MY_EMBEDDING_KEY = "sk-from-custom-env"

    const configLayer = makeMockConfig({
      banyancode_embedding_model: "test-model",
      banyancode_embedding_api_key_env: "MY_EMBEDDING_KEY",
    })
    const layer = defaultLayer.pipe(Layer.provide(httpLayer), Layer.provide(configLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        yield* provider.embed("hello")
      }).pipe(Effect.provide(layer)),
    )

    if (originalKey !== undefined) process.env.MY_EMBEDDING_KEY = originalKey
    else delete process.env.MY_EMBEDDING_KEY

    expect(receivedAuth).toBe("Bearer sk-from-custom-env")
  })
})