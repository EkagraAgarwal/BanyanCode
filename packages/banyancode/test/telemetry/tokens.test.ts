import { describe, expect, test } from "bun:test"
import { make } from "../../src/telemetry/tokens.js"

const tokens = (input: number, output: number, reasoning = 0, read = 0, write = 0) => ({
  input,
  output,
  reasoning,
  cache: { read, write },
})

describe("token attribution ring", () => {
  test("normalizes usage and computes the total", () => {
    const store = make()
    store.record({ sessionID: "ses_a", costUsd: 0.25, tokens: tokens(10, 5, 2, 3, 1), recordedAt: 1000 })
    const [event] = store.recent()
    expect(event).toEqual({
      sessionID: "ses_a",
      costUsd: 0.25,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadInputTokens: 3,
      cacheWriteInputTokens: 1,
      totalTokens: 21,
      recordedAt: 1000,
    })
  })

  test("carries model and agent attribution when supplied", () => {
    const store = make()
    store.record({
      sessionID: "ses_a",
      providerID: "openai",
      modelID: "gpt-5.6",
      agent: "build",
      costUsd: 0.1,
      tokens: tokens(1, 1),
      recordedAt: 1000,
    })
    expect(store.recent()[0]).toMatchObject({
      providerID: "openai",
      modelID: "gpt-5.6",
      agent: "build",
    })
  })

  test("bounds the ring and filters by session and time", () => {
    const store = make({ maxEvents: 2 })
    store.record({ sessionID: "ses_a", costUsd: 0.1, tokens: tokens(1, 1), recordedAt: 1000 })
    store.record({ sessionID: "ses_b", costUsd: 0.2, tokens: tokens(2, 2), recordedAt: 2000 })
    store.record({ sessionID: "ses_a", costUsd: 0.3, tokens: tokens(3, 3), recordedAt: 3000 })
    expect(store.count()).toBe(2)
    expect(store.recent().map((event) => event.recordedAt)).toEqual([2000, 3000])
    expect(store.recent({ sessionID: "ses_a" }).map((event) => event.recordedAt)).toEqual([3000])
    expect(store.recent({ since: 2500 }).map((event) => event.recordedAt)).toEqual([3000])
  })

  test("drops events older than the retention window", () => {
    const store = make({ retentionMs: 1000 })
    store.record({ sessionID: "ses_a", costUsd: 0.1, tokens: tokens(1, 1), recordedAt: 1000 })
    store.record({ sessionID: "ses_a", costUsd: 0.1, tokens: tokens(1, 1), recordedAt: 2500 })
    expect(store.recent().map((event) => event.recordedAt)).toEqual([2500])
  })

  test("disabled attribution records nothing", () => {
    const store = make({ enabled: false })
    store.record({ sessionID: "ses_a", costUsd: 0.1, tokens: tokens(1, 1), recordedAt: 1000 })
    expect(store.count()).toBe(0)
  })
})
