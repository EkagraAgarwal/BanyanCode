import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import type { RouteDecision, RouterInput } from "../../src/banyancode/gateway/types"
import { coarseRouteForDecision, routerInputFor, scoreRouter } from "../../src/banyancode/routing/bench"
import { ROUTING_CORPUS, type RoutingCase } from "../fixture/routing-corpus"

// Generic router scorer (routing/bench.ts scoreRouter): scores ANY gateway
// ToolRouter against the corpus (spec §47-51, §111, §123, §148). classify is
// never-failing by contract (plan §2.7) — defects must be caught inside
// classify and fail closed to "direct".
const decision = (route: RouteDecision["route"], reasonCodes: string[] = ["test"]): RouteDecision => ({
  route,
  confidence: 1,
  reasonCodes,
})

// Stable key from RouterInput so a stub can recover the corpus case (and its
// category) from the exact object scoreRouter passes to classify.
const inputKey = (input: RouterInput): string =>
  JSON.stringify([input.toolName, input.arguments, input.userRequest ?? null])

const caseByInputKey = new Map<string, RoutingCase>(
  ROUTING_CORPUS.map((case_) => [inputKey(routerInputFor(case_)), case_]),
)

describe("scoreRouter — generic router scorer (spec §47-51, §148)", () => {
  test("always-direct router matches the always-direct baseline exactly", async () => {
    const result = await Effect.runPromise(scoreRouter(ROUTING_CORPUS, () => Effect.succeed(decision("direct"))))

    expect(result.total).toBe(ROUTING_CORPUS.length)
    expect(result.correct).toBe(result.baselineCorrect)
    expect(result.accuracy).toBe(result.baselineAccuracy)
    expect(result.hardNegativeErrors).toEqual([])
    expect(result.missedIntelligence.length).toBe(ROUTING_CORPUS.length - result.baselineCorrect)
  })

  test("intelligence-for-relationships router beats the baseline with zero hard-negative leaks", async () => {
    const classify = (input: RouterInput): Effect.Effect<RouteDecision, never, never> =>
      Effect.succeed(
        decision(
          caseByInputKey.get(inputKey(input))?.category === "relationships" ? "intelligence" : "direct",
          ["stub"],
        ),
      )

    const result = await Effect.runPromise(scoreRouter(ROUTING_CORPUS, classify))

    expect(result.accuracy).toBeGreaterThan(result.baselineAccuracy)
    expect(result.perCategory["relationships"].correct).toBe(65)
    // direct-expected cases were never upgraded — no false intelligence
    expect(result.falseIntelligence).toEqual([])
    // all 45 hard negatives routed direct — no leaks
    expect(result.hardNegativeErrors).toEqual([])
  })

  test("classify that throws inside but fails closed to direct still completes", async () => {
    // Fail-closed per contract: the defect is caught INSIDE classify.
    const failClosed = (): Effect.Effect<RouteDecision, never, never> =>
      Effect.sync(() => {
        throw new Error("router defect")
      }).pipe(Effect.catchCause(() => Effect.succeed(decision("direct", ["defect-fallback"]))))

    const result = await Effect.runPromise(scoreRouter(ROUTING_CORPUS, failClosed))
    expect(result.total).toBe(ROUTING_CORPUS.length)
    expect(result.accuracy).toBe(result.baselineAccuracy)

    // A defect that escapes classify (violating the never-failing contract)
    // rejects the whole benchmark — scoreRouter must not hide router bugs.
    const uncaught = (): Effect.Effect<RouteDecision, never, never> =>
      Effect.sync(() => {
        throw new Error("escaped defect")
      })
    await expect(Effect.runPromise(scoreRouter(ROUTING_CORPUS, uncaught))).rejects.toThrow()
  })

  test("maps RouteDecision.route direct/intelligence/augment onto direct/intelligence/hybrid", async () => {
    const miniCorpus: RoutingCase[] = [
      { id: "mini-direct", toolName: "read", arguments: { filePath: "README.md" }, expectedRoute: "DIRECT_READ", category: "content" },
      { id: "mini-intel", toolName: "grep", arguments: { pattern: "AuthManager" }, userRequest: "Who calls AuthManager?", expectedRoute: "CALLERS", category: "relationships" },
      { id: "mini-hybrid", toolName: "grep", arguments: { pattern: "Foo" }, expectedRoute: "HYBRID", category: "ambiguous" },
    ]
    const classify = (input: RouterInput): Effect.Effect<RouteDecision, never, never> =>
      Effect.succeed(
        decision(
          input.arguments.filePath !== undefined ? "direct" : input.arguments.pattern === "Foo" ? "augment" : "intelligence",
          ["test"],
        ),
      )

    const result = await Effect.runPromise(scoreRouter(miniCorpus, classify))
    expect(result.byId.get("mini-direct")?.actual).toBe("direct")
    expect(result.byId.get("mini-intel")?.actual).toBe("intelligence")
    expect(result.byId.get("mini-hybrid")?.actual).toBe("hybrid")
    expect(result.correct).toBe(3)

    expect(coarseRouteForDecision("direct")).toBe("direct")
    expect(coarseRouteForDecision("intelligence")).toBe("intelligence")
    expect(coarseRouteForDecision("augment")).toBe("hybrid")
  })

  test("routerInputFor maps corpus fields onto RouterInput", () => {
    const case_ = ROUTING_CORPUS[0]!
    const input = routerInputFor(case_)
    expect(input.toolName).toBe(case_.toolName)
    expect(input.arguments).toBe(case_.arguments)
    expect(input.userRequest).toBe(case_.userRequest)
    expect(input.recentToolCalls).toEqual([])
    expect(input.investigationState).toBeUndefined()
    expect(input.repositoryContext).toBeUndefined()
  })
})
