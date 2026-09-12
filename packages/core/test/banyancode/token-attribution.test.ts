import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Usage } from "@opencode-ai/llm"
import { TokenAttribution, type TokenAttributionInput } from "../../src/banyancode/token-attribution"

const baseInput = (overrides: Partial<TokenAttributionInput> = {}): TokenAttributionInput => ({
  callID: "call-1",
  modelID: "model-1",
  provider: "openai",
  sessionID: "session-1",
  parentSessionID: "parent-1",
  agentRole: "build",
  depth: 2,
  startedAt: 1_000,
  durationMs: 42,
  status: "success",
  usage: new Usage({
    inputTokens: 100,
    outputTokens: 30,
    reasoningTokens: 10,
    cacheReadInputTokens: 20,
    cacheWriteInputTokens: 5,
    totalTokens: 130,
  }),
  trace: { traceName: "model.call", parentTraceName: "agent.run" },
  ...overrides,
})

const withAttribution = <A>(effect: Effect.Effect<A, never, TokenAttribution.Service>, options = {}) =>
  Effect.runPromise(effect.pipe(Effect.provide(TokenAttribution.layer(options))))

describe("TokenAttribution", () => {
  test("records normalized usage and call lineage without provider payloads", async () => {
    await withAttribution(
      Effect.gen(function* () {
        const service = yield* TokenAttribution.Service
        yield* service.record(baseInput())
        const [event] = yield* service.recent()
        expect(event).toMatchObject({
          callID: "call-1",
          modelID: "model-1",
          provider: "openai",
          sessionID: "session-1",
          parentSessionID: "parent-1",
          agentRole: "build",
          depth: 2,
          inputTokens: 100,
          outputTokens: 30,
          reasoningTokens: 10,
          cacheReadInputTokens: 20,
          cacheWriteInputTokens: 5,
          uncachedInputTokens: 75,
          traceName: "model.call",
          parentTraceName: "agent.run",
        })
        expect(event).not.toHaveProperty("providerMetadata")
      }),
    )
  })

  test("does not derive uncached tokens until cache components are known", async () => {
    await withAttribution(
      Effect.gen(function* () {
        const service = yield* TokenAttribution.Service
        yield* service.record(
          baseInput({
            usage: new Usage({ inputTokens: 100, cacheReadInputTokens: 20 }),
          }),
        )
        const [event] = yield* service.recent()
        expect(event?.uncachedInputTokens).toBeUndefined()
      }),
    )
  })

  test("bounds events and removes expired entries", async () => {
    await withAttribution(
      Effect.gen(function* () {
        const service = yield* TokenAttribution.Service
        yield* service.record(baseInput({ callID: "old", startedAt: 0 }))
        yield* service.record(baseInput({ callID: "one", startedAt: 900 }))
        yield* service.record(baseInput({ callID: "two", startedAt: 1_000 }))
        expect(yield* service.count()).toBe(2)
        expect((yield* service.recent()).map((event) => event.callID)).toEqual(["one", "two"])
      }),
      { maxEvents: 2, retentionMs: 500 },
    )
  })
})
