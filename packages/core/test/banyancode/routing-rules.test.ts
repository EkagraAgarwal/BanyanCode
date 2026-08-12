import { describe, expect, test } from "bun:test"

import {
  hasRelationshipLanguage,
  isConfigFile,
  isDocumentationPath,
  isDocsScoped,
  isExactFileRead,
  isLiteralQuery,
} from "../../src/banyancode/routing/features"
import { evaluate } from "../../src/banyancode/routing/rules"
import { HIGH_CONFIDENCE, MID_CONFIDENCE, routeForConfidence } from "../../src/banyancode/routing/thresholds"
import type { RuleInput, RuleVerdict } from "../../src/banyancode/routing/types"

const verdictOf = (input: RuleInput): RuleVerdict => evaluate(input)

describe("routing rules — evaluate", () => {
  test('docs path + relationship phrase -> DIRECT (hard negative §121 grep "callers" docs/README.md)', () => {
    const v = verdictOf({ toolName: "grep", arguments: { pattern: "callers", path: "docs/README.md" } })
    expect(v.verdict).toBe("direct")
    expect(v.reasonCodes).toContain("docs-scoped")
    expect(v.confidence).toBe(1)
  })

  test('docs path + "who calls Foo?" -> DIRECT (hard negative §128 grep "who calls Foo?" docs/)', () => {
    const v = verdictOf({ toolName: "grep", arguments: { pattern: "who calls Foo?", path: "docs/" } })
    expect(v.verdict).toBe("direct")
    expect(v.reasonCodes).toContain("docs-scoped")
    expect(v.confidence).toBe(1)
  })

  test('grep("who calls AuthManager?") with no path -> INTELLIGENCE (§21 Example A)', () => {
    const v = verdictOf({ toolName: "grep", arguments: { pattern: "who calls AuthManager?" } })
    expect(v.verdict).toBe("intelligence")
    expect(v.reasonCodes).toContain("relationship-language")
    expect(v.confidence).toBe(0.9)
  })

  test("grep bare symbol with relationship userRequest -> INTELLIGENCE (§21 Example A)", () => {
    const v = verdictOf({
      toolName: "grep",
      arguments: { pattern: "AuthManager" },
      userRequest: "Find all references to AuthManager",
    })
    expect(v.verdict).toBe("intelligence")
    expect(v.reasonCodes).toContain("relationship-language")
  })

  test("read src/auth/AuthManager.ts -> DIRECT exact content (§138)", () => {
    const v = verdictOf({ toolName: "read", arguments: { path: "src/auth/AuthManager.ts" } })
    expect(v.verdict).toBe("direct")
    expect(v.reasonCodes).toContain("exact-content-read")
    expect(v.confidence).toBe(1)
  })

  test("read with offset/limit -> DIRECT exact range", () => {
    const v = verdictOf({
      toolName: "read",
      arguments: { path: "src/auth/AuthManager.ts", offset: 10, limit: 20 },
    })
    expect(v.verdict).toBe("direct")
    expect(v.reasonCodes).toContain("exact-range-read")
    expect(v.confidence).toBe(1)
  })

  test("grep TODO -> DIRECT literal query (Flow B)", () => {
    const v = verdictOf({ toolName: "grep", arguments: { pattern: "TODO" } })
    expect(v.verdict).toBe("direct")
    expect(v.reasonCodes).toContain("literal-query")
    expect(v.confidence).toBe(1)
  })

  test("grep error-message-looking pattern -> DIRECT literal query", () => {
    const v = verdictOf({
      toolName: "grep",
      arguments: { pattern: "TypeError: undefined is not an object" },
    })
    expect(v.verdict).toBe("direct")
    expect(v.reasonCodes).toContain("literal-query")
  })

  test("glob docs/**/*.md -> DIRECT docs scope", () => {
    const v = verdictOf({ toolName: "glob", arguments: { pattern: "docs/**/*.md" } })
    expect(v.verdict).toBe("direct")
    expect(v.confidence).toBe(1)
  })

  test('grep "implements" in README.md -> DIRECT (golden test §49)', () => {
    const v = verdictOf({ toolName: "grep", arguments: { pattern: "implements", path: "README.md" } })
    expect(v.verdict).toBe("direct")
    expect(v.reasonCodes).toContain("docs-scoped")
    expect(v.confidence).toBe(1)
  })

  test("config-file reads -> DIRECT", () => {
    const readEnv = verdictOf({ toolName: "read", arguments: { path: ".env" } })
    expect(readEnv.verdict).toBe("direct")
    expect(readEnv.reasonCodes).toContain("exact-content-read")

    const readJson = verdictOf({ toolName: "read", arguments: { path: "config.json" } })
    expect(readJson.verdict).toBe("direct")

    const grepConfig = verdictOf({ toolName: "grep", arguments: { pattern: "apiKey", path: "config.json" } })
    expect(grepConfig.verdict).toBe("direct")
    expect(grepConfig.reasonCodes).toContain("config-scoped")
  })

  test(".github/ paths and Dockerfile -> DIRECT", () => {
    const ci = verdictOf({ toolName: "grep", arguments: { pattern: "on:", path: ".github/workflows/ci.yml" } })
    expect(ci.verdict).toBe("direct")

    const docker = verdictOf({ toolName: "read", arguments: { path: "Dockerfile" } })
    expect(docker.verdict).toBe("direct")
  })

  test("relationship language scoped to a non-doc path -> HYBRID (0.75)", () => {
    const v = verdictOf({ toolName: "grep", arguments: { pattern: "callers", path: "src/" } })
    expect(v.verdict).toBe("hybrid")
    expect(v.reasonCodes).toContain("relationship-language")
    expect(v.reasonCodes).toContain("scoped-path")
    expect(v.confidence).toBe(0.75)
  })

  test("unknown literal grep -> DIRECT fallback (0.5)", () => {
    const v = verdictOf({ toolName: "grep", arguments: { pattern: "Foo" } })
    expect(v.verdict).toBe("direct")
    expect(v.reasonCodes).toContain("fallback-direct")
    expect(v.confidence).toBe(0.5)
  })

  test("glob for source files -> DIRECT fallback (0.5)", () => {
    const v = verdictOf({ toolName: "glob", arguments: { pattern: "src/**/*.ts" } })
    expect(v.verdict).toBe("direct")
    expect(v.reasonCodes).toContain("fallback-direct")
  })
})

