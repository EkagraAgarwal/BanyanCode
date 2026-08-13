import { describe, expect, test } from "bun:test"
import { ROUTING_CORPUS } from "../fixture/routing-corpus"

const TOOL_NAMES = ["read", "grep", "glob"] as const
const ROUTES = [
  "DIRECT_READ",
  "DIRECT_SEARCH",
  "DIRECT_GLOB",
  "AUGMENT_READ",
  "SYMBOL_SEARCH",
  "REFERENCES",
  "CALLERS",
  "CALLEES",
  "DEPENDENTS",
  "IMPORTS",
  "IMPLEMENTATIONS",
  "EXTENSIONS",
  "IMPACT",
  "STRUCTURAL",
  "ARCHITECTURE",
  "OWNERSHIP",
  "HYBRID",
] as const
const CATEGORIES = [
  "content",
  "lexical-search",
  "symbol",
  "relationships",
  "structural",
  "architecture",
  "ambiguous",
  "hard-negative",
] as const

describe("routing corpus", () => {
  test("corpus has at least 300 entries", () => {
    expect(ROUTING_CORPUS.length).toBeGreaterThanOrEqual(300)
  })

  test("every entry has a unique id", () => {
    const ids = ROUTING_CORPUS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("every entry has a valid toolName", () => {
    for (const c of ROUTING_CORPUS) {
      expect((TOOL_NAMES as readonly string[]).includes(c.toolName), `id ${c.id}`).toBe(true)
    }
  })

  test("every entry has an expectedRoute in the route union", () => {
    for (const c of ROUTING_CORPUS) {
      expect((ROUTES as readonly string[]).includes(c.expectedRoute), `id ${c.id}`).toBe(true)
    }
  })

  test("every entry has a valid category", () => {
    for (const c of ROUTING_CORPUS) {
      expect((CATEGORIES as readonly string[]).includes(c.category), `id ${c.id}`).toBe(true)
    }
  })

  test("every entry has non-empty arguments", () => {
    for (const c of ROUTING_CORPUS) {
      expect(Object.keys(c.arguments).length, `id ${c.id}`).toBeGreaterThan(0)
    }
  })

  test("hard negatives: at least 40, and every one routes DIRECT_* or AUGMENT_READ", () => {
    const hardNegatives = ROUTING_CORPUS.filter((c) => c.category === "hard-negative")
    expect(hardNegatives.length).toBeGreaterThanOrEqual(40)
    for (const c of hardNegatives) {
      // AUGMENT_READ is permitted for code-file reads: it preserves the exact
      // content byte-for-byte (header is model-facing metadata only), so the
      // §48 no-graph-substitution invariant still holds. hn-028 (src/foo.ts)
      // is the canonical case.
      expect(
        c.expectedRoute.startsWith("DIRECT") || c.expectedRoute === "AUGMENT_READ",
        `id ${c.id} expectedRoute ${c.expectedRoute}`,
      ).toBe(true)
    }
  })

  test("golden assertions: 5 known ids have their canonical route", () => {
    const byId = new Map(ROUTING_CORPUS.map((c) => [c.id, c]))
    const golden: Record<string, (typeof ROUTES)[number]> = {
      "content-001": "DIRECT_READ", // read README.md
      "rel-001": "CALLERS", // grep AuthManager + "Who calls AuthManager?"
      "symbol-001": "SYMBOL_SEARCH", // grep MemoryRepo + "Where is MemoryRepo defined?"
      "hn-001": "DIRECT_SEARCH", // docs-scoped phrase "who calls Foo?" (spec §128)
      "arch-001": "OWNERSHIP", // "Who owns the banyancode module?"
    }
    for (const [id, route] of Object.entries(golden)) {
      const c = byId.get(id)
      expect(c, `missing id ${id}`).toBeDefined()
      expect(c!.expectedRoute).toBe(route)
    }
  })
})
