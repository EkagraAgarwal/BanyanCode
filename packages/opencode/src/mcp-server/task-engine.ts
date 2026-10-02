// Event-driven MCP task engine (Milestone B, gap-plan §4.3 + §4.4).
//
// Single implementation of concurrency/queue/timeout/rehydrate (§3.8):
// TaskStore.runningCount / McpTaskTracker die in consolidation. tasks.ts is
// left untouched; deletion happens in a later pass.
//
// Design notes:
// - Record table keyed by opaque high-entropy handle (B9/§8.2), mapped to
//   the session ID. Never the raw `ses_` id.
// - Bounded in-memory event queue + a single sequential consumer loop. The
//   mcp-server slice is plain async (no Effect runtime here); the loop gives
//   the same guarantee the AGENTS.md queue rules require: bounded, one
//   drain, no per-event fork. A second consumer of this queue must never
//   be added.
// - "done" requires an assistant message newer than the prompt AND an idle
//   session (or a session.idle event for this prompt) — fixes the
//   promptAsync race (§3.2).
// - needs_input timeout is a server-side timer started on question.asked,
//   not on caller poll (§3.5).
// - Queue state persists in session metadata `mcp_state: "queued"` so it
//   survives restarts; rehydrate rebuilds records from metadata (§4.4).
// - Replies carry typed `decision: "approve" | "reject"` (§3.7).

import { newTaskHandle } from "./task-handle"

export type TaskStatus = "queued" | "running" | "needs_input" | "done" | "failed" | "cancelled"
export type PermissionPolicy = "reject" | "edits" | "yolo"
export type ReplyDecision = "approve" | "reject"

export interface PendingQuestion {
  requestID: string
  kind: "permission" | "question"
  title: string
  detail?: string
  askedAt: number
}

export interface TaskRecord {
  handle: string
  sessionID: string
  status: TaskStatus
  agent?: string
  model?: string
  mcpClient: string
  permission: PermissionPolicy
  isolation: "shared" | "worktree"
  createdAt: number
  updatedAt: number
  promptIndex: number
  pendingQuestion?: PendingQuestion
  error?: string
}

// Structural permission rows carried to session creation (E1). Mirrors
// PermissionV1.Rule without importing Effect Schema here: the literals keep
// both directions assignable for the server.ts adapter (engine →
// SdkCreateSessionInput.permission and back).
export interface EnginePermissionRule {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}
export type EnginePermissionRuleset = EnginePermissionRule[]

// Port shape mirrors tasks.ts SessionClient (copied, not imported, to
// avoid churn while tasks.ts still exists). session-client.ts implements
// this port against the real SDK.
export interface EngineSessionMessage {
  role: string
  text: string
  time?: number
}

export interface EngineSessionClient {
  createSession(input: {
    title?: string
    metadata: Record<string, string>
    agent?: string
    model?: string
    // readonly: policy.ts buildRuleset returns the immutable ruleset array.
    permission?: readonly EnginePermissionRule[]
  }): Promise<{ id: string }>
  promptAsync(input: { sessionID: string; prompt: string; agent?: string; model?: string }): Promise<void>
  abort(input: { sessionID: string }): Promise<void>
  sessionStatus(input: { sessionID: string }): Promise<"busy" | "idle" | "retry" | "failed">
  messages(input: { sessionID: string; limit?: number }): Promise<EngineSessionMessage[]>
  pending(input: { sessionID: string }): Promise<PendingQuestion[]>
  replyPermission(input: {
    sessionID: string
    requestID: string
    reply: "once" | "always" | "reject"
    message?: string
  }): Promise<void>
  rejectQuestion(input: { sessionID: string; requestID: string; message?: string }): Promise<void>
  replyQuestion(input: { sessionID: string; requestID: string; message: string }): Promise<void>
  writeMetadata(input: { sessionID: string; metadata: Record<string, string> }): Promise<void>
}

// Session lookup for rehydrate (§4.4): find the session behind a handle,
// or list all MCP-owned sessions after a restart.
export interface EngineSessionLookup {
  findSession(input: { sessionID: string }): Promise<{ metadata: Record<string, string> } | undefined>
  listMcpSessions(): Promise<Array<{ sessionID: string; metadata: Record<string, string> }>>
}

