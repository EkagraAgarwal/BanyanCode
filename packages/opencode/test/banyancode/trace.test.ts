import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir, readFile, rm } from "fs/promises"
import { record, readTrace } from "../../src/observability/trace"

describe("trace", () => {
  test("writes ordered tool.call events to JSONL", async () => {
    const worktree = path.join(import.meta.dir, "..", "..", ".tmp-trace")
    const sessionID = "ses_trace_test"
    await rm(worktree, { recursive: true, force: true })
    await mkdir(worktree, { recursive: true })

    await record(worktree, sessionID, { type: "tool.call", phase: "start", tool: "repo_find_subsystem", input: { query: "x" } })
    await record(worktree, sessionID, {
      type: "tool.call",
      phase: "end",
      tool: "repo_find_subsystem",
      resultSummary: "related=2",
      ms: 12,
    })

    const events = await readTrace(worktree, sessionID)
    expect(events.length).toBe(2)
    expect(events[0]?.phase).toBe("start")
    expect(events[1]?.phase).toBe("end")
    expect(events[1]?.ms).toBe(12)

    await rm(worktree, { recursive: true, force: true })
  })
})
