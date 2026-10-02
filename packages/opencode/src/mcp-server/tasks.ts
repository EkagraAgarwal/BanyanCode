// Phase 1 MCP delegation lifecycle: banyan_task_start/status/result/cancel/reply.
//
// A task is a normal session tagged `origin: "mcp"` with `mcp_client` taken
// from the MCP `clientInfo.name`, so it shows up in the TUI session list,
// telemetry and `/session/:id/mesh`. `task_id` is the root session ID.
//
// Calling pattern is start-then-poll with a bounded long-poll
// (`wait_seconds` clamped to 0-50). When the session raises a question or a
// permission the policy cannot decide, the task moves to `needs_input` and
// carries the pending question; `task_reply` continues the SAME session.
//
// Permissions default to reject here (mirrors `run.ts` without
// `--dangerously-skip-permissions`: auto-reject anything not already allowed
// by config). `edits`/`yolo` policies live in the sibling worker. Jev and
// caller decisions never grant permissions beyond the active policy.

import { buildCompactResult, DEFAULT_RESULT_MAX_TOKENS } from "./result"
import type { CompactResult, DiffFileInput, ResultDetail } from "./result"

export type TaskStatus = "queued" | "running" | "needs_input" | "done" | "failed" | "cancelled"

// Phase 1 serves `reject` only. The type keeps the full union so the
// sibling worker (edits/yolo) can reuse this slice without reshaping it.
export type PermissionPolicy = "reject" | "edits" | "yolo"

export const MAX_WAIT_SECONDS = 50

export function clampWaitSeconds(value?: number): number {
  if (value === undefined || Number.isNaN(value)) return 0
  return Math.min(MAX_WAIT_SECONDS, Math.max(0, Math.floor(value)))
}

export interface TaskPlanStep {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
}

export interface TaskStartInput {
  prompt: string
  agent?: string
  model?: string
  plan?: { title: string; steps: TaskPlanStep[]; exitCriteria: string }
  files?: string[]
  isolation?: "shared" | "worktree"
  permission?: PermissionPolicy
  wait_seconds?: number
}

export interface PendingQuestion {
  requestID: string
  kind: "permission" | "question"
  title: string
  detail?: string
  askedAt: number
}

export interface TaskRecord {
  task_id: string
  status: TaskStatus
  agent?: string
  model?: string
  mcp_client: string
  origin: "mcp"
  permission: PermissionPolicy
  isolation: "shared" | "worktree"
  createdAt: number
  updatedAt: number
  elapsedMs: number
  cost: number
  lastActivity: string
  pendingQuestion?: PendingQuestion
  error?: string
  cancelled: boolean
}

export interface TaskStartResult {
  task_id: string
  status: TaskStatus
  result?: CompactResult
}

