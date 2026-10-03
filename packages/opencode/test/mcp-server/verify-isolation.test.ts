import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { NodeHttpServer } from "@effect/platform-node"
import { testEffect } from "../lib/effect"
import {
  checkMemoryStoreLimits,
  isMcpMemoryOp,
  resolveMemoryRoute,
  resolveVerifyRoute,
  summarizeVerifyResult,
  tagMemoryStore,
} from "../../src/mcp-server/tools-verify-memory"

// NOTE (gap-plan §4.8 consolidation): the isolation/policy/tracker tests that
// used to live here asserted the deleted isolation.ts module
// (decidePermissionRequest/resolvePermission/McpTaskTracker). That behavior
// is pinned elsewhere now — policy.ts by policy-matrix.test.ts, the
// realpath-aware path guard by paths.test.ts, and queue/finish/disconnect by
// task-engine.test.ts. What remains is the still-shipped verify/memory
// behavior plus the real-HTTP single-element-array regression probe.

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

describe("mcp verify + memory (Phase 2)", () => {
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

  test("verify summary passes through a clean run unmarked", () => {
    const summary = summarizeVerifyResult("test", {
      status: "passed",
      summary: { passed: 3, failed: 0, skipped: 1 },
      durationMs: 5,
      cacheHit: false,
    })
    expect(summary.passed).toBe(3)
    expect(summary.failed).toBe(0)
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
