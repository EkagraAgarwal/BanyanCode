/**
 * Routing benchmark harness — shared scoring logic (spec §46-51, §148-151).
 *
 * Two entry points, one scoring pipeline:
 *   - `scoreCorpus(corpus, evaluate)` — scores any deterministic
 *     `evaluate(input): RuleVerdict` router (the rules path);
 *   - `scoreRouter(corpus, classify)` — scores any gateway ToolRouter
 *     (`classify(input): Effect<RouteDecision>`), i.e. RulesRouter or a test
 *     stub, against the same corpus.
 *
 * Both run against the routing corpus (`test/fixture/routing-corpus.ts`, 365
 * cases / 45 hard negatives). Coarse scoring collapses the corpus's
 * fine-grained expected routes onto the three verdict buckets:
 *
 *   DIRECT_READ / DIRECT_SEARCH / DIRECT_GLOB  -> "direct"
 *   SYMBOL_SEARCH / REFERENCES / CALLERS / CALLEES / DEPENDENTS / IMPORTS /
 *   IMPLEMENTATIONS / EXTENSIONS / IMPACT / STRUCTURAL / ARCHITECTURE /
 *   OWNERSHIP                                  -> "intelligence"
 *   HYBRID                                     -> "hybrid"
 *
 * Scoring is exact coarse-match (1.0 on match, 0.0 otherwise) — no partial
 * credit. The corpus currently contains no HYBRID entries; if one is added,
 * an exact "hybrid" verdict is required for full credit (a hybrid route is a
 * distinct route, not a halfway point between direct and intelligence).
 *
 * Baseline is the NoopRouter behavior: always "direct" (spec §148). The two
 * critical error rates from spec §46 are tracked separately:
 *   - missed intelligence: an intelligence-expected case left "direct"
 *     (hurts performance, usually preserves correctness);
 *   - false intelligence: a direct-expected case upgraded to intelligence or
 *     hybrid (dangerous — documentation content missed by the graph).
 * Per spec §46 the false-intelligence rate is the one to optimize first.
 */
import { Effect } from "effect"
import type { RoutingCase } from "../../../test/fixture/routing-corpus"
import type { RouteDecision, RouterInput } from "../gateway/types"
import type { RuleInput, RuleVerdict, RouteVerdict } from "./types"

/** Coarse route buckets the corpus expected routes are mapped onto. */
export type CoarseRoute = RouteVerdict

/** Map a corpus expected route onto its coarse bucket. */
export function expectedCoarseRoute(expected: RoutingCase["expectedRoute"]): CoarseRoute {
  switch (expected) {
    case "DIRECT_READ":
    case "DIRECT_SEARCH":
    case "DIRECT_GLOB":
      return "direct"
    case "HYBRID":
      return "hybrid"
    default:
      return "intelligence"
  }
}

/** Build the `RuleInput` the rules engine consumes from a corpus case. */
export function toRuleInput(case_: RoutingCase): RuleInput {
  return {
    toolName: case_.toolName,
    arguments: case_.arguments,
    userRequest: case_.userRequest,
  }
}

export interface CaseScore {
  id: string
  category: RoutingCase["category"]
  expectedRoute: RoutingCase["expectedRoute"]
  expected: CoarseRoute
  actual: CoarseRoute
  correct: boolean
  verdict: RuleVerdict
}

export interface CategoryScore {
  total: number
  correct: number
  accuracy: number
}

export interface BenchResult {
  total: number
  correct: number
  accuracy: number
  baselineCorrect: number
  baselineAccuracy: number
  perCategory: Readonly<Record<RoutingCase["category"], CategoryScore>>
  byId: ReadonlyMap<string, CaseScore>
  /** Hard-negative ids that did NOT route "direct" (spec §48/§49 golden invariant). */
  hardNegativeErrors: readonly string[]
  /** Intelligence-expected ids left "direct" (missed intelligence, spec §46). */
  missedIntelligence: readonly string[]
  missedIntelligenceRate: number
  /** Direct-expected ids upgraded to intelligence/hybrid (false intelligence, spec §46). */
  falseIntelligence: readonly string[]
  falseIntelligenceRate: number
  cases: readonly CaseScore[]
}

export type Evaluator = (input: RuleInput) => RuleVerdict

const CATEGORIES = [
  "content",
  "lexical-search",
  "symbol",
  "relationships",
  "structural",
  "architecture",
  "ambiguous",
  "hard-negative",
] as const satisfies readonly RoutingCase["category"][]

