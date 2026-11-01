import { describe, expect, test } from "bun:test"
import { emptyDigest, foldDigest } from "../src/digest"
import { SYNTHETIC_AGGREGATE, transcriptEvents, transcriptOrdinal } from "../src/transcript"

const assistant = (overrides: Partial<Parameters<typeof transcriptEvents>[0][number]> = {}) => ({
  type: "assistant",
  created: 1_000,
  text: "done",
  cost: 0.02,
  tokens: { input: 10, output: 4, reasoning: 0, cacheRead: 2, cacheWrite: 1 },
  ...overrides,
})

describe("transcriptEvents", () => {
  test("emits digest-shaped events tagged with the synthetic aggregate", () => {
    const events = transcriptEvents(
      [
        { type: "user", created: 900, text: "do it" },
        assistant({ tools: [{ name: "edit", input: { filePath: "src/a.ts" } }] }),
      ],
      0,
    )
    expect(events.map((event) => event.type)).toEqual([
      "session.step.started",
      "session.tool.called",
      "session.text.ended",
      "session.step.ended",
    ])
    for (const event of events) expect(event.durable?.aggregateID).toBe(SYNTHETIC_AGGREGATE)
    expect(events.every((event) => event.durable?.seq === 2)).toBe(true)
  })

  test("folding transcript events yields steps, tools, files, text, cost and tokens", () => {
    const events = transcriptEvents(
      [assistant({ tools: [{ name: "edit", input: { filePath: "src/a.ts" } }] })],
      0,
    )
    const state = foldDigest(emptyDigest(), events)
    expect(state.steps).toBe(1)
    expect(state.toolCalls).toBe(1)
    expect(state.files).toEqual(["src/a.ts"])
    expect(state.lastText).toBe("done")
    expect(state.cost).toBeCloseTo(0.02)
    expect(state.tokens).toEqual({ input: 10, output: 4, reasoning: 0, cacheRead: 2, cacheWrite: 1 })
  })

  test("afterOrdinal skips already-reported messages", () => {
    const messages = [
      { type: "user", created: 1 },
      assistant({ created: 2 }),
      assistant({ created: 3 }),
    ]
    expect(transcriptEvents(messages, 0)).toHaveLength(6)
    expect(transcriptEvents(messages, 2)).toHaveLength(3)
    expect(transcriptEvents(messages, 3)).toHaveLength(0)
    expect(transcriptOrdinal(messages)).toBe(3)
  })

  test("non-assistant messages carry no counters", () => {
    expect(transcriptEvents([{ type: "idle", created: 1 }], 0)).toEqual([])
  })
})
