import path from "path"
import { appendFile, mkdir } from "fs/promises"

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

export const span = async <A>(
  worktree: string,
  sessionID: string,
  tool: string,
  input: unknown,
  fn: () => Promise<A>,
  summarize: (result: A) => string,
) => {
  await record(worktree, sessionID, { type: "tool.call", phase: "start", tool, input })
  const start = Date.now()
  const result = await fn()
  await record(worktree, sessionID, {
    type: "tool.call",
    phase: "end",
    tool,
    resultSummary: summarize(result),
    ms: Date.now() - start,
  })
  return result
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
