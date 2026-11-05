import { describe, expect, test } from "bun:test"
import type { Decision, DecideInput, ProbeResult } from "../../src/gateway/types.js"
import {
  decide,
  DEFAULT_READ_OUTLINE_LINES,
  identifierQuery,
  isCodePath,
  isConfigPath,
  isDocumentationPath,
  isEnvPath,
  isExternalPath,
  isMediaPath,
} from "../../src/gateway/routing.js"

/**
 * Routing is a pure function of (tool, arguments, probe, ledger). These are the
 * rules, one table row each. There is deliberately no chat text in the input:
 * the same arguments must route the same way whatever the user said.
 */

const ROOT = "D:/repo"
const FRESH: ProbeResult = { graphBuilt: true, stale: false }

const decideCall = (
  tool: string,
  args: Record<string, unknown>,
  options: {
    readonly probe?: Partial<ProbeResult>
    readonly repeat?: boolean
    readonly root?: string
    readonly readOutlineLines?: number
    readonly allows?: (tool: string) => boolean
  } = {},
): Decision => {
  const input: DecideInput = {
    tool,
    arguments: args,
    probe: { ...FRESH, ...options.probe },
    repeat: options.repeat ?? false,
    root: options.root ?? ROOT,
    readOutlineLines: options.readOutlineLines ?? DEFAULT_READ_OUTLINE_LINES,
    allows: options.allows ?? (() => true),
  }
  return decide(input)
}

const routeOf = (decision: Decision) => decision.route
const targetOf = (decision: Decision) =>
  decision.target === undefined ? undefined : { tool: decision.target.tool, op: decision.target.op }

describe("routing is the same for the same call, whatever was typed", () => {
  test("the input surface has no conversation text", () => {
    const input: DecideInput = {
      tool: "grep",
      arguments: { pattern: "AuthManager" },
      probe: FRESH,
      repeat: false,
      root: ROOT,
      readOutlineLines: 400,
      allows: () => true,
    }
    expect(Object.keys(input).sort()).toEqual([
      "allows",
      "arguments",
      "probe",
      "readOutlineLines",
      "repeat",
      "root",
      "tool",
    ])
    // @ts-expect-error routing must never read the user's message
    decide({ ...input, userRequest: "who calls AuthManager" })
    expect(decide(input)).toEqual(decide({ ...input }))
  })

  test("the same arguments with different earlier turns route identically", () => {
    const args = { pattern: "AuthManager" }
    const first = decideCall("grep", args, { probe: { symbolHits: 3 } })
    const second = decideCall("grep", args, { probe: { symbolHits: 3 } })
    expect(first).toEqual(second)
    expect(first.route).toBe("swap")
  })
})

describe("grep routing", () => {
  const symbol = { symbolHits: 4 }

  test("a single identifier swaps to code_find usages", () => {
    const decision = decideCall("grep", { pattern: "AuthManager" }, { probe: symbol })
    expect(decision).toMatchObject({ route: "swap", reason: "identifier" })
    expect(decision.target).toEqual({
      tool: "code_find",
      input: { intent: "usages", target: "AuthManager" },
      op: "usages",
    })
  })

  test("a dotted identifier swaps and keeps both segments", () => {
    const decision = decideCall("grep", { pattern: "AuthManager.login" }, { probe: symbol })
    expect(decision.target?.input.target).toBe("AuthManager.login")
  })

  test("a \\b-wrapped identifier swaps as the bare identifier", () => {
    const decision = decideCall("grep", { pattern: "\\bAuthManager\\b" }, { probe: symbol })
    expect(decision.route).toBe("swap")
    expect(decision.target?.input.target).toBe("AuthManager")
  })

  test("scope path and include are passed through", () => {
    const decision = decideCall("grep", { pattern: "AuthManager", path: "src/auth/AuthManager.ts", include: "*.ts" }, {
      probe: symbol,
    })
    expect(decision.target).toEqual({
      tool: "code_find",
      input: { intent: "usages", target: "AuthManager", path: "src/auth/AuthManager.ts", include: "*.ts" },
      op: "usages",
    })
  })

  const direct: ReadonlyArray<[string, Record<string, unknown>, string]> = [
    ["a regex", { pattern: "Auth.*Manager" }, "regex"],
    ["whitespace prose", { pattern: "who calls AuthManager" }, "whitespace"],
    ["error text", { pattern: "TypeError: x is not a function" }, "error-text"],
    ["a TODO marker", { pattern: "TODO" }, "literal-marker"],
    ["a FIXME marker", { pattern: "fixme" }, "literal-marker"],
    ["a HACK marker", { pattern: "hack" }, "literal-marker"],
    ["an XXX marker", { pattern: "xxx" }, "literal-marker"],
    ["a NOTE marker", { pattern: "note" }, "literal-marker"],
    ["a BUG marker", { pattern: "bug" }, "literal-marker"],
    ["a case-insensitive search", { pattern: "AuthManager", caseSensitive: false }, "case-insensitive"],
    ["two characters", { pattern: "fn" }, "short-query"],
    ["a docs path", { pattern: "AuthManager", path: "docs" }, "docs-scoped"],
    ["a markdown include", { pattern: "AuthManager", include: "*.md" }, "config-scoped"],
    ["an env path", { pattern: "AuthManager", path: ".env.local" }, "env-file"],
    ["a media path", { pattern: "AuthManager", path: "assets/logo.png" }, "binary"],
    ["an outside path", { pattern: "AuthManager", path: "../elsewhere" }, "outside-project"],
  ]

  for (const [label, args, reason] of direct) {
    test(`${label} runs the real grep (${reason})`, () => {
      const decision = decideCall("grep", args, { probe: symbol })
      expect(routeOf(decision)).toBe("direct")
      expect(decision.reason).toBe(reason)
    })
  }

  test("probe empty falls back", () => {
    const decision = decideCall("grep", { pattern: "AuthManager" }, { probe: { symbolHits: 0 } })
    expect(routeOf(decision)).toBe("fallback")
    expect(decision.reason).toBe("graph-empty")
  })

  test("graph stale falls back", () => {
    const decision = decideCall("grep", { pattern: "AuthManager" }, { probe: { ...symbol, stale: true } })
    expect(routeOf(decision)).toBe("fallback")
    expect(decision.reason).toBe("graph-stale")
  })

  test("unbuilt graph falls back", () => {
    const decision = decideCall("grep", { pattern: "AuthManager" }, {
      probe: { graphBuilt: false, stale: true, symbolHits: 4 },
    })
    expect(routeOf(decision)).toBe("fallback")
    expect(decision.reason).toBe("graph-unbuilt")
  })

  test("an unavailable target tool falls back", () => {
    const decision = decideCall("grep", { pattern: "AuthManager" }, {
      probe: symbol,
      allows: (tool) => tool !== "code_find",
    })
    expect(routeOf(decision)).toBe("fallback")
    expect(decision.reason).toBe("tool-unavailable")
  })
})