describe("routing rules — feature predicates", () => {
  test("isDocumentationPath", () => {
    expect(isDocumentationPath("README.md")).toBe(true)
    expect(isDocumentationPath("CONTRIBUTING")).toBe(true)
    expect(isDocumentationPath("LICENSE")).toBe(true)
    expect(isDocumentationPath("CHANGELOG.md")).toBe(true)
    expect(isDocumentationPath("docs/architecture.md")).toBe(true)
    expect(isDocumentationPath("src/docs/guide.md")).toBe(true)
    expect(isDocumentationPath("src/auth/AuthManager.ts")).toBe(false)
  })

  test("isConfigFile", () => {
    expect(isConfigFile("config.json")).toBe(true)
    expect(isConfigFile("bunfig.toml")).toBe(true)
    expect(isConfigFile("Dockerfile")).toBe(true)
    expect(isConfigFile(".env.local")).toBe(true)
    expect(isConfigFile(".github/workflows/ci.yml")).toBe(true)
    expect(isConfigFile("src/main.ts")).toBe(false)
  })

  test("hasRelationshipLanguage", () => {
    expect(hasRelationshipLanguage({ toolName: "grep", arguments: { pattern: "who calls AuthManager?" } })).toBe(true)
    expect(hasRelationshipLanguage({ toolName: "grep", arguments: { pattern: "callers" } })).toBe(true)
    expect(hasRelationshipLanguage({ toolName: "grep", arguments: { pattern: "dependents" } })).toBe(true)
    expect(hasRelationshipLanguage({ toolName: "grep", arguments: { pattern: "imports from" } })).toBe(true)
    expect(hasRelationshipLanguage({ toolName: "grep", arguments: { pattern: "TODO" } })).toBe(false)
    expect(hasRelationshipLanguage({ toolName: "grep", arguments: { pattern: "import" } })).toBe(false)
    expect(hasRelationshipLanguage({ toolName: "grep", arguments: { pattern: "AuthManager" } })).toBe(false)
  })

  test("isLiteralQuery", () => {
    expect(isLiteralQuery({ toolName: "grep", arguments: { pattern: "TODO" } })).toBe(true)
    expect(isLiteralQuery({ toolName: "grep", arguments: { pattern: "FIXME" } })).toBe(true)
    expect(isLiteralQuery({ toolName: "grep", arguments: { pattern: "HACK" } })).toBe(true)
    expect(isLiteralQuery({ toolName: "grep", arguments: { pattern: "TypeError: x is not a function" } })).toBe(true)
    expect(isLiteralQuery({ toolName: "grep", arguments: { pattern: "AuthManager" } })).toBe(false)
  })

  test("isExactFileRead", () => {
    expect(isExactFileRead({ toolName: "read", arguments: { path: "src/auth/AuthManager.ts" } })).toBe(true)
    expect(isExactFileRead({ toolName: "grep", arguments: { pattern: "x" } })).toBe(false)
  })

  test("isDocsScoped", () => {
    expect(isDocsScoped({ toolName: "grep", arguments: { pattern: "callers", path: "docs/" } })).toBe(true)
    expect(isDocsScoped({ toolName: "grep", arguments: { pattern: "callers", path: "src/" } })).toBe(false)
    expect(isDocsScoped({ toolName: "grep", arguments: { pattern: "callers" } })).toBe(false)
  })
})

describe("routeForConfidence — §24 banding", () => {
  test(">= 0.90 -> intelligence", () => {
    expect(routeForConfidence(0.95, "intelligence")).toBe("intelligence")
    expect(routeForConfidence(HIGH_CONFIDENCE, "intelligence")).toBe("intelligence")
  })

  test("0.70-0.90 -> hybrid", () => {
    expect(routeForConfidence(0.8, "intelligence")).toBe("hybrid")
    expect(routeForConfidence(MID_CONFIDENCE, "hybrid")).toBe("hybrid")
  })

  test("< 0.70 -> direct", () => {
    expect(routeForConfidence(0.69, "intelligence")).toBe("direct")
    expect(routeForConfidence(0.5, "hybrid")).toBe("direct")
    expect(routeForConfidence(0, "intelligence")).toBe("direct")
  })

  test("direct verdict is never upgraded by confidence (§138)", () => {
    expect(routeForConfidence(1, "direct")).toBe("direct")
    expect(routeForConfidence(0.5, "direct")).toBe("direct")
  })

  test("high-confidence hybrid -> intelligence", () => {
    expect(routeForConfidence(0.99, "hybrid")).toBe("intelligence")
  })
})
