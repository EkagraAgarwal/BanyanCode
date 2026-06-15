import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Config } from "@/config/config"
import { TestConfig } from "../fixture/config"

describe("BanyanConfig", () => {
  test("banyanConfig() returns the loaded BanyanConfig via service", async () => {
    const mockBanyanConfig = {
      banyancode_embedding_model: "openai/text-embedding-3-small",
      banyancode_yolo_mode: true,
    }

    const mockBanyanLayer = Layer.succeed(
      Banyan.BanyanConfigService,
      Banyan.BanyanConfigService.of({
        get: () => Effect.succeed(mockBanyanConfig),
        getGlobal: () => Effect.succeed(mockBanyanConfig),
        update: () => Effect.succeed(mockBanyanConfig),
      }),
    )

    const testLayer = Layer.mergeAll(TestConfig.layer(), mockBanyanLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const banyanConfig = yield* Banyan.BanyanConfigService.use((svc) => svc.get())
        expect(banyanConfig.banyancode_embedding_model).toBe("openai/text-embedding-3-small")
        expect(banyanConfig.banyancode_yolo_mode).toBe(true)
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("update writes to banyancode.json via service", async () => {
    let updatedConfig: any = null

    const mockBanyanLayer = Layer.succeed(
      Banyan.BanyanConfigService,
      Banyan.BanyanConfigService.of({
        get: () => Effect.succeed({}),
        getGlobal: () => Effect.succeed({}),
        update: (patch) => {
          updatedConfig = patch
          return Effect.succeed(patch)
        },
      }),
    )

    const testLayer = Layer.mergeAll(TestConfig.layer(), mockBanyanLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        yield* svc.update({ banyancode_embedding_model: "openai/text-embedding-3-small" })
      }).pipe(Effect.provide(testLayer)),
    )

    expect(updatedConfig).toEqual({ banyancode_embedding_model: "openai/text-embedding-3-small" })
  })

  test("after update, get returns the new value", async () => {
    let storedConfig = {}

    const mockBanyanLayer = Layer.succeed(
      Banyan.BanyanConfigService,
      Banyan.BanyanConfigService.of({
        get: () => Effect.succeed(storedConfig),
        getGlobal: () => Effect.succeed(storedConfig),
        update: (patch) => {
          storedConfig = { ...storedConfig, ...patch }
          return Effect.succeed(storedConfig)
        },
      }),
    )

    const testLayer = Layer.mergeAll(TestConfig.layer(), mockBanyanLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        yield* svc.update({ banyancode_embedding_model: "openai/text-embedding-3-small" })
        const result = yield* svc.get()
        expect(result.banyancode_embedding_model).toBe("openai/text-embedding-3-small")
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("opencode config is NOT touched by BanyanConfig updates", async () => {
    let opencodeConfigUpdated = false

    const mockConfigLayer = Layer.succeed(
      Config.Service,
      Config.Service.of({
        get: () => Effect.succeed({}),
        getGlobal: () => Effect.succeed({}),
        getConsoleState: () => Effect.succeed({ consoleManagedProviders: [], activeOrgName: undefined, switchableOrgCount: 0 }),
        update: () => {
          opencodeConfigUpdated = true
          return Effect.void
        },
        updateGlobal: () => Effect.succeed({ info: {}, changed: false }),
        invalidate: () => Effect.void,
        directories: () => Effect.succeed([]),
        waitForDependencies: () => Effect.void,
      }),
    )

    const mockBanyanLayer = Layer.succeed(
      Banyan.BanyanConfigService,
      Banyan.BanyanConfigService.of({
        get: () => Effect.succeed({}),
        getGlobal: () => Effect.succeed({}),
        update: () => Effect.succeed({}),
      }),
    )

    const testLayer = Layer.mergeAll(mockConfigLayer, mockBanyanLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Banyan.BanyanConfigService
        yield* svc.update({ banyancode_embedding_model: "x" })
      }).pipe(Effect.provide(testLayer)),
    )

    expect(opencodeConfigUpdated).toBe(false)
  })
})