/** Score one corpus case from its verdict. Shared by the sync and Effect paths. */
const scoreCase = (case_: RoutingCase, verdict: RuleVerdict): CaseScore => {
  const expected = expectedCoarseRoute(case_.expectedRoute)
  return {
    id: case_.id,
    category: case_.category,
    expectedRoute: case_.expectedRoute,
    expected,
    actual: verdict.verdict,
    correct: verdict.verdict === expected,
    verdict,
  }
}

/** Aggregate a flat CaseScore list into the benchmark result (baseline + error rates). */
const aggregateScores = (cases: readonly CaseScore[]): BenchResult => {
  const total = cases.length
  const correct = cases.filter((c) => c.correct).length
  const baselineCorrect = cases.filter((c) => c.expected === "direct").length

  const perCategory = {} as Record<RoutingCase["category"], CategoryScore>
  for (const category of CATEGORIES) {
    const inCategory = cases.filter((c) => c.category === category)
    const correctInCategory = inCategory.filter((c) => c.correct).length
    perCategory[category] = {
      total: inCategory.length,
      correct: correctInCategory,
      accuracy: inCategory.length === 0 ? 0 : correctInCategory / inCategory.length,
    }
  }

  const hardNegativeErrors = cases
    .filter((c) => c.category === "hard-negative" && c.actual !== "direct")
    .map((c) => c.id)
  const missedIntelligence = cases.filter((c) => c.expected !== "direct" && c.actual === "direct").map((c) => c.id)
  const falseIntelligence = cases.filter((c) => c.expected === "direct" && c.actual !== "direct").map((c) => c.id)

  const intelligenceExpected = cases.filter((c) => c.expected !== "direct").length
  const directExpected = cases.filter((c) => c.expected === "direct").length

  return {
    total,
    correct,
    accuracy: total === 0 ? 0 : correct / total,
    baselineCorrect,
    baselineAccuracy: total === 0 ? 0 : baselineCorrect / total,
    perCategory,
    byId: new Map(cases.map((c) => [c.id, c])),
    hardNegativeErrors,
    missedIntelligence,
    missedIntelligenceRate: intelligenceExpected === 0 ? 0 : missedIntelligence.length / intelligenceExpected,
    falseIntelligence,
    falseIntelligenceRate: directExpected === 0 ? 0 : falseIntelligence.length / directExpected,
    cases,
  }
}

/** Score a corpus against a router. Pure: no I/O, no side effects. */
export function scoreCorpus(corpus: readonly RoutingCase[], evaluate: Evaluator): BenchResult {
  return aggregateScores(corpus.map((c) => scoreCase(c, evaluate(toRuleInput(c)))))
}

// ── Generic ToolRouter scorer (spec §47-51, §111, §123, §148) ────────────
// scoreRouter scores ANY gateway router — RulesRouter or a test stub —
// against the same corpus by running its Effect-based classify per case
// (concurrency 4). The classify contract is never-failing (plan §2.7):
// defects must be caught INSIDE classify and fail closed to "direct", so a
// router bug can never block the benchmark.

/** Map a corpus case onto the gateway RouterInput routers consume (spec §133). */
export function routerInputFor(case_: RoutingCase): RouterInput {
  return {
    toolName: case_.toolName,
    arguments: case_.arguments,
    userRequest: case_.userRequest,
    recentToolCalls: [],
  }
}

/** Map a RouteDecision route onto the coarse bucket used for scoring. */
export function coarseRouteForDecision(route: RouteDecision["route"]): CoarseRoute {
  switch (route) {
    case "direct":
      return "direct"
    case "intelligence":
      return "intelligence"
    case "augment":
      // Augment = original tool + graph augmentation: the corpus "hybrid"
      // bucket (combine multiple routes).
      return "hybrid"
  }
}

const verdictFromDecision = (decision: RouteDecision): RuleVerdict => ({
  verdict: coarseRouteForDecision(decision.route),
  reasonCodes: [...decision.reasonCodes],
  confidence: decision.confidence,
})

/** Score a corpus against a gateway ToolRouter's classify. Effect-based. */
export function scoreRouter(
  corpus: readonly RoutingCase[],
  classify: (input: RouterInput) => Effect.Effect<RouteDecision, never, never>,
): Effect.Effect<BenchResult, never, never> {
  return Effect.forEach(corpus, (case_) => classify(routerInputFor(case_)), { concurrency: 4 }).pipe(
    Effect.map((decisions) =>
      aggregateScores(decisions.map((decision, index) => scoreCase(corpus[index], verdictFromDecision(decision)))),
    ),
  )
}