describe("glob routing", () => {
  const matches = { matchCount: 3 }

  test("a code-file glob swaps to repo files and keeps path", () => {
    const decision = decideCall("glob", { pattern: "**/*.ts", path: "packages" }, { probe: matches })
    expect(decision).toMatchObject({ route: "swap", reason: "code-files" })
    expect(targetOf(decision)).toEqual({ tool: "repo", op: "files" })
    expect(decision.target?.input).toEqual({ op: "files", pattern: "**/*.ts", path: "packages" })
  })

  test("a directory wildcard swaps", () => {
    expect(routeOf(decideCall("glob", { pattern: "src/*" }, { probe: matches }))).toBe("swap")
    expect(routeOf(decideCall("glob", { pattern: "**/*" }, { probe: matches }))).toBe("swap")
  })

  const direct: ReadonlyArray<[string, Record<string, unknown>, string]> = [
    ["markdown", { pattern: "**/*.md" }, "pattern-not-code"],
    ["json", { pattern: "*.json" }, "pattern-not-code"],
    ["a docs directory", { pattern: "docs/**" }, "pattern-not-code"],
    ["a docs scope path", { pattern: "**/*.ts", path: "docs" }, "docs-scoped"],
    ["an env file", { pattern: ".env*" }, "env-file"],
    ["an outside path", { pattern: "**/*.ts", path: "D:/other" }, "outside-project"],
    ["hidden files, which are never indexed", { pattern: "**/*.ts", hidden: true }, "hidden-files"],
  ]

  for (const [label, args, reason] of direct) {
    test(`${label} runs the real glob (${reason})`, () => {
      const decision = decideCall("glob", args, { probe: matches })
      expect(routeOf(decision)).toBe("direct")
      expect(decision.reason).toBe(reason)
    })
  }

  test("no indexed match falls back", () => {
    expect(decideCall("glob", { pattern: "*.ts" }, { probe: { matchCount: 0 } })).toMatchObject({
      route: "fallback",
      reason: "graph-empty",
    })
  })

  test("stale and unbuilt graphs fall back", () => {
    expect(decideCall("glob", { pattern: "*.ts" }, { probe: { ...matches, stale: true } })).toMatchObject({
      route: "fallback",
      reason: "graph-stale",
    })
    expect(decideCall("glob", { pattern: "*.ts" }, { probe: { graphBuilt: false, matchCount: 3 } })).toMatchObject({
      route: "fallback",
      reason: "graph-unbuilt",
    })
  })
})

