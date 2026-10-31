import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  CATEGORIES,
  DEFAULT_BASE,
  OWNED_GLOBS,
  findUnledgered,
  globToRegExp,
  isOwnedPath,
  ledgerProblems,
  matchesGlob,
  parseLedgerTable,
  parseNameStatus,
} from "./patch-ledger"

describe("glob matching", () => {
  test("* does not cross a path separator", () => {
    expect(matchesGlob(".github/workflows/release.yml", ".github/workflows/*")).toBe(true)
    expect(matchesGlob(".github/workflows/nested/release.yml", ".github/workflows/*")).toBe(false)
  })

  test("** crosses path separators", () => {
    expect(matchesGlob("packages/banyancode/server.ts", "packages/banyancode*/**")).toBe(true)
    expect(matchesGlob("packages/banyancode-tui/src/index.tsx", "packages/banyancode*/**")).toBe(true)
    expect(matchesGlob("packages/banyancode", "packages/banyancode*/**")).toBe(false)
  })

  test("**/ also matches zero directories", () => {
    expect(matchesGlob("a/b", "a/**/b")).toBe(true)
    expect(matchesGlob("a/x/y/b", "a/**/b")).toBe(true)
    expect(matchesGlob("specs/banyancode/v2-patches.md", "specs/**")).toBe(true)
  })

  test("? matches exactly one non-separator character", () => {
    expect(matchesGlob("a/b", "a/?")).toBe(true)
    expect(matchesGlob("a/bc", "a/?")).toBe(false)
  })

  test("regex special characters are escaped", () => {
    expect(matchesGlob("a.b", "a.b")).toBe(true)
    expect(matchesGlob("axb", "a.b")).toBe(false)
    expect(globToRegExp("a+b").test("a+b")).toBe(true)
    expect(globToRegExp("a+b").test("aab")).toBe(false)
  })

  test("paths are normalized (backslashes, leading ./)", () => {
    expect(matchesGlob("packages\\banyancode\\src\\server.ts", "packages/banyancode*/**")).toBe(true)
    expect(matchesGlob("./bun.lock", "bun.lock")).toBe(true)
  })
})

describe("isOwnedPath", () => {
  test("every documented owned glob matches its intended path", () => {
    expect(isOwnedPath("packages/banyancode/src/server.ts")).toBe(true)
    expect(isOwnedPath("packages/banyancode-spike/src/server.ts")).toBe(true)
    expect(isOwnedPath("specs/banyancode/v2-patches.md")).toBe(true)
    expect(isOwnedPath("script/banyancode/patch-ledger.ts")).toBe(true)
    expect(isOwnedPath(".github/workflows/banyancode-ci.yml")).toBe(true)
    expect(isOwnedPath("bun.lock")).toBe(true)
  })

  test("upstream-owned paths are not owned", () => {
    expect(isOwnedPath("packages/util/src/global.ts")).toBe(false)
    expect(isOwnedPath("packages/core/src/config/discovery.ts")).toBe(false)
    expect(isOwnedPath(".github/workflows/release.yml")).toBe(false)
    expect(isOwnedPath("script/lint-changed.ts")).toBe(false)
    expect(isOwnedPath("specs/v2/plugin-api.md")).toBe(false)
  })
})

const SAMPLE_LEDGER = [
  "# Ledger",
  "",
  "Some prose that is not a table.",
  "",
  "| Path | Category | Why | Upstream PR |",
  "| --- | --- | --- | --- |",
  "| `.github/workflows/*` | ci | upstream workflows removed | — |",
  "| packages/util/src/global.ts | branding | app name | https://github.com/anomalyco/opencode/pull/1 |",
  "| packages/core/src/plugin/internal.ts | hook | register built-in plugin | |",
  "",
].join("\n")

