export * as GatewayRouting from "./routing.js"

import type { RuleInput, RuleVerdict, RouteVerdict } from "./types.js"

// Ported from v1 `packages/core/src/banyancode/routing/{features,rules,thresholds}.ts`.
// Pure predicates + deterministic rules. No filesystem, no graph, no services.

const DOC_BASENAMES = new Set(["readme", "contributing", "license", "changelog"])
const DOC_EXTENSIONS = new Set([".md", ".mdx"])
const CONFIG_EXTENSIONS = new Set([".txt", ".yaml", ".yml", ".json", ".toml", ".xml", ".env"])

export const normalizePath = (path: string): string => path.replace(/\\/g, "/")

const extensionOf = (base: string): string => {
  const dot = base.lastIndexOf(".")
  return dot <= 0 ? "" : base.slice(dot).toLowerCase()
}

const hasSegment = (path: string, segment: string): boolean => path.split("/").some((part) => part === segment)

const basenameOf = (path: string): string => {
  const parts = normalizePath(path).split("/")
  return parts[parts.length - 1] ?? path
}

export function isDocumentationPath(path: string): boolean {
  const base = basenameOf(path)
  const stem = base.replace(/\.(md|mdx|txt)$/i, "").toLowerCase()
  if (DOC_BASENAMES.has(stem)) return true
  if (hasSegment(normalizePath(path), "docs")) return true
  if (hasSegment(normalizePath(path), "specs")) return true
  return DOC_EXTENSIONS.has(extensionOf(base))
}

export function isConfigFile(path: string): boolean {
  const base = basenameOf(path)
  const lower = base.toLowerCase()
  if (CONFIG_EXTENSIONS.has(extensionOf(base))) return true
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return true
  if (lower.startsWith(".env")) return true
  if (hasSegment(normalizePath(path), ".github")) return true
  return false
}

export const isDirectPathSignal = (path: string): boolean => isDocumentationPath(path) || isConfigFile(path)

export function extractPaths(input: RuleInput): string[] {
  const out: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.trim() !== "") out.push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim() !== "") out.push(item)
      }
    }
  }
  if (input.paths !== undefined) {
    for (const p of input.paths) push(p)
  }
  push(input.arguments.path)
  push(input.arguments.paths)
  push(input.arguments.directory)
  if (input.toolName === "glob") push(input.arguments.pattern)
  if (input.toolName === "grep") push(input.arguments.include)
  return out
}

export function extractPattern(input: RuleInput): string | undefined {
  for (const key of ["pattern", "query", "target"] as const) {
    const value = input.arguments[key]
    if (typeof value === "string" && value.trim() !== "") return value
  }
  return undefined
}

export function isExactFileRead(input: RuleInput): boolean {
  if (input.toolName !== "read") return false
  const target = input.arguments.path ?? input.arguments.filePath
  return typeof target === "string" && target.trim() !== ""
}

const RELATIONSHIP_PHRASES = [
  "call sites",
  "call site",
  "called by",
  "calls from",
  "imported by",
  "imports from",
  "implementations of",
  "implementation of",
  "subclasses of",
  "subclass of",
  "affected components",
  "who calls",
  "what calls",
  "used by",
  "depends on",
  "depend on",
] as const

const RELATIONSHIP_TOKENS = new Set([
  "callers",
  "calls",
  "called",
  "references",
  "referenced",
  "reference",
  "usages",
  "usage",
  "dependents",
  "dependencies",
  "dependency",
  "implementations",
  "implementation",
  "implements",
  "implemented",
  "implementing",
  "extends",
  "extended",
  "extending",
  "subclasses",
  "subclass",
  "imports",
  "imported",
  "impact",
  "impacts",
  "impacted",
  "affected",
  "affecting",
  "affects",
  "architecture",
  "architectural",
  "ownership",
  "owner",
  "definition",
  "definitions",
  "define",
  "defined",
  "defining",
  "symbol",
  "symbols",
  "relationship",
  "relationships",
])

const RELATIONSHIP_TOKEN_PATTERN = new RegExp(`\\b(?:${[...RELATIONSHIP_TOKENS].join("|")})\\b`, "i")

