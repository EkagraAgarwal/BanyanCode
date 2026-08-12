export * as RepositoryGatewayRouter from "./router"

import { Context, Effect } from "effect"
import { extractPattern, routeForConfidence } from "../routing"
import { evaluate as evaluateRoutingRules } from "../routing/rules"
import type { RuleInput } from "../routing/types"
import type { Relation, RepositoryOperation, RouteDecision, RouterInput, ToolRouter } from "./types"

// Context tag for the ToolRouter dependency consumed by the gateway layer.
// `defaultLayer` supplies the NoopRouter or RulesRouter behind
// BANYANCODE_ROUTER / `banyancode_router` (plan §2.7) by replacing this tag.
export class ToolRouterService extends Context.Service<ToolRouterService, ToolRouter>()("@banyancode/ToolRouter") {}

// RulesRouter identity + policy version (spec §43): recorded in RouteDecision
// provenance and forwarded into `repository_route` traces so benchmark
// comparisons stay meaningful across policy releases. Bump ROUTER_VERSION when
// the relation-keyword table, threshold banding, or verdict mapping changes.
export const ROUTER_IDENTITY = "rules"
export const ROUTER_VERSION = "0.1.0"

// Passthrough router — the default. Every request routes DIRECT with full
// confidence so the gateway is a byte-for-byte behavioral no-op when the
// router feature is off (plan §4: "Disabled router (default) must be a
// byte-for-byte behavioral no-op").
export const NoopRouter: ToolRouter = {
  classify: (_input: RouterInput): Effect.Effect<RouteDecision, never, never> =>
    Effect.succeed({
      route: "direct",
      confidence: 1,
      reasonCodes: ["noop"],
      router: "noop",
      routerVersion: "0",
    }),
}

// Relationship-language detection (spec §20 INTELLIGENCE indicators). Maps the
// relation keyword found in the pattern/args to the RepositoryOperation
// `relation` it expresses. Order matters — the FIRST matching entry wins, with
// the more specific phrases listed before the bare keywords they contain.
const RELATION_MATCHERS: ReadonlyArray<{ readonly relation: Relation; readonly pattern: RegExp }> = [
  { relation: "callers", pattern: /\b(?:callers|call sites?|called by|calls from|who calls|what calls|calls?)\b/i },
  { relation: "references", pattern: /\b(?:references?|referenced|used by|usages?|usage|uses|used)\b/i },
  { relation: "dependents", pattern: /\b(?:dependents?|depends? on|depend on|affected components|impact(?:s|ed|ing)?)\b/i },
  { relation: "imports", pattern: /\b(?:imports?|imported|importing)\b/i },
  { relation: "implementations", pattern: /\b(?:implementations?|implements|implemented|implementing)\b/i },
  { relation: "extensions", pattern: /\b(?:extends?|extended|extending|subclasses?|subclass of)\b/i },
]

// Identifier-ish tail of the pattern: letters/digits/underscore plus `/`, `.`,
// `-` so "who calls src/server.ts" keeps the path as the target.
const TARGET_IDENTIFIER = "[A-Za-z_$][A-Za-z0-9_$./-]*"
const TARGET_WITH_CONNECTOR = new RegExp(`\\s*(?:of|to|for|in|from|by|with|that)\\s+(${TARGET_IDENTIFIER})`)
const TARGET_BARE = new RegExp(`\\s*(${TARGET_IDENTIFIER})`)

// Detect the relation keyword in `text` and extract the target symbol/path
// that follows it ("who calls AuthManager" -> { callers, "AuthManager" },
// "implementations of Foo" -> { implementations, "Foo" }). The target is
// best-effort: when nothing follows the keyword, the caller falls back to the
// full pattern string as the target.
const detectRelation = (
  text: string,
): { readonly relation: Relation; readonly target?: string } | undefined => {
  if (text.trim() === "") return undefined
  for (const matcher of RELATION_MATCHERS) {
    const match = matcher.pattern.exec(text)
    if (!match) continue
    const after = text.slice((match.index ?? 0) + match[0].length)
    const connector = after.match(TARGET_WITH_CONNECTOR)
    const bare = connector ?? after.match(TARGET_BARE)
    const target = bare?.[1]?.replace(/[./]+$/, "").trim()
    return { relation: matcher.relation, target: target !== "" ? target : undefined }
  }
  return undefined
}

// Build the pure routing-rules input from the gateway RouterInput. `paths` is
// intentionally omitted: rules.ts derives the scope from `arguments` via
// extractPaths, and RouterInput carries no pre-resolved scope.
const buildRuleInput = (input: RouterInput): RuleInput => ({
  toolName: input.toolName,
  arguments: input.arguments,
  userRequest: input.userRequest,
})

// Derive the semantic RepositoryOperation for an INTELLIGENCE decision:
// relationship ops when the pattern/userRequest carries relation vocabulary,
// otherwise a symbol query over the full pattern text.
export const deriveOperation = (input: RouterInput): RepositoryOperation => {
  const pattern = extractPattern(input) ?? ""
  const relation = detectRelation(pattern) ?? detectRelation(input.userRequest ?? "")
  if (relation !== undefined) {
    return { kind: "relationship", relation: relation.relation, target: relation.target ?? pattern }
  }
  return { kind: "symbol", query: pattern }
}

// Pure verdict -> RouteDecision mapping. Never throws (pure functions only).
export const classifyRules = (input: RouterInput): RouteDecision => {
  const verdict = evaluateRoutingRules(buildRuleInput(input))
  const banded = routeForConfidence(verdict.confidence, verdict.verdict)

  // Only high-confidence (>= 0.90) relationship language upgrades to
  // INTELLIGENCE (spec §24). Hybrid — relationship language alongside a
  // narrow scope (0.75) — is deliberately kept DIRECT in Phase 2: both the
  // graph and the text index are plausible, and a misroute costs more than a
  // miss (spec §46: optimize the false-intelligence rate first). The §24
  // banding is still applied here as the policy hook; a learned classifier
  // (Phase 5) can arbitrate the 0.70-0.90 band instead.
  if (verdict.verdict === "intelligence" && banded === "intelligence") {
    return {
      route: "intelligence",
      operation: deriveOperation(input),
      confidence: verdict.confidence,
      reasonCodes: verdict.reasonCodes,
      router: ROUTER_IDENTITY,
      routerVersion: ROUTER_VERSION,
    }
  }

  return {
    route: "direct",
    confidence: verdict.confidence,
    reasonCodes:
      verdict.verdict === "hybrid" ? [...verdict.reasonCodes, "hybrid-direct-failsafe"] : verdict.reasonCodes,
    router: ROUTER_IDENTITY,
    routerVersion: ROUTER_VERSION,
  }
}

// Deterministic signal-based router (plan §2.7, Phase 2). Never fails by
// contract: any defect during classification falls back to DIRECT so a router
// bug can never block or distort the original tool call.
export const RulesRouter: ToolRouter = {
  classify: (input: RouterInput): Effect.Effect<RouteDecision, never, never> =>
    Effect.sync(() => classifyRules(input)).pipe(
      Effect.catchCause(() =>
        Effect.succeed({
          route: "direct" as const,
          confidence: 0.5,
          reasonCodes: ["rules-fallback"],
          router: ROUTER_IDENTITY,
          routerVersion: ROUTER_VERSION,
        }),
      ),
    ),
}
