import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { BanyanAgentSaveInput } from "../../src/server/routes/instance/httpapi/groups/global"

describe("BanyanAgentSaveInput schema validation for tools", () => {
  const decodePromise = (input: unknown) =>
    Effect.runPromise(
      Schema.decodeUnknownExit(BanyanAgentSaveInput)(input).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      ),
    )

  test("accepts valid tools array", async () => {
    const result = await decodePromise({
      name: "test-agent",
      tools: ["read", "write", "bash"],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tools).toEqual(["read", "write", "bash"])
    }
  })

  test("accepts empty tools array", async () => {
    const result = await decodePromise({
      name: "test-agent",
      tools: [],
    })
    expect(result.ok).toBe(true)
  })

  test("accepts tools with max length items", async () => {
    const result = await decodePromise({
      name: "test-agent",
      tools: ["a".repeat(128)],
    })
    expect(result.ok).toBe(true)
  })

  test("rejects tools item longer than 128 chars", async () => {
    const result = await decodePromise({
      name: "test-agent",
      tools: ["a".repeat(129)],
    })
    expect(result.ok).toBe(false)
  })

  test("rejects tools with path traversal", async () => {
    const result = await decodePromise({
      name: "test-agent",
      tools: ["../escape"],
    })
    expect(result.ok).toBe(false)
  })

  test("rejects tools with absolute path", async () => {
    const result = await decodePromise({
      name: "test-agent",
      tools: ["/etc/passwd"],
    })
    expect(result.ok).toBe(false)
  })

  test("accepts both permission and tools", async () => {
    const result = await decodePromise({
      name: "test-agent",
      permission: ["read", "write"],
      tools: ["code_find", "memory_store"],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.permission).toEqual(["read", "write"])
      expect(result.value.tools).toEqual(["code_find", "memory_store"])
    }
  })

  test("tools is optional (absent is ok)", async () => {
    const result = await decodePromise({
      name: "test-agent",
      description: "A test agent",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tools).toBeUndefined()
    }
  })
})
