// Offline Jev policy/wire replay benchmark.
//
// OFFLINE ONLY: every request goes through an injected stub fetch that
// replays canned wire payloads. No network access, no paid requests, no
// live success claims. Token counts come from Jev.estimateTokens and USD
// figures from Jev.estimatedCostFor — both are fixture-derived estimates.
//
// Run: bun ./packages/opencode/script/jev-bench.ts
// Optional external fixture: JEV_BENCH_FIXTURE=/path/to/fixture.json overlays
// one extra replay built from that file's { state, questions } shape.
import {
  ask,
  estimateTokens,
  estimatedCostFor,
  resetJevStateForTests,
  type Question,
} from "@opencode-ai/core/banyancode/jev"

export const OFFLINE_NOTE = "OFFLINE wire replay — fixture-derived estimates only; not live success claims."

const BENCH_MODEL = "jev-latest"
const BENCH_BACKEND = "typesafe" as const
const BENCH_API_KEY = "bench-offline-key"

export interface BenchFixture {
  readonly id: string
  readonly kind: "noul" | "choice" | "score"
  readonly state: string
  readonly questions: Readonly<Record<string, Question>>
  readonly wireAnswers: Readonly<Record<string, unknown>>
}

export const FIXTURES: ReadonlyArray<BenchFixture> = [
  {
    id: "route-readonly",
    kind: "noul",
    state: "bench: decide whether a read-only file lookup may proceed without a plan",
    questions: {
      routing: {
        type: "noul",
        instructions: "Decide if the described lookup is read-only.",
        criteria: { true: "Only reads files, no writes.", false: "Writes files or changes state." },
      },
    },
    wireAnswers: { routing: { type: "noul", noul: 0.82 } },
  },
  {
    id: "tier-select",
    kind: "choice",
    state: "bench: pick an execution tier for a small bounded edit",
    questions: {
      tier: {
        type: "choice",
        instructions: "Pick the cheapest tier that can handle the edit.",
        criteria: {
          fast: "Small bounded edit with clear scope.",
          strong: "Ambiguous multi-file change.",
          escalate: "Needs a human decision first.",
        },
      },
    },
    wireAnswers: {
      tier: {
        type: "choice",
        choice: "fast",
        probabilities: { fast: 0.7, strong: 0.2, escalate: 0.1 },
        confidence: 0.7,
      },
    },
  },
  {
    id: "handoff-quality",
    kind: "score",
    state: "bench: score an explorer handoff for downstream use",
    questions: {
      quality: {
        type: "score",
        instructions: "Score the handoff against the rubric criteria.",
        criteria: ["relevance", "safety", "brevity"],
      },
    },
    wireAnswers: {
      quality: {
        type: "score",
        score: 2,
        legend: { "0": "off-topic", "1": "partially useful", "2": "directly usable" },
        probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 },
        confidence: 0.6,
      },
    },
  },
]

export interface ReplayFetch {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly requests: () => number
}

