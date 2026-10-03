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
// - Events for child sessions (subagent asks) resolve to the root task
//   handle through the session tree (W1.1): apply() falls back to
//   resolveChildHandle, which lists children per non-terminal task and
//   caches hits in sessionToHandle (misses in a bounded TTL cache).
// - Safety-net sweep (W1.1): while any task is non-terminal a single
//   interval refreshes every running/needs_input handle then dequeues.
//   The timer stops when nothing is non-terminal and restarts on start.
// - needs_input timeout is a server-side timer started on question.asked,
//   not on caller poll (§3.5).
// - Queue state persists in session metadata `mcp_state: "queued"` so it
//   survives restarts; rehydrate rebuilds records from metadata (§4.4).
// - Replies carry typed `decision: "approve" | "reject"` (§3.7).

import { newTaskHandle } from "./task-handle"
import type { WorktreeManager, WorktreeReleaseDisposition } from "./worktree"

export type TaskStatus = "queued" | "running" | "needs_input" | "done" | "failed" | "cancelled"
export type PermissionPolicy = "reject" | "edits" | "yolo"
export type ReplyDecision = "approve" | "reject"

// Per-task worktree checkout recorded on the task (C2). `directory` is the
// absolute worktree path every SDK call for this task runs with.
export interface TaskWorktree {
  name: string
  directory: string
  branch: string
}

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
  // Machine-readable failure code. Set to "BUDGET" when the per-task USD
  // cap aborts the task (C6); the tool layer maps it to the tool error.
  errorCode?: string
  // Accumulated USD spend for the task (root + child sessions), summed from
  // session.cost events on the engine event source (C6).
  cost: number
  // Effective per-task USD cap (per-start override or the engine default).
  budgetUsd: number
  worktree?: TaskWorktree
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
//
// `directory` is the per-task SDK root: worktree tasks pass the allocated
// worktree path (C2) and every call runs scoped to it. Absent means the
// server default (cwd).
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
    directory?: string
  }): Promise<{ id: string }>
  promptAsync(input: { sessionID: string; prompt: string; agent?: string; model?: string; directory?: string }): Promise<void>
  abort(input: { sessionID: string; directory?: string }): Promise<void>
  sessionStatus(input: { sessionID: string; directory?: string }): Promise<"busy" | "idle" | "retry" | "failed">
  messages(input: { sessionID: string; limit?: number; directory?: string }): Promise<EngineSessionMessage[]>
  pending(input: { sessionID: string; directory?: string }): Promise<PendingQuestion[]>
  replyPermission(input: {
    sessionID: string
    requestID: string
    reply: "once" | "always" | "reject"
    message?: string
    directory?: string
  }): Promise<void>
  rejectQuestion(input: { sessionID: string; requestID: string; message?: string; directory?: string }): Promise<void>
  replyQuestion(input: { sessionID: string; requestID: string; message: string; directory?: string }): Promise<void>
  writeMetadata(input: { sessionID: string; metadata: Record<string, string>; directory?: string }): Promise<void>
  // Child-session tree for event attribution (W1.1): the engine resolves
  // events from subagent sessions to the root task handle. Optional so
  // in-memory harnesses keep compiling; without it only root-session
  // events are attributed.
  listChildren?(input: { sessionID: string; directory?: string }): Promise<string[]>
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
//
// session.cost carries the CUMULATIVE USD total for one session (root or
// child), mirroring the Jev per-session budget accounting pattern: the
// engine keeps a per-session high-water entry per task and sums them, so
// dropped or reordered events can only delay the cap trip, never double
// count it. The live mapper derives it from `session.updated` info.cost
// (server.ts, sibling-owned).
export type EngineEvent =
  | { type: "session.status"; sessionID: string; status: "busy" | "idle" | "retry" }
  | { type: "session.idle"; sessionID: string }
  | { type: "session.error"; sessionID: string; message: string }
  | { type: "session.cost"; sessionID: string; cost: number }
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
  // Requested worktree name for isolation "worktree" (C2). Sanitized by
  // the worktree manager; a taken name rejects with a suggestion. Absent
  // means an generated `mcp-<hex>` name.
  worktreeName?: string
  // Per-task USD cap override (C6). Falls back to the engine default.
  budgetUsd?: number
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
  // Safety-net sweep cadence (W1.1). Defaults to 7_500 ms (inside the
  // 5–10 s window). Clamped to >= 1_000 ms.
  sweepIntervalMs?: number
  now?: () => number
  onWorktreeCleanup?: (input: {
    handle: string
    sessionID: string
    worktreePath?: string
    disposition?: WorktreeReleaseDisposition
  }) => void | Promise<void>
  eventQueueBound?: number
  // Worktree manager for isolation "worktree" (C2). Starts that request a
  // worktree fail closed when no manager is configured.
  worktrees?: WorktreeManager
  // Default per-task USD cap (C6). A per-start budgetUsd wins over this.
  taskBudgetUsd?: number
}

