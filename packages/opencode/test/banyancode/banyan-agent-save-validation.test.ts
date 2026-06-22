import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { BanyanAgentSaveInput } from "../../src/server/routes/instance/httpapi/groups/global"

const decodePromise = (input: unknown) =>
  Effect.runPromise(
    Schema.decodeUnknownExit(BanyanAgentSaveInput)(input).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    ),
  )

describe("BanyanAgentSaveInput schema validation", () => {
  test("accepts valid agent name", async () => {
    const result = await decodePromise({
      name: "my-agent_1.0",
      description: "A helpful agent",
    })
    expect(result.ok).toBe(true)
  })

  test("rejects name with path traversal sequence", async () => {
    const result = await decodePromise({
      name: "../../../etc/passwd",
    })
    expect(result.ok).toBe(false)
  })

  test("rejects name with absolute path prefix", async () => {
    const result = await decodePromise({
      name: "/etc/passwd",
    })
    expect(result.ok).toBe(false)
  })

  test("rejects name with forward slash", async () => {
    const result = await decodePromise({
      name: "foo/bar",
    })
    expect(result.ok).toBe(false)
  })

  test("rejects name with backslash", async () => {
    const result = await decodePromise({
      name: "foo\\bar",
    })
    expect(result.ok).toBe(false)
  })

  test("rejects name with whitespace", async () => {
    const result = await decodePromise({
      name: "foo bar",
    })
    expect(result.ok).toBe(false)
  })

  test("rejects empty name", async () => {
    const result = await decodePromise({ name: "" })
    expect(result.ok).toBe(false)
  })

  test("rejects name longer than 64 chars", async () => {
    const result = await decodePromise({ name: "a".repeat(65) })
    expect(result.ok).toBe(false)
  })

  test("rejects description longer than 280 chars", async () => {
    const result = await decodePromise({
      name: "valid",
      description: "x".repeat(281),
    })
    expect(result.ok).toBe(false)
  })

  test("accepts boundary length names", async () => {
    const r1 = await decodePromise({ name: "a" })
    const r2 = await decodePromise({ name: "a".repeat(64) })
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
  })

  test("rejects model providerID longer than 128 chars", async () => {
    const result = await decodePromise({
      name: "valid",
      model: { providerID: "x".repeat(129), modelID: "y" },
    })
    expect(result.ok).toBe(false)
  })

  test("rejects prompt longer than 50000 chars", async () => {
    const result = await decodePromise({
      name: "valid",
      prompt: "x".repeat(50_001),
    })
    expect(result.ok).toBe(false)
  })
})
