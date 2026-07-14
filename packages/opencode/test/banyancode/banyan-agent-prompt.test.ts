import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { BanyanAgentPromptUpdateInput } from "../../src/server/routes/instance/httpapi/groups/global"

describe("BanyanAgentPromptUpdateInput schema validation", () => {
  const decodePromise = (input: unknown) =>
    Effect.runPromise(
      Schema.decodeUnknownExit(BanyanAgentPromptUpdateInput)(input).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      ),
    )

  test("accepts valid agent name", async () => {
    const result = await decodePromise({ name: "coder", prompt: "Hello, coder!" })
    expect(result.ok).toBe(true)
  })

  test("accepts name with dots, underscores, hyphens", async () => {
    const result = await decodePromise({ name: "my_agent.v2-beta", prompt: "Test prompt" })
    expect(result.ok).toBe(true)
  })

  test("rejects name with path traversal", async () => {
    const result = await decodePromise({ name: "../../../etc/passwd", prompt: "Test" })
    expect(result.ok).toBe(false)
  })

  test("rejects name with forward slash", async () => {
    const result = await decodePromise({ name: "foo/bar", prompt: "Test" })
    expect(result.ok).toBe(false)
  })

  test("rejects empty name", async () => {
    const result = await decodePromise({ name: "", prompt: "Test" })
    expect(result.ok).toBe(false)
  })

  test("accepts valid prompt", async () => {
    const result = await decodePromise({ name: "coder", prompt: "A reasonable prompt" })
    expect(result.ok).toBe(true)
  })

  test("accepts empty prompt (clear behavior)", async () => {
    const result = await decodePromise({ name: "coder", prompt: "" })
    expect(result.ok).toBe(true)
  })

  test("accepts prompt at max length (50000 chars)", async () => {
    const result = await decodePromise({ name: "coder", prompt: "a".repeat(50_000) })
    expect(result.ok).toBe(true)
  })

  test("rejects prompt exceeding 50000 chars", async () => {
    const result = await decodePromise({ name: "coder", prompt: "a".repeat(50_001) })
    expect(result.ok).toBe(false)
  })

  test("rejects name longer than 64 chars", async () => {
    const result = await decodePromise({ name: "a".repeat(65), prompt: "Test" })
    expect(result.ok).toBe(false)
  })
})