// Event source abstraction: in-process mode feeds from the SDK
// `event.subscribe` SSE stream, attach mode from `global.event`. One
// producer, one consumer.
export type EngineEvent =
  | { type: "session.status"; sessionID: string; status: "busy" | "idle" | "retry" }
  | { type: "session.idle"; sessionID: string }
  | { type: "session.error"; sessionID: string; message: string }
  | { type: "permission.asked"; sessionID: string; request: PendingQuestion }
  | { type: "question.asked"; sessionID: string; request: PendingQuestion }

export interface EngineEventSource {
  subscribe(handler: (event: EngineEvent) => void): () => void
}

export interface TaskStartInput {
  prompt: string
  agent?: string
  model?: string
  isolation?: "shared" | "worktree"
  permission?: PermissionPolicy
  // Session ruleset built by the caller (policy.ts buildRuleset) from the
  // server policy. Forwarded to createSession so the policy holds at
  // creation time even when nobody polls (E1).
  permissionRuleset?: readonly EnginePermissionRule[]
  mcpClient?: string
}

export interface TaskReplyInput {
  decision: ReplyDecision
  message?: string
}

export interface WaitForStateChangeOptions {
  // Resolve on the next record update that leaves this status. When omitted,
  // any record update resolves. Resolves immediately when the current status
  // already differs.
  fromStatus?: TaskStatus
  // Deadline in milliseconds. Resolves with the current record when it
  // passes. Defaults to 0 (no wait — return the current record).
  timeoutMs?: number
}

interface StateWaiter {
  fromStatus?: TaskStatus
  timer: ReturnType<typeof setTimeout>
  resolve: (record: TaskRecord) => void
}

const MCP_ORIGIN = "mcp"
const MCP_HANDLE_KEY = "mcp_handle"
const QUEUED_STATE_KEY = "mcp_state"
const QUEUED_STATE_VALUE = "queued"

export interface TaskEngineOptions {
  maxConcurrentTasks: number
  needsInputTimeoutMs?: number
  now?: () => number
  onWorktreeCleanup?: (input: { handle: string; sessionID: string }) => void | Promise<void>
  eventQueueBound?: number
}

export const DEFAULT_NEEDS_INPUT_TIMEOUT_MS = 600_000
const DEFAULT_EVENT_QUEUE_BOUND = 1024

export class UnknownTaskError extends Error {
  readonly code = "UNKNOWN_TASK" as const
  constructor(handle: string) {
    super(`unknown or expired task handle: ${handle}. Start a new task with banyan_task_start.`)
  }
}

export class TaskEngine {
  private readonly records = new Map<string, TaskRecord>()
  private readonly sessionToHandle = new Map<string, string>()
  private readonly queuedInputs = new Map<string, TaskStartInput>()
  private readonly needsInputTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly stateWaiters = new Map<string, Set<StateWaiter>>()
  private readonly eventQueue: EngineEvent[] = []
  private draining = false
  private closed = false
  private readonly unsubscribe: () => void
  private droppedEvents = 0

  readonly maxConcurrentTasks: number
  readonly needsInputTimeoutMs: number
  private readonly now: () => number
  private readonly onWorktreeCleanup: (input: { handle: string; sessionID: string }) => void | Promise<void>
  private readonly eventQueueBound: number

  constructor(
    private readonly client: EngineSessionClient,
    private readonly lookup: EngineSessionLookup,
    eventSource: EngineEventSource,
    opts: TaskEngineOptions,
  ) {
    this.maxConcurrentTasks = opts.maxConcurrentTasks
    this.needsInputTimeoutMs = opts.needsInputTimeoutMs ?? DEFAULT_NEEDS_INPUT_TIMEOUT_MS
    this.now = opts.now ?? Date.now
    this.onWorktreeCleanup = opts.onWorktreeCleanup ?? (() => {})
    this.eventQueueBound = opts.eventQueueBound ?? DEFAULT_EVENT_QUEUE_BOUND
    this.unsubscribe = eventSource.subscribe((event) => this.enqueue(event))
  }

  get droppedEventCount(): number {
    return this.droppedEvents
  }

