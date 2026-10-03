// Shared session port for the MCP task slice (gap-plan §4.8 consolidation).
//
// Moved verbatim from the deleted tasks.ts: session-client.ts (the
// production implementation), server.ts and tools-task.ts (consumers), and
// the protocol tests all share these types. The legacy TaskStore lifecycle
// machinery that used to live alongside them is gone — TaskEngine
// (task-engine.ts) is the single implementation of concurrency, queue,
// timeout, and rehydrate.
import type { EnginePermissionRuleset } from "./task-engine"
import type { DiffFileInput } from "./result"

export interface PendingQuestion {
  requestID: string
  kind: "permission" | "question"
  title: string
  detail?: string
  askedAt: number
}

// Minimal session port. Production wires the SDK v2 client
// (`session.create/promptAsync/abort/diff/messages/todo/mesh`,
// `permission.reply`, `question.reply/reject`); tests inject a fake.
export interface SessionMessage {
  role: string
  text: string
  time?: number
}

export interface SessionClient {
  // Creation-time overrides (E1): per-task agent/model/permission ruleset
  // from the engine; the SDK implementation merges them with its defaults.
  createSession(input: {
    title?: string
    metadata: Record<string, string>
    agent?: string
    model?: string
    permission?: EnginePermissionRuleset
  }): Promise<{ id: string }>
  promptAsync(input: { sessionID: string; prompt: string; agent?: string; model?: string }): Promise<void>
  prompt(input: { sessionID: string; prompt: string; agent?: string; model?: string }): Promise<void>
  abort(input: { sessionID: string }): Promise<void>
  sessionStatus(input: { sessionID: string }): Promise<"busy" | "idle" | "retry" | "failed">
  messages(input: { sessionID: string; limit?: number }): Promise<SessionMessage[]>
  diff(input: { sessionID: string }): Promise<DiffFileInput[]>
  todo(input: { sessionID: string }): Promise<Array<{ title: string; status: string }>>
  pending(input: { sessionID: string }): Promise<PendingQuestion[]>
  subagents(input: { sessionID: string }): Promise<Array<{ agent: string; model: string; status: string }>>
  cost(input: { sessionID: string }): Promise<{ cost: number; tokensByModel: Record<string, { input: number; output: number }> }>
  replyPermission(input: { sessionID: string; requestID: string; reply: "once" | "always" | "reject"; message?: string }): Promise<void>
  rejectQuestion(input: { sessionID: string; requestID: string; message?: string }): Promise<void>
  replyQuestion(input: { sessionID: string; requestID: string; message: string }): Promise<void>
}

export * as McpSessionTypes from "./types"
