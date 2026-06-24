import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { Banyan } from "@opencode-ai/core/banyancode"
import { CodegraphEmbedService } from "@opencode-ai/core/banyancode/codegraph-embed-service"
import { EmbeddingError } from "@opencode-ai/core/banyancode/embedding-provider"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

const makeMockEmbedder = (options: {
  allResult?: { embedded: number; skipped: number; total: number; model?: string }
  allError?: Error
  fileResult?: { embedded: number; skipped: number; total: number; model?: string }
  fileError?: Error
  delayMs?: number
}) => {
  const allSuccess: { embedded: number; skipped: number; total: number; model: string | undefined } = {
    embedded: options.allResult?.embedded ?? 0,
    skipped: options.allResult?.skipped ?? 0,
    total: options.allResult?.total ?? 0,
    model: options.allResult?.model ?? "test-model",
  }
  const fileSuccess: { embedded: number; skipped: number; total: number; model: string | undefined } = {
    embedded: options.fileResult?.embedded ?? 0,
    skipped: options.fileResult?.skipped ?? 0,
    total: options.fileResult?.total ?? 0,
    model: options.fileResult?.model ?? "test-model",
  }

  const mkError = (msg: string) => new EmbeddingError({ message: msg })

  const embedAll: Effect.Effect<
    { embedded: number; skipped: number; total: number; model: string | undefined },
    EmbeddingError,
    never
  > = options.allError
    ? Effect.fail(mkError(options.allError.message))
    : Effect.gen(function* () {
        if (options.delayMs) yield* Effect.sleep(options.delayMs)
        return allSuccess
      })

  const embedFile: Effect.Effect<
    { embedded: number; skipped: number; total: number; model: string | undefined },
    EmbeddingError,
    never
  > = options.fileError
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

const stubBoot = Layer.succeed(
  PluginBoot.Service,
  PluginBoot.Service.of({ wait: () => Effect.void }),
)

function buildLayer(mock: Layer.Layer<Banyan.CodegraphEmbedder, never, never>, dbLayer: Layer.Layer<Database.Service>) {
  // Build EventV2 layer with our dbLayer so it doesn't use the global Database.
  const eventLayer = EventV2.layer.pipe(Layer.provide(dbLayer))
  return CodegraphEmbedService.layer.pipe(
    Layer.provide(mock),
    Layer.provide(stubPlugin),
    Layer.provide(stubBoot),
    Layer.provide(dbLayer),
    Layer.provide(eventLayer),
  )
}

describe("CodegraphEmbedService", () => {
  test("starts in idle state", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(`${tmp.path}/test.sqlite`)
    const mock = makeMockEmbedder({})
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CodegraphEmbedService.Service
        const state = yield* svc.status()
        expect(state.status).toBe("idle")
      }).pipe(Effect.provide(buildLayer(mock, dbLayer))),
    )
  })

  test("start() forks work, transitions to completed, and persists state", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(`${tmp.path}/test.sqlite`)
    const mock = makeMockEmbedder({ allResult: { embedded: 5, skipped: 2, total: 7, model: "test-model" } })

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
        expect(state.done).toBe(7)
        expect(state.total).toBe(7)
      }).pipe(Effect.provide(buildLayer(mock, dbLayer)), Effect.scoped),
    )
  })

  test("completed state uses the real graph total even when every embed fails", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(`${tmp.path}/test.sqlite`)
    // No embedded or skipped, but the graph has 12 nodes — done/total should still
    // reflect the real count so the TUI doesn't show '0/0' (the pre-fix bug).
    const mock = makeMockEmbedder({ allResult: { embedded: 0, skipped: 0, total: 12, model: "test-model" } })

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CodegraphEmbedService.Service
        yield* svc.start({})
        yield* Effect.sleep(50)
        const state = yield* svc.status()
        if (state.status !== "completed") {
          throw new Error(`expected completed, got ${state.status}: ${state.error}`)
        }
        expect(state.done).toBe(12)
        expect(state.total).toBe(12)
        expect(state.result?.embedded).toBe(0)
        expect(state.result?.skipped).toBe(0)
      }).pipe(Effect.provide(buildLayer(mock, dbLayer)), Effect.scoped),
    )
  })

  test("start({ file }) uses embedFile", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(`${tmp.path}/test.sqlite`)
    let calledWith: string | undefined
    const mock = Layer.succeed(
      Banyan.CodegraphEmbedder,
      Banyan.CodegraphEmbedder.of({
        embedAll: () =>
          Effect.succeed({ embedded: 0, skipped: 0, total: 0, model: "test-model" }),
        embedFile: (fileID: string) =>
          Effect.gen(function* () {
            calledWith = fileID
            return { embedded: 3, skipped: 1, total: 4, model: "test-model" }
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
      }).pipe(Effect.provide(buildLayer(mock, dbLayer)), Effect.scoped),
    )
  })

  test("start() failure transitions to failed state with error message", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(`${tmp.path}/test.sqlite`)
    const mock = makeMockEmbedder({ allError: new Error("model not configured") })

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CodegraphEmbedService.Service
        yield* svc.start({})
        yield* Effect.sleep(50)
        const state = yield* svc.status()
        expect(state.status).toBe("failed")
        expect(state.error).toContain("model not configured")
      }).pipe(Effect.provide(buildLayer(mock, dbLayer)), Effect.scoped),
    )
  })
})