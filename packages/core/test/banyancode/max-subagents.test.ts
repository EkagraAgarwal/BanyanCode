import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { MaxSubagents } from "../../src/banyancode/max-subagents"
import { MaxSubagentsError } from "../../src/banyancode/max-subagents"
import { BanyanConfigService } from "../../src/banyancode/banyan-config"
import { FSUtil } from "../../src/fs-util"
import { DEFAULT_MAX_SUBAGENTS, MAX_SUBAGENTS_LIMIT } from "../../src/v1/config/banyan-config"

const makeMockConfig = (config: Record<string, unknown> = {}) =>
  Layer.succeed(
    BanyanConfigService.Service,
    BanyanConfigService.Service.of({
      get: () => Effect.succeed(config as any),
      getGlobal: () => Effect.succeed(config as any),
      update: (patch: any) => Effect.succeed({ ...config, ...patch } as any),
    }),
  )

// Build test layer with mock config taking precedence
const buildTestLayer = (config: Record<string, unknown> = {}) =>
  MaxSubagents.layer.pipe(
    Layer.provide(makeMockConfig(config)),
    Layer.provide(BanyanConfigService.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
  )

describe("MaxSubagents", () => {
  test("current returns configured value", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* MaxSubagents.Service
        const value = yield* svc.current()
        expect(value).toBe(8)
      }).pipe(Effect.provide(buildTestLayer({ banyancode_max_subagents: 8 }))),
    )
  })

  test("current returns default when unset", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* MaxSubagents.Service
        const value = yield* svc.current()
        expect(value).toBe(DEFAULT_MAX_SUBAGENTS)
      }).pipe(Effect.provide(buildTestLayer())),
    )
  })

  test("validate accepts valid values", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* MaxSubagents.Service
        expect(yield* svc.validate(1)).toBe(1)
        expect(yield* svc.validate(10)).toBe(10)
        expect(yield* svc.validate(MAX_SUBAGENTS_LIMIT)).toBe(MAX_SUBAGENTS_LIMIT)
      }).pipe(Effect.provide(buildTestLayer())),
    )
  })

  test("validate rejects out-of-range values", async () => {
    let error: unknown = null
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* MaxSubagents.Service
          yield* svc.validate(0)
        }).pipe(Effect.provide(buildTestLayer())),
      )
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(MaxSubagentsError)
  })
})
