#!/usr/bin/env bun

// Routing benchmark harness — run from packages/core:
//
//   bun run script/routing-bench.ts            # report-only, exit 0
//   bun run script/routing-bench.ts --strict   # non-zero exit on hard-negative leaks
//
// Scores the deterministic routing rules (routing/rules.ts) against the
// routing corpus (test/fixture/routing-corpus.ts, 365 cases / 45 hard
// negatives) and prints a per-category accuracy table, the always-direct
// baseline (NoopRouter behavior, spec §148), the two critical error rates
// (spec §46), and the hard-negative leak list (spec §48/§49).

import { scoreCorpus } from "../src/banyancode/routing/bench"
import { evaluate } from "../src/banyancode/routing/rules"
import { ROUTING_CORPUS } from "../test/fixture/routing-corpus"

const strict = process.argv.includes("--strict")

const result = scoreCorpus(ROUTING_CORPUS, evaluate)

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`
const pad = (text: string, width: number): string => text.padEnd(width)

console.log("Routing benchmark")
console.log(`  corpus:   ${result.total} cases (${ROUTING_CORPUS.filter((c) => c.category === "hard-negative").length} hard negatives)`)
console.log(`  router:   deterministic rules (routing/rules.ts)`)
console.log(`  baseline: always-direct (NoopRouter behavior, spec §148)`)
console.log("")

console.log(pad("category", 16) + pad("total", 8) + pad("correct", 10) + "accuracy")
console.log("-".repeat(44))
const rows = Object.entries(result.perCategory) as Array<
  [keyof typeof result.perCategory, (typeof result.perCategory)[keyof typeof result.perCategory]]
>
for (const [category, score] of rows) {
  console.log(pad(category, 16) + pad(String(score.total), 8) + pad(String(score.correct), 10) + pct(score.accuracy))
}
console.log("-".repeat(44))
console.log(pad("overall", 16) + pad(String(result.total), 8) + pad(String(result.correct), 10) + pct(result.accuracy))
console.log(pad("baseline", 16) + pad(String(result.total), 8) + pad(String(result.baselineCorrect), 10) + pct(result.baselineAccuracy))
console.log("")
console.log(`rules vs baseline: ${(result.accuracy - result.baselineAccuracy) >= 0 ? "+" : ""}${pct(result.accuracy - result.baselineAccuracy)}`)
console.log("")

console.log(`missed intelligence: ${result.missedIntelligence.length}/${result.total - result.baselineCorrect} (${pct(result.missedIntelligenceRate)}) — intelligence-expected left direct`)
if (result.missedIntelligence.length > 0) {
  console.log(`  ids: ${result.missedIntelligence.join(", ")}`)
}
console.log(`false intelligence:  ${result.falseIntelligence.length}/${result.baselineCorrect} (${pct(result.falseIntelligenceRate)}) — direct-expected upgraded`)
if (result.falseIntelligence.length > 0) {
  console.log(`  ids: ${result.falseIntelligence.join(", ")}`)
}
console.log("")

if (result.hardNegativeErrors.length > 0) {
  console.log(`HARD-NEGATIVE LEAKS (${result.hardNegativeErrors.length}): ${result.hardNegativeErrors.join(", ")}`)
} else {
  console.log("HARD-NEGATIVE LEAKS: none — all 45 hard negatives route direct")
}
console.log("")

if (strict && result.hardNegativeErrors.length > 0) {
  console.error(`--strict: ${result.hardNegativeErrors.length} hard-negative failure(s)`)
  process.exit(1)
}
console.log("exit 0 (report-only)")