export function createReplayFetch(
  answers: Readonly<Record<string, unknown>>,
  usage: Record<string, number> = { input_tokens: 12, output_tokens: 3, cost: 0.0001 },
): ReplayFetch {
  let count = 0
  const fetch = async (_input: string, _init?: RequestInit): Promise<Response> => {
    count += 1
    return new Response(JSON.stringify({ answers, usage }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  return { fetch, requests: () => count }
}

const throwingFetch = (): ReplayFetch => {
  const fetch = async (_input: string, _init?: RequestInit): Promise<Response> => {
    throw new Error("bench fetch must not be called on the disabled/missing-key path")
  }
  return { fetch, requests: () => 0 }
}

export interface FixtureResult {
  readonly id: string
  readonly kind: string
  readonly ok: boolean
  readonly reason: string
  readonly latencyMs: number
  readonly physicalRequests: number
  readonly cached: boolean
  readonly tokens: number
  readonly estCostUsd: number | undefined
  readonly usage: unknown
}

export interface BenchSummary {
  readonly offline: true
  readonly fixtures: ReadonlyArray<FixtureResult>
  readonly totalPhysicalRequests: number
  readonly totalTokens: number
  readonly totalEstCostUsd: number | undefined
  readonly disabledRouting: string
  readonly missingKeyRouting: string
  readonly external: FixtureResult | undefined
  readonly externalSkipped: string | undefined
  readonly note: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Builds a valid replay answer for each question shape so an external
// fixture file only needs { state, questions }; the wire side stays canned.
function genericWireAnswers(questions: Readonly<Record<string, Question>>): Record<string, unknown> {
  const answers: Record<string, unknown> = {}
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "noul") {
      answers[id] = { type: "noul", noul: 0.5 }
    } else if (question.type === "choice") {
      const options = Object.keys(question.criteria)
      const rest = options.length > 1 ? 0.4 / (options.length - 1) : 0
      const probabilities: Record<string, number> = {}
      for (const option of options) probabilities[option] = option === options[0] ? 0.6 : rest
      answers[id] = { type: "choice", choice: options[0], probabilities, confidence: 0.5 }
    } else {
      // Score answers are level-indexed: score in [0, levels-1],
      // probabilities and legend keyed by level index strings.
      const levels = question.criteria.map((_, index) => String(index))
      const rest = levels.length > 1 ? 0.4 / (levels.length - 1) : 0
      const probabilities: Record<string, number> = {}
      const legend: Record<string, string> = {}
      for (const level of levels) {
        probabilities[level] = level === levels[levels.length - 1] ? 0.6 : rest
        legend[level] = `level ${level}`
      }
      answers[id] = { type: "score", score: levels.length - 1, legend, probabilities, confidence: 0.5 }
    }
  }
  return answers
}

async function runFixture(fixture: BenchFixture, sessionID: string): Promise<FixtureResult> {
  const replay = createReplayFetch(fixture.wireAnswers)
  const tokens = estimateTokens(fixture.state, fixture.questions)
  const result = await ask({
    state: fixture.state,
    questions: { ...fixture.questions },
    config: { banyancode_jev_client: { cacheMaxEntries: 0, cacheTtlMs: 0 } },
    backend: BENCH_BACKEND,
    model: BENCH_MODEL,
    apiKey: BENCH_API_KEY,
    env: {},
    fetch: replay.fetch,
    timeoutMs: 5_000,
    sessionID,
    feature: "bench",
    scope: `bench:${fixture.id}`,
  })
  return {
    id: fixture.id,
    kind: fixture.kind,
    ok: result.ok,
    reason: result.ok ? "ok" : result.reason,
    latencyMs: result.latencyMs,
    physicalRequests: replay.requests(),
    cached: result.ok && result.cached === true,
    tokens,
    estCostUsd: estimatedCostFor(BENCH_MODEL, BENCH_BACKEND, tokens),
    usage: result.ok ? result.usage : undefined,
  }
}

async function runExternalFixture(path: string | undefined): Promise<{
  external: FixtureResult | undefined
  externalSkipped: string | undefined
}> {
  if (!path) return { external: undefined, externalSkipped: undefined }
  const file = Bun.file(path)
  if (!(await file.exists())) return { external: undefined, externalSkipped: `missing file ${path}` }
  const parsed: unknown = await file.json().catch(() => undefined)
  if (!isRecord(parsed) || typeof parsed.state !== "string" || !isRecord(parsed.questions)) {
    return { external: undefined, externalSkipped: `invalid fixture shape in ${path}` }
  }
  const fixture: BenchFixture = {
    id: "external",
    kind: "choice",
    state: parsed.state,
    questions: parsed.questions as Readonly<Record<string, Question>>,
    wireAnswers: genericWireAnswers(parsed.questions as Readonly<Record<string, Question>>),
  }
  return { external: await runFixture(fixture, "bench-external"), externalSkipped: undefined }
}

export async function runJevBench(options: { fixturePath?: string } = {}): Promise<BenchSummary> {
  resetJevStateForTests()
  const fixtures: Array<FixtureResult> = []
  for (const fixture of FIXTURES) {
    fixtures.push(await runFixture(fixture, `bench-${fixture.id}`))
  }

  const disabledFetch = throwingFetch()
  const disabled = await ask({
    state: FIXTURES[0].state,
    questions: { ...FIXTURES[0].questions },
    config: { banyancode_jev_enabled: false },
    apiKey: BENCH_API_KEY,
    env: {},
    fetch: disabledFetch.fetch,
    sessionID: "bench-routing",
    feature: "bench",
    scope: "bench:disabled",
  })

  const missingKeyFetch = throwingFetch()
  const missingKey = await ask({
    state: FIXTURES[0].state,
    questions: { ...FIXTURES[0].questions },
    env: {},
    fetch: missingKeyFetch.fetch,
    sessionID: "bench-routing",
    feature: "bench",
    scope: "bench:missing-key",
  })

  const { external, externalSkipped } = await runExternalFixture(options.fixturePath ?? process.env.JEV_BENCH_FIXTURE)

  const all = external ? [...fixtures, external] : fixtures
  const totalPhysicalRequests = all.reduce((sum, row) => sum + row.physicalRequests, 0)
  const totalTokens = all.reduce((sum, row) => sum + row.tokens, 0)
  const costs = all.map((row) => row.estCostUsd).filter((cost): cost is number => cost !== undefined)
  return {
    offline: true,
    fixtures,
    totalPhysicalRequests,
    totalTokens,
    totalEstCostUsd: costs.length === all.length ? costs.reduce((sum, cost) => sum + cost, 0) : undefined,
    disabledRouting: disabled.ok ? "unexpected-ok" : disabled.reason,
    missingKeyRouting: missingKey.ok ? "unexpected-ok" : missingKey.reason,
    external,
    externalSkipped,
    note: OFFLINE_NOTE,
  }
}

function formatCost(cost: number | undefined): string {
  return cost === undefined ? "unknown-model" : `$${cost.toFixed(6)}`
}

if (import.meta.main) {
  const summary = await runJevBench()
  console.log("jev-bench: OFFLINE wire replay (no network, no paid requests)")
  for (const row of summary.fixtures) {
    console.log(
      `  [${row.kind}] ${row.id}: ${row.reason} latency=${row.latencyMs}ms ` +
        `requests=${row.physicalRequests} cached=${row.cached} tokens~${row.tokens} est=${formatCost(row.estCostUsd)}`,
    )
  }
  if (summary.external) {
    const row = summary.external
    console.log(
      `  [external] ${row.id}: ${row.reason} latency=${row.latencyMs}ms ` +
        `requests=${row.physicalRequests} tokens~${row.tokens} est=${formatCost(row.estCostUsd)}`,
    )
  }
  if (summary.externalSkipped) console.log(`  [external] skipped: ${summary.externalSkipped}`)
  console.log(`  routing: disabled -> ${summary.disabledRouting}, missing-key -> ${summary.missingKeyRouting}`)
  console.log(
    `  totals: ${summary.fixtures.length} fixtures, ${summary.totalPhysicalRequests} physical requests, ` +
      `~${summary.totalTokens} tokens, est ${formatCost(summary.totalEstCostUsd)}`,
  )
  console.log(`  NOTE: ${summary.note}`)
  const failed = summary.fixtures.filter((row) => !row.ok)
  if (failed.length > 0 || summary.disabledRouting !== "disabled" || summary.missingKeyRouting !== "missing-key") {
    console.error("jev-bench: FAILED")
    process.exit(1)
  }
}
