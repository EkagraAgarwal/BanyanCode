import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir, readFile, rm, writeFile } from "fs/promises"
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

  test("record() writes one line per call to the trace file", async () => {
    const worktree = path.join(import.meta.dir, "..", "..", ".tmp-trace-record")
    const sessionID = "ses_trace_one"
    await rm(worktree, { recursive: true, force: true })
    await mkdir(worktree, { recursive: true })

    const traceFile = path.join(worktree, ".banyancode", "trace", `${sessionID}.jsonl`)
    await record(worktree, sessionID, {
      type: "tool.call",
      phase: "start",
      tool: "code_find",
      input: { intent: "definition", target: "foo" },
    })

    const contents = await readFile(traceFile, "utf8")
    const lines = contents.split("\n").filter(Boolean)
    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0] ?? "{}")
    expect(parsed.tool).toBe("code_find")
    expect(parsed.phase).toBe("start")
    expect(parsed.sessionID).toBe(sessionID)

    await rm(worktree, { recursive: true, force: true })
  })

  test("rolling cap keeps at most 10000 events and drops lines older than 7 days", async () => {
    const worktree = path.join(import.meta.dir, "..", "..", ".tmp-trace-cap")
    const sessionID = "ses_trace_cap"
    await rm(worktree, { recursive: true, force: true })
    await mkdir(worktree, { recursive: true })

    const dir = path.join(worktree, ".banyancode", "trace")
    await mkdir(dir, { recursive: true })
    const traceFile = path.join(dir, `${sessionID}.jsonl`)

    const now = Date.now()
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000
    const oneMinuteAgo = now - 60 * 1000

    const oldLines: string[] = []
    for (let i = 0; i < 12000; i++) {
      oldLines.push(
        JSON.stringify({
          type: "tool.call",
          phase: "start",
          tool: "stale",
          ts: eightDaysAgo + i,
          sessionID,
        }),
      )
    }
    await writeFile(traceFile, oldLines.join("\n") + "\n", "utf8")

    await record(worktree, sessionID, {
      type: "tool.call",
      phase: "start",
      tool: "fresh",
      input: { triggeredCap: true },
    })

    const afterCap = await readTrace(worktree, sessionID)
    expect(afterCap.length).toBeLessThanOrEqual(10000)
    expect(afterCap.length).toBeGreaterThan(0)
    expect(afterCap.every((event) => event.ts >= oneMinuteAgo - 1000)).toBe(true)

    await rm(worktree, { recursive: true, force: true })
  })

  test("optional cache and workspace fields survive a record/readTrace round-trip", async () => {
    const worktree = path.join(import.meta.dir, "..", "..", ".tmp-trace-fields")
    const sessionID = "ses_trace_fields"
    await rm(worktree, { recursive: true, force: true })
    await mkdir(worktree, { recursive: true })

    await record(worktree, sessionID, {
      type: "tool.call",
      phase: "start",
      tool: "codegraph_query",
      input: { function: "foo" },
      cache: { hit: true, key: "k-1" },
      workspace: { worktree: "/some/repo", focusDirs: ["src", "packages"] },
    })
    await record(worktree, sessionID, {
      type: "tool.call",
      phase: "end",
      tool: "codegraph_query",
      resultSummary: "nodes=2",
      ms: 7,
    })

    const events = await readTrace(worktree, sessionID)
    expect(events.length).toBe(2)
    expect(events[0]?.cache).toEqual({ hit: true, key: "k-1" })
    expect(events[0]?.workspace).toEqual({ worktree: "/some/repo", focusDirs: ["src", "packages"] })
    expect(events[1]?.cache).toBeUndefined()
    expect(events[1]?.workspace).toBeUndefined()

    await rm(worktree, { recursive: true, force: true })
  })
})
