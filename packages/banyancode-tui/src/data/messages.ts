import type { SessionMessageInfo, SessionMessageAssistantTool, SessionInfo, TokenUsageInfo } from "@opencode/client"
import { truncate } from "./format"

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"
export interface Todo {
  readonly content: string
  readonly status: TodoStatus
}

const TODO_STATUSES = new Set<unknown>(["pending", "in_progress", "completed", "cancelled"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function parseTodos(value: unknown): Todo[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.content !== "string" || !item.content) return []
    return [{ content: item.content, status: TODO_STATUSES.has(item.status) ? (item.status as TodoStatus) : "pending" }]
  })
}

/** The current list is the input of the latest completed `todowrite` call before the revert boundary. */
export function sessionTodos(messages: ReadonlyArray<SessionMessageInfo>, boundary?: string): Todo[] {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  const tool = messages
    .slice(0, boundaryIndex === -1 ? messages.length : boundaryIndex)
    .flatMap((message) => (message.type === "assistant" ? message.content : []))
    .findLast(
      (item): item is SessionMessageAssistantTool & { state: { status: "completed" } } =>
        item.type === "tool" && item.name === "todowrite" && item.state.status === "completed",
    )
  return parseTodos(tool?.state.status === "completed" ? (tool.state as { input: unknown }).input : undefined)
}

export function toolNames(messages: ReadonlyArray<SessionMessageInfo>): string[] {
  const names = new Set<string>()
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const item of message.content) if (item.type === "tool") names.add(item.name)
  }
  return [...names]
}

export function isAssistant(message: SessionMessageInfo): message is Extract<SessionMessageInfo, { type: "assistant" }> {
  return message.type === "assistant"
}

export type ToolCallStatus = "pending" | "running" | "completed" | "error"

export interface ToolCall {
  readonly id: string
  readonly name: string
  /** One-line summary of the call's input, for a row next to the tool name. */
  readonly args: string
  readonly status: ToolCallStatus
  readonly createdAt: number
  readonly completedAt?: number | undefined
}

// The keys that identify what a call is about. A tool row shows one of these
// instead of the whole input object.
const TOOL_ARG_KEYS = [
  "filePath",
  "file_path",
  "path",
  "file",
  "command",
  "cmd",
  "pattern",
  "query",
  "url",
  "name",
  "description",
  "prompt",
  "text",
] as const

/** Collapse whitespace and clip to `max`, for single-row display. */
function oneLine(value: string, max: number): string {
  return truncate(value.replace(/\s+/g, " ").trim(), max)
}

/**
 * A short, single-row summary of a tool call's input. Streaming calls carry a
 * raw JSON fragment rather than an object, so both shapes are accepted.
 */
export function toolArgs(input: unknown, max = 60): string {
  if (typeof input === "string") return oneLine(input, max)
  if (typeof input !== "object" || input === null) return ""
  const record = input as Record<string, unknown>
  const preferred = TOOL_ARG_KEYS.map((key) => record[key]).find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  )
  const value =
    preferred ??
    Object.values(record).find(
      (item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean",
    )
  if (value === undefined) return ""
  return oneLine(String(value), max)
}

/** Every tool call in message order, with its arguments and state. */
export function toolHistory(messages: ReadonlyArray<SessionMessageInfo>): ToolCall[] {
  return messages.flatMap((message) =>
    message.type !== "assistant"
      ? []
      : message.content.flatMap((item) =>
          item.type !== "tool"
            ? []
            : [
                {
                  id: item.id,
                  name: item.name,
                  args: toolArgs(item.state.input),
                  // `streaming` means the model is still emitting arguments;
                  // the tool has not started, so it is not "running" yet.
                  status: item.state.status === "streaming" ? ("pending" as const) : item.state.status,
                  createdAt: item.time.created,
                  completedAt: item.time.completed,
                },
              ],
        ),
  )
}

/** The call currently executing; while none runs, the one still receiving arguments. */
export function currentTool(messages: ReadonlyArray<SessionMessageInfo>): ToolCall | undefined {
  const history = toolHistory(messages)
  return history.findLast((call) => call.status === "running") ?? history.findLast((call) => call.status === "pending")
}

/** How many tool calls are executing right now. */
export function runningToolCount(messages: ReadonlyArray<SessionMessageInfo>): number {
  return toolHistory(messages).filter((call) => call.status === "running").length
}

/**
 * The newest assistant text, or its reasoning when it produced no text. Blank
 * when there is none: callers render nothing rather than placeholder narration.
 */
export function latestOutput(messages: ReadonlyArray<SessionMessageInfo>, lines = 6): string[] {
  if (lines <= 0) return []
  const message = messages.findLast(
    (item) =>
      item.type === "assistant" &&
      item.content.some((part) => (part.type === "text" || part.type === "reasoning") && part.text.trim().length > 0),
  )
  if (message?.type !== "assistant") return []
  const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
  const reasoning = message.content.flatMap((part) => (part.type === "reasoning" ? [part.text] : [])).join("\n")
  const source = text.trim().length > 0 ? text : reasoning
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-lines)
}

/** The child's last assistant text, clipped. Undefined when it said nothing. */
export function returnedSummary(messages: ReadonlyArray<SessionMessageInfo>, max = 80): string | undefined {
  const message = messages.findLast(
    (item): item is Extract<SessionMessageInfo, { type: "assistant" }> =>
      isAssistant(item) && item.content.some((part) => part.type === "text" && part.text.trim().length > 0),
  )
  if (!message) return undefined
  const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ")
  const summary = oneLine(text, max)
  return summary.length > 0 ? summary : undefined
}

/**
 * Milliseconds since the run started: the newest user message, or the newest
 * assistant message when a run has no visible prompt of its own.
 */
export function elapsedMs(messages: ReadonlyArray<SessionMessageInfo>, now = Date.now()): number | undefined {
  const start =
    messages.findLast((item) => item.type === "user")?.time.created ??
    messages.findLast((item) => item.type === "assistant")?.time.created
  if (start === undefined) return undefined
  return Math.max(0, now - start)
}

export function lastAssistant(
  messages: ReadonlyArray<SessionMessageInfo>,
  completed?: boolean,
): Extract<SessionMessageInfo, { type: "assistant" }> | undefined {
  return messages.findLast(
    (message): message is Extract<SessionMessageInfo, { type: "assistant" }> =>
      isAssistant(message) && (completed === undefined ? true : completed ? message.time.completed !== undefined : message.time.completed === undefined),
  )
}

export function totalTokens(tokens: TokenUsageInfo | undefined): number {
  if (!tokens) return 0
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export function sessionTokenTotal(sessions: readonly Pick<SessionInfo, "tokens">[]): number {
  return sessions.reduce((sum, session) => sum + totalTokens(session.tokens), 0)
}

export function sessionCostTotal(sessions: readonly Pick<SessionInfo, "cost">[]): number {
  return sessions.reduce((sum, session) => sum + (session.cost ?? 0), 0)
}

export function sessionAge(ms: number | undefined, now = Date.now()): string {
  if (ms === undefined) return "—"
  const seconds = Math.max(0, Math.floor((now - ms) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
