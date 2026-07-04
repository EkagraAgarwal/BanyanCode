import path from "path"
import { appendFile, mkdir, readFile, writeFile } from "fs/promises"
import { Effect } from "effect"

export type TraceEvent = {
  type: "tool.call"
  phase: "start" | "end"
  tool: string
  ts: number
  sessionID: string
  input?: unknown
  resultSummary?: string
  ms?: number
  cache?: { hit: boolean; key?: string }
  workspace?: { worktree: string; focusDirs?: readonly string[] }
}

const TRACE_FILE_HARD_CAP = 10_000
const TRACE_FILE_AGE_MS = 7 * 24 * 60 * 60 * 1000

const traceDir = (worktree: string) => path.join(worktree, ".banyancode", "trace")

const maybeCompact = async (filePath: string) => {
  try {
    const text = await readFile(filePath, "utf8")
    const lines = text.split("\n").filter(Boolean)
    if (lines.length <= TRACE_FILE_HARD_CAP) return
    const cutoff = Date.now() - TRACE_FILE_AGE_MS
    const recent: string[] = []
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { ts?: unknown }
        const ts = typeof parsed.ts === "number" ? parsed.ts : undefined
        if (ts === undefined || ts >= cutoff) recent.push(line)
      } catch {
        recent.push(line)
      }
    }
    const tail = recent.slice(-TRACE_FILE_HARD_CAP)
    const next = tail.length === 0 ? "" : tail.join("\n") + "\n"
    await writeFile(filePath, next, "utf8")
  } catch {}
}

export const record = async (worktree: string, sessionID: string, event: Omit<TraceEvent, "ts" | "sessionID">) => {
  const dir = traceDir(worktree)
  await mkdir(dir, { recursive: true })
  const line: TraceEvent = { ...event, ts: Date.now(), sessionID }
  const filePath = path.join(dir, `${sessionID}.jsonl`)
  await appendFile(filePath, `${JSON.stringify(line)}\n`, "utf8")
  await maybeCompact(filePath)
}

export const readTrace = async (worktree: string, sessionID: string) => {
  const file = Bun.file(path.join(traceDir(worktree), `${sessionID}.jsonl`))
  if (!(await file.exists())) return []
  const text = await file.text()
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceEvent)
}

export const traced = <A, E, R>(
  worktree: string,
  sessionID: string,
  tool: string,
  input: unknown,
  summary: (result: A) => string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    yield* Effect.promise(() => record(worktree, sessionID, { type: "tool.call", phase: "start", tool, input }))
    const start = Date.now()
    const result = yield* effect
    yield* Effect.promise(() =>
      record(worktree, sessionID, {
        type: "tool.call",
        phase: "end",
        tool,
        resultSummary: summary(result),
        ms: Date.now() - start,
      }),
    )
    return result
  })
