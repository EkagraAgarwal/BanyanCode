import { describe, expect, test } from "bun:test"
import {
  decodeCursor,
  emptyDigest,
  encodeCursor,
  foldDigest,
  hashCall,
  stableStringify,
  summarizeDigest,
} from "../src/digest"
import { event } from "./fake-port"

describe("digest cursor", () => {
  test("round-trips positive durable seqs and negative transcript ordinals", () => {
    const cursor = encodeCursor({ btask_a: 12, btask_b: 0, btask_c: -7 })
    expect(decodeCursor(cursor)).toEqual({ btask_a: 12, btask_c: -7 })
  })

  test("garbage and legacy cursors decode to an empty map", () => {
    expect(decodeCursor(undefined)).toEqual({})
    expect(decodeCursor("")).toEqual({})
    expect(decodeCursor("garbage")).toEqual({})
    expect(decodeCursor("b1.not-base64-json")).toEqual({})
    expect(decodeCursor(`b1.${Buffer.from('{"t":{"a":"x"}}').toString("base64url")}`)).toEqual({})
  })
})

describe("digest fold", () => {
  test("counts steps, tool calls, files, tokens and cost", () => {
    const state = foldDigest(emptyDigest(), [
      event(1, "session.step.started", {}),
      event(2, "session.tool.called", { name: "edit", input: { filePath: "src/a.ts" } }),
      event(3, "session.tool.called", { name: "read", input: { path: "README.md" } }),
      event(4, "session.tool.failed", { name: "bash" }),
      event(5, "session.step.ended", {
        cost: 0.25,
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } },
        files: ["src/b.ts"],
      }),
      event(6, "session.text.ended", { text: "done: patched two files" }),
    ])
    expect(state.steps).toBe(1)
    expect(state.toolCalls).toBe(2)
    expect(state.toolFailures).toBe(1)
    expect(state.files).toEqual(["src/a.ts", "src/b.ts"])
    expect(state.cost).toBeCloseTo(0.25)
    expect(state.tokens).toEqual({ input: 100, output: 20, reasoning: 5, cacheRead: 7, cacheWrite: 3 })
    expect(state.lastText).toBe("done: patched two files")
    expect(state.lastSeq).toBe(6)
    expect(Object.keys(state.toolNames).sort()).toEqual(["edit", "read"])
  })

  test("only edit-family tools contribute files", () => {
    const state = foldDigest(emptyDigest(), [
      event(1, "session.tool.called", { name: "read", input: { path: "a.ts" } }),
      event(2, "session.tool.called", { name: "apply_patch", input: { path: "b.ts" } }),
    ])
    expect(state.files).toEqual(["b.ts"])
  })

  test("summarize truncates text and the tool list", () => {
    const state = foldDigest(emptyDigest(), [
      event(1, "session.text.ended", { text: "x".repeat(500) }),
      ...Array.from({ length: 8 }, (_, index) =>
        event(index + 2, "session.tool.called", { name: `tool_${index}`, input: {} }),
      ),
    ])
    const summary = summarizeDigest(state, { maxTextChars: 40, maxTools: 3 })
    expect(summary.last_text?.length).toBeLessThanOrEqual(40)
    expect(summary.tools).toHaveLength(3)
    expect(summary.tool_calls).toBe(8)
  })

  test("stableStringify ignores key order so loop hashes match", () => {
    expect(stableStringify({ a: 1, b: { c: 2, d: 3 } })).toBe(stableStringify({ b: { d: 3, c: 2 }, a: 1 }))
    expect(hashCall("edit", { b: 1, a: 2 })).toBe(hashCall("edit", { a: 2, b: 1 }))
    expect(hashCall("edit", { a: 2 })).not.toBe(hashCall("read", { a: 2 }))
  })
})
