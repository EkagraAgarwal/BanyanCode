import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { RepositoryGateway } from "../../src/banyancode/gateway"
import { ToolRouterService } from "../../src/banyancode/gateway/router"
import { RepositoryGatewayTrace } from "../../src/banyancode/gateway/trace"
import type { RepositoryRouteTrace } from "../../src/banyancode/gateway/trace"
import type { RepositoryRequest, RouteDecision } from "../../src/banyancode/gateway/types"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

process.env.BANYANCODE_ENABLE = "1"

// Test double router: reports a fixed DIRECT decision with distinct
// provenance so the trace fields can be asserted against it.
const testDoubleRouter = ToolRouterService.of({
  classify: () =>
    Effect.succeed({
      route: "direct" as const,
      confidence: 0.9,
      reasonCodes: ["test-double"],
      router: "test-double",
      routerVersion: "1.2.3",
      policyVersion: "v9",
    }),
})

const it = testEffect(
  RepositoryGateway.layer.pipe(Layer.provide(Layer.succeed(ToolRouterService, testDoubleRouter))),
)

describe("RepositoryGateway tracing (Phase 1 — repository_route)", () => {
  it.effect("execute emits a repository_route trace matching the decision", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const gateway = yield* RepositoryGateway.Service
      const outcome = yield* gateway.execute({
        source: "model-tool",
        sessionID: "trace-test-session",
        originalTool: "grep",
        arguments: { pattern: "AuthManager" },
        repositoryContext: {
          root: dir.path,
          graphStatus: "fresh",
          supportedLanguages: ["typescript"],
        },
      })
      expect(outcome.route).toBe("direct")

      const raw = yield* Effect.promise(() =>
        readFile(path.join(dir.path, ".banyancode", "trace", "trace-test-session.jsonl"), "utf8"),
      )
      const trace = JSON.parse(raw.trim().split("\n").at(-1) ?? "") as RepositoryRouteTrace
      expect(trace.event).toBe("repository_route")
      expect(trace.originalTool).toBe("grep")
      expect(trace.arguments).toEqual({ pattern: "AuthManager" })
      expect(trace.route).toBe("direct")
      expect(trace.confidence).toBe(0.9)
      expect(trace.backend).toBe("filesystem")
      expect(trace.reasonCodes).toEqual(["test-double"])
      expect(trace.graphFreshness).toBe("fresh")
      expect(trace.latencyMs).toBeGreaterThanOrEqual(0)
      expect(trace.router).toBe("test-double")
      expect(trace.routerVersion).toBe("1.2.3")
      expect(trace.policyVersion).toBe("v9")
    }),
  )

  it.effect("trace emission failure does not fail execute", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      // A FILE at the worktree path makes the trace mkdir fail — the emit is
      // swallowed (catchCause) and execute must still return the direct outcome.
      const blocker = path.join(dir.path, "blocker")
      yield* Effect.promise(() => writeFile(blocker, "not a directory"))
      const gateway = yield* RepositoryGateway.Service
      const outcome = yield* gateway.execute({
        source: "model-tool",
        sessionID: "trace-fail-session",
        originalTool: "read",
        arguments: { path: "src/foo.ts" },
        repositoryContext: {
          root: blocker,
          graphStatus: "stale",
          supportedLanguages: [],
        },
      })
      expect(outcome.route).toBe("direct")
    }),
  )

  it.effect("execute without repositoryContext or sessionID does not emit and does not fail", () =>
    Effect.gen(function* () {
      const gateway = yield* RepositoryGateway.Service
      const outcome = yield* gateway.execute({
        source: "model-tool",
        originalTool: "read",
        arguments: { path: "src/foo.ts" },
      })
      expect(outcome.route).toBe("direct")
    }),
  )

  test("traceFor produces a serializable JSON object with all plan §44 fields", () => {
    const request: RepositoryRequest = {
      source: "model-tool",
      sessionID: "trace-pure-session",
      originalTool: "grep",
      arguments: { pattern: "AuthManager" },
      repositoryContext: {
        root: "/repo",
        graphStatus: "fresh",
        supportedLanguages: ["typescript"],
      },
    }
    const decision: RouteDecision = {
      route: "direct",
      confidence: 0.9,
      reasonCodes: ["noop"],
      router: "noop",
      routerVersion: "0",
      policyVersion: "v1",
    }
    const trace = RepositoryGatewayTrace.traceFor(request, decision, { route: "direct" }, Date.now())
    const json = JSON.parse(JSON.stringify(trace)) as Record<string, unknown>
    expect(json.event).toBe("repository_route")
    expect(json.originalTool).toBe("grep")
    expect(json.arguments).toEqual({ pattern: "AuthManager" })
    expect(json.route).toBe("direct")
    expect(json.confidence).toBe(0.9)
    expect(json.backend).toBe("filesystem")
    expect(json.reasonCodes).toEqual(["noop"])
    expect(json.graphFreshness).toBe("fresh")
    expect(typeof json.latencyMs).toBe("number")
    expect(json.router).toBe("noop")
    expect(json.routerVersion).toBe("0")
    expect(json.policyVersion).toBe("v1")
  })
})
