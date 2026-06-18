import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { Banyan } from "@opencode-ai/core/banyancode"
import { CodegraphEmbedService } from "@opencode-ai/core/banyancode/codegraph-embed-service"
import { EmbeddingError } from "@opencode-ai/core/banyancode/embedding-provider"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

const makeMockEmbedder = (options: {
  allResult?: { embedded: number; skipped: number; model: string | undefined }
  allError?: Error
  fileResult?: { embedded: number; skipped: number }
  fileError?: Error
  delayMs?: number
}) => {
  const allSuccess: { embedded: number; skipped: number; model: string | undefined } = options.allResult ?? {
    embedded: 0,
    skipped: 0,
    model: "test-model",
  }
  const fileSuccess: { embedded: number; skipped: number } = options.fileResult ?? { embedded: 0, skipped: 0 }

  const mkError = (msg: string) => new EmbeddingError({ message: msg })

  const embedAll: Effect.Effect<
    { embedded: number; skipped: number; model: string | undefined },
    EmbeddingError,
    never
  > = options.allError
    ? Effect.fail(mkError(options.allError.message))
    : Effect.gen(function* () {
        if (options.delayMs) yield* Effect.sleep(options.delayMs)
        return allSuccess
      })

  const embedFile: Effect.Effect<{ embedded: number; skipped: number }, EmbeddingError, never> = options.fileError
    ? Effect.fail(mkError(options.fileError.message))
    : Effect.gen(function* () {
        if (options.delayMs) yield* Effect.sleep(options.delayMs)
        return fileSuccess
      })

  return Layer.succeed(
    Banyan.CodegraphEmbedder,
    Banyan.CodegraphEmbedder.of({
      embedAll: () => embedAll,
      embedFile: (_fileID: string) => embedFile,
      embedNode: () => Effect.void,
    }),
  )
}

const stubPlugin = Layer.succeed(
  PluginV2.Service,
  PluginV2.Service.of({
    add: () => Effect.void,
    remove: () => Effect.void,
    trigger: () => Effect.succeed({ embeddings: [] } as any),
    triggerFor: () => Effect.succeed({ embeddings: [] } as any),
  }),
)

function buildLayer(mock: Layer.Layer<Banyan.CodegraphEmbedder, never, never>) {
  return CodegraphEmbedService.layer.pipe(
    Layer.provide(mock),
    Layer.provide(stubPlugin),
    Layer.provide(EventV2.defaultLayer),
  )
}

describe("CodegraphEmbedService", () => {
  test("starts in idle state", async () => {
    const mock = makeMockEmbedder({})
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CodegraphEmbedService.Service
        const state = yield* svc.status()
        expect(state.status).toBe("idle")
      }).pipe(Effect.provide(buildLayer(mock))),
    )
  })

  test("start() forks work, transitions to completed, and persists state", async () => {
    await tmpdir()
    const mock = makeMockEmbedder({ allResult: { embedded: 5, skipped: 2, model: "test-model" } })

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CodegraphEmbedService.Service
        yield* svc.start({})
        yield* Effect.sleep(50)
        const state = yield* svc.status()
        if (state.status !== "completed") {
          throw new Error(`expected completed, got ${state.status}: ${state.error}`)
        }
        expect(state.result?.embedded).toBe(5)
        expect(state.result?.skipped).toBe(2)
      }).pipe(Effect.provide(buildLayer(mock)), Effect.scoped),
    )
  })

  test("start({ file }) uses embedFile", async () => {
    await tmpdir()
    let calledWith: string | undefined
    const mock = Layer.succeed(
      Banyan.CodegraphEmbedder,
      Banyan.CodegraphEmbedder.of({
        embedAll: () => Effect.succeed({ embedded: 0, skipped: 0, model: "test-model" }),
        embedFile: (fileID: string) =>
          Effect.gen(function* () {
            calledWith = fileID
            return { embedded: 3, skipped: 1 }
          }),
        embedNode: () => Effect.void,
      }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CodegraphEmbedService.Service
        yield* svc.start({ file: "src/foo.ts" })
        yield* Effect.sleep(50)
        expect(calledWith).toBe("src/foo.ts")
        const state = yield* svc.status()
        if (state.status !== "completed") {
          throw new Error(`expected completed, got ${state.status}: ${state.error}`)
        }
        expect(state.result?.embedded).toBe(3)
      }).pipe(Effect.provide(buildLayer(mock)), Effect.scoped),
    )
  })

  test("start() failure transitions to failed state with error message", async () => {
    await tmpdir()
    const mock = makeMockEmbedder({ allError: new Error("model not configured") })

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CodegraphEmbedService.Service
        yield* svc.start({})
        yield* Effect.sleep(50)
        const state = yield* svc.status()
        expect(state.status).toBe("failed")
        expect(state.error).toContain("model not configured")
      }).pipe(Effect.provide(buildLayer(mock)), Effect.scoped),
    )
  })
})