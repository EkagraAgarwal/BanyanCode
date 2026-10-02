import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { NodeHttpServer } from "@effect/platform-node"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import {
  McpTaskTracker,
  decidePermissionRequest,
  isInsideRoot,
  resolvePermission,
} from "../../src/mcp-server/isolation"
import {
  checkMemoryStoreLimits,
  isMcpMemoryOp,
  resolveMemoryRoute,
  resolveVerifyRoute,
  summarizeVerifyResult,
  tagMemoryStore,
} from "../../src/mcp-server/tools-verify-memory"

// Real HTTP layer probe (no mocks): inline schemas, so a single-element
// array regression in the HttpApi $ref path fails here first.
const ProbeInput = Schema.Struct({
  dirs: Schema.Array(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
})
const ProbeResult = Schema.Struct({
  count: Schema.Number,
  tags: Schema.Number,
})

const ProbeApi = HttpApi.make("probe").add(
  HttpApiGroup.make("probe").add(HttpApiEndpoint.post("run", "/probe/run", { payload: ProbeInput, success: ProbeResult })),
)

const probeHandlers = HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
  Effect.gen(function* () {
    return handlers.handle("run", ({ payload }) =>
      Effect.succeed({ count: payload.dirs.length, tags: payload.tags?.length ?? 0 }),
    )
  }),
)

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(ProbeApi).pipe(Layer.provide(probeHandlers)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const it = testEffect(apiLayer)

describe("mcp verify + isolation (Phase 2)", () => {
  test("permission matrix: reject denies edits, edits approves inside cwd, else rejects", () => {
    expect(
      decidePermissionRequest({ policy: "reject", cwd: "/repo", kind: "edit", target: "src/a.ts" }),
    ).toBe("reject")
    expect(decidePermissionRequest({ policy: "edits", cwd: "/repo", kind: "edit", target: "src/a.ts" })).toBe(
      "approve",
    )
    expect(decidePermissionRequest({ policy: "edits", cwd: "/repo", kind: "write", target: "../escape.ts" })).toBe(
      "reject",
    )
    expect(decidePermissionRequest({ policy: "edits", cwd: "/repo", kind: "other" })).toBe("reject")
  })

  test("permission matrix: bash/network defer to existing config, yolo approves in-root edits", () => {
    expect(decidePermissionRequest({ policy: "edits", cwd: "/repo", kind: "bash" })).toBe("defer")
    expect(decidePermissionRequest({ policy: "reject", cwd: "/repo", kind: "network" })).toBe("defer")
    expect(
      decidePermissionRequest({ policy: "yolo", cwd: "/repo", kind: "write", target: "src/a.ts" }),
    ).toBe("approve")
    expect(decidePermissionRequest({ policy: "yolo", cwd: "/repo", kind: "write", target: "/etc/passwd" })).toBe(
      "reject",
    )
  })

  test("yolo requires --allow-yolo (maps banyancode_yolo_mode)", () => {
    expect(() => resolvePermission({ requested: "yolo", allowYolo: false })).toThrow("--allow-yolo")
    expect(resolvePermission({ requested: "yolo", allowYolo: true })).toBe("yolo")
    expect(resolvePermission({ allowYolo: false })).toBe("reject")
    expect(resolvePermission({ requested: "edits", configured: "reject", allowYolo: false })).toBe("edits")
  })

  test("path traversal escapes are rejected", () => {
    expect(isInsideRoot("/repo", "src/a.ts")).toBe(true)
    expect(isInsideRoot("/repo", "../escape.ts")).toBe(false)
    expect(isInsideRoot("/repo", "/etc/passwd")).toBe(false)
  })

  test("two concurrent worktree write tasks stay disjoint", async () => {
    await using tmp = await tmpdir()
    const tracker = new McpTaskTracker({
      maxConcurrentTasks: 4,
      maxSubagents: 5,
      allocateWorktree: (taskId) => ({ path: `${tmp.path}/wt-${taskId}`, branch: `mcp/${taskId}` }),
    })
    const first = tracker.tryStart({ taskId: "aaa", isolation: "worktree", writeCapable: true })
    const second = tracker.tryStart({ taskId: "bbb", isolation: "worktree", writeCapable: true })
    expect(first.status).toBe("running")
    expect(second.status).toBe("running")
    expect(first.worktreePath).not.toBe(second.worktreePath)
    expect(first.branch).not.toBe(second.branch)
    expect(isInsideRoot(tmp.path, first.worktreePath ?? "")).toBe(true)
    expect(isInsideRoot(tmp.path, second.worktreePath ?? "")).toBe(true)
  })

  test("second write-capable shared task is rejected, suggests worktree", () => {
    const tracker = new McpTaskTracker({ maxConcurrentTasks: 4, maxSubagents: 5 })
    tracker.tryStart({ taskId: "one", isolation: "shared", writeCapable: true })
    expect(() => tracker.tryStart({ taskId: "two", isolation: "shared", writeCapable: true })).toThrow(
      'isolation "worktree"',
    )
  })

  test("over-cap starts queue; cap is min(max_concurrent_tasks, banyancode_max_subagents)", () => {
    const tracker = new McpTaskTracker({ maxConcurrentTasks: 4, maxSubagents: 1 })
    expect(tracker.effectiveCap).toBe(1)
    expect(tracker.tryStart({ taskId: "a", isolation: "worktree", writeCapable: true }).status).toBe("running")
    expect(tracker.tryStart({ taskId: "b", isolation: "worktree", writeCapable: true }).status).toBe("queued")
    tracker.finish("a")
    expect(tracker.statusOf("b")?.status).toBe("running")
  })

  test("stdio disconnect aborts, --attach keeps running pickable by task_id", () => {
    const tracker = new McpTaskTracker({ maxConcurrentTasks: 4, maxSubagents: 5 })
    tracker.tryStart({ taskId: "live", isolation: "worktree", writeCapable: true })
    tracker.tryStart({ taskId: "attached", isolation: "worktree", writeCapable: true })
    expect(tracker.onDisconnect("live", { attached: false })).toBe("aborted")
    expect(tracker.statusOf("live")).toBeUndefined()
    expect(tracker.onDisconnect("attached", { attached: true })).toBe("kept")
    expect(tracker.statusOf("attached")?.status).toBe("running")
  })

  test("stdout hygiene: no non-JSON-RPC bytes on stdout during startup+task", () => {
    const writes: Array<string> = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      const tracker = new McpTaskTracker({ maxConcurrentTasks: 2, maxSubagents: 5 })
      tracker.tryStart({ taskId: "t1", isolation: "worktree", writeCapable: true })
      summarizeVerifyResult("test", {
        status: "passed",
        summary: { passed: 3, failed: 0, skipped: 1 },
        durationMs: 5,
        cacheHit: false,
      })
      tracker.finish("t1")
    } finally {
      process.stdout.write = original
    }
    expect(writes).toEqual([])
  })

  test("verify routes map to existing /global endpoints; summary keeps first N failures", () => {
    expect(resolveVerifyRoute("typecheck")).toBe("/global/typecheck")
    expect(resolveVerifyRoute("test")).toBe("/global/test-run")
    expect(resolveVerifyRoute("lint")).toBe("/global/lint")
    const summary = summarizeVerifyResult(
      "test",
      {
        status: "failed",
        summary: { passed: 8, failed: 2, skipped: 0 },
        durationMs: 120,
        cacheHit: false,
        rawOutput: "ok line\nFAIL a\n\nFAIL b\nFAIL c\n",
      },
      2,
    )
    expect(summary.passed).toBe(8)
    expect(summary.failed).toBe(2)
    expect(summary.failures).toEqual(["ok line", "FAIL a"])
  })

  test("memory: only recall/search/store/get/summary are MCP-visible; store tagged + size-limited", () => {
    for (const op of ["recall", "search", "store", "get", "summary"]) {
      expect(isMcpMemoryOp(op)).toBe(true)
    }
    for (const op of ["forget", "promote", "reject", "candidates", "list"]) {
      expect(isMcpMemoryOp(op)).toBe(false)
    }
    expect(resolveMemoryRoute("store")).toBe("/global/memory/store")
    const tagged = tagMemoryStore({ key: "plan", value: { a: 1 }, scope: "global", tags: ["t"] })
    expect(tagged.origin).toBe("mcp")
    expect(tagged.tags).toContain("origin:mcp")
    expect(checkMemoryStoreLimits({ value: "ok", tags: ["t"] })).toBeUndefined()
    expect(checkMemoryStoreLimits({ value: "x".repeat(40_000) })?.length).toBeGreaterThan(0)
    expect(checkMemoryStoreLimits({ value: "ok", tags: Array.from({ length: 17 }, (_, i) => `t${i}`) })).toContain(
      "tags",
    )
  })

  it.live("real HTTP layer: single-element dirs array decodes", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/probe/run").pipe(
        HttpClientRequest.bodyJson({ dirs: ["packages"] }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(response.status).toBe(200)
      expect((yield* response.json) as { count: number; tags: number }).toEqual({ count: 1, tags: 0 })
    }),
  )

  it.live("real HTTP layer: multi-element arrays decode", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/probe/run").pipe(
        HttpClientRequest.bodyJson({ dirs: ["packages", "specs"], tags: ["a", "b"] }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(response.status).toBe(200)
      expect((yield* response.json) as { count: number; tags: number }).toEqual({ count: 2, tags: 2 })
    }),
  )

  it.live("real HTTP layer: single-element tags array decodes", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/probe/run").pipe(
        HttpClientRequest.bodyJson({ dirs: ["packages"], tags: ["mcp"] }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(response.status).toBe(200)
      expect((yield* response.json) as { count: number; tags: number }).toEqual({ count: 1, tags: 1 })
    }),
  )

  it.live("real HTTP layer: string-typed dirs is still rejected", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/probe/run").pipe(
        HttpClientRequest.bodyJson({ dirs: "packages" }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(response.status).toBe(400)
    }),
  )
})
