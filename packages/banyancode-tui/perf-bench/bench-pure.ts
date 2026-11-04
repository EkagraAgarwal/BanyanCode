/**
 * Pure-step benchmark for the Agents tab data layer. Same modules the tab
 * imports; only the fixture is synthetic. Prints microseconds per call.
 *
 * Manual tool, not part of `bun test`:
 *   bun perf-bench/bench-pure.ts [agents] [messages] [columns]
 */
import type { SessionMessageInfo } from "@opencode/client"
import { rosterRows, streamEntries, visibleRows } from "../src/data/understory"
import {
  agentSpans,
  messagesAt,
  sparkValues,
  staleEdits,
  tokenBuckets,
  tokenRate,
} from "../src/data/understory-spans"
import { agents, message, rootSession, sessionInfo } from "./data"

const AGENTS = Number(process.argv[2] ?? 20)
const MESSAGES = Number(process.argv[3] ?? 200)
const COLUMNS = Number(process.argv[4] ?? 90)

const specs = agents(AGENTS, MESSAGES, { live: Math.min(8, AGENTS) })
const sessions = [rootSession(), ...specs.map(sessionInfo)]
const store: Record<string, readonly SessionMessageInfo[]> = {}
specs.forEach((spec, index) => {
  const out: SessionMessageInfo[] = [
    { id: `${spec.id}_u0`, type: "user", time: { created: spec.created }, text: "do the task" } as unknown as SessionMessageInfo,
  ]
  for (let m = 1; m <= spec.messages; m += 1) out.push(message(spec.id, m, spec.created + m * 1_000, 1, spec.live && m >= spec.messages - 2))
  store[spec.id] = out
})
store["ses_root"] = [message("ses_root", 1, rootSession().time.created + 500, 1, false)]

const messagesOf = (id: string) => store[id] ?? []
const rows = rosterRows({
  root: "ses_root",
  sessions,
  killed: new Set<string>(),
  pending: () => 0,
  status: (id) => (specs.some((spec) => spec.id === id && spec.live) ? "running" : "idle"),
  messages: messagesOf,
})

const bench = (label: string, iterations: number, run: () => unknown) => {
  for (let i = 0; i < 3; i += 1) run()
  const samples: number[] = []
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now()
    run()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  const median = samples[samples.length >> 1]!
  console.log(
    JSON.stringify({ label, n: iterations, msMedian: +median.toFixed(3), usPerCall: Math.round(median * 1000) }),
  )
}

const allMessages = specs.flatMap((spec) => store[spec.id] ?? [])
const from = specs[0]!.created
const to = from + MESSAGES * 1_000

console.log(
  JSON.stringify({ fixture: { agents: AGENTS, messagesEach: MESSAGES, totalMessages: allMessages.length, columns: COLUMNS } }),
)

bench("rosterRows(20 sessions)", 20, () =>
  rosterRows({
    root: "ses_root",
    sessions,
    killed: new Set<string>(),
    pending: () => 0,
    status: (id) => (specs.some((spec) => spec.id === id && spec.live) ? "running" : "idle"),
    messages: messagesOf,
  }),
)
bench("visibleRows(folded=false)", 20, () => visibleRows(rows, { folded: false, selected: undefined }))

const spansPerSession = specs.map((spec) => agentSpans(store[spec.id] ?? [], { state: "running", start: spec.created }))
bench("agentSpans(one session)", 20, () => agentSpans(store[specs[0]!.id] ?? [], { state: "running" }))
bench("agentSpans(all 20 sessions)", 5, () =>
  specs.map((spec) => agentSpans(store[spec.id] ?? [], { state: "running", start: spec.created })),
)
bench("messagesAt(all assistant msgs)", 20, () => messagesAt(allMessages, to))
bench("staleEdits(20 sessions)", 5, () =>
  staleEdits(
    specs.map((spec) => ({ sessionID: spec.id, label: spec.id, messages: store[spec.id] ?? [] })),
    20,
  ),
)
bench("streamEntries(20 sessions)", 5, () =>
  streamEntries(
    specs.map((spec) => ({
      sessionID: spec.id,
      label: spec.id,
      state: "running" as const,
      messages: store[spec.id] ?? [],
    })),
    { now: to },
  ),
)
bench("tokenBuckets(one session, 90 cols)", 10, () => tokenBuckets(spansPerSession[0]!, store[specs[0]!.id] ?? [], from, to, COLUMNS))
bench("tokenBuckets(all 20 sessions, 90 cols)", 5, () =>
  specs.map((spec, index) => tokenBuckets(spansPerSession[index]!, store[spec.id] ?? [], from, to, COLUMNS)),
)
bench("sparkValues(one session, 14 cols)", 50, () =>
  sparkValues(store[specs[0]!.id] ?? [], { to, columns: 14 }),
)
bench("tokenRate(one session)", 50, () => tokenRate(store[specs[0]!.id] ?? [], { to }))
