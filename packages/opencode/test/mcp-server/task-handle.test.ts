import { describe, expect, test } from "bun:test"
import { assertHandleShape, expiredOrUnknown, isTaskHandleShape, newTaskHandle } from "../../src/mcp-server/task-handle"

describe("mcp task handles", () => {
  test("newTaskHandle returns btask_ prefix with 64 hex chars", () => {
    expect(newTaskHandle()).toMatch(/^btask_[0-9a-f]{64}$/)
  })

  test("handles carry well over 24 bits of entropy (1000 unique)", () => {
    const seen = new Set(Array.from({ length: 1000 }, () => newTaskHandle()))
    expect(seen.size).toBe(1000)
  })

  test("assertHandleShape rejects ses_ ids and garbage", () => {
    for (const bad of ["ses_fake_1", "ses_abc123", "garbage", "", "btask_short", "btask_" + "zz".repeat(32)]) {
      expect(() => assertHandleShape(bad)).toThrow("not a banyan task handle")
      expect(isTaskHandleShape(bad)).toBe(false)
    }
  })

  test("assertHandleShape accepts a fresh handle and narrows the type", () => {
    const id: unknown = newTaskHandle()
    assertHandleShape(id)
    expect(id.startsWith("btask_")).toBe(true)
  })

  test("expiredOrUnknown returns an UNKNOWN_TASK error with recovery text", () => {
    const result = expiredOrUnknown(`btask_${"0".repeat(64)}`)
    expect(result.isError).toBe(true)
    expect(result.content).toHaveLength(1)
    expect(result.content[0]?.text).toContain("UNKNOWN_TASK")
    expect(result.content[0]?.text).toContain("banyan_task_start")
  })
})