export const DEFAULT_NEEDS_INPUT_TIMEOUT_MS = 600_000
// Sane default guardrail for unattended caller loops (C6): cheap-model
// delegation costs cents per task, so 5 USD trips only on runaway spend.
// Mirror point for the Jev perSessionUsd pattern, which has no default.
export const DEFAULT_TASK_BUDGET_USD = 5
const DEFAULT_SWEEP_INTERVAL_MS = 7_500
const MIN_SWEEP_INTERVAL_MS = 1_000
// Negative child-resolution cache: bounds wasted tree walks for events
// from sessions this engine does not own (attach mode sees every
// session on the server). Self-corrects when a child appears later.
const UNKNOWN_SESSION_TTL_MS = 30_000
const UNKNOWN_SESSION_BOUND = 500
const DEFAULT_EVENT_QUEUE_BOUND = 1024

export class UnknownTaskError extends Error {
  readonly code = "UNKNOWN_TASK" as const
  constructor(handle: string) {
    super(`unknown or expired task handle: ${handle}. Start a new task with banyan_task_start.`)
  }
}

// A second write-capable shared task while one is still active (C2). The
// suggestion names the fix: retry the start with isolation "worktree".
export class SharedWriteConflictError extends Error {
  readonly code = "SHARED_WRITE_CONFLICT" as const
  readonly suggestion = "worktree" as const
  constructor(activeHandle: string) {
    super(
      `a write-capable shared task (${activeHandle}) is already active; shared tasks would clobber each other's edits. ` +
        `Retry with isolation "worktree" for an isolated checkout.`,
    )
  }
}

