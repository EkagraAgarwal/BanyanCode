import { describe, expect, test } from "bun:test"
import { McpTaskTracker } from "../../src/mcp-server/isolation"

const tracker = (cap: number): McpTaskTracker => new McpTaskTracker({ maxConcurrentTasks: cap, maxSubagents: cap })

const start = (t: McpTaskTracker, taskId: string): void => {
  t.tryStart({ taskId, isolation: "shared", writeCapable: false })
}

describe("mcp task tracker finish/dequeue", () => {
  test("finish promotes the queued head in order", () => {
    const t = tracker(1)
    start(t, "a")
    start(t, "b")
    start(t, "c")
    expect(t.statusOf("b")?.status).toBe("queued")
    t.finish("a")
    expect(t.statusOf("b")?.status).toBe("running")
    expect(t.statusOf("c")?.status).toBe("queued")
    expect(t.queuedCount).toBe(1)
  })

  test("finishing a queued id removes it without promoting or re-queueing", () => {
    const t = tracker(1)
    start(t, "a")
    start(t, "b")
    t.finish("b")
    expect(t.statusOf("b")).toBeUndefined()
    expect(t.statusOf("a")?.status).toBe("running")
    expect(t.queuedCount).toBe(0)
  })

  test("finish of an unknown id leaves running and queued slots untouched", () => {
    const t = tracker(1)
    start(t, "a")
    start(t, "b")
    t.finish("ghost")
    expect(t.statusOf("a")?.status).toBe("running")
    expect(t.statusOf("b")?.status).toBe("queued")
    expect(t.queuedCount).toBe(1)
  })
})

describe("mcp task tracker onDisconnect", () => {
  test("disconnect aborts via the hook, then releases the slot", () => {
    const t = tracker(2)
    start(t, "live")
    const aborted: string[] = []
    expect(
      t.onDisconnect("live", {
        attached: false,
        abortRunning: (id) => {
          aborted.push(id)
        },
      }),
    ).toBe("aborted")
    expect(aborted).toEqual(["live"])
    expect(t.statusOf("live")).toBeUndefined()
  })

  test("disconnect without a hook still releases the slot", () => {
    const t = tracker(2)
    start(t, "live")
    expect(t.onDisconnect("live", { attached: false })).toBe("aborted")
    expect(t.statusOf("live")).toBeUndefined()
  })

  test("attached disconnect keeps the task and never calls the hook", () => {
    const t = tracker(2)
    start(t, "attached")
    let called = false
    expect(
      t.onDisconnect("attached", {
        attached: true,
        abortRunning: () => {
          called = true
        },
      }),
    ).toBe("kept")
    expect(called).toBe(false)
    expect(t.statusOf("attached")?.status).toBe("running")
  })
})
