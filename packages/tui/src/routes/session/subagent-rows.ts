import type { SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
import { canonicalToolName } from "../../util/tool-display"

// The keys that name what a tool call is doing. A child row shows one per line.
const ARG_KEYS = ["filePath", "file_path", "path", "command", "pattern", "query", "url", "description", "name"] as const

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function collectIDs(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === "string") return [item]
    if (typeof item !== "object" || item === null) return []
    const record = item as Record<string, unknown>
    const id = stringValue(record.sessionID) ?? stringValue(record.sessionId) ?? stringValue(record.id)
    return id ? [id] : []
  })
}

/**
 * Child session IDs named by a subagent tool part. Running parts carry the child
 * in their metadata; the input names it too when the tool continues a session.
 */
export function subagentChildSessionIDs(part: SessionMessageAssistantTool): string[] {
  const state = part.state
  const metadata = state.status === "streaming" ? undefined : state.metadata
  const input = typeof state.input === "string" ? undefined : state.input
  const ids = [
    stringValue(metadata?.sessionID),
    stringValue(metadata?.sessionId),
    stringValue(metadata?.childID),
    ...collectIDs(metadata?.sessions),
    ...collectIDs(metadata?.children),
    state.status === "running" ? stringValue(input?.sessionID) : undefined,
  ].filter((id): id is string => id !== undefined)
  return [...new Set(ids)]
}

export type ChildTool = {
  readonly name: string
  readonly args: string
}

/** The tool a child session is executing, or the one still receiving its arguments. */
export function childCurrentTool(messages: readonly SessionMessageInfo[]): ChildTool | undefined {
  const message = messages.findLast(
    (item): item is Extract<SessionMessageInfo, { type: "assistant" }> =>
      item.type === "assistant" && item.content.some((part) => part.type === "tool"),
  )
  if (message?.type !== "assistant") return undefined
  const tool = message.content.findLast(
    (part): part is SessionMessageAssistantTool =>
      part.type === "tool" && (part.state.status === "running" || part.state.status === "streaming"),
  )
  if (!tool) return undefined
  const input = typeof tool.state.input === "string" ? undefined : tool.state.input
  const args = ARG_KEYS.map((key) => input?.[key]).find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  )
  return {
    name: canonicalToolName(tool.name),
    args: (args ?? "").replace(/\s+/g, " ").trim(),
  }
}

export type SubagentChild = {
  readonly sessionID: string
  readonly agent?: string | undefined
  readonly status: string
  readonly messages: readonly SessionMessageInfo[]
}

export type SubagentChildRow = {
  readonly sessionID: string
  readonly agent: string
  readonly tool?: ChildTool
}

/** One row per child that is still running; finished children drop out of the transcript. */
export function subagentChildRows(children: readonly SubagentChild[]): SubagentChildRow[] {
  return children.flatMap((child) => {
    if (child.status !== "running") return []
    return [{ sessionID: child.sessionID, agent: child.agent ?? "subagent", tool: childCurrentTool(child.messages) }]
  })
}