const MCP_WORKTREE_KEY = "mcp_worktree"
const MCP_WORKTREE_BRANCH_KEY = "mcp_worktree_branch"
const MCP_WORKTREE_NAME_KEY = "mcp_worktree_name"

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
  // Safety-net sweep (W1.1): one interval, owned by the engine, stopped
  // when no task is non-terminal.
  private sweepTimer: ReturnType<typeof setInterval> | undefined
  // Child sessions already attributed to a handle, plus recent misses.
  private readonly unknownSessions = new Map<string, number>()

  readonly maxConcurrentTasks: number
  readonly needsInputTimeoutMs: number
  readonly sweepIntervalMs: number
  readonly taskBudgetUsd: number
  private readonly now: () => number
  private readonly onWorktreeCleanup: (input: {
    handle: string
    sessionID: string
    worktreePath?: string
    disposition?: WorktreeReleaseDisposition
  }) => void | Promise<void>
  private readonly eventQueueBound: number
  private readonly worktrees: WorktreeManager | undefined
  // Per-task cost ledger (C6): handle -> (sessionID -> cumulative USD).
  // Mirrors the Jev per-session budget accounting pattern — session.cost
  // events carry cumulative totals, so the task spend is the sum of the
  // per-session high-water marks. Pruned when the task settles.
  private readonly costLedger = new Map<string, Map<string, number>>()

  constructor(
    private readonly client: EngineSessionClient,
    private readonly lookup: EngineSessionLookup,
    eventSource: EngineEventSource,
    opts: TaskEngineOptions,
  ) {
    this.maxConcurrentTasks = opts.maxConcurrentTasks
    this.needsInputTimeoutMs = opts.needsInputTimeoutMs ?? DEFAULT_NEEDS_INPUT_TIMEOUT_MS
    this.sweepIntervalMs = Math.max(opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS, MIN_SWEEP_INTERVAL_MS)
    this.now = opts.now ?? Date.now
    this.onWorktreeCleanup = opts.onWorktreeCleanup ?? (() => {})
    this.eventQueueBound = opts.eventQueueBound ?? DEFAULT_EVENT_QUEUE_BOUND
    this.worktrees = opts.worktrees
    this.taskBudgetUsd = opts.taskBudgetUsd ?? DEFAULT_TASK_BUDGET_USD
    this.unsubscribe = eventSource.subscribe((event) => this.enqueue(event))
  }

  get droppedEventCount(): number {
    return this.droppedEvents
  }

  get sweepActive(): boolean {
    return this.sweepTimer !== undefined
  }

  close(): void {
    this.closed = true
    this.unsubscribe()
    this.stopSweepTimer()
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

  // Write-capable means it can mutate the shared checkout: any policy
  // past `reject`. Used by the C2 shared-writer guard below.
  private static isWriteCapable(record: Pick<TaskRecord, "isolation" | "permission">): boolean {
    return record.isolation === "shared" && record.permission !== "reject"
  }

  private activeSharedWriter(): TaskRecord | undefined {
    for (const record of this.records.values()) {
      if (record.status === "cancelled" || record.status === "done" || record.status === "failed") continue
      if (TaskEngine.isWriteCapable(record)) return record
    }
    return undefined
  }

  async start(input: TaskStartInput): Promise<TaskRecord> {
    const permission = input.permission ?? "reject"
    const isolation = input.isolation ?? "shared"
    const budgetUsd = input.budgetUsd ?? this.taskBudgetUsd
    if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
      throw new Error(`task budget must be a non-negative USD number, got ${String(input.budgetUsd)}`)
    }
    // C2 shared-writer guard: at most one write-capable task runs in the
    // shared checkout. Read-only (reject) tasks never collide.
    if (TaskEngine.isWriteCapable({ isolation, permission })) {
      const active = this.activeSharedWriter()
      if (active) throw new SharedWriteConflictError(active.handle)
    }
    // C2 worktree allocation happens BEFORE session creation so a name
    // collision rejects without leaving an orphan session behind. Without
    // a configured manager the request fails closed.
    let worktree: TaskWorktree | undefined
    if (isolation === "worktree") {
      if (!this.worktrees) throw new Error('isolation "worktree" is not configured on this server; retry with isolation "shared"')
      const allocated = await this.worktrees.allocate({
        ...(input.worktreeName !== undefined ? { name: input.worktreeName } : {}),
      })
      worktree = { name: allocated.name, directory: allocated.directory, branch: allocated.branch }
    }
    // Opaque high-entropy handle (B9/§8.2), never the raw ses_ id. Minted
    // before creation so it can ride along in the creation metadata (E0).
    const handle = newTaskHandle()
    let created: { id: string }
    try {
      created = await this.client.createSession({
        title: input.prompt.split("\n")[0]?.slice(0, 80) || "mcp task",
        metadata: {
          origin: MCP_ORIGIN,
          mcp_client: input.mcpClient ?? "unknown",
          mcp_handle: handle,
          mcp_state: this.runningSlotsUsed() >= this.maxConcurrentTasks ? QUEUED_STATE_VALUE : "running",
          ...(worktree !== undefined
            ? {
                [MCP_WORKTREE_KEY]: worktree.directory,
                [MCP_WORKTREE_BRANCH_KEY]: worktree.branch,
                [MCP_WORKTREE_NAME_KEY]: worktree.name,
              }
            : {}),
        },
        // Creation-time agent/model/ruleset passthrough (E1): the policy
        // holds from session.create even when nobody polls.
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.permissionRuleset !== undefined ? { permission: input.permissionRuleset } : {}),
        // C2: the session is rooted at the worktree checkout.
        ...(worktree !== undefined ? { directory: worktree.directory } : {}),
      })
    } catch (error) {
      // Don't orphan the checkout when session creation fails.
      if (worktree !== undefined) await this.releaseWorktree(worktree.directory).catch(() => {})
      throw error
    }
    const at = this.now()
    const record: TaskRecord = {
      handle,
      sessionID: created.id,
      status: "running",
      mcpClient: input.mcpClient ?? "unknown",
      permission,
      isolation,
      createdAt: at,
      updatedAt: at,
      promptIndex: 0,
      cost: 0,
      budgetUsd,
    }
    if (input.agent !== undefined) record.agent = input.agent
    if (input.model !== undefined) record.model = input.model
    if (worktree !== undefined) record.worktree = worktree
    this.records.set(record.handle, record)
    this.sessionToHandle.set(record.sessionID, record.handle)

    // Repair write for ports that do not persist creation metadata
    // verbatim: the handle↔session binding is what rehydrate matches on
    // (E2). Best-effort — the live record table stays authoritative.
    await this.client
      .writeMetadata({
        sessionID: record.sessionID,
        metadata: {
          [MCP_HANDLE_KEY]: handle,
          ...(worktree !== undefined
            ? {
                [MCP_WORKTREE_KEY]: worktree.directory,
                [MCP_WORKTREE_BRANCH_KEY]: worktree.branch,
                [MCP_WORKTREE_NAME_KEY]: worktree.name,
              }
            : {}),
        },
        ...this.dirForRecord(record),
      })
      .catch(() => {})

    if (this.runningSlotsUsed() > this.maxConcurrentTasks) {
      this.queuedInputs.set(record.handle, input)
      await this.client.writeMetadata({
        sessionID: record.sessionID,
        metadata: { [QUEUED_STATE_KEY]: QUEUED_STATE_VALUE },
      })
      this.ensureSweepTimer()
      return this.patch(record.handle, { status: "queued" })
    }
    await this.launch(record.handle, input)
    this.ensureSweepTimer()
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
      await this.client.promptAsync({ sessionID: record.sessionID, prompt: reply.message, ...this.dirForRecord(record) })
      return this.patch(handle, { status: "running", promptIndex: record.promptIndex + 1 })
    }
    this.clearNeedsInputTimer(handle)
    if (pending.kind === "permission") {
      // Caller decisions never grant beyond policy: under `reject` every
      // approval collapses to reject. No string equality on free text —
      // the typed `decision` field is the only signal.
      const granted = reply.decision === "approve" && record.permission !== "reject" ? "once" : "reject"
      await this.client.replyPermission({
        sessionID: record.sessionID,
        requestID: pending.requestID,
        reply: granted,
        ...this.dirForRecord(record),
      })
    } else {
      if (reply.decision === "reject") {
        await this.client.rejectQuestion({
          sessionID: record.sessionID,
          requestID: pending.requestID,
          ...this.dirForRecord(record),
        })
      } else {
        if (!reply.message) throw new Error("task_reply needs message to answer the pending question")
        await this.client.replyQuestion({
          sessionID: record.sessionID,
          requestID: pending.requestID,
          message: reply.message,
          ...this.dirForRecord(record),
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
    await this.client.abort({ sessionID: record.sessionID, ...this.dirForRecord(record) }).catch(() => {})
    await this.settleWorktree(handle, true)
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
      cost: 0,
      budgetUsd: this.taskBudgetUsd,
    }
    // A restarted process recovers the worktree binding from the metadata
    // the engine wrote at start (same E2 pattern as mcp_handle).
    const worktreeDir = metadata[MCP_WORKTREE_KEY]
    const worktreeBranch = metadata[MCP_WORKTREE_BRANCH_KEY]
    const worktreeName = metadata[MCP_WORKTREE_NAME_KEY]
    if (worktreeDir && worktreeBranch && worktreeName) {
      record.isolation = "worktree"
      record.worktree = { name: worktreeName, directory: worktreeDir, branch: worktreeBranch }
    }
    this.records.set(handle, record)
    this.sessionToHandle.set(sessionID, handle)
    await this.refresh(handle)
    this.updateSweepTimer()
    return this.get(handle)
  }

  private patch(handle: string, patch: Partial<TaskRecord>): TaskRecord {
    const record = this.records.get(handle)
    if (!record) throw new UnknownTaskError(handle)
    const next: TaskRecord = { ...record, ...patch, updatedAt: this.now() }
    this.records.set(handle, next)
    this.notifyStateWaiters(handle, next)
    this.updateSweepTimer()
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
    const dir = this.dirForRecord(record)
    const before = await this.client.messages({ sessionID: record.sessionID, ...dir })
    await this.client.promptAsync({
      sessionID: record.sessionID,
      prompt: input.prompt,
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...dir,
    })
    this.patch(handle, { status: "running", promptIndex: before.length })
    await this.refresh(handle)
  }

  // Per-task SDK root (C2): the allocated worktree path, or nothing (the
  // server default) for shared tasks. Spread into every port call.
  private dirForRecord(record: TaskRecord): { directory: string } | Record<string, never> {
    return record.worktree !== undefined ? { directory: record.worktree.directory } : {}
  }

  private dirForHandle(handle: string): { directory: string } | Record<string, never> {
    const record = this.records.get(handle)
    return record ? this.dirForRecord(record) : {}
  }

  private async releaseWorktree(directory: string): Promise<WorktreeReleaseDisposition | undefined> {
    if (!this.worktrees) return undefined
    try {
      return await this.worktrees.release(directory)
    } catch {
      return undefined
    }
  }

  // Terminal worktree settlement (C2): release the checkout — clean ones
  // are removed, dirty ones preserved — then report through the owner
  // hook. Best-effort: git failures never rewrite the task's terminal
  // state. `notify` preserves the historical cancel-only hook for shared
  // tasks; worktree tasks always notify so the owner learns the
  // disposition. The cost ledger is pruned on every terminal path.
  private async settleWorktree(handle: string, notify: boolean): Promise<void> {
    const record = this.records.get(handle)
    this.costLedger.delete(handle)
    const directory = record?.worktree?.directory
    if (!directory) {
      if (notify && record) await this.onWorktreeCleanup({ handle, sessionID: record.sessionID })
      return
    }
    const disposition = await this.releaseWorktree(directory)
    if (notify && record) {
      await this.onWorktreeCleanup({
        handle,
        sessionID: record.sessionID,
        worktreePath: directory,
        ...(disposition !== undefined ? { disposition } : {}),
      })
    }
  }

  private async dequeueNext(): Promise<void> {
    if (this.runningSlotsUsed() >= this.maxConcurrentTasks) return
    for (const [handle] of this.records) {
      const queued = this.queuedInputs.get(handle)
      if (!queued) continue
      this.queuedInputs.delete(handle)
      const record = this.get(handle)
      await this.client.writeMetadata({
        sessionID: record.sessionID,
        metadata: { [QUEUED_STATE_KEY]: "running" },
        ...this.dirForRecord(record),
      })
      await this.launch(handle, queued)
      return
    }
  }

  private hasNonTerminalTasks(): boolean {
    for (const record of this.records.values()) {
      if (record.status === "queued" || record.status === "running" || record.status === "needs_input") return true
    }
    return false
  }

  private ensureSweepTimer(): void {
    if (this.closed || this.sweepTimer !== undefined || !this.hasNonTerminalTasks()) return
    this.sweepTimer = setInterval(() => {
      void this.sweepAll()
    }, this.sweepIntervalMs)
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref()
  }

  private stopSweepTimer(): void {
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
  }

  private updateSweepTimer(): void {
    if (!this.hasNonTerminalTasks()) this.stopSweepTimer()
    else this.ensureSweepTimer()
  }

  // Safety-net sweep (W1.1): refresh every active handle, then dequeue.
  // Events drive the common path; this only covers missed SSE. Stops
  // itself when nothing is non-terminal.
  private async sweepAll(): Promise<void> {
    if (this.closed) return
    for (const [handle, record] of [...this.records]) {
      if (this.closed) return
      if (record.status !== "running" && record.status !== "needs_input") continue
      try {
        await this.refresh(handle)
      } catch {
        // Next handle; the following sweep retries this one.
      }
    }
    if (this.closed) return
    try {
      await this.dequeueNext()
    } catch {
      // Retry on the next sweep.
    }
    this.updateSweepTimer()
  }

  // Attribute a child (subagent) session to its root task handle (W1.1).
  // Hits are cached in sessionToHandle; misses in a bounded TTL map so
  // foreign sessions on a shared server cost one tree walk per TTL.
  private async resolveChildHandle(sessionID: string): Promise<string | undefined> {
    const at = this.now()
    const negativeAt = this.unknownSessions.get(sessionID)
    if (negativeAt !== undefined && at - negativeAt < UNKNOWN_SESSION_TTL_MS) return undefined
    if (typeof this.client.listChildren !== "function") return undefined
    for (const record of this.records.values()) {
      if (record.status === "cancelled" || record.status === "done" || record.status === "failed") continue
      if (record.sessionID === sessionID) {
        this.sessionToHandle.set(sessionID, record.handle)
        this.unknownSessions.delete(sessionID)
        return record.handle
      }
      let children: string[] = []
      try {
        children = await this.client.listChildren({ sessionID: record.sessionID, ...this.dirForRecord(record) })
      } catch {
        continue
      }
      if (children.includes(sessionID)) {
        this.sessionToHandle.set(sessionID, record.handle)
        this.unknownSessions.delete(sessionID)
        return record.handle
      }
    }
    this.unknownSessions.set(sessionID, at)
    if (this.unknownSessions.size > UNKNOWN_SESSION_BOUND) {
      const oldest = this.unknownSessions.keys().next()
      if (!oldest.done) this.unknownSessions.delete(oldest.value)
    }
    return undefined
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
      // Swallowed: expiry is best-effort (the sweep retries). Without the
      // catch a post-close expiry becomes an unhandled rejection.
      void this.expireNeedsInput(handle, pending.requestID).catch(() => {})
    }, delay)
    if (typeof timer.unref === "function") timer.unref()
    this.needsInputTimers.set(handle, timer)
  }

  private async expireNeedsInput(handle: string, requestID: string): Promise<void> {
    if (this.closed) return
    const record = this.records.get(handle)
    if (!record || record.pendingQuestion?.requestID !== requestID) return
    const pending = record.pendingQuestion
    if (pending.kind === "permission") {
      await this.client.replyPermission({
        sessionID: record.sessionID,
        requestID: pending.requestID,
        reply: "reject",
        ...this.dirForHandle(handle),
      })
    } else {
      await this.client.rejectQuestion({
        sessionID: record.sessionID,
        requestID: pending.requestID,
        ...this.dirForHandle(handle),
      })
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
        if (!event) continue
        // One bad event (session deleted mid-flight, connection reset)
        // must neither kill the loop nor surface as an unhandled
        // rejection: the sweep retries whatever was missed.
        try {
          await this.apply(event)
        } catch {
          // Dropped by design; see droppedEvents for the bounded queue.
        }
      }
    } finally {
      this.draining = false
    }
  }

  private async apply(event: EngineEvent): Promise<void> {
    let handle = this.sessionToHandle.get(event.sessionID)
    if (!handle) {
      const resolved = await this.resolveChildHandle(event.sessionID)
      if (!resolved) return
      handle = resolved
    }
    const record = this.records.get(handle)
    if (!record || record.status === "cancelled" || record.status === "done" || record.status === "failed") return

    switch (event.type) {
      case "session.error":
        this.clearNeedsInputTimer(handle)
        this.queuedInputs.delete(handle)
        this.patch(handle, { status: "failed", error: event.message, pendingQuestion: undefined })
        await this.settleWorktree(handle, record.worktree !== undefined)
        await this.dequeueNext()
        return
      case "session.cost": {
        // C6: accumulate cumulative per-session totals into the task spend.
        // Non-finite or negative payloads are ignored, never trusted.
        if (!Number.isFinite(event.cost) || event.cost < 0) return
        let sessions = this.costLedger.get(handle)
        if (!sessions) {
          sessions = new Map<string, number>()
          this.costLedger.set(handle, sessions)
        }
        sessions.set(event.sessionID, event.cost)
        let total = 0
        for (const value of sessions.values()) total += value
        if (this.records.get(handle)?.cost !== total) this.patch(handle, { cost: total })
        if (total > record.budgetUsd) await this.abortOverBudget(handle, total)
        return
      }
      case "permission.asked":
        if (record.permission === "reject") {
          await this.client.replyPermission({
            sessionID: record.sessionID,
            requestID: event.request.requestID,
            reply: "reject",
            ...this.dirForHandle(handle),
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
    const dir = this.dirForRecord(record)
    const pending = await this.client.pending({ sessionID: record.sessionID, ...dir })
    const first = pending[0]
    if (first) {
      if (first.kind === "permission" && record.permission === "reject") {
        await this.client.replyPermission({
          sessionID: record.sessionID,
          requestID: first.requestID,
          reply: "reject",
          ...dir,
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
    const status = await this.client.sessionStatus({ sessionID: record.sessionID, ...dir })
    if (status === "failed") {
      this.clearNeedsInputTimer(handle)
      this.queuedInputs.delete(handle)
      this.patch(handle, { status: "failed", pendingQuestion: undefined })
      await this.settleWorktree(handle, record.worktree !== undefined)
      await this.dequeueNext()
      return
    }
    if (status === "busy" || status === "retry") {
      if (record.status !== "needs_input") this.patch(handle, { status: "running" })
      return
    }
    // Idle: done only with an assistant message newer than the prompt.
    const messages = await this.client.messages({ sessionID: record.sessionID, ...dir })
    const fresh = messages.slice(record.promptIndex).some((msg) => msg.role === "assistant")
    if (!fresh) {
      if (record.status !== "queued") this.patch(handle, { status: "running" })
      return
    }
    this.clearNeedsInputTimer(handle)
    this.queuedInputs.delete(handle)
    this.patch(handle, { status: "done", pendingQuestion: undefined })
    await this.settleWorktree(handle, record.worktree !== undefined)
    await this.client.writeMetadata({ sessionID: record.sessionID, metadata: { [QUEUED_STATE_KEY]: "done" }, ...dir })
    await this.dequeueNext()
  }

  // C6 budget trip: abort the session, fail the task with the BUDGET code,
  // settle the worktree (dirty output is preserved), and free the slot.
  private async abortOverBudget(handle: string, total: number): Promise<void> {
    const record = this.records.get(handle)
    if (!record || record.status === "cancelled" || record.status === "done" || record.status === "failed") return
    this.clearNeedsInputTimer(handle)
    this.queuedInputs.delete(handle)
    await this.client.abort({ sessionID: record.sessionID, ...this.dirForRecord(record) }).catch(() => {})
    this.patch(handle, {
      status: "failed",
      errorCode: "BUDGET",
      error: `task exceeded its USD cap of $${record.budgetUsd} (spent $${total.toFixed(4)})`,
      pendingQuestion: undefined,
    })
    await this.settleWorktree(handle, record.worktree !== undefined)
    await this.dequeueNext()
  }
}

export * as McpTaskEngine from "./task-engine"
