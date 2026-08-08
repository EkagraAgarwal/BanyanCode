import { describe, expect, test } from "bun:test"
import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2"
import { coalesceDeltas } from "../../src/context/sdk"

const wrap = (payload: Event): GlobalEvent => ({ directory: "", payload })

const delta = (id: string, messageID: string, partID: string, field: string, text: string): GlobalEvent =>
  wrap({
    id,
    type: "message.part.delta",
    properties: { sessionID: "s1", messageID, partID, field, delta: text },
  })

const idle = (id: string, sessionID: string): GlobalEvent =>
  wrap({ id, type: "session.idle", properties: { sessionID } })

describe("coalesceDeltas", () => {
  test("merges contiguous deltas for the same part/field into one event", () => {
    const merged = coalesceDeltas([
      delta("e1", "m1", "p1", "text", "Hel"),
      delta("e2", "m1", "p1", "text", "lo"),
      delta("e3", "m1", "p1", "text", " world"),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      payload: {
        id: "e1",
        type: "message.part.delta",
        properties: { messageID: "m1", partID: "p1", field: "text", delta: "Hello world" },
      },
    })
  })

  test("does not merge deltas for different parts or fields", () => {
    const merged = coalesceDeltas([
      delta("e1", "m1", "p1", "text", "Hel"),
      delta("e2", "m1", "p2", "text", "lo"),
      delta("e3", "m1", "p1", "text", " world"),
    ])
    expect(merged).toHaveLength(3)
    const texts = merged.map((e) => e.payload)
    expect(texts).toEqual([
      {
        id: "e1",
        type: "message.part.delta",
        properties: { sessionID: "s1", messageID: "m1", partID: "p1", field: "text", delta: "Hel" },
      },
      {
        id: "e2",
        type: "message.part.delta",
        properties: { sessionID: "s1", messageID: "m1", partID: "p2", field: "text", delta: "lo" },
      },
      {
        id: "e3",
        type: "message.part.delta",
        properties: { sessionID: "s1", messageID: "m1", partID: "p1", field: "text", delta: " world" },
      },
    ])
  })

  test("flushes the pending run around non-delta events and keeps order", () => {
    const merged = coalesceDeltas([
      delta("e1", "m1", "p1", "text", "Hel"),
      idle("x1", "s1"),
      delta("e2", "m1", "p1", "text", "lo"),
    ])
    expect(merged).toHaveLength(3)
    expect(merged[0].payload).toMatchObject({ id: "e1", type: "message.part.delta", properties: { delta: "Hel" } })
    expect(merged[1].payload).toMatchObject({ id: "x1", type: "session.idle" })
    expect(merged[2].payload).toMatchObject({ id: "e2", type: "message.part.delta", properties: { delta: "lo" } })
  })

  test("concatenates a long stream without losing final text", () => {
    const chunks = 500
    const events = Array.from({ length: chunks }, (_, i) => delta(`e${i}`, "m1", "p1", "text", `c${i}`))
    const merged = coalesceDeltas(events)
    expect(merged).toHaveLength(1)
    const finalDelta = (merged[0]!.payload as Extract<Event, { type: "message.part.delta" }>).properties.delta
    expect(finalDelta).toBe(Array.from({ length: chunks }, (_, i) => `c${i}`).join(""))
  })

  test("interleaved reasoning and text deltas merge independently", () => {
    const merged = coalesceDeltas([
      delta("e1", "m1", "p-think", "text", "let me "),
      delta("e2", "m1", "p-think", "text", "think"),
      delta("e3", "m1", "p-text", "text", "Answer: "),
      delta("e4", "m1", "p-text", "text", "42"),
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0].payload).toMatchObject({ id: "e1", properties: { partID: "p-think", delta: "let me think" } })
    expect(merged[1].payload).toMatchObject({ id: "e3", properties: { partID: "p-text", delta: "Answer: 42" } })
  })
})
