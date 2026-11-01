import { describe, expect, test } from "bun:test"
import { classifyRules, deriveOperation, isCodePath, NoopRouter, RulesRouter } from "../../src/gateway/router.js"
import { formatAugmentHeader } from "../../src/gateway/formatter.js"
import { evaluate, REASON_CODES } from "../../src/gateway/routing.js"
import { Effect } from "effect"

const input = (toolName: string, args: Record<string, unknown>, userRequest?: string) => ({
  toolName,
  arguments: args,
  recentToolCalls: [],
  ...(userRequest === undefined ? {} : { userRequest }),
})

describe("gateway routing port", () => {
  test("exact reads stay direct", () => {
    const verdict = evaluate(input("read", { path: "src/app.ts" }))
    expect(verdict.verdict).toBe("direct")
    expect(verdict.reasonCodes).toEqual([REASON_CODES.exactContentRead])
    expect(verdict.confidence).toBe(1)
  })

  test("relationship language routes to intelligence", () => {
    const verdict = evaluate(input("grep", { pattern: "who calls AuthManager" }))
    expect(verdict.verdict).toBe("intelligence")
    expect(verdict.confidence).toBe(0.9)
    expect(verdict.reasonCodes).toEqual([REASON_CODES.relationshipLanguage])
  })

  test("a scoped relationship query is hybrid and fails closed to direct", () => {
    const verdict = evaluate(input("grep", { pattern: "callers of AuthManager", path: "src" }))
    expect(verdict.verdict).toBe("hybrid")
    const decision = classifyRules(input("grep", { pattern: "callers of AuthManager", path: "src" }))
    expect(decision.route).toBe("direct")
    expect(decision.reasonCodes).toContain("hybrid-direct-failsafe")
  })

  test("documentation scope overrides relationship language", () => {
    const verdict = evaluate(input("grep", { pattern: "callers", path: "docs" }))
    expect(verdict.verdict).toBe("direct")
    expect(verdict.reasonCodes).toEqual([REASON_CODES.docsScoped])
  })

  test("literal marker queries stay direct", () => {
    const verdict = evaluate(input("grep", { pattern: "TODO" }))
    expect(verdict.verdict).toBe("direct")
    expect(verdict.reasonCodes).toEqual([REASON_CODES.literalQuery])
  })

  test("exact reads of code files route to augment", () => {
    const decision = classifyRules(input("read", { path: "src/auth/AuthManager.ts" }))
    expect(decision.route).toBe("augment")
    expect(decision.reasonCodes).toContain("content-code-file")
    expect(classifyRules(input("read", { path: "README.md" })).route).toBe("direct")
  })

  test("deriveOperation extracts relationship targets", () => {
    expect(deriveOperation(input("grep", { pattern: "who calls AuthManager" }))).toEqual({
      kind: "relationship",
      relation: "callers",
      target: "AuthManager",
    })
    expect(deriveOperation(input("grep", { pattern: "AuthManager" }))).toEqual({
      kind: "symbol",
      query: "AuthManager",
    })
  })

  test("code path allowlist", () => {
    expect(isCodePath("src/a.ts")).toBe(true)
    expect(isCodePath("src/a.TSX")).toBe(true)
    expect(isCodePath("package.json")).toBe(false)
    expect(isCodePath("Makefile")).toBe(false)
  })

  test("augment header matches the v1 rendering", () => {
    expect(
      formatAugmentHeader({ symbol: "AuthManager", imports: 2, references: 7, callers: 3, dependents: 1 }),
    ).toBe("Symbol: AuthManager | Imports: 2 | References: 7 | Callers: 3 | Dependents: 1")
  })

  test("NoopRouter is a byte-identical passthrough", async () => {
    const decision = await Effect.runPromise(NoopRouter.classify(input("grep", { pattern: "x" })))
    expect(decision).toEqual({ route: "direct", confidence: 1, reasonCodes: ["noop"], router: "noop", routerVersion: "0" })
  })

  test("RulesRouter never fails", async () => {
    const decision = await Effect.runPromise(RulesRouter.classify(input("grep", { pattern: "who calls X" })))
    expect(decision.route).toBe("intelligence")
  })
})