describe("parseLedgerTable", () => {
  test("parses rows, skips the header and separator, strips backticks", () => {
    const entries = parseLedgerTable(SAMPLE_LEDGER)
    expect(entries.map((entry) => entry.path)).toEqual([
      ".github/workflows/*",
      "packages/util/src/global.ts",
      "packages/core/src/plugin/internal.ts",
    ])
    expect(entries[0]).toEqual({
      path: ".github/workflows/*",
      category: "ci",
      why: "upstream workflows removed",
      pr: "—",
      line: 7,
    })
    expect(entries[1].category).toBe("branding")
    expect(entries[1].pr).toBe("https://github.com/anomalyco/opencode/pull/1")
    expect(entries[2].pr).toBe("")
  })

  test("returns nothing for markdown without a ledger table", () => {
    expect(parseLedgerTable("# No table\n\n| not | a ledger |")).toEqual([])
    expect(parseLedgerTable("")).toEqual([])
  })

  test("ignores rows with an empty path cell", () => {
    const markdown = ["| Path | Category | Why | Upstream PR |", "| --- | --- | --- | --- |", "|  | ci | blank | |"].join("\n")
    expect(parseLedgerTable(markdown)).toEqual([])
  })
})

describe("ledgerProblems", () => {
  test("accepts every documented category", () => {
    const entries = CATEGORIES.map((category, index) => ({
      path: `file-${index}.ts`,
      category,
      why: "why",
      pr: "",
      line: index + 1,
    }))
    expect(ledgerProblems(entries)).toEqual([])
  })

  test("rejects an unknown or empty category", () => {
    const problems = ledgerProblems([
      { path: "a.ts", category: "misc", why: "", pr: "", line: 3 },
      { path: "b.ts", category: "", why: "", pr: "", line: 4 },
    ])
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain("line 3")
    expect(problems[0]).toContain('unknown category "misc"')
  })
})

describe("findUnledgered", () => {
  const entries = parseLedgerTable(SAMPLE_LEDGER)

  test("keeps led paths and ignores BanyanCode-owned paths", () => {
    const changed = [
      "packages/util/src/global.ts",
      "specs/banyancode/v2-patches.md",
      "script/banyancode/patch-ledger.ts",
      "bun.lock",
    ]
    expect(findUnledgered(changed, entries)).toEqual([])
  })

  test("matches ledger globs, including deleted workflows", () => {
    const changed = [".github/workflows/release.yml", ".github/workflows/triage-close-issues.yml"]
    expect(findUnledgered(changed, entries)).toEqual([])
  })

  test("reports unledgered paths sorted and deduplicated", () => {
    const changed = [
      "packages/cli/src/index.ts",
      "packages/core/src/config/discovery.ts",
      "packages/cli/src/index.ts",
      ".github/workflows/release.yml",
    ]
    expect(findUnledgered(changed, entries)).toEqual([
      "packages/cli/src/index.ts",
      "packages/core/src/config/discovery.ts",
    ])
  })
})

describe("parseNameStatus", () => {
  test("collects paths for modified, added and deleted entries", () => {
    const output = ["M\tpackages/util/src/global.ts", "A\tspecs/banyancode/v2-patches.md", "D\t.github/workflows/release.yml", ""].join(
      "\n",
    )
    expect(parseNameStatus(output)).toEqual([
      "packages/util/src/global.ts",
      "specs/banyancode/v2-patches.md",
      ".github/workflows/release.yml",
    ])
  })

  test("ignores blank and malformed lines", () => {
    expect(parseNameStatus("\nM\nM\t\n")).toEqual([])
  })
})

describe("shipped ledger", () => {
  const ledger = readFileSync(join(import.meta.dir, "../../specs/banyancode/v2-patches.md"), "utf8")

  test("parses and carries the seeded ci row", () => {
    const entries = parseLedgerTable(ledger)
    expect(entries).toContainEqual(
      expect.objectContaining({
        path: ".github/workflows/*",
        category: "ci",
        why: "upstream workflows removed; BanyanCode CI replaces them",
      }),
    )
    expect(ledgerProblems(entries)).toEqual([])
  })

  test("documents the upstream base and every owned glob", () => {
    expect(ledger).toContain(DEFAULT_BASE)
    expect(ledger).toContain("OpenCode v2.2.5")
    OWNED_GLOBS.forEach((glob) => expect(ledger).toContain(glob))
  })
})
