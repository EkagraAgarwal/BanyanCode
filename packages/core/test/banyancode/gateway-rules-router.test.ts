import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { RepositoryGatewayRouter } from "../../src/banyancode/gateway/router"
import { testEffect } from "../lib/effect"

process.env.BANYANCODE_ENABLE = "1"

const it = testEffect(Layer.empty)

// RouterInput shorthand for grep-style calls.
const grep = (pattern: string, extra: Record<string, unknown> = {}, userRequest?: string) => ({
  toolName: "grep",
  arguments: { pattern, ...extra },
  recentToolCalls: [],
  ...(userRequest !== undefined ? { userRequest } : {}),
})

describe("RulesRouter (Phase 2 — deterministic rules)", () => {
  describe("relationship language routes to INTELLIGENCE", () => {
    it.effect("'who calls AuthManager' -> relationship:callers", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify(grep("who calls AuthManager"))
        expect(decision.route).toBe("intelligence")
        expect(decision.operation).toEqual({ kind: "relationship", relation: "callers", target: "AuthManager" })
        expect(decision.confidence).toBe(0.9)
        expect(decision.reasonCodes).toContain("relationship-language")
        expect(decision.router).toBe("rules")
        expect(decision.routerVersion).toBe("0.1.0")
      }),
    )

    it.effect("'references to Foo' -> relationship:references", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify(grep("references to Foo"))
        expect(decision.route).toBe("intelligence")
        expect(decision.operation).toEqual({ kind: "relationship", relation: "references", target: "Foo" })
      }),
    )

    it.effect("'who is used by AuthManager' -> relationship:references", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify(grep("who is used by AuthManager"))
        expect(decision.route).toBe("intelligence")
        expect(decision.operation).toEqual({ kind: "relationship", relation: "references", target: "AuthManager" })
      }),
    )

    it.effect("'who depends on Foo' -> relationship:dependents", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify(grep("who depends on Foo"))
        expect(decision.route).toBe("intelligence")
        expect(decision.operation).toEqual({ kind: "relationship", relation: "dependents", target: "Foo" })
      }),
    )

    it.effect("'what imports Foo' -> relationship:imports", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify(grep("what imports Foo"))
        expect(decision.route).toBe("intelligence")
        expect(decision.operation).toEqual({ kind: "relationship", relation: "imports", target: "Foo" })
      }),
    )

    it.effect("'implementations of Foo' -> relationship:implementations", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify(grep("implementations of Foo"))
        expect(decision.route).toBe("intelligence")
        expect(decision.operation).toEqual({ kind: "relationship", relation: "implementations", target: "Foo" })
      }),
    )

    it.effect("'subclasses of Foo' -> relationship:extensions", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify(grep("subclasses of Foo"))
        expect(decision.route).toBe("intelligence")
        expect(decision.operation).toEqual({ kind: "relationship", relation: "extensions", target: "Foo" })
      }),
    )

    it.effect("'who calls Foo' in the user request with a bare pattern -> intelligence", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify(grep("Foo", {}, "who calls Foo?"))
        expect(decision.route).toBe("intelligence")
        expect(decision.operation).toEqual({ kind: "relationship", relation: "callers", target: "Foo" })
      }),
    )

    it.effect("relationship language without a relation keyword -> symbol op", () =>
      Effect.gen(function* () {
        // "definition" is INTELLIGENCE vocabulary but has no relation entry:
        // the default operation is a symbol query over the full pattern.
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify(grep("AuthManager definition"))
        expect(decision.route).toBe("intelligence")
        expect(decision.operation).toEqual({ kind: "symbol", query: "AuthManager definition" })
      }),
    )
  })

  describe("hard negatives stay DIRECT (spec §121/§128)", () => {
    it.effect("docs-scoped 'callers' grep stays direct", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify(
          grep("callers", { path: "docs/" }, "grep the docs for the word callers"),
        )
        expect(decision.route).toBe("direct")
        expect(decision.reasonCodes).toContain("docs-scoped")
      }),
    )

    it.effect("README.md-scoped relationship language stays direct", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify(grep("who calls Foo", { path: "README.md" }))
        expect(decision.route).toBe("direct")
        expect(decision.reasonCodes).toContain("docs-scoped")
      }),
    )

    it.effect("grep TODO stays direct (literal query)", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify(grep("TODO"))
        expect(decision.route).toBe("direct")
        expect(decision.reasonCodes).toContain("literal-query")
        expect(decision.confidence).toBe(1)
      }),
    )

    it.effect("exact read request stays direct (exact-content-read)", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify({
          toolName: "read",
          arguments: { path: "src/foo.ts" },
          recentToolCalls: [],
        })
        expect(decision.route).toBe("direct")
        expect(decision.reasonCodes).toContain("exact-content-read")
      }),
    )
  })

  describe("Phase 2 fail-safe: hybrid stays DIRECT", () => {
    it.effect("relationship language with a narrow scope (hybrid) does NOT upgrade to intelligence", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify(grep("who calls Foo", { path: "src" }))
        expect(decision.route).toBe("direct")
        expect(decision.reasonCodes).toContain("relationship-language")
        expect(decision.reasonCodes).toContain("hybrid-direct-failsafe")
        expect(decision.confidence).toBe(0.75)
      }),
    )
  })

  describe("never fails on garbage input", () => {
    it.effect("empty arguments resolve to direct fallback", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify({
          toolName: "grep",
          arguments: {},
          recentToolCalls: [],
        })
        expect(decision.route).toBe("direct")
        expect(decision.reasonCodes).toContain("fallback-direct")
      }),
    )

    it.effect("non-string pattern resolves to direct fallback", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify({
          toolName: "grep",
          arguments: { pattern: 42 },
          recentToolCalls: [],
        })
        expect(decision.route).toBe("direct")
      }),
    )

    it.effect("unknown tool with odd arguments never fails", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify({
          toolName: "mystery",
          arguments: { nested: { deep: [1, 2, 3] } },
          recentToolCalls: [],
        })
        expect(["direct", "intelligence"]).toContain(decision.route)
      }),
    )

    it.effect("undefined userRequest and empty pattern never fail", () =>
      Effect.gen(function* () {
        const decision = yield* RepositoryGatewayRouter.RulesRouter.classify({
          toolName: "grep",
          arguments: { pattern: "" },
          userRequest: undefined,
          recentToolCalls: [],
        })
        expect(decision.route).toBe("direct")
      }),
    )
  })
})
