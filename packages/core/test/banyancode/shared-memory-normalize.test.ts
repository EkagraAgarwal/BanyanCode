import { describe, expect, test } from "bun:test"
import { normalizeSharedMemoryInput } from "../../src/tool/shared-memory"

describe("shared_memory stuffed-invocation recovery (regression)", () => {
  test("write stuffed into value is unwrapped: op/key/tags lifted to top level", () => {
    const normalized = normalizeSharedMemoryInput({
      value: { op: "write", key: "research:topic:name", value: { summary: "x" }, tags: ["research"] },
    } as never)
    expect(normalized.op).toBe("write")
    expect(normalized.key).toBe("research:topic:name")
    expect(normalized.tags).toEqual(["research"])
    expect((normalized.value as { summary: string }).summary).toBe("x")
  })

  test("read stuffed into payload is unwrapped", () => {
    const normalized = normalizeSharedMemoryInput({
      payload: { op: "read", key: "research:topic:name" },
    } as never)
    expect(normalized.op).toBe("read")
    expect(normalized.key).toBe("research:topic:name")
  })

  test("legitimate payload containing an op key is NOT unwrapped when top-level op is present", () => {
    const input = {
      op: "write",
      key: "research:x",
      payload: { op: "read", key: "nested" },
    } as never
    const normalized = normalizeSharedMemoryInput(input)
    expect(normalized.op).toBe("write")
    expect(normalized.key).toBe("research:x")
    expect(normalized.payload).toEqual({ op: "read", key: "nested" })
  })

  test("missing op without a stuffed payload stays unresolved (execute returns the teaching error)", () => {
    const normalized = normalizeSharedMemoryInput({ key: "research:x" } as never)
    expect(normalized.op).toBeUndefined()
  })

  test("legacy top-level value alias is preserved (no unwrap, value kept)", () => {
    const normalized = normalizeSharedMemoryInput({ op: "write", key: "k", value: 42 } as never)
    expect(normalized.op).toBe("write")
    expect(normalized.value).toBe(42)
  })

  test("stuffed payload without a valid op literal is not unwrapped", () => {
    const normalized = normalizeSharedMemoryInput({ value: { op: "explode", key: "k" } } as never)
    expect(normalized.op).toBeUndefined()
  })
})
