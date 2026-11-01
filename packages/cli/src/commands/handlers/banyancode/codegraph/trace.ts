/**
 * `banyancode codegraph trace` — v1 read a per-session JSONL trace file and
 * printed the last N events as a table. v2's plugin still writes traces to the
 * same place (`<worktree>/.banyancode/trace/<sessionID>.jsonl`) but as
 * `repository_route` events instead of `tool.call` events, so the reader
 * accepts both shapes and renders v1's columns either way.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { Effect, Option } from "effect"
import { Global } from "@opencode/util/global"
import { Commands } from "../../../commands"
import { Runtime } from "../../../../framework/runtime"
import { onError } from "../client"
import { dim, println, Style } from "../ui"

const TRACE_COLUMN_TS = 15
const TRACE_COLUMN_TOOL = 28
const TRACE_COLUMN_INPUT = 30
const TRACE_COLUMN_RESULT = 30
const TRACE_COLUMN_MS = 6

const truncate = (value: string, width: number) =>
  value.length <= width ? value.padEnd(width) : value.slice(0, Math.max(0, width - 1)) + "…"

const summarize = (input: unknown): string => {
  if (input === undefined || input === null) return ""
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

const findTraceFile = (worktree: string, sessionID: string): string | undefined => {
  const candidates = [
    path.join(worktree, ".banyancode", "trace", `${sessionID}.jsonl`),
    path.join(
      Global.Path.data,
      "trace",
      createHash("sha256").update(worktree).digest("hex").slice(0, 16),
      `${sessionID}.jsonl`,
    ),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]
}

type Row = { ts: string; tool: string; input: string; result: string; ms: string }

/** v1 `tool.call` events and v2 `repository_route` events map to the same row. */
const toRow = (event: Record<string, unknown>): Row | undefined => {
  if (typeof event.ts !== "number") return undefined
  const ts = String(event.ts)
  if (event.phase === "start" || event.phase === "end") {
    const phase = event.phase
    return {
      ts,
      tool: typeof event.tool === "string" ? event.tool : "",
      input: phase === "start" ? summarize(event.input) : "",
      result: phase === "end" && typeof event.resultSummary === "string" ? event.resultSummary : "",
      ms: phase === "end" && typeof event.ms === "number" ? String(event.ms) : "",
    }
  }
  const route = typeof event.route === "string" ? event.route : typeof event.event === "string" ? event.event : ""
  const backend = typeof event.backend === "string" ? event.backend : undefined
  const confidence = typeof event.confidence === "number" ? event.confidence.toFixed(2) : undefined
  return {
    ts,
    tool: typeof event.originalTool === "string" ? event.originalTool : "",
    input: summarize(event.arguments),
    result: [route, backend && `via ${backend}`, confidence && `(${confidence})`].filter(Boolean).join(" "),
    ms: typeof event.latencyMs === "number" ? String(event.latencyMs) : "",
  }
}

const header = () =>
  Style.TEXT_DIM +
  [
    truncate("TIME", TRACE_COLUMN_TS),
    truncate("TOOL", TRACE_COLUMN_TOOL),
    truncate("INPUT-SUMMARY", TRACE_COLUMN_INPUT),
    truncate("RESULT-SUMMARY", TRACE_COLUMN_RESULT),
    truncate("MS", TRACE_COLUMN_MS),
  ].join(" ") +
  Style.TEXT_NORMAL

const printRow = (row: Row) =>
  println(
    Style.TEXT_DIM + truncate(row.ts, TRACE_COLUMN_TS) + Style.TEXT_NORMAL,
    Style.TEXT_INFO_BOLD + truncate(row.tool, TRACE_COLUMN_TOOL) + Style.TEXT_NORMAL,
    Style.TEXT_NORMAL + truncate(row.input, TRACE_COLUMN_INPUT) + Style.TEXT_NORMAL,
    truncate(row.result, TRACE_COLUMN_RESULT),
    Style.TEXT_DIM + truncate(row.ms, TRACE_COLUMN_MS) + Style.TEXT_NORMAL,
  )

const handler = Effect.fn("cli.codegraph.trace")(function* (
  input: Runtime.Input<(typeof Commands.commands.codegraph.commands)["trace"]>,
) {
  const worktree = path.resolve(Option.getOrUndefined(input.worktree) ?? process.cwd())
  const file = findTraceFile(worktree, input.session)
  if (!file || !existsSync(file)) {
    println(`no traces for session ${input.session}`)
    return
  }
  const events = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line)
        return typeof parsed === "object" && parsed !== null ? [parsed as Record<string, unknown>] : []
      } catch {
        return []
      }
    })
  const tail = events.slice(-Math.max(1, input.limit))
  println(Style.TEXT_HIGHLIGHT + `Trace for session ${input.session}` + Style.TEXT_NORMAL)
  println(dim(`  file:   ${file}`))
  println(dim(`  events: ${events.length} (showing last ${tail.length})`))
  println("")
  println(header())
  for (let index = tail.length - 1; index >= 0; index--) {
    const event = tail[index]
    if (!event) continue
    const row = toRow(event)
    if (row) printRow(row)
  }
})

export default Runtime.handler(Commands.commands.codegraph.commands.trace, (input) =>
  handler(input).pipe(Effect.catch(onError())),
)
