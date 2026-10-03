import { describe, expect, test } from "bun:test"
import { lastUserText, resolveTurnAdvisory } from "../../src/session/runner/llm"

describe("lastUserText", () => {
  test("returns the latest user text", () => {
    expect(
      lastUserText([{ type: "user", text: "first" }, { type: "assistant" }, { type: "user", text: "second" }]),
    ).toBe("second")
  })

  test("skips blank user messages", () => {
    expect(lastUserText([{ type: "user", text: "  " }, { type: "system" }])).toBeUndefined()
  })

  test("returns undefined when no user message exists", () => {
    expect(lastUserText([])).toBeUndefined()
    expect(lastUserText([{ type: "assistant" }, { type: "system" }])).toBeUndefined()
  })
})

describe("resolveTurnAdvisory", () => {
  const plan = { kind: "small_edit" as const, tier: "fast" as const }

  test("pinned models drop the plan (pins win, no override)", () => {
    expect(resolveTurnAdvisory(true, plan)).toBeUndefined()
  })

  test("unpinned turns keep the plan as advisory context", () => {
    expect(resolveTurnAdvisory(false, plan)).toEqual(plan)
  })

  test("missing plan stays missing", () => {
    expect(resolveTurnAdvisory(false, undefined)).toBeUndefined()
    expect(resolveTurnAdvisory(true, undefined)).toBeUndefined()
  })
})
