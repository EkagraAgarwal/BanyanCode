import { describe, expect, test } from "bun:test"

const ctxModule = await import("../../../src/feature-plugins/sidebar/context" as any)
const {
  categorizeTokens,
  sumToolTokens,
  estimateTokens,
  cachedSumToolTokens,
  cachedTaskSpawnPromptTokens,
  clearPartTokenCache,
  partTokenCacheStats,
} = (ctxModule.__test ?? ctxModule.default?.__test) as {
  categorizeTokens: any
  sumToolTokens: any
  estimateTokens: any
  cachedSumToolTokens: any
  cachedTaskSpawnPromptTokens: any
  clearPartTokenCache: () => void
  partTokenCacheStats: () => { entries: number; computes: number }
}

const toolPart = (id: string, output: string, status = "completed") => ({
  id,
  sessionID: "session_test",
  messageID: "msg-1",
  type: "tool" as const,
  callID: `call-${id}`,
  tool: "bash",
  state: {
    status,
    input: { cmd: "ls -la" },
    output,
    content: [{ type: "text" as const, text: output }],
  },
})

const assistant = {
  id: "msg-1",
  type: "assistant" as const,
  role: "assistant" as const,
  tokens: { input: 5000, output: 3000, reasoning: 1000, cache: { read: 0, write: 0 } },
  modelID: "test-model",
  providerID: "test-provider",
  time: { created: 0, completed: 1000 },
}

const user = {
  id: "msg-u1",
  type: "user" as const,
  role: "user" as const,
  text: "hello",
  time: { created: 0 },
}

describe("incremental context-sidebar accounting", () => {
  test("cached tool tokens equal the direct computation", () => {
    clearPartTokenCache()
    const part = toolPart("cache-eq", "x".repeat(1000))
    expect(cachedSumToolTokens(part)).toBe(sumToolTokens(part))
  })

  test("repeat categorization recomputes nothing (delta from unchanged parts)", () => {
    clearPartTokenCache()
    const parts = [toolPart("cache-delta", "y".repeat(5000))]
    const getter = () => parts
    categorizeTokens([user as any, assistant as any], getter)
    const first = partTokenCacheStats().computes
    expect(first).toBeGreaterThan(0)
    categorizeTokens([user as any, assistant as any], getter)
    expect(partTokenCacheStats().computes).toBe(first)
  })

  test("changed output invalidates the entry and recomputes", () => {
    clearPartTokenCache()
    const before = toolPart("cache-inv", "short")
    const after = toolPart("cache-inv", "short plus much more output here")
    expect(cachedSumToolTokens(before)).toBe(sumToolTokens(before))
    const computes = partTokenCacheStats().computes
    expect(cachedSumToolTokens(after)).toBe(sumToolTokens(after))
    expect(partTokenCacheStats().computes).toBe(computes + 1)
    expect(cachedSumToolTokens(after)).toBeGreaterThan(cachedSumToolTokens(before))
  })

  test("status transition pending -> completed invalidates the entry", () => {
    clearPartTokenCache()
    const pending = toolPart("cache-status", "", "pending")
    const done = toolPart("cache-status", "done output", "completed")
    const pendingTokens = cachedSumToolTokens(pending)
    const computes = partTokenCacheStats().computes
    expect(cachedSumToolTokens(done)).toBe(sumToolTokens(done))
    expect(partTokenCacheStats().computes).toBe(computes + 1)
    expect(pendingTokens).not.toBe(cachedSumToolTokens(done))
  })

  test("parts without an id bypass the cache without throwing", () => {
    clearPartTokenCache()
    const { id: _dropped, ...noId } = toolPart("cache-noid", "abc")
    expect(cachedSumToolTokens(noId)).toBe(sumToolTokens(noId))
    expect(partTokenCacheStats().entries).toBe(0)
  })

  test("task spawn prompt tokens are cached per input", () => {
    clearPartTokenCache()
    const task = {
      id: "cache-task",
      sessionID: "session_test",
      messageID: "msg-1",
      type: "tool" as const,
      callID: "call-task",
      tool: "task",
      state: { status: "completed", input: { prompt: "investigate the auth module" } },
    }
    expect(cachedTaskSpawnPromptTokens(task)).toBe(estimateTokens("investigate the auth module"))
    const computes = partTokenCacheStats().computes
    expect(cachedTaskSpawnPromptTokens(task)).toBe(estimateTokens("investigate the auth module"))
    expect(partTokenCacheStats().computes).toBe(computes)
  })

  test("categorizeTokens buckets are identical with and without the cache", () => {
    clearPartTokenCache()
    const parts = [toolPart("cache-parity", "z".repeat(3000))]
    const getter = (id: string) => (id === "msg-1" ? parts : [])
    const cat = categorizeTokens([user as any, assistant as any], getter)
    // Direct computation for comparison (bypasses the cache: fresh ids).
    const direct = toolPart("cache-parity-direct", "z".repeat(3000))
    expect(cat!.tools).toBe(sumToolTokens(direct))
  })
})