export function hasRelationshipLanguage(input: RuleInput): boolean {
  const pattern = extractPattern(input)
  const text = [pattern, input.userRequest].filter((t): t is string => typeof t === "string").join(" ")
  if (text.trim() === "") return false
  const lower = text.toLowerCase()
  if (RELATIONSHIP_PHRASES.some((phrase) => lower.includes(phrase))) return true
  return RELATIONSHIP_TOKEN_PATTERN.test(text)
}

const LITERAL_TOKENS = new Set(["todo", "fixme", "hack", "xxx", "note", "bug"])
const LITERAL_TOKEN_PATTERN = new RegExp(`\\b(?:${[...LITERAL_TOKENS].join("|")})\\b`, "i")
const ERROR_SIGNATURE_PATTERN =
  /(?:typeerror|referenceerror|rangeerror|syntaxerror|urierror|eacces|enoent|epipe|econnrefused)\b|not a function|is not defined|cannot read|undefined is not|uncaught exception|stack trace|error\s*:|warning\s*:/i

export function isLiteralQuery(input: RuleInput): boolean {
  const pattern = extractPattern(input)
  if (pattern === undefined) return false
  if (LITERAL_TOKEN_PATTERN.test(pattern)) return true
  return ERROR_SIGNATURE_PATTERN.test(pattern)
}

export function isDocsScoped(input: RuleInput): boolean {
  const paths = extractPaths(input)
  return paths.length > 0 && paths.every(isDirectPathSignal)
}

export const HIGH_CONFIDENCE = 0.9
export const MID_CONFIDENCE = 0.7

export function routeForConfidence(confidence: number, verdict: RouteVerdict): RouteVerdict {
  if (verdict === "direct" || confidence < MID_CONFIDENCE) return "direct"
  if (confidence >= HIGH_CONFIDENCE) return "intelligence"
  return "hybrid"
}

export const REASON_CODES = {
  exactContentRead: "exact-content-read",
  exactRangeRead: "exact-range-read",
  docsScoped: "docs-scoped",
  configScoped: "config-scoped",
  literalQuery: "literal-query",
  relationshipLanguage: "relationship-language",
  scopedPath: "scoped-path",
  fallbackDirect: "fallback-direct",
} as const

export const CONFIDENCE = {
  strongDirect: 1,
  strongIntelligence: 0.9,
  hybrid: 0.75,
  fallbackDirect: 0.5,
} as const

const hasRangeArguments = (args: Record<string, unknown>): boolean =>
  typeof args.offset === "number" ||
  typeof args.limit === "number" ||
  typeof args.startLine === "number" ||
  typeof args.endLine === "number"

export function evaluate(input: RuleInput): RuleVerdict {
  const paths = extractPaths(input)
  const relationship = hasRelationshipLanguage(input)
  const literal = isLiteralQuery(input)
  const exactRead = isExactFileRead(input)

  if (exactRead) {
    const ranged = hasRangeArguments(input.arguments)
    return {
      verdict: "direct",
      reasonCodes: [ranged ? REASON_CODES.exactRangeRead : REASON_CODES.exactContentRead],
      confidence: CONFIDENCE.strongDirect,
    }
  }

  if (isDocsScoped(input)) {
    const docs = paths.every(isDocumentationPath)
    return {
      verdict: "direct",
      reasonCodes: [docs ? REASON_CODES.docsScoped : REASON_CODES.configScoped],
      confidence: CONFIDENCE.strongDirect,
    }
  }

  if (literal && !relationship) {
    return {
      verdict: "direct",
      reasonCodes: [REASON_CODES.literalQuery],
      confidence: CONFIDENCE.strongDirect,
    }
  }

  if (relationship) {
    if (paths.length > 0) {
      return {
        verdict: "hybrid",
        reasonCodes: [REASON_CODES.relationshipLanguage, REASON_CODES.scopedPath],
        confidence: CONFIDENCE.hybrid,
      }
    }
    return {
      verdict: "intelligence",
      reasonCodes: [REASON_CODES.relationshipLanguage],
      confidence: CONFIDENCE.strongIntelligence,
    }
  }

  return {
    verdict: "direct",
    reasonCodes: [REASON_CODES.fallbackDirect],
    confidence: CONFIDENCE.fallbackDirect,
  }
}
