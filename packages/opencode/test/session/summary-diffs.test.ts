import { describe, expect, test } from "bun:test"

import { SessionSummary } from "../../src/session/summary"
import { Session } from "../../src/session/session"

describe("SessionSummary.toCountDiffs", () => {
  test("strips patch and status, keeps file and counts", () => {
    const out = SessionSummary.toCountDiffs([
      { file: "a.ts", patch: "@@ -1 +1 @@\n-old\n+new", additions: 3, deletions: 1, status: "modified" },
      { file: "b.ts", patch: "", additions: 0, deletions: 0, status: "added" },
    ])
    expect(out).toEqual([
      { file: "a.ts", additions: 3, deletions: 1 },
      { file: "b.ts", additions: 0, deletions: 0 },
    ])
  })

  test("keeps entries without a file", () => {
    expect(SessionSummary.toCountDiffs([{ additions: 1, deletions: 0 }])).toEqual([{ additions: 1, deletions: 0 }])
  })

  test("empty stays empty", () => {
    expect(SessionSummary.toCountDiffs([])).toEqual([])
  })
})

describe("Session.shouldEmitMessageUpdated", () => {
  test("first write emits", () => {
    expect(Session.shouldEmitMessageUpdated(undefined, `{"id":"msg_1"}`)).toBe(true)
  })

  test("unchanged payload skips", () => {
    expect(Session.shouldEmitMessageUpdated(`{"id":"msg_1"}`, `{"id":"msg_1"}`)).toBe(false)
  })

  test("changed payload emits", () => {
    expect(Session.shouldEmitMessageUpdated(`{"id":"msg_1"}`, `{"id":"msg_1","cost":2}`)).toBe(true)
  })
})