export interface TaskReplyInput {
  message?: string
  answer?: string
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
  createSession(input: { title?: string; metadata: Record<string, string> }): Promise<{ id: string }>
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

export interface TaskStoreOptions {
  maxConcurrentTasks?: number
  needsInputTimeoutMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollIntervalMs?: number
  resultMaxTokens?: number
}

export interface TaskStore {
  tasks: Map<string, TaskRecord>
  maxConcurrentTasks: number
  needsInputTimeoutMs: number
  now: () => number
  sleep: (ms: number) => Promise<void>
  pollIntervalMs: number
  resultMaxTokens: number
}

export const DEFAULT_MAX_CONCURRENT_TASKS = 4
export const DEFAULT_NEEDS_INPUT_TIMEOUT_MS = 600_000

export function createTaskStore(opts: TaskStoreOptions = {}): TaskStore {
  return {
    tasks: new Map(),
    maxConcurrentTasks: opts.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS,
    needsInputTimeoutMs: opts.needsInputTimeoutMs ?? DEFAULT_NEEDS_INPUT_TIMEOUT_MS,
    now: opts.now ?? Date.now,
    sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    pollIntervalMs: opts.pollIntervalMs ?? 250,
    resultMaxTokens: opts.resultMaxTokens ?? DEFAULT_RESULT_MAX_TOKENS,
  }
}

export function runningCount(store: TaskStore): number {
  let count = 0
  for (const task of store.tasks.values()) {
    if (task.status === "running" || task.status === "needs_input") count++
  }
  return count
}

function touch(store: TaskStore, task: TaskRecord, patch?: Partial<TaskRecord>): TaskRecord {
  const now = store.now()
  const next: TaskRecord = {
    ...task,
    ...patch,
    updatedAt: now,
    elapsedMs: now - task.createdAt,
  }
  store.tasks.set(next.task_id, next)
  return next
}

// Headless permission policy for Phase 1: auto-reject anything the config
// does not already allow (same as `run.ts` without the flag). Returns the
// reply that must be sent. Caller/Jev input is validated through
// `assertWithinPolicy` first so neither can escalate beyond this.
export function policyReplyFor(policy: PermissionPolicy, allowYolo: boolean): "once" | "reject" {
  if (policy === "yolo" && allowYolo) return "once"
  return "reject"
}

export function assertWithinPolicy(
  policy: PermissionPolicy,
  decision: "approve" | "reject",
  allowYolo: boolean,
): "once" | "reject" {
  if (decision === "approve") {
    const granted = policyReplyFor(policy, allowYolo)
    if (granted === "reject") return "reject"
    return granted
  }
  return "reject"
}

export async function autoRejectPending(
  client: SessionClient,
  store: TaskStore,
  task: TaskRecord,
  pending: PendingQuestion,
): Promise<void> {
  if (pending.kind === "permission") {
    await client.replyPermission({ sessionID: task.task_id, requestID: pending.requestID, reply: "reject" })
  } else {
    await client.rejectQuestion({ sessionID: task.task_id, requestID: pending.requestID })
  }
  touch(store, task, { lastActivity: `auto-rejected ${pending.kind} ${pending.requestID}` })
}

export function isNeedsInputTimedOut(store: TaskStore, task: TaskRecord, now?: number): boolean {
  if (!task.pendingQuestion) return false
  const at = now ?? store.now()
  return at - task.pendingQuestion.askedAt >= store.needsInputTimeoutMs
}

async function refreshFromSession(client: SessionClient, store: TaskStore, task: TaskRecord): Promise<TaskRecord> {
  if (task.status === "cancelled" || task.status === "failed") return task
  const pending = await client.pending({ sessionID: task.task_id })
  if (pending.length > 0) {
    const first = pending[0]
    const next = touch(store, task, {
      status: "needs_input",
      pendingQuestion: first,
      lastActivity: first.title,
    })
    if (isNeedsInputTimedOut(store, next)) {
      await autoRejectPending(client, store, next, first)
      return touch(store, next, {
        status: "running",
        pendingQuestion: undefined,
        lastActivity: `needs_input timed out; rejected ${first.requestID}`,
      })
    }
    return next
  }
  const status = await client.sessionStatus({ sessionID: task.task_id })
  if (status === "failed") return touch(store, task, { status: "failed", lastActivity: "session failed" })
  if (status === "busy" || status === "retry") {
    return touch(store, task, {
      status: task.status === "queued" ? task.status : "running",
      lastActivity: "running",
    })
  }
  const recent = await client.messages({ sessionID: task.task_id, limit: 1 })
  const last = recent[recent.length - 1]
  return touch(store, task, {
    status: "done",
    pendingQuestion: undefined,
    lastActivity: last ? last.text.split("\n")[0]?.slice(0, 120) ?? "done" : "done",
  })
}

async function waitSettled(
  client: SessionClient,
  store: TaskStore,
  task: TaskRecord,
  waitSeconds: number,
): Promise<TaskRecord> {
  let current = await refreshFromSession(client, store, task)
  const deadline = store.now() + clampWaitSeconds(waitSeconds) * 1000
  while (current.status === "running" || current.status === "queued") {
    if (store.now() >= deadline) break
    await store.sleep(store.pollIntervalMs)
    current = await refreshFromSession(client, store, current)
  }
  return current
}

export async function taskStart(
  store: TaskStore,
  client: SessionClient,
  input: TaskStartInput,
  opts: { mcpClient?: string; allowYolo?: boolean } = {},
): Promise<TaskStartResult> {
  const permission: PermissionPolicy = input.permission ?? "reject"
  if (permission === "yolo" && !opts.allowYolo) {
    throw new Error("yolo requires the server to be started with --allow-yolo")
  }
  const created = await client.createSession({
    title: input.prompt.split("\n")[0]?.slice(0, 80) || "mcp task",
    metadata: { origin: "mcp", mcp_client: opts.mcpClient ?? "unknown" },
  })
  const now = store.now()
  let task: TaskRecord = {
    task_id: created.id,
    status: "running",
    origin: "mcp",
    mcp_client: opts.mcpClient ?? "unknown",
    permission,
    isolation: input.isolation ?? "shared",
    createdAt: now,
    updatedAt: now,
    elapsedMs: 0,
    cost: 0,
    lastActivity: "started",
    cancelled: false,
  }
  if (input.agent !== undefined) task = { ...task, agent: input.agent }
  if (input.model !== undefined) task = { ...task, model: input.model }
  store.tasks.set(task.task_id, task)

  // Over-cap starts queue instead of failing.
  if (runningCount(store) > store.maxConcurrentTasks) {
    const queued = touch(store, task, { status: "queued", lastActivity: "queued behind running tasks" })
    return { task_id: queued.task_id, status: queued.status }
  }

  await client.promptAsync({
    sessionID: task.task_id,
    prompt: input.prompt,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  })
  const settled = await waitSettled(client, store, touch(store, task, { lastActivity: "prompted" }), input.wait_seconds ?? 0)
  if (settled.status === "done") {
    return { task_id: settled.task_id, status: settled.status, result: await taskResult(store, client, settled.task_id) }
  }
  return { task_id: settled.task_id, status: settled.status }
}

export async function taskStatus(
  store: TaskStore,
  client: SessionClient,
  task_id: string,
  wait_seconds?: number,
): Promise<TaskRecord> {
  const task = store.tasks.get(task_id)
  if (!task) throw new Error(`unknown task_id: ${task_id}`)
  return waitSettled(client, store, task, wait_seconds ?? 0)
}

export async function taskReply(
  store: TaskStore,
  client: SessionClient,
  task_id: string,
  reply: TaskReplyInput,
  opts: { allowYolo?: boolean } = {},
): Promise<TaskRecord> {
  const task = store.tasks.get(task_id)
  if (!task) throw new Error(`unknown task_id: ${task_id}`)
  if (task.status === "cancelled") return task
  const pending = task.pendingQuestion
  if (!pending) {
    // No pending question: continue the same session with follow-up text.
    const text = reply.message ?? reply.answer
    if (!text) throw new Error("task_reply needs message or answer")
    await client.prompt({ sessionID: task_id, prompt: text })
    return touch(store, task, { status: "running", lastActivity: "follow-up sent" })
  }
  if (isNeedsInputTimedOut(store, task)) {
    await autoRejectPending(client, store, task, pending)
    const timedOut = touch(store, task, {
      status: "running",
      pendingQuestion: undefined,
      lastActivity: `needs_input timed out; rejected ${pending.requestID}`,
    })
    return timedOut
  }
  if (pending.kind === "permission") {
    // Caller decisions never grant beyond policy: Phase 1 policy is reject,
    // so any approval collapses to reject.
    const wants = reply.answer === "approve" || reply.message === "approve" ? "approve" : "reject"
    const granted = assertWithinPolicy(task.permission, wants, opts.allowYolo ?? false)
    await client.replyPermission({ sessionID: task_id, requestID: pending.requestID, reply: granted })
  } else {
    const text = reply.answer ?? reply.message
    if (!text) throw new Error("task_reply needs message or answer for the pending question")
    await client.replyQuestion({ sessionID: task_id, requestID: pending.requestID, message: text })
  }
  const resumed = touch(store, task, { status: "running", pendingQuestion: undefined, lastActivity: "reply sent" })
  const followUp = reply.message ?? reply.answer
  if (followUp && pending.kind === "question") {
    await client.prompt({ sessionID: task_id, prompt: followUp })
  }
  return refreshFromSession(client, store, resumed)
}

export async function taskCancel(store: TaskStore, client: SessionClient, task_id: string): Promise<TaskRecord> {
  const task = store.tasks.get(task_id)
  if (!task) throw new Error(`unknown task_id: ${task_id}`)
  if (task.status === "cancelled") return task
  await client.abort({ sessionID: task_id })
  return touch(store, task, { status: "cancelled", cancelled: true, lastActivity: "cancelled" })
}

export async function taskResult(
  store: TaskStore,
  client: SessionClient,
  task_id: string,
  detail: ResultDetail = "summary",
): Promise<CompactResult> {
  const task = store.tasks.get(task_id)
  if (!task) throw new Error(`unknown task_id: ${task_id}`)
  const [msgs, diffFiles, todos, pending, subs, cost] = await Promise.all([
    client.messages({ sessionID: task_id, limit: 20 }),
    client.diff({ sessionID: task_id }),
    client.todo({ sessionID: task_id }),
    client.pending({ sessionID: task_id }),
    client.subagents({ sessionID: task_id }),
    client.cost({ sessionID: task_id }),
  ])
  const finalMessage = [...msgs].reverse().find((msg) => msg.role === "assistant")?.text
  const openTodos = todos.filter((item) => item.status !== "completed")
  return buildCompactResult(
    {
      task_id,
      status: task.status,
      ...(finalMessage !== undefined ? { finalMessage } : {}),
      diffFiles,
      todos: openTodos,
      openQuestions: pending.map((item) => ({ requestID: item.requestID, question: item.title })),
      cost: cost.cost,
      tokensByModel: cost.tokensByModel,
      subagentCount: subs.length,
      worktree: task.isolation === "worktree" ? task_id : undefined,
    },
    { maxTokens: store.resultMaxTokens, detail },
  )
}

export * as McpTasks from "./tasks"