describe("read routing", () => {
  const large = { indexed: true, fileStale: false, lines: 1200, bytes: 40_000 }

  test("a large whole-file code read swaps to repo outline", () => {
    const decision = decideCall("read", { path: "src/app.ts" }, { probe: large })
    expect(decision).toMatchObject({ route: "swap", reason: "outline" })
    expect(decision.target).toEqual({ tool: "repo", input: { op: "outline", path: "src/app.ts" }, op: "outline" })
  })

  test("the line threshold comes from config", () => {
    const small = { indexed: true, fileStale: false, lines: 30, bytes: 900 }
    expect(routeOf(decideCall("read", { path: "src/app.ts" }, { probe: small }))).toBe("augment")
    expect(routeOf(decideCall("read", { path: "src/app.ts" }, { probe: small, readOutlineLines: 20 }))).toBe("swap")
  })

  test("a small file is augmented, not swapped", () => {
    const decision = decideCall("read", { path: "src/app.ts" }, {
      probe: { indexed: true, fileStale: false, lines: 20, bytes: 800 },
    })
    expect(decision).toMatchObject({ route: "augment", reason: "small-file" })
  })

  test("a ranged read never swaps and still gets the symbol header", () => {
    expect(decideCall("read", { path: "src/app.ts", offset: 100, limit: 50 }, { probe: large })).toMatchObject({
      route: "augment",
      reason: "ranged-read",
    })
    expect(decideCall("read", { path: "src/app.ts", limit: 50 }, { probe: large }).reason).toBe("ranged-read")
  })

  const direct: ReadonlyArray<[string, Record<string, unknown>, string]> = [
    ["a non-code file", { path: "Makefile" }, "non-code"],
    ["a config file", { path: "package.json" }, "config"],
    ["an env file", { path: ".env.local" }, "env-file"],
    ["a media file", { path: "assets/logo.png" }, "binary"],
    ["documentation", { path: "docs/guide.md" }, "docs"],
    ["an outside path", { path: "D:/other/app.ts" }, "outside-project"],
    ["a relative escape", { path: "../app.ts" }, "outside-project"],
    ["an escape through a subfolder", { path: "src/../../app.ts" }, "outside-project"],
    ["an absolute escape through the root", { path: "D:/repo/../other/app.ts" }, "outside-project"],
  ]

  for (const [label, args, reason] of direct) {
    test(`${label} runs the real read (${reason})`, () => {
      const decision = decideCall("read", args, { probe: large })
      expect(routeOf(decision)).toBe("direct")
      expect(decision.reason).toBe(reason)
    })
  }

  test("unbuilt graph, unindexed file and file drift fall back", () => {
    expect(
      decideCall("read", { path: "src/app.ts" }, { probe: { graphBuilt: false, stale: true, ...large } }),
    ).toMatchObject({ route: "fallback", reason: "graph-unbuilt" })
    expect(
      decideCall("read", { path: "src/app.ts" }, { probe: { ...large, indexed: false } }),
    ).toMatchObject({ route: "fallback", reason: "not-indexed" })
    expect(
      decideCall("read", { path: "src/app.ts" }, { probe: { ...large, fileStale: true } }),
    ).toMatchObject({ route: "fallback", reason: "file-stale" })
  })
})

describe("ledger and unknown tools", () => {
  test("an identical call that already swapped goes direct with reason repeat", () => {
    const args = { path: "src/app.ts" }
    const large = { indexed: true, fileStale: false, lines: 1200, bytes: 40_000 }
    expect(routeOf(decideCall("read", args, { probe: large }))).toBe("swap")
    expect(decideCall("read", args, { probe: large, repeat: true })).toMatchObject({
      route: "direct",
      reason: "repeat",
    })
    expect(decideCall("grep", { pattern: "AuthManager" }, { probe: { symbolHits: 2 }, repeat: true })).toMatchObject({
      route: "direct",
      reason: "repeat",
    })
  })

  test("other tools are not the gateway's business", () => {
    expect(decideCall("shell", { command: "ls" }).reason).toBe("not-gateway-tool")
  })
})

describe("query and path predicates", () => {
  test("identifierQuery accepts identifiers only", () => {
    expect(identifierQuery("AuthManager")).toBe("AuthManager")
    expect(identifierQuery("\\bAuthManager\\b")).toBe("AuthManager")
    expect(identifierQuery("Repo.update")).toBe("Repo.update")
    expect(identifierQuery("fn")).toBeUndefined()
    expect(identifierQuery("Auth.*")).toBeUndefined()
    expect(identifierQuery("TODO")).toBeUndefined()
    expect(identifierQuery("who calls AuthManager")).toBeUndefined()
  })

  test("path predicates", () => {
    expect(isCodePath("src/a.ts")).toBe(true)
    expect(isCodePath("src/a.TSX")).toBe(true)
    expect(isCodePath("package.json")).toBe(false)
    expect(isConfigPath("package.json")).toBe(true)
    expect(isConfigPath(".env.example")).toBe(true)
    expect(isEnvPath(".env.local")).toBe(true)
    expect(isDocumentationPath("docs/a.png")).toBe(true)
    expect(isDocumentationPath("src/a.ts")).toBe(false)
    expect(isMediaPath("assets/logo.png")).toBe(true)
    expect(isExternalPath("src/a.ts", ROOT)).toBe(false)
    expect(isExternalPath("D:/repo/src/a.ts", ROOT)).toBe(false)
    expect(isExternalPath("D:/other/a.ts", ROOT)).toBe(true)
    expect(isExternalPath("/other/a.ts", ROOT)).toBe(true)
    expect(isExternalPath("../a.ts", ROOT)).toBe(true)
  })
})
