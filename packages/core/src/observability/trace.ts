import path from "path"
import { appendFile, mkdir } from "fs/promises"
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
}

const traceDir = (worktree: string) => path.join(worktree, ".banyancode", "trace")

export const record = async (worktree: string, sessionID: string, event: Omit<TraceEvent, "ts" | "sessionID">) => {
  const dir = traceDir(worktree)
  await mkdir(dir, { recursive: true })
  const line: TraceEvent = { ...event, ts: Date.now(), sessionID }
  await appendFile(path.join(dir, `${sessionID}.jsonl`), `${JSON.stringify(line)}\n`, "utf8")
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
