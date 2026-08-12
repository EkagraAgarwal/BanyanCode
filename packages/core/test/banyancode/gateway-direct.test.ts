import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { RepositoryGateway } from "../../src/banyancode/gateway"
import { RepositoryGatewayRouter } from "../../src/banyancode/gateway/router"
import { RepositoryGatewayNormalizer } from "../../src/banyancode/gateway/normalizer"
import { RepositoryGatewayFormatter } from "../../src/banyancode/gateway/formatter"
import type { RepositoryOperation, RepositoryRequest, RepositoryResult } from "../../src/banyancode/gateway/types"
import { testEffect } from "../lib/effect"

process.env.BANYANCODE_ENABLE = "1"

const it = testEffect(RepositoryGateway.defaultLayer)

describe("RepositoryGateway (Phase 0 — DIRECT only)", () => {
  describe("NoopRouter", () => {
    it.effect("always returns direct with confidence 1", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.NoopRouter.classify({
          toolName: "grep",
          arguments: { pattern: "AuthManager" },
          recentToolCalls: [],
        })
        expect(decision.route).toBe("direct")
        expect(decision.confidence).toBe(1)
        expect(decision.reasonCodes).toContain("noop")
      }),
    )

    it.effect("never fails on empty input", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.NoopRouter.classify({
          toolName: "read",
          arguments: {},
          recentToolCalls: [],
        })
        expect(decision.route).toBe("direct")
        expect(decision.confidence).toBe(1)
      }),
    )
  })

  describe("normalize", () => {
    it.effect("maps read to content", () =>
      Effect.gen(function* () {
        const op = yield* RepositoryGatewayNormalizer.normalize({
          source: "model-tool",
          originalTool: "read",
          arguments: { path: "src/foo.ts" },
        })
        expect(op.kind).toBe("content")
        if (op.kind === "content") expect(op.path).toBe("src/foo.ts")
      }),
    )

    it.effect("maps grep to text_search", () =>
      Effect.gen(function* () {
        const op = yield* RepositoryGatewayNormalizer.normalize({
          source: "model-tool",
          originalTool: "grep",
          arguments: { pattern: "AuthManager", path: "src" },
        })
        expect(op.kind).toBe("text_search")
        if (op.kind === "text_search") {
          expect(op.pattern).toBe("AuthManager")
          expect(op.paths).toEqual(["src"])
        }
      }),
    )

    it.effect("maps glob to file_discovery", () =>
      Effect.gen(function* () {
        const op = yield* RepositoryGatewayNormalizer.normalize({
          source: "model-tool",
          originalTool: "glob",
          arguments: { pattern: "**/*.test.ts" },
        })
        expect(op.kind).toBe("file_discovery")
        if (op.kind === "file_discovery") expect(op.pattern).toBe("**/*.test.ts")
      }),
    )

    it.effect("falls back to content for unknown tools", () =>
      Effect.gen(function* () {
        const op = yield* RepositoryGatewayNormalizer.normalize({
          source: "model-tool",
          originalTool: "list_files",
          arguments: { path: "/tmp" },
        })
        expect(op.kind).toBe("content")
      }),
    )

    it.effect("falls back to text_search for unknown tools with a pattern", () =>
      Effect.gen(function* () {
        const op = yield* RepositoryGatewayNormalizer.normalize({
          source: "model-tool",
          originalTool: "search",
          arguments: { query: "AuthManager" },
        })
        expect(op.kind).toBe("text_search")
        if (op.kind === "text_search") expect(op.pattern).toBe("AuthManager")
      }),
    )
  })

  describe("gateway.execute", () => {
    it.effect("resolves DIRECT for read/grep/glob with the NoopRouter (DIRECT-only invariant)", () =>
      Effect.gen(function* () {
        const gateway = yield* RepositoryGateway.Service
        const requests: RepositoryRequest[] = [
          { source: "model-tool", originalTool: "read", arguments: { path: "src/foo.ts" } },
          { source: "model-tool", originalTool: "grep", arguments: { pattern: "AuthManager" } },
          { source: "model-tool", originalTool: "glob", arguments: { pattern: "**/*.test.ts" } },
        ]
        for (const request of requests) {
          const outcome = yield* gateway.execute(request)
          expect(outcome.route).toBe("direct")
        }
      }),
    )

    it.effect("executes with full request context", () =>
      Effect.gen(function* () {
        const gateway = yield* RepositoryGateway.Service
        const outcome = yield* gateway.execute({
          source: "native-banyan-tool",
          originalTool: "grep",
          arguments: { pattern: "AuthManager", path: "src" },
          userRequest: "who calls AuthManager?",
          recentToolCalls: [{ tool: "read", arguments: { path: "src/auth.ts" } }],
          investigationState: {
            entities: new Set(["AuthManager"]),
            files: new Set(["src/auth.ts"]),
            concepts: new Set(["authentication"]),
            recentQueries: [{ query: "AuthManager" }],
          },
          repositoryContext: {
            root: "D:/repo",
            graphStatus: "fresh",
            supportedLanguages: ["typescript"],
            graphCoverage: { indexedFiles: 100, totalFiles: 120 },
          },
        })
        expect(outcome.route).toBe("direct")
      }),
    )
  })

  describe("formatter", () => {
    it.effect("renders relationship results as path:line lists", () =>
      Effect.gen(function* () {
        const op: RepositoryOperation = { kind: "relationship", relation: "callers", target: "AuthManager" }
        const result: RepositoryResult = {
          route: "intelligence",
          operation: op,
          source: "codegraph",
          results: [
            { path: "src/server.ts", line: 42 },
            { path: "src/routes/auth.ts", line: 17 },
            { path: "src/tests/auth.test.ts", line: 81 },
          ],
          provenance: {
            originalTool: "grep",
            resolvedOperation: "relationship:callers",
            router: "noop",
            routerVersion: "0",
          },
        }
        const text = RepositoryGatewayFormatter.format(op, result)
        expect(text).toContain("AuthManager callers:")
        expect(text).toContain("src/server.ts:42")
        expect(text).toContain("src/routes/auth.ts:17")
        expect(text).toContain("src/tests/auth.test.ts:81")
      }),
    )

    it.effect("renders an explicit no-results line for empty results", () =>
      Effect.gen(function* () {
        const op: RepositoryOperation = { kind: "content", path: "src/foo.ts" }
        const result: RepositoryResult = {
          route: "direct",
          operation: op,
          source: "filesystem",
          results: [],
          provenance: {
            originalTool: "read",
            resolvedOperation: "content",
            router: "noop",
            routerVersion: "0",
          },
        }
        const text = RepositoryGatewayFormatter.format(op, result)
        expect(text).toContain("src/foo.ts:")
        expect(text).toContain("No results.")
      }),
    )
  })
})
