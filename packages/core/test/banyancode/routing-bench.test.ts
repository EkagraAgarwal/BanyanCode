import { describe, expect, test } from "bun:test"

import { scoreCorpus } from "../../src/banyancode/routing/bench"
import { evaluate } from "../../src/banyancode/routing/rules"
import { ROUTING_CORPUS } from "../fixture/routing-corpus"

// Shared scoring: same code path as script/routing-bench.ts (bench.ts).
// These are GOLDEN invariants (spec §48/§49). If any fails, that is a REAL
// finding about routing/rules.ts — do not weaken this test; report the
// failing ids so the rules can be fixed.
const result = scoreCorpus(ROUTING_CORPUS, evaluate)

const hardNegativeLeaks = (): string[] =>
  ROUTING_CORPUS.filter((c) => c.category === "hard-negative")
    .map((c) => ({ id: c.id, actual: result.byId.get(c.id)?.actual }))
    .filter((entry) => entry.actual !== undefined && entry.actual !== "direct")
    .map((entry) => entry.id)

describe("routing benchmark — golden invariants (spec §48/§49)", () => {
  test("hard-negative accuracy is 100% — every hard negative routes direct", () => {
    expect(hardNegativeLeaks()).toEqual([])
  })

  test("rules overall accuracy beats the always-direct baseline (spec §148)", () => {
    expect(result.accuracy).toBeGreaterThan(result.baselineAccuracy)
  })

  test("golden ids route to the expected bucket", () => {
    expect(result.byId.get("rel-001")?.actual).toBe("intelligence")
    expect(result.byId.get("hn-001")?.actual).toBe("direct")
    expect(result.byId.get("content-001")?.actual).toBe("direct")
  })
})

describe("routing benchmark — corpus composition", () => {
  test("corpus contains the expected 365 cases across 8 categories", () => {
    expect(ROUTING_CORPUS.length).toBe(365)
    expect(result.perCategory["hard-negative"].total).toBe(45)
    expect(result.perCategory["content"].total).toBe(60)
    expect(result.perCategory["relationships"].total).toBe(65)
    expect(result.perCategory["symbol"].total).toBe(40)
    expect(result.perCategory["structural"].total).toBe(40)
    expect(result.perCategory["architecture"].total).toBe(35)
    expect(result.perCategory["lexical-search"].total).toBe(55)
    expect(result.perCategory["ambiguous"].total).toBe(25)
  })

  test("every case id is unique", () => {
    const ids = ROUTING_CORPUS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
