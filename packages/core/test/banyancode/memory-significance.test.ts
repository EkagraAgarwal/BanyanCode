import { describe, expect, test } from "bun:test"
import type { MemoryPayloadV1 } from "@opencode-ai/core/banyancode/memory-payload"
import {
  decide,
  KEEP_THRESHOLD,
  MERGE_THRESHOLD,
  normalizeForDedupe,
  scoreRepeat,
  scoreSpecificity,
  suggestKey,
  totalScore,
} from "@opencode-ai/core/banyancode/memory-significance"

const basePayload: MemoryPayloadV1 = {
  kind: "decision",
  title: "Use Turso",
  body: "Storage backend is Turso/libSQL.",
  source: { type: "user" },
  confidence: "high",
  importance: "high",
  status: "active",
}

describe("memory-significance", () => {
  test("decision/user/high scores above KEEP_THRESHOLD", () => {
    const score = totalScore({ payload: basePayload })
    expect(score).toBeGreaterThanOrEqual(KEEP_THRESHOLD)
    expect(decide({ payload: basePayload })).toBe("keep")
  })

  test("observation/low/system/short body lands in discard", () => {
    const payload: MemoryPayloadV1 = {
      kind: "observation",
      title: "ok",
      body: "short",
      source: { type: "system" },
      confidence: "low",
      importance: "low",
      status: "active",
    }
    const score = totalScore({ payload })
    expect(score).toBeLessThan(MERGE_THRESHOLD)
    expect(decide({ payload })).toBe("discard")
  })

  test("long observation gets summarized when its body exceeds threshold", () => {
    const long = "x".repeat(800)
    const payload: MemoryPayloadV1 = {
      kind: "observation",
      title: "noise",
      body: long,
      source: { type: "agent" },
      confidence: "low",
      importance: "low",
      status: "active",
    }
    const decision = decide({ payload })
    expect(decision).not.toBe("discard")
  })

  test("merge candidate when existing entries with overlapping tags exist", () => {
    const candidate: MemoryPayloadV1 = {
      ...basePayload,
      title: "Use Turso",
      tags: ["database", "storage"],
    }
    const existing: MemoryPayloadV1[] = [
      { ...basePayload, tags: ["database", "storage"], title: "Use Turso" },
    ]
    const score = totalScore({ payload: candidate, existing })
    expect(score).toBeGreaterThan(MERGE_THRESHOLD)
    const repeat = scoreRepeat(candidate, existing)
    expect(repeat).toBeGreaterThan(0)
  })

  test("scoreSpecificity rewards body length, capped at ceiling", () => {
    const small: MemoryPayloadV1 = { ...basePayload, body: "tiny" }
    const medium: MemoryPayloadV1 = { ...basePayload, body: "x".repeat(200) }
    const huge: MemoryPayloadV1 = { ...basePayload, body: "x".repeat(2000) }
    expect(scoreSpecificity(small)).toBeLessThan(scoreSpecificity(medium))
    expect(scoreSpecificity(medium)).toBeLessThanOrEqual(scoreSpecificity(huge))
    expect(scoreSpecificity(huge)).toBeCloseTo(0.2, 1)
  })

  test("normalizeForDedupe collapses whitespace and lowercases", () => {
    expect(normalizeForDedupe("  Hello   World\n\nFoo ")).toBe("hello world foo")
  })

  test("suggestKey produces canonical kind:slug", () => {
    expect(suggestKey(basePayload)).toBe("decision:use-turso")
    const spaced: MemoryPayloadV1 = { ...basePayload, title: "Use TURSO !!! for real" }
    expect(suggestKey(spaced)).toBe("decision:use-turso-for-real")
  })
})
