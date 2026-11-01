import type { SessionMessageInfo, SessionMessageAssistantTool, SessionInfo, TokenUsageInfo } from "@opencode/client"

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
