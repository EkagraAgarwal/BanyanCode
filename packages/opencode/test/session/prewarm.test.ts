import { beforeEach, describe, expect, test } from "bun:test"
import { maybePrewarm, prewarmFiredCount, resetPrewarm } from "@/session/prewarm"

const base = {
  providerID: "openai",
  modelID: "gpt-5.6",
  promptCacheMode: "implicit",
  enabled: true,
  stablePrefix: "system-prefix",
}

beforeEach(() => {
  resetPrewarm()
})

describe("session.prewarm gate (WS6)", () => {
  test("disabled (default: banyancode_prompt_cache_prewarm unset) is a no-op", async () => {
    await maybePrewarm({ ...base, enabled: false })
    expect(prewarmFiredCount()).toBe(0)
  })

  test("non-openai provider is a no-op", async () => {
    await maybePrewarm({ ...base, providerID: "anthropic" })
    expect(prewarmFiredCount()).toBe(0)
  })

  test("prompt cache mode off is a no-op", async () => {
    await maybePrewarm({ ...base, promptCacheMode: "off" })
    expect(prewarmFiredCount()).toBe(0)
  })

  test("pre-5.6 / gpt-60 models are a no-op (anchored model gate)", async () => {
    await maybePrewarm({ ...base, modelID: "gpt-5.2" })
    await maybePrewarm({ ...base, modelID: "gpt-60" })
    expect(prewarmFiredCount()).toBe(0)
  })

  test("second call with the same model+prefix within 30min is skipped (idempotent)", async () => {
    await maybePrewarm(base)
    await maybePrewarm(base)
    expect(prewarmFiredCount()).toBe(1)
  })

  test("different stable prefix hashes fire again; gpt-6 family passes the gate", async () => {
    await maybePrewarm(base)
    await maybePrewarm({ ...base, stablePrefix: "other-prefix" })
    await maybePrewarm({ ...base, modelID: "gpt-6-astra" })
    expect(prewarmFiredCount()).toBe(3)
  })
})
