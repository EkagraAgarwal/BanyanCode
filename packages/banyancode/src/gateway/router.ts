export * as GatewayRouter from "./router.js"

import { Effect } from "effect"
import { extractPattern, evaluate, REASON_CODES, routeForConfidence } from "./routing.js"
import type { Relation, RepositoryOperation, RouteDecision, RouterInput, ToolRouter } from "./types.js"

// Ported from v1 `gateway/router.ts`. Identity is unchanged so routing traces
// from v1 and v2 remain comparable.

export const ROUTER_IDENTITY = "rules"
export const ROUTER_VERSION = "0.1.0"
export const REASON_CODE_CONTENT_CODE_FILE = "content-code-file"

export const NoopRouter: ToolRouter = {
  classify: (): Effect.Effect<RouteDecision, never, never> =>
    Effect.succeed({
      route: "direct",
      confidence: 1,
      reasonCodes: ["noop"],
      router: "noop",
      routerVersion: "0",
    }),
}

const RELATION_MATCHERS: ReadonlyArray<{ readonly relation: Relation; readonly pattern: RegExp }> = [
  { relation: "callers", pattern: /\b(?:callers|call sites?|called by|calls from|who calls|what calls|calls?)\b/i },
  { relation: "references", pattern: /\b(?:references?|referenced|used by|usages?|usage|uses|used)\b/i },
  { relation: "dependents", pattern: /\b(?:dependents?|depends? on|depend on|affected components|impact(?:s|ed|ing)?)\b/i },
  { relation: "imports", pattern: /\b(?:imports?|imported|importing)\b/i },
  { relation: "implementations", pattern: /\b(?:implementations?|implements|implemented|implementing)\b/i },
  { relation: "extensions", pattern: /\b(?:extends?|extended|extending|subclasses?|subclass of)\b/i },
]

const TARGET_IDENTIFIER = "[A-Za-z_$][A-Za-z0-9_$./-]*"
const TARGET_WITH_CONNECTOR = new RegExp(`\\s*(?:of|to|for|in|from|by|with|that)\\s+(${TARGET_IDENTIFIER})`)
const TARGET_BARE = new RegExp(`\\s*(${TARGET_IDENTIFIER})`)

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

export const deriveOperation = (input: RouterInput): RepositoryOperation => {
  const pattern = extractPattern(input) ?? ""
  const relation = detectRelation(pattern) ?? detectRelation(input.userRequest ?? "")
  if (relation !== undefined) {
    return { kind: "relationship", relation: relation.relation, target: relation.target ?? pattern }
  }
  return { kind: "symbol", query: pattern }
}

const readPathFor = (input: RouterInput): string => {
  const target = input.arguments.path ?? input.arguments.filePath
  return typeof target === "string" ? target : ""
}

// Code-file allowlist shared with the read-augmentation gate, so an augment
// decision can always either produce a header or fail closed to direct.
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "py", "rs", "go", "java", "kt", "kts", "scala", "groovy",
  "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "swift",
  "rb", "php", "sh", "bash", "zsh", "zig", "dart", "lua",
  "ex", "exs", "erl", "hrl", "hs", "clj", "cljs",
])

export const isCodePath = (path: string): boolean => {
  const dot = path.lastIndexOf(".")
  if (dot < 0 || dot === path.length - 1) return false
  return CODE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}

export const classifyRules = (input: RouterInput): RouteDecision => {
  const verdict = evaluate({
    toolName: input.toolName,
    arguments: input.arguments,
    ...(input.userRequest === undefined ? {} : { userRequest: input.userRequest }),
  })
  const banded = routeForConfidence(verdict.confidence, verdict.verdict)

  if (
    (verdict.reasonCodes.includes(REASON_CODES.exactContentRead) ||
      verdict.reasonCodes.includes(REASON_CODES.exactRangeRead)) &&
    isCodePath(readPathFor(input))
  ) {
    return {
      route: "augment",
      confidence: 1,
      reasonCodes: [...verdict.reasonCodes, REASON_CODE_CONTENT_CODE_FILE],
      router: ROUTER_IDENTITY,
      routerVersion: ROUTER_VERSION,
    }
  }

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

export const directDecision = (decision: RouteDecision): RouteDecision => ({
  ...decision,
  route: "direct",
})
