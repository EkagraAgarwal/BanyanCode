/**
 * Deterministic routing rules — pure `evaluate(input): RuleVerdict`.
 *
 * Implements the spec §20 signal lists as heuristics with §135 policy
 * precedence, narrowed to this module's scope:
 *
 *   1. explicit exact-content request   (§138 exactness must win)
 *   2. explicit user scope              (§121, §128, §137 docs/config scope)
 *   3. deterministic constraints        (§20 literal queries, doc patterns)
 *   4. heuristic fallback               (§20 relationship language, else direct)
 *
 * Signals are NOT absolute laws: a documentation-path signal overrides
 * relationship language (spec §121 grep "callers" docs/README.md → direct;
 * §128 grep "who calls Foo?" docs/ → direct).
 */
import {
  extractPaths,
  hasRelationshipLanguage,
  isDocumentationPath,
  isDocsScoped,
  isExactFileRead,
  isLiteralQuery,
} from "./features"
import type { RuleInput, RuleVerdict } from "./types"

/** Stable kebab-case reason codes emitted in RuleVerdict.reasonCodes. */
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

/** Direct for strong direct signals, §24-banded otherwise. */
export const CONFIDENCE = {
  strongDirect: 1,
  strongIntelligence: 0.9,
  hybrid: 0.75,
  fallbackDirect: 0.5,
} as const

function hasRangeArguments(args: Record<string, unknown>): boolean {
  return (
    typeof args.offset === "number" ||
    typeof args.limit === "number" ||
    typeof args.startLine === "number" ||
    typeof args.endLine === "number"
  )
}

/**
 * Deterministically route a repository operation. Pure, never throws, never
 * touches the filesystem or the code graph — it only classifies.
 */
export function evaluate(input: RuleInput): RuleVerdict {
  const paths = extractPaths(input)
  const relationship = hasRelationshipLanguage(input)
  const literal = isLiteralQuery(input)
  const exactRead = isExactFileRead(input)

  // Precedence 1 — explicit exact-content / exact-range request (§138).
  if (exactRead) {
    const ranged = hasRangeArguments(input.arguments)
    return {
      verdict: "direct",
      reasonCodes: [ranged ? REASON_CODES.exactRangeRead : REASON_CODES.exactContentRead],
      confidence: CONFIDENCE.strongDirect,
    }
  }

  // Precedence 2 — explicit user scope limited to documentation/config files.
  // Docs scope overrides relationship language (§121, §128, §137).
  if (isDocsScoped(input)) {
    const docs = paths.every(isDocumentationPath)
    return {
      verdict: "direct",
      reasonCodes: [docs ? REASON_CODES.docsScoped : REASON_CODES.configScoped],
      confidence: CONFIDENCE.strongDirect,
    }
  }

  // Precedence 3 — deterministic constraints: literal text queries with no
  // relationship language stay direct (§20: grep TODO / FIXME / error sigs).
  if (literal && !relationship) {
    return {
      verdict: "direct",
      reasonCodes: [REASON_CODES.literalQuery],
      confidence: CONFIDENCE.strongDirect,
    }
  }

  // Heuristic fallback — strong relationship language routes to the graph
  // (§21 Example A); a narrow non-doc scope alongside it is hybrid (graph +
  // text both plausible). Everything else defaults to direct (safe fallback,
  // §25: correct + complete beats clever + incomplete).
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