  close(): void {
    this.closed = true
    this.unsubscribe()
    for (const timer of this.needsInputTimers.values()) clearTimeout(timer)
    this.needsInputTimers.clear()
    for (const [handle, waiters] of this.stateWaiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.resolve(this.get(handle))
      }
    }
    this.stateWaiters.clear()
  }

  runningSlotsUsed(): number {
    let count = 0
    for (const record of this.records.values()) {
      if (record.status === "running" || record.status === "needs_input") count++
    }
    return count
  }

  get(handle: string): TaskRecord {
    const record = this.records.get(handle)
    if (!record) throw new UnknownTaskError(handle)
    return { ...record }
  }

  async start(input: TaskStartInput): Promise<TaskRecord> {
    const permission = input.permission ?? "reject"
    // Opaque high-entropy handle (B9/§8.2), never the raw ses_ id. Minted
    // before creation so it can ride along in the creation metadata (E0).
    const handle = newTaskHandle()
    const created = await this.client.createSession({
      title: input.prompt.split("\n")[0]?.slice(0, 80) || "mcp task",
      metadata: {
        origin: MCP_ORIGIN,
        mcp_client: input.mcpClient ?? "unknown",
        mcp_handle: handle,
        mcp_state: this.runningSlotsUsed() >= this.maxConcurrentTasks ? QUEUED_STATE_VALUE : "running",
      },
      // Creation-time agent/model/ruleset passthrough (E1): the policy
      // holds from session.create even when nobody polls.
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.permissionRuleset !== undefined ? { permission: input.permissionRuleset } : {}),
    })
    const at = this.now()
    const record: TaskRecord = {
      handle,
      sessionID: created.id,
      status: "running",
      mcpClient: input.mcpClient ?? "unknown",
      permission,
      isolation: input.isolation ?? "shared",
      createdAt: at,
      updatedAt: at,
      promptIndex: 0,
    }
    if (input.agent !== undefined) record.agent = input.agent
    if (input.model !== undefined) record.model = input.model
    this.records.set(record.handle, record)
    this.sessionToHandle.set(record.sessionID, record.handle)

    // Repair write for ports that do not persist creation metadata
    // verbatim: the handle↔session binding is what rehydrate matches on
    // (E2). Best-effort — the live record table stays authoritative.
    await this.client
      .writeMetadata({ sessionID: record.sessionID, metadata: { [MCP_HANDLE_KEY]: handle } })
      .catch(() => {})

    if (this.runningSlotsUsed() > this.maxConcurrentTasks) {
      this.queuedInputs.set(record.handle, input)
      await this.client.writeMetadata({
        sessionID: record.sessionID,
        metadata: { [QUEUED_STATE_KEY]: QUEUED_STATE_VALUE },
      })
      return this.patch(record.handle, { status: "queued" })
    }
    await this.launch(record.handle, input)
    return this.get(record.handle)
  }

  async status(handle: string): Promise<TaskRecord> {
    const record = this.get(handle)
    if (record.status === "running" || record.status === "queued") await this.refresh(record.handle)
    return this.get(record.handle)
  }

  // Event-driven wait hook (E4): resolves on the next record update that
  // leaves fromStatus (or any update when fromStatus is omitted), or with
  // the current record when timeoutMs elapses. The engine's single
  // sequential drain is the only producer — patch() is the single funnel,
  // so no polling is involved. Works with the noop event source: refresh()
  // patches through the same funnel.
  async waitForStateChange(handle: string, opts: WaitForStateChangeOptions = {}): Promise<TaskRecord> {
    const record = this.get(handle)
    const timeoutMs = Math.max(0, Math.floor(opts.timeoutMs ?? 0))
    if (timeoutMs <= 0) return { ...record }
    if (opts.fromStatus !== undefined && record.status !== opts.fromStatus) return { ...record }
    return new Promise<TaskRecord>((resolve) => {
      const owned = this.stateWaiters.get(handle) ?? new Set<StateWaiter>()
      this.stateWaiters.set(handle, owned)
      const waiter: StateWaiter = {
        ...(opts.fromStatus !== undefined ? { fromStatus: opts.fromStatus } : {}),
        resolve,
        timer: setTimeout(() => {
          owned.delete(waiter)
          if (owned.size === 0) this.stateWaiters.delete(handle)
          resolve(this.get(handle))
        }, timeoutMs),
      }
      if (typeof waiter.timer.unref === "function") waiter.timer.unref()
      // No await between the get() above and this add, so no transition
      // can slip through unwitnessed on this thread.
      owned.add(waiter)
    })
  }

  async reply(handle: string, reply: TaskReplyInput): Promise<TaskRecord> {
    const record = this.get(handle)
    if (record.status === "cancelled" || record.status === "done" || record.status === "failed") return record
    const pending = record.pendingQuestion
    if (!pending) {
      if (!reply.message) throw new Error("task_reply needs message when no question is pending")
      await this.client.promptAsync({ sessionID: record.sessionID, prompt: reply.message })
      return this.patch(handle, { status: "running", promptIndex: record.promptIndex + 1 })
    }
    this.clearNeedsInputTimer(handle)
    if (pending.kind === "permission") {
      // Caller decisions never grant beyond policy: under `reject` every
      // approval collapses to reject. No string equality on free text —
      // the typed `decision` field is the only signal.
      const granted = reply.decision === "approve" && record.permission !== "reject" ? "once" : "reject"
      await this.client.replyPermission({ sessionID: record.sessionID, requestID: pending.requestID, reply: granted })
    } else {
      if (reply.decision === "reject") {
        await this.client.rejectQuestion({ sessionID: record.sessionID, requestID: pending.requestID })
      } else {
        if (!reply.message) throw new Error("task_reply needs message to answer the pending question")
        await this.client.replyQuestion({
          sessionID: record.sessionID,
          requestID: pending.requestID,
          message: reply.message,
        })
      }
    }
    this.patch(handle, { status: "running", pendingQuestion: undefined })
    await this.refresh(handle)
    return this.get(handle)
  }

  async cancel(handle: string): Promise<TaskRecord> {
    const record = this.get(handle)
    // Terminal records stay as they are: cancelling a done/failed task
    // must not rewrite its history (or re-fire cleanup and dequeue).
    if (record.status === "cancelled" || record.status === "done" || record.status === "failed") return record
    this.clearNeedsInputTimer(handle)
    this.queuedInputs.delete(handle)
    await this.client.abort({ sessionID: record.sessionID }).catch(() => {})
    await this.onWorktreeCleanup({ handle, sessionID: record.sessionID })
    this.patch(handle, { status: "cancelled", pendingQuestion: undefined })
    await this.dequeueNext()
    return this.get(handle)
  }

  // Rehydrate (§4.4): rebuild the record for a handle whose session still
  // exists. Called on unknown-handle lookup and at startup via rehydrateAll.
  // Matches on the mcp_handle binding the engine writes at start (E2), with
  // a legacy fallback for pre-binding sessions that carry only origin mcp:
  // adopted when unambiguous, else UNKNOWN_TASK.
  async rehydrate(handle: string): Promise<TaskRecord> {
    if (this.records.has(handle)) return this.get(handle)
    const sessions = await this.lookup.listMcpSessions()
    const found = sessions.find((s) => s.metadata[MCP_HANDLE_KEY] === handle)
    if (found) return this.rebuildFromSession(handle, found.sessionID, found.metadata)
    const legacy = sessions.filter((s) => s.metadata["origin"] === MCP_ORIGIN && !s.metadata[MCP_HANDLE_KEY])
    if (legacy.length === 1) {
      const only = legacy[0]
      if (only) {
        await this.client
          .writeMetadata({ sessionID: only.sessionID, metadata: { [MCP_HANDLE_KEY]: handle } })
          .catch(() => {})
        return this.rebuildFromSession(handle, only.sessionID, { ...only.metadata, [MCP_HANDLE_KEY]: handle })
      }
    }
    throw new UnknownTaskError(handle)
  }

  async rehydrateAll(): Promise<TaskRecord[]> {
    const sessions = await this.lookup.listMcpSessions()
    const out: TaskRecord[] = []
    for (const session of sessions) {
      let handle = session.metadata[MCP_HANDLE_KEY]
      if (!handle) {
        // Legacy session (origin mcp, no binding yet): mint one and write
        // it back so the handle is stable from here on.
        if (session.metadata["origin"] !== MCP_ORIGIN) continue
        handle = newTaskHandle()
        await this.client
          .writeMetadata({ sessionID: session.sessionID, metadata: { [MCP_HANDLE_KEY]: handle } })
          .catch(() => {})
        session.metadata = { ...session.metadata, [MCP_HANDLE_KEY]: handle }
      }
      if (this.records.has(handle)) continue
      out.push(await this.rebuildFromSession(handle, session.sessionID, session.metadata))
    }
    return out
  }

  private async rebuildFromSession(
    handle: string,
    sessionID: string,
    metadata: Record<string, string>,
  ): Promise<TaskRecord> {
    const at = this.now()
    const queued = metadata[QUEUED_STATE_KEY] === QUEUED_STATE_VALUE
    const record: TaskRecord = {
      handle,
      sessionID,
      status: queued ? "queued" : "running",
      mcpClient: metadata["mcp_client"] ?? "unknown",
      permission: (metadata["policy"] as PermissionPolicy) ?? "reject",
      isolation: metadata["isolation"] === "worktree" ? "worktree" : "shared",
      createdAt: at,
      updatedAt: at,
      promptIndex: 0,
    }
    this.records.set(handle, record)
    this.sessionToHandle.set(sessionID, handle)
    await this.refresh(handle)
    return this.get(handle)
  }

  private patch(handle: string, patch: Partial<TaskRecord>): TaskRecord {
    const record = this.records.get(handle)
    if (!record) throw new UnknownTaskError(handle)
    const next: TaskRecord = { ...record, ...patch, updatedAt: this.now() }
    this.records.set(handle, next)
    this.notifyStateWaiters(handle, next)
    return { ...next }
  }

  // Single wakeup funnel for waitForStateChange (E4): every state change
  // flows through patch(), so waiters never need a second consumer on the
  // event queue.
  private notifyStateWaiters(handle: string, next: TaskRecord): void {
    const waiters = this.stateWaiters.get(handle)
    if (!waiters || waiters.size === 0) return
    for (const waiter of [...waiters]) {
      if (waiter.fromStatus !== undefined && next.status === waiter.fromStatus) continue
      clearTimeout(waiter.timer)
      waiters.delete(waiter)
      waiter.resolve({ ...next })
    }
    if (waiters.size === 0) this.stateWaiters.delete(handle)
  }

  private async launch(handle: string, input: TaskStartInput): Promise<void> {
    const record = this.get(handle)
    const before = await this.client.messages({ sessionID: record.sessionID })
    await this.client.promptAsync({
      sessionID: record.sessionID,
      prompt: input.prompt,
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
    })
    this.patch(handle, { status: "running", promptIndex: before.length })
    await this.refresh(handle)
  }

  private async dequeueNext(): Promise<void> {
    if (this.runningSlotsUsed() >= this.maxConcurrentTasks) return
    for (const [handle] of this.records) {
      const queued = this.queuedInputs.get(handle)
      if (!queued) continue
      this.queuedInputs.delete(handle)
      const record = this.get(handle)
      await this.client.writeMetadata({ sessionID: record.sessionID, metadata: { [QUEUED_STATE_KEY]: "running" } })
      await this.launch(handle, queued)
      return
    }
  }

  private clearNeedsInputTimer(handle: string): void {
    const timer = this.needsInputTimers.get(handle)
    if (timer !== undefined) clearTimeout(timer)
    this.needsInputTimers.delete(handle)
  }

  private startNeedsInputTimer(handle: string, pending: PendingQuestion): void {
    this.clearNeedsInputTimer(handle)
    const elapsed = this.now() - pending.askedAt
    const delay = Math.max(0, this.needsInputTimeoutMs - elapsed)
    const timer = setTimeout(() => {
      this.needsInputTimers.delete(handle)
      void this.expireNeedsInput(handle, pending.requestID)
    }, delay)
    if (typeof timer.unref === "function") timer.unref()
    this.needsInputTimers.set(handle, timer)
  }

  private async expireNeedsInput(handle: string, requestID: string): Promise<void> {
    const record = this.records.get(handle)
    if (!record || record.pendingQuestion?.requestID !== requestID) return
    const pending = record.pendingQuestion
    if (pending.kind === "permission") {
      await this.client.replyPermission({ sessionID: record.sessionID, requestID: pending.requestID, reply: "reject" })
    } else {
      await this.client.rejectQuestion({ sessionID: record.sessionID, requestID: pending.requestID })
    }
    this.patch(handle, { status: "running", pendingQuestion: undefined })
    await this.refresh(handle)
  }

  private enqueue(event: EngineEvent): void {
    if (this.closed) return
    if (this.eventQueue.length >= this.eventQueueBound) {
      this.droppedEvents++
      return
    }
    this.eventQueue.push(event)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.eventQueue.length > 0) {
        const event = this.eventQueue.shift()
        if (event) await this.apply(event)
      }
    } finally {
      this.draining = false
    }
  }

  private async apply(event: EngineEvent): Promise<void> {
    const handle = this.sessionToHandle.get(event.sessionID)
    if (!handle) return
    const record = this.records.get(handle)
    if (!record || record.status === "cancelled" || record.status === "done" || record.status === "failed") return

    switch (event.type) {
      case "session.error":
        this.clearNeedsInputTimer(handle)
        this.queuedInputs.delete(handle)
        this.patch(handle, { status: "failed", error: event.message, pendingQuestion: undefined })
        await this.dequeueNext()
        return
      case "permission.asked":
        if (record.permission === "reject") {
          await this.client.replyPermission({
            sessionID: record.sessionID,
            requestID: event.request.requestID,
            reply: "reject",
          })
          this.patch(handle, { status: "running" })
          return
        }
        this.patch(handle, { status: "needs_input", pendingQuestion: event.request })
        this.startNeedsInputTimer(handle, event.request)
        return
      case "question.asked":
        this.patch(handle, { status: "needs_input", pendingQuestion: event.request })
        this.startNeedsInputTimer(handle, event.request)
        return
      case "session.idle":
      case "session.status":
        if (event.type === "session.status" && event.status !== "idle") {
          if (record.status !== "needs_input") this.patch(handle, { status: "running" })
          return
        }
        await this.refresh(handle)
        return
    }
  }

  private async refresh(handle: string): Promise<void> {
    const record = this.records.get(handle)
    if (!record || record.status === "cancelled" || record.status === "failed") return
    const pending = await this.client.pending({ sessionID: record.sessionID })
    const first = pending[0]
    if (first) {
      if (first.kind === "permission" && record.permission === "reject") {
        await this.client.replyPermission({
          sessionID: record.sessionID,
          requestID: first.requestID,
          reply: "reject",
        })
        this.patch(handle, { status: "running", pendingQuestion: undefined })
        return
      }
      const current = this.records.get(handle)
      if (current?.pendingQuestion?.requestID !== first.requestID) {
        this.patch(handle, { status: "needs_input", pendingQuestion: first })
        this.startNeedsInputTimer(handle, first)
      }
      return
    }
    const status = await this.client.sessionStatus({ sessionID: record.sessionID })
    if (status === "failed") {
      this.clearNeedsInputTimer(handle)
      this.queuedInputs.delete(handle)
      this.patch(handle, { status: "failed", pendingQuestion: undefined })
      await this.dequeueNext()
      return
    }
    if (status === "busy" || status === "retry") {
      if (record.status !== "needs_input") this.patch(handle, { status: "running" })
      return
    }
    // Idle: done only with an assistant message newer than the prompt.
    const messages = await this.client.messages({ sessionID: record.sessionID })
    const fresh = messages.slice(record.promptIndex).some((msg) => msg.role === "assistant")
    if (!fresh) {
      if (record.status !== "queued") this.patch(handle, { status: "running" })
      return
    }
    this.clearNeedsInputTimer(handle)
    this.queuedInputs.delete(handle)
    this.patch(handle, { status: "done", pendingQuestion: undefined })
    await this.client.writeMetadata({ sessionID: record.sessionID, metadata: { [QUEUED_STATE_KEY]: "done" } })
    await this.dequeueNext()
  }
}

export * as McpTaskEngine from "./task-engine"
