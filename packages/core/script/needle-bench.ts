#!/usr/bin/env bun

// Needle router benchmark harness — run from packages/core:
//
//   bun run script/needle-bench.ts            # report-only, exit 0
//   bun run script/needle-bench.ts --strict   # non-zero exit on hard-negative leaks
//
// Scores the real Needle 2 model (native engine, `needle.exe --serve`) against
// the routing corpus (test/fixture/routing-corpus.ts, 365 cases / 45 hard
// negatives) using the shared generic router scorer (routing/bench.ts
// scoreRouter). Prints the same table as script/routing-bench.ts plus a
// per-classify latency column (mean/median/p95 ms).
//
// Native engine protocol (recon: shared_memory needle2:runtime-recipe):
//   tools are FIXED at server startup via `--tools tools.json`; each request
//   is `POST /complete {"input": "<prompt>"}`. The server keeps session state
//   across /complete (256-token sliding window), so the harness POSTs /reset
//   before every case to keep corpus entries independent.
//   Any network/parse failure fails closed to { route: "direct" } (spec §35).
//
// Uses the gateway NeedleRouter's own builders/parsers (buildRequest,
// buildInput, parseResponse, toDecision) so the harness scores EXACTLY the
// code path production classification would take. The server tools.json must
// match NEEDLE_TOOLS — see `--write-tools` below.
//
// Port overridable via NEEDLE_PORT (default 8080). `--write-tools <path>`
// writes the 16-route tools.json (from NEEDLE_TOOLS) the server should be
// started with, then exits:
//
//   bun run script/needle-bench.ts --write-tools tools16.json
//   needle.exe --tools tools16.json --serve --port 8080
//   bun run script/needle-bench.ts

import { Effect } from "effect"

import {
  NEEDLE_TOOLS,
  buildInput,
  buildRequest,
  parseResponse,
  toDecision,
} from "../src/banyancode/gateway/needle-router"
import type { RouteDecision, RouterInput } from "../src/banyancode/gateway/types"
import { routerInputFor, scoreRouter } from "../src/banyancode/routing/bench"
import { ROUTING_CORPUS, type RoutingCase } from "../test/fixture/routing-corpus"

const writeToolsArg = process.argv.indexOf("--write-tools")
if (writeToolsArg !== -1) {
  const target = process.argv[writeToolsArg + 1]
  if (target === undefined) {
    console.error("--write-tools requires a path argument")
    process.exit(2)
  }
  await Bun.write(target, JSON.stringify(NEEDLE_TOOLS, null, 2))
  console.log(`wrote ${NEEDLE_TOOLS.length} tool schemas to ${target}`)
  console.log(`start the server with: needle.exe --tools ${target} --serve --port ${process.env.NEEDLE_PORT ?? "8080"}`)
  process.exit(0)
}

const strict = process.argv.includes("--strict")
const port = Number(process.env.NEEDLE_PORT ?? "8080")
const baseUrl = `http://127.0.0.1:${port}`

// Per-call latency in completion order; case identity recovered via a stable
// key so per-category latency can be bucketed after scoring.
const inputKey = (input: RouterInput): string =>
  JSON.stringify([input.toolName, input.arguments, input.userRequest ?? null])

const caseByInputKey = new Map<string, RoutingCase>(
  ROUTING_CORPUS.map((case_) => [inputKey(routerInputFor(case_)), case_]),
)

const latencies: number[] = []
const latencyByCategory = new Map<RoutingCase["category"], number[]>()

const reset = async (): Promise<void> => {
  try {
    await fetch(`${baseUrl}/reset`, { method: "POST" })
  } catch {
    // reset failure is tolerable — the next complete() still runs.
  }
}

const classify = (input: RouterInput): Effect.Effect<RouteDecision, never, never> => {
  const startedAt = performance.now()
  const record = (): void => {
    const latencyMs = performance.now() - startedAt
    latencies.push(latencyMs)
    const case_ = caseByInputKey.get(inputKey(input))
    if (case_ !== undefined) {
      const bucket = latencyByCategory.get(case_.category) ?? []
      bucket.push(latencyMs)
      latencyByCategory.set(case_.category, bucket)
    }
  }
  return Effect.tryPromise(async () => {
    // Session isolation: reset before every case (native engine keeps a
    // sliding-window session per server process).
    await reset()
    const prompt = buildInput(buildRequest(input))
    const response = await fetch(`${baseUrl}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: prompt }),
    })
    if (!response.ok) {
      throw new Error(`needle server responded ${response.status} ${response.statusText}`)
    }
    const body = await response.text()
    return toDecision(parseResponse(body), input)
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed({
        route: "direct" as const,
        confidence: 0,
        reasonCodes: ["needle-unreachable"],
        router: "needle",
        routerVersion: "unknown",
      }),
    ),
    Effect.tap(() => Effect.sync(record)),
  )
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`
const pad = (text: string, width: number): string => text.padEnd(width)
const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

const main = async (): Promise<void> => {
  const result = await Effect.runPromise(scoreRouter(ROUTING_CORPUS, classify))

  const sorted = [...latencies].sort((a, b) => a - b)
  const median = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]
  const p95 = sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]

  console.log("Needle 2 benchmark (real model, native engine)")
  console.log(`  corpus:   ${result.total} cases (${ROUTING_CORPUS.filter((c) => c.category === "hard-negative").length} hard negatives)`)
  console.log(`  router:   needle (POST ${baseUrl}/complete, session reset per case)`)
  console.log(`  baseline: always-direct (NoopRouter behavior, spec §148)`)
  console.log("")

  console.log(pad("category", 16) + pad("total", 8) + pad("correct", 10) + pad("accuracy", 12) + "latency-mean(ms)")
  console.log("-".repeat(62))
  const rows = Object.entries(result.perCategory) as Array<
    [keyof typeof result.perCategory, (typeof result.perCategory)[keyof typeof result.perCategory]]
  >
  for (const [category, score] of rows) {
    const categoryLatency = mean(latencyByCategory.get(category) ?? [])
    console.log(
      pad(category, 16) + pad(String(score.total), 8) + pad(String(score.correct), 10) + pad(pct(score.accuracy), 12) + categoryLatency.toFixed(1),
    )
  }
  console.log("-".repeat(62))
  console.log(pad("overall", 16) + pad(String(result.total), 8) + pad(String(result.correct), 10) + pad(pct(result.accuracy), 12) + mean(latencies).toFixed(1))
  console.log(pad("baseline", 16) + pad(String(result.total), 8) + pad(String(result.baselineCorrect), 10) + pad(pct(result.baselineAccuracy), 12) + "-")
  console.log("")
  console.log(`needle vs baseline: ${result.accuracy - result.baselineAccuracy >= 0 ? "+" : ""}${pct(result.accuracy - result.baselineAccuracy)}`)
  console.log("")
  console.log(`latency (ms): mean ${mean(latencies).toFixed(1)} | median ${median.toFixed(1)} | p95 ${p95.toFixed(1)}`)
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
}

await main()
