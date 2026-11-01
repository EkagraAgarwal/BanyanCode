// Task engine for the BanyanCode MCP delegation server.
//
// A task is a normal v2 session tagged with BanyanCode metadata, so it keeps
// running when the MCP client disconnects and survives a server restart (v2
// session storage + claimed-execution recovery). Handles are opaque
// `btask_<hex>` strings mapped to session IDs; they are rehydrated from
// session metadata, never from process memory alone.
//
// Concurrency, budget, stuck detection and checkup digests live here; the MCP
// layer (tools-task.ts) only formats these results. Plain async: the MCP
// process is not an Effect runtime, and the same rules apply as in v1 — one
// bounded event queue, one drain loop, no per-event fibers.

import {
  emptyDigest,
  encodeCursor,
  foldDigest,
  summarizeDigest,
  type DigestState,
  type DigestSummary,
  type DurableEvent,
} from "./digest"
import { detectStuck, suggestCheckupSeconds } from "./stuck"
import { evaluateBudget, type Budget } from "./budget"
import path from "node:path"
import { newTaskHandle } from "./task-handle"
import { BUILTIN_PROFILE_NAMES, autoDecision, decide, profileRules, resolveProfile } from "./autonomy"
import type { EngineEvent } from "./events"
import { SYNTHETIC_AGGREGATE, transcriptEvents, type TranscriptMessage } from "./transcript"
import type { FormSummary, PermissionRequest, SessionPort, SessionSummary } from "./session-client"
import type { ResolvedConfig } from "./config"

export type TaskStatus = "queued" | "running" | "needs_input" | "done" | "failed" | "cancelled"

export type TaskPhase = "queued" | "starting" | "executing" | "waiting_input" | "finished"

export type PendingAsk = {
  kind: "permission" | "question"
  id: string
  title: string
  detail?: string
  askedAt: number
  /** Session that owns the ask: a subagent session answers on its own ID. */
  sessionID?: string
}

export type TaskWorktree = {
  directory: string
  projectID: string
  /** True when the engine created the checkout and must remove it on settle. */
  created: boolean
}

export type TaskRecord = {
  handle: string
  sessionID: string
  parentHandle?: string
  status: TaskStatus
  phase: TaskPhase
  agent?: string
  model?: string
  autonomy: string
  isolation: "shared" | "worktree"
  worktree?: TaskWorktree
  mcpClient: string
  createdAt: number
  updatedAt: number
  launchedAt?: number
  prompt: string
  pending: PendingAsk[]
  error?: string
  errorCode?: string
  cost: number
  tokens: { input: number; output: number }
  budget: Budget
  digest: DigestState
  /** Durable events captured live since the last checkup folded them. */
  live: DurableEvent[]
  /** Events dropped because the live buffer hit its bound. */
  liveDropped: number
  lastActivityAt?: number
  lastCheckupAt?: number
  lastCheckupSeq: number
  terminalReportedAt?: number
  maxSubagents?: number
}

export type TaskStartInput = {
  prompt: string
  agent?: string
  model?: string
  worktree?: "new" | "shared" | string
  autonomy?: string
  maxSubagents?: number
  budget?: { max_steps?: number; max_cost?: number; timeout_s?: number }
  mcpClient?: string
  parentHandle?: string
  directory?: string
}

export type ReplyInput = {
  decision?: "approve" | "reject"
  message?: string
  delivery?: "steer" | "queue"
  requestID?: string
}

export type CheckupTaskReport = {
  task_id: string
  status: TaskStatus
  phase: TaskPhase
  agent?: string
  model?: string
  progress: DigestSummary
  pending: Array<{ id: string; kind: "permission" | "question"; title: string; age_s: number }>
  files_changed: number
  cost: number
  tokens: { input: number; output: number }
  stuck?: { kind: "no_progress" | "loop"; detail: string }
  next_checkup_in_s?: number
  budget: { max_steps: number; max_cost: number; timeout_s?: number; steps: number }
}

export type CheckupReport = {
  now: number
  cursor: string
  tasks: CheckupTaskReport[]
  terminal: Array<{ task_id: string; status: TaskStatus; error?: string; error_code?: string }>
  summary: { active: number; needs_input: number; done: number; failed: number }
}

export type ResultDetail = "summary" | "diff" | "transcript"

export type TaskResult = {
  task_id: string
  status: TaskStatus
  detail: ResultDetail
  summary: {
    status: TaskStatus
    phase: TaskPhase
    cost: number
    tokens: { input: number; output: number }
    files_changed: number
    additions: number
    deletions: number
    steps: number
    tool_calls: number
    tool_failures: number
    last_text?: string
    error?: string
    error_code?: string
    worktree?: string
  }
  diff?: Array<{ file: string; status: string; additions: number; deletions: number; patch?: string }>
  transcript?: { messages: Array<{ role: string; text: string }>; cursor?: string; truncated: boolean }
}

export type TaskTreeNode = {
  task_id: string
  status: TaskStatus
  phase: TaskPhase
  agent?: string
  model?: string
  isolation: "shared" | "worktree"
  cost: number
  pending: number
  last_text?: string
  children: TaskTreeNode[]
}

export type TaskEngineOptions = {
  port: SessionPort
  config: ResolvedConfig
  root: string
  now?: () => number
  sweepIntervalMs?: number
  needsInputTimeoutMs?: number
  eventQueueBound?: number
}

const MCP_ORIGIN = "banyan-mcp"
const HANDLE_KEY = "banyan_task"
const PARENT_KEY = "banyan_parent"
const AUTONOMY_KEY = "banyan_autonomy"
const STATE_KEY = "banyan_state"
const BUDGET_KEY = "banyan_budget"
const CLIENT_KEY = "mcp_client"

const DEFAULT_SWEEP_INTERVAL_MS = 7_500
const MIN_SWEEP_INTERVAL_MS = 1_000
const DEFAULT_EVENT_QUEUE_BOUND = 1024
const REHYDRATE_LIST_LIMIT = 200
const REHYDRATE_CACHE_MS = 10_000
const TRANSCRIPT_PAGE_DEFAULT = 40
const LIVE_BUFFER_BOUND = 256
const TRANSCRIPT_PAGE_SIZE = 100
const TRANSCRIPT_PAGE_CAP = 10

export class UnknownTaskError extends Error {
  readonly code = "UNKNOWN_TASK" as const
  constructor(handle: string) {
    super(`unknown or expired task handle: ${handle}. Start a new task with banyan_task_start.`)
  }
}

export class SharedWriteConflictError extends Error {
  readonly code = "SHARED_WRITE_CONFLICT" as const
  constructor(activeHandle: string) {
    super(
      `a write-capable shared task (${activeHandle}) is already active. ` +
        `Retry with worktree: "new" for an isolated checkout.`,
    )
  }
}

export class McpKilledError extends Error {
  readonly code = "MCP_KILLED" as const
  constructor() {
    super("the BanyanCode MCP server kill switch is engaged (BANYANCODE_MCP_KILL)")
  }
}

type Waiter = {
  fromStatus?: TaskStatus
  timer: ReturnType<typeof setTimeout>
  resolve: (record: TaskRecord) => void
}

export class TaskEngine {
  private readonly records = new Map<string, TaskRecord>()
  private readonly sessionToHandle = new Map<string, string>()
  private readonly queued = new Map<string, TaskStartInput>()
  private readonly waiters = new Map<string, Set<Waiter>>()
  private readonly eventQueue: EngineEvent[] = []
  private readonly needsInputTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly unknownSessions = new Map<string, number>()
  private readonly transitions = new Set<(record: TaskRecord) => void>()
  private draining = false
  private closed = false
  private droppedEvents = 0
  private sweepTimer: ReturnType<typeof setInterval> | undefined
  private budgetTimer: ReturnType<typeof setInterval> | undefined
  private rehydratedAt: number | undefined
  private readonly unsubscribe: () => void
  readonly now: () => number
  readonly sweepIntervalMs: number
  readonly needsInputTimeoutMs: number
  private readonly eventQueueBound: number
  readonly config: ResolvedConfig
  readonly root: string
  private readonly port: SessionPort

  constructor(options: TaskEngineOptions) {
    this.port = options.port
    this.config = options.config
    this.root = options.root
    this.now = options.now ?? Date.now
    this.sweepIntervalMs = Math.max(options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS, MIN_SWEEP_INTERVAL_MS)
    this.needsInputTimeoutMs = options.needsInputTimeoutMs ?? options.config.needsInputTimeoutSeconds * 1000
    this.eventQueueBound = options.eventQueueBound ?? DEFAULT_EVENT_QUEUE_BOUND
    this.unsubscribe = this.port.subscribeEvents((event) => this.enqueue(event))
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
    this.port.dispose?.()
    this.stopSweepTimer()
    this.stopBudgetTimer()
    for (const timer of this.needsInputTimers.values()) clearTimeout(timer)
    this.needsInputTimers.clear()
    for (const [, owned] of this.waiters) {
      for (const waiter of owned) {
        clearTimeout(waiter.timer)
        waiter.resolve(this.records.values().next().value ?? ({} as TaskRecord))
      }
    }
    this.waiters.clear()
  }

  onTransition(listener: (record: TaskRecord) => void): () => void {
    this.transitions.add(listener)
    return () => {
      this.transitions.delete(listener)
    }
  }

  get(handle: string): TaskRecord {
    const record = this.records.get(handle)
    if (!record) throw new UnknownTaskError(handle)
    return { ...record, pending: [...record.pending], digest: { ...record.digest } }
  }

  has(handle: string): boolean {
    return this.records.has(handle)
  }

  list(): TaskRecord[] {
    return [...this.records.values()].map((record) => ({
      ...record,
      pending: [...record.pending],
      digest: { ...record.digest },
    }))
  }

  runningSlots(): number {
    return [...this.records.values()].filter((record) => record.status === "running" || record.status === "needs_input").length
  }

  // --- start / spawn --------------------------------------------------------

  async start(input: TaskStartInput): Promise<TaskRecord> {
    if (this.closed) throw new McpKilledError()
    assertAllowed(this.config, input)
    this.assertKnownProfile(input.autonomy)
    const profile = resolveProfile(this.config.autonomy, input.autonomy)
    return this.createWithIsolation(input, profile.name, undefined)
  }

  private assertKnownProfile(name: string | undefined): void {
    if (name === undefined) return
    if (this.config.autonomy.profiles[name] !== undefined) return
    if (BUILTIN_PROFILE_NAMES.includes(name)) return
    throw new Error(
      `unknown autonomy profile "${name}"; known profiles: ` +
        [...BUILTIN_PROFILE_NAMES, ...Object.keys(this.config.autonomy.profiles)].join(", "),
    )
  }

  private async createWithIsolation(
    input: TaskStartInput,
    autonomyName: string,
    parent: TaskRecord | undefined,
  ): Promise<TaskRecord> {
    const requestedWorktree = input.worktree ?? (parent === undefined ? this.config.worktree : "shared")
    const wantsWorktree = requestedWorktree === "new" || (requestedWorktree !== "shared" && requestedWorktree !== "new")
    const profile = resolveProfile(this.config.autonomy, autonomyName)
    // Only an unconditional allow makes a shared task a writer: `ask` cannot
    // escalate while nobody is watching, and `deny` clearly cannot.
    const writeCapable = decide(profile.profile, this.root, { action: "edit", resources: [this.root] }) === "allow"
    if (!wantsWorktree && writeCapable && this.activeSharedWriter() !== undefined) {
      throw new SharedWriteConflictError(this.activeSharedWriter()!.handle)
    }
    let worktree: TaskWorktree | undefined
    if (wantsWorktree) worktree = await this.allocateWorktree(requestedWorktree)
    const handle = newTaskHandle()
    const now = this.now()
    const budget = {
      maxSteps: parseMaxSteps(input.budget?.max_steps),
      maxCost: input.budget?.max_cost ?? this.config.taskBudgetUsd,
      timeoutMs: (input.budget?.timeout_s ?? 0) * 1000,
    }
    let created: { id: string }
    try {
      created = await this.port.createSession({
        title: sessionTitle(input.prompt),
        ...(parent !== undefined ? { parentID: parent.sessionID } : {}),
        metadata: {
          origin: MCP_ORIGIN,
          [HANDLE_KEY]: handle,
          [AUTONOMY_KEY]: profile.name,
          [STATE_KEY]: "running",
          [CLIENT_KEY]: input.mcpClient ?? "unknown",
          ...(parent !== undefined ? { [PARENT_KEY]: parent.handle } : {}),
          ...(worktree !== undefined ? { banyan_worktree: worktree.directory } : {}),
          ...(input.budget !== undefined ? { [BUDGET_KEY]: JSON.stringify(input.budget) } : {}),
        },
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        permissions: profileRules(profile.profile, this.root),
        // Sessions are location-scoped: without this the task would run in the
        // background service's cwd ($HOME) instead of the requested project.
        directory: worktree?.directory ?? this.root,
      })
    } catch (error) {
      if (worktree !== undefined) await this.releaseWorktree(worktree).catch(() => undefined)
      throw error
    }
    const record: TaskRecord = {
      handle,
      sessionID: created.id,
      status: "queued",
      phase: "queued",
      autonomy: profile.name,
      isolation: worktree !== undefined ? "worktree" : "shared",
      mcpClient: input.mcpClient ?? "unknown",
      createdAt: now,
      updatedAt: now,
      prompt: input.prompt,
      pending: [],
      cost: 0,
      tokens: { input: 0, output: 0 },
      budget,
      digest: emptyDigest(),
      live: [],
      liveDropped: 0,
      lastCheckupSeq: 0,
    }
    if (parent !== undefined) record.parentHandle = parent.handle
    if (input.agent !== undefined) record.agent = input.agent
    if (input.model !== undefined) record.model = input.model
    if (worktree !== undefined) record.worktree = worktree
    if (input.maxSubagents !== undefined) record.maxSubagents = input.maxSubagents
    this.records.set(handle, record)
    this.sessionToHandle.set(record.sessionID, handle)
    // Repair write for endpoints that do not persist creation metadata
    // verbatim: the handle↔session binding is what rehydrate matches on.
    await this.port
      .updateMetadata({ sessionID: record.sessionID, metadata: { [HANDLE_KEY]: handle } })
      .catch(() => undefined)

    if (this.runningSlots() >= this.config.maxConcurrentTasks) {
      this.queued.set(handle, { ...input, parentHandle: record.parentHandle, worktree: undefined })
      await this.port
        .updateMetadata({ sessionID: record.sessionID, metadata: { [STATE_KEY]: "queued" } })
        .catch(() => undefined)
      this.ensureSweepTimer()
      this.ensureBudgetTimer()
      return this.patch(handle, {})
    }
    await this.launch(handle)
    this.ensureSweepTimer()
    this.ensureBudgetTimer()
    return this.get(handle)
  }

  async spawn(parentHandle: string, subtasks: TaskStartInput[]): Promise<TaskRecord[]> {
    if (this.closed) throw new McpKilledError()
    const parent = this.require(parentHandle)
    if (parent.status === "cancelled" || parent.status === "failed" || parent.status === "done") {
      throw new Error(`cannot spawn subtasks under a ${parent.status} task`)
    }
    const cap = parent.maxSubagents ?? this.config.maxConcurrentTasks
    if (cap > 0 && subtasks.length > cap) {
      throw new Error(`spawn requested ${subtasks.length} subtasks but max_subagents is ${cap}`)
    }
    for (const subtask of subtasks) this.assertKnownProfile(subtask.autonomy)
    const created: TaskRecord[] = []
    for (const subtask of subtasks) {
      created.push(
        await this.createWithIsolation(
          {
            ...subtask,
            mcpClient: subtask.mcpClient ?? parent.mcpClient,
            autonomy: subtask.autonomy ?? parent.autonomy,
          },
          subtask.autonomy ?? parent.autonomy,
          parent,
        ),
      )
    }
    return created
  }

  private async launch(handle: string): Promise<void> {
    const record = this.get(handle)
    const before = await this.port.messagePage({ sessionID: record.sessionID, order: "desc", limit: 1 })
    const latest = before.items[0]
    try {
      await this.port.prompt({ sessionID: record.sessionID, text: record.prompt })
    } catch (error) {
      this.patch(handle, {
        status: "failed",
        phase: "finished",
        error: error instanceof Error ? error.message : String(error),
        errorCode: "LAUNCH_FAILED",
      })
      throw error
    }
    const launchedAt = this.now()
    this.patch(handle, {
      status: "running",
      phase: "executing",
      launchedAt: latest?.created !== undefined ? Math.min(launchedAt, latest.created) : launchedAt,
    })
    await this.port
      .updateMetadata({ sessionID: record.sessionID, metadata: { [STATE_KEY]: "running" } })
      .catch(() => undefined)
    await this.refresh(handle).catch(() => undefined)
  }

  // --- status / wait --------------------------------------------------------

  async status(handle: string): Promise<TaskRecord> {
    const record = this.require(handle)
    if (record.status === "running" || record.status === "queued") await this.refresh(handle).catch(() => undefined)
    return this.get(handle)
  }

  async waitForStateChange(handle: string, options: { fromStatus?: TaskStatus; timeoutMs?: number } = {}): Promise<TaskRecord> {
    const record = this.get(handle)
    const timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? 0))
    if (timeoutMs <= 0) return record
    if (options.fromStatus !== undefined && record.status !== options.fromStatus) return record
    return new Promise<TaskRecord>((resolve) => {
      const owned = this.waiters.get(handle) ?? new Set<Waiter>()
      this.waiters.set(handle, owned)
      const waiter: Waiter = {
        ...(options.fromStatus !== undefined ? { fromStatus: options.fromStatus } : {}),
        resolve,
        timer: setTimeout(() => {
          owned.delete(waiter)
          if (owned.size === 0) this.waiters.delete(handle)
          resolve(this.has(handle) ? this.get(handle) : record)
        }, timeoutMs),
      }
      if (typeof waiter.timer.unref === "function") waiter.timer.unref()
      owned.add(waiter)
    })
  }

  // --- checkup --------------------------------------------------------------

  async checkup(input: {
    cursor?: string
    cursorState: Record<string, number>
    taskIDs?: string[]
    maxTextChars?: number
    elicit?: (ask: PendingAsk, task: TaskRecord) => Promise<"allow" | "deny" | "skip">
  }): Promise<{ report: CheckupReport; cursor: Record<string, number> }> {
    await this.ensureRehydrated()
    const now = this.now()
    const selected =
      input.taskIDs !== undefined && input.taskIDs.length > 0
        ? input.taskIDs.map((id) => this.require(id))
        : [...this.records.values()]
    const cursorOut: Record<string, number> = { ...input.cursorState }
    const reports: CheckupTaskReport[] = []
    const terminal: CheckupReport["terminal"] = []
    let active = 0
    let needsInput = 0
    let done = 0
    let failed = 0

    for (const record of selected) {
      const current = this.has(record.handle) ? this.require(record.handle) : record
      if (current.status === "running" || current.status === "queued") {
        await this.refresh(current.handle).catch(() => undefined)
      }
      const after = input.cursorState[current.handle] ?? 0
      const drained = this.drainLive(current.handle)
      const events = await this.selectEvents(current.sessionID, after, drained)
      const delta = foldDigest(emptyDigest(), events)
      const nextCursor = nextCursorFrom(after, events)
      // Keep the cumulative digest for budget enforcement; failures here only
      // affect the step counter, never correctness of the status.
      this.patch(current.handle, {
        digest: foldDigest(this.records.get(current.handle)?.digest ?? emptyDigest(), events),
        lastCheckupSeq: nextCursor,
        lastCheckupAt: now,
      })
      cursorOut[current.handle] = nextCursor
      const latest = this.require(current.handle)
      await this.reconcilePending(latest, input.elicit).catch(() => undefined)
      const settled = this.require(current.handle)
      const lastEventAt = settled.lastActivityAt ?? settled.digest.lastEventAt
      const stuck = detectStuck({
        status: settled.status,
        lastEventAt,
        now,
        recentToolCalls: settled.digest.recentCalls,
      })
      const nextCheckup = suggestCheckupSeconds({
        status: settled.status,
        stuck,
        now,
        lastEventAt,
      })
      const budgetTrip = this.budgetTrip(settled)
      if (budgetTrip !== undefined) await this.cancelInternal(settled.handle, budgetTrip).catch(() => undefined)
      const final = this.get(settled.handle)
      if (final.status === "running" || final.status === "queued") active += 1
      if (final.status === "needs_input") needsInput += 1
      if (final.status === "done") done += 1
      if (final.status === "failed") failed += 1
      if (final.status === "done" || final.status === "failed" || final.status === "cancelled") {
        if (final.terminalReportedAt === undefined) {
          terminal.push({
            task_id: final.handle,
            status: final.status,
            ...(final.error !== undefined ? { error: final.error } : {}),
            ...(final.errorCode !== undefined ? { error_code: final.errorCode } : {}),
          })
          this.patch(final.handle, { terminalReportedAt: now })
        }
      }
      reports.push({
        task_id: final.handle,
        status: final.status,
        phase: final.phase,
        ...(final.agent !== undefined ? { agent: final.agent } : {}),
        ...(final.model !== undefined ? { model: final.model } : {}),
        progress: summarizeDigest(delta, { maxTextChars: input.maxTextChars ?? 200 }),
        pending: final.pending.map((ask) => ({
          id: ask.id,
          kind: ask.kind,
          title: ask.title,
          age_s: Math.max(0, Math.round((now - ask.askedAt) / 1000)),
        })),
        files_changed: final.digest.files.length,
        cost: Math.round(final.cost * 10_000) / 10_000,
        tokens: { ...final.tokens },
        ...(stuck !== undefined ? { stuck: { kind: stuck.kind, detail: stuck.detail } } : {}),
        ...(nextCheckup !== undefined ? { next_checkup_in_s: nextCheckup } : {}),
        budget: {
          max_steps: final.budget.maxSteps,
          max_cost: final.budget.maxCost,
          ...(final.budget.timeoutMs > 0 ? { timeout_s: Math.round(final.budget.timeoutMs / 1000) } : {}),
          steps: final.digest.steps,
        },
      })
      await this.maybeSettle(final.handle).catch(() => undefined)
    }
    this.updateSweepTimer()
    return {
      report: {
        now,
        cursor: encodeCursor(cursorOut),
        tasks: reports,
        terminal,
        summary: { active, needs_input: needsInput, done, failed },
      },
      cursor: cursorOut,
    }
  }

  private async fetchEvents(sessionID: string, after: number): Promise<DurableEvent[]> {
    const raw = await this.port.log({ sessionID, ...(after > 0 ? { after } : {}) })
    return (raw as unknown as DurableEvent[]).filter((event) => event.type !== "log.synced")
  }

  // Digest source preference:
  //  1. real durable log (only when the host runs Bus with persist: true);
  //  2. durable events captured live since the last checkup (the default host);
  //  3. synthetic events rebuilt from the transcript (restart history).
  // A positive cursor is a durable sequence, a negative one a transcript
  // ordinal; this keeps the two spaces from ever being compared.
  private async selectEvents(
    sessionID: string,
    after: number,
    live: readonly DurableEvent[],
  ): Promise<DurableEvent[]> {
    const logged = await this.fetchEvents(sessionID, after > 0 ? after : 0).catch(() => [] as DurableEvent[])
    if (logged.length > 0) return logged
    if (live.length > 0) return [...live]
    if (after > 0) return []
    const messages = await this.pageAll(sessionID).catch(() => [] as TranscriptMessage[])
    return transcriptEvents(messages, after < 0 ? -after : 0)
  }

  // Full transcript, paged. Bounded so a pathological session cannot stall a
  // checkup; the digest is still useful from the first pages.
  private async pageAll(sessionID: string): Promise<TranscriptMessage[]> {
    const messages: TranscriptMessage[] = []
    let cursor: string | undefined
    for (let page = 0; page < TRANSCRIPT_PAGE_CAP; page += 1) {
      // The server rejects a cursor combined with an explicit order, so the
      // first page sets the direction and later pages only carry the cursor.
      const response = await this.port.messagePage({
        sessionID,
        limit: TRANSCRIPT_PAGE_SIZE,
        ...(cursor === undefined ? { order: "asc" as const } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      })
      for (const message of response.items) {
        messages.push({
          type: message.type,
          created: message.created,
          ...(message.text !== undefined ? { text: message.text } : {}),
          ...(message.cost !== undefined ? { cost: message.cost } : {}),
          ...(message.tokens !== undefined ? { tokens: message.tokens } : {}),
          ...(message.tools !== undefined ? { tools: message.tools } : {}),
        })
      }
      if (response.next === undefined) break
      cursor = response.next
    }
    return messages
  }

  private pushLive(handle: string, event: DurableEvent): void {
    const record = this.records.get(handle)
    if (!record) return
    const live = [...record.live, event]
    let dropped = record.liveDropped
    if (live.length > LIVE_BUFFER_BOUND) {
      dropped += live.length - LIVE_BUFFER_BOUND
      live.splice(0, live.length - LIVE_BUFFER_BOUND)
    }
    const created = typeof event.created === "number" ? event.created : undefined
    this.records.set(handle, {
      ...record,
      live,
      liveDropped: dropped,
      ...(created !== undefined && (record.lastActivityAt === undefined || created > record.lastActivityAt)
        ? { lastActivityAt: created }
        : {}),
    })
  }

  private drainLive(handle: string): DurableEvent[] {
    const record = this.records.get(handle)
    if (!record || record.live.length === 0) return []
    const events = record.live
    this.records.set(handle, { ...record, live: [] })
    return events
  }

  // --- reply / cancel -------------------------------------------------------

  async reply(handle: string, input: ReplyInput): Promise<TaskRecord> {
    const record = this.require(handle)
    if (record.status === "cancelled" || record.status === "done" || record.status === "failed") return record
    await this.refresh(handle).catch(() => undefined)
    const current = this.require(handle)
    const ask = current.pending.find((item) => input.requestID === undefined || item.id === input.requestID)
    if (ask === undefined) {
      if (input.message === undefined || input.message === "") {
        throw new Error("task_reply needs a message when the task has no pending question")
      }
      await this.port.prompt({
        sessionID: current.sessionID,
        text: input.message,
        delivery: input.delivery ?? "queue",
        resume: true,
      })
      this.clearNeedsInputTimer(handle)
      return this.patch(handle, { status: "running", phase: "executing", pending: [] })
    }
    this.clearNeedsInputTimer(handle)
    const askSession = ask.sessionID ?? current.sessionID
    if (ask.kind === "permission") {
      const granted =
        input.decision === "approve" && this.config.permission !== "reject" ? "once" : "reject"
      await this.port.replyPermission({
        sessionID: askSession,
        requestID: ask.id,
        decision: granted,
        ...(input.message !== undefined ? { message: input.message } : {}),
      })
    } else if (input.decision === "reject") {
      await this.port.cancelForm({
        sessionID: askSession,
        formID: ask.id,
        ...(input.message !== undefined ? { message: input.message } : {}),
      })
    } else {
      if (input.message === undefined || input.message === "") {
        throw new Error("task_reply needs a message to answer a pending question")
      }
      const answer = await this.buildFormAnswer(askSession, ask.id, input.message)
      await this.port.replyForm({ sessionID: askSession, formID: ask.id, answer })
    }
    this.patch(handle, {
      status: "running",
      phase: "executing",
      pending: current.pending.filter((item) => item.id !== ask.id),
    })
    return this.get(handle)
  }

  // Question forms are answered from one free-text reply: every string field
  // receives the text, multiselects receive it as a single choice, booleans
  // parse common affirmatives.
  private async buildFormAnswer(
    sessionID: string,
    formID: string,
    message: string,
  ): Promise<Record<string, string | number | boolean | string[]>> {
    const detail = await this.port.formFields({ sessionID, formID })
    const answer: Record<string, string | number | boolean | string[]> = {}
    for (const field of detail.fields) {
      switch (field.type) {
        case "boolean":
          answer[field.key] = /^(y|yes|true|approve|ok|allow)$/i.test(message.trim())
          break
        case "number":
        case "integer": {
          const value = Number(message.trim())
          answer[field.key] = Number.isFinite(value) ? value : 0
          break
        }
        case "multiselect":
          answer[field.key] = [message]
          break
        case "external":
          break
        default:
          answer[field.key] = message
          break
      }
    }
    return answer
  }

  async cancel(handle: string): Promise<TaskRecord> {
    return this.cancelInternal(handle, undefined)
  }

  async cancelAll(): Promise<TaskRecord[]> {
    const out: TaskRecord[] = []
    for (const record of [...this.records.values()]) {
      if (record.status === "cancelled" || record.status === "done" || record.status === "failed") continue
      out.push(await this.cancelInternal(record.handle, undefined).catch(() => this.get(record.handle)))
    }
    return out
  }

  private async cancelInternal(handle: string, failure: { errorCode: string; error: string } | undefined): Promise<TaskRecord> {
    const record = this.require(handle)
    if (record.status === "cancelled" || record.status === "done" || record.status === "failed") return record
    this.clearNeedsInputTimer(handle)
    this.queued.delete(handle)
    await this.port.interrupt({ sessionID: record.sessionID }).catch(() => undefined)
    await this.port
      .updateMetadata({ sessionID: record.sessionID, metadata: { [STATE_KEY]: failure !== undefined ? "failed" : "cancelled" } })
      .catch(() => undefined)
    if (record.worktree !== undefined) await this.releaseWorktree(record.worktree).catch(() => undefined)
    this.patch(handle, {
      status: failure !== undefined ? "failed" : "cancelled",
      phase: "finished",
      pending: [],
      ...(record.worktree !== undefined ? { worktree: undefined } : {}),
      ...(failure !== undefined ? { errorCode: failure.errorCode, error: failure.error } : {}),
    })
    await this.dequeueNext().catch(() => undefined)
    return this.get(handle)
  }

  // --- result ---------------------------------------------------------------

  async result(handle: string, detail: ResultDetail, cursor?: string): Promise<TaskResult> {
    await this.refresh(handle).catch(() => undefined)
    let current = this.get(handle)
    // `result` must stand alone: if no checkup ran, rebuild the counters from
    // the transcript so steps/files/last-text are not reported as zero.
    if (current.digest.steps === 0 && current.digest.lastText === undefined) {
      const messages = await this.pageAll(current.sessionID).catch(() => [] as TranscriptMessage[])
      if (messages.length > 0) {
        this.patch(handle, { digest: foldDigest(current.digest, transcriptEvents(messages, 0)) })
        current = this.get(handle)
      }
    }
    const budgetChars = Math.max(400, this.config.resultMaxTokens * 4)
    const summary: TaskResult["summary"] = {
      status: current.status,
      phase: current.phase,
      cost: Math.round(current.cost * 10_000) / 10_000,
      tokens: { ...current.tokens },
      files_changed: current.digest.files.length,
      additions: 0,
      deletions: 0,
      steps: current.digest.steps,
      tool_calls: current.digest.toolCalls,
      tool_failures: current.digest.toolFailures,
    }
    if (current.digest.lastText !== undefined) {
      summary.last_text = clip(current.digest.lastText.trim(), Math.min(1_200, budgetChars / 2))
    }
    if (current.error !== undefined) summary.error = current.error
    if (current.errorCode !== undefined) summary.error_code = current.errorCode
    if (current.worktree !== undefined) summary.worktree = current.worktree.directory

    let diffResult: TaskResult["diff"]
    try {
      const diff = await this.port.diff({ sessionID: current.sessionID })
      // Diff is authoritative when non-empty; otherwise report the files the
      // digest saw the task touch (a run that reverted everything, or a
      // non-git project).
      summary.files_changed = diff.length > 0 ? diff.length : current.digest.files.length
      summary.additions = diff.reduce((total, file) => total + file.additions, 0)
      summary.deletions = diff.reduce((total, file) => total + file.deletions, 0)
      if (detail === "diff") {
        diffResult = []
        let used = 0
        for (const file of diff) {
          const patch = file.patch
          const remaining = budgetChars - used
          if (remaining <= 0) break
          diffResult.push({
            file: file.file,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            ...(patch !== undefined && patch !== "" ? { patch: clip(patch, Math.min(4_000, remaining)) } : {}),
          })
          used += Math.min(patch?.length ?? 0, 4_000)
        }
      }
    } catch {
      // Diff is best-effort (a deleted session or a non-git project).
    }

    const result: TaskResult = { task_id: current.handle, status: current.status, detail, summary }
    if (diffResult !== undefined) result.diff = diffResult
    if (detail === "transcript") {
      const page = await this.port.messagePage({
        sessionID: current.sessionID,
        limit: TRANSCRIPT_PAGE_DEFAULT,
        ...(cursor === undefined || cursor === "" ? { order: "asc" as const } : {}),
        ...(cursor !== undefined && cursor !== "" ? { cursor } : {}),
      })
      const messages: Array<{ role: string; text: string }> = []
      let used = 0
      let truncated = false
      for (const message of page.items) {
        const text = clip(message.text ?? "", 600)
        if (text === "") continue
        if (used + text.length > budgetChars) {
          truncated = true
          break
        }
        messages.push({ role: message.role ?? message.type, text })
        used += text.length
      }
      result.transcript = {
        messages,
        ...(page.next !== undefined ? { cursor: page.next } : {}),
        truncated,
      }
    }
    return result
  }

  // --- list tree ------------------------------------------------------------

  tree(): TaskTreeNode[] {
    const nodes = new Map<string, TaskTreeNode>()
    for (const record of this.records.values()) {
      const node: TaskTreeNode = {
        task_id: record.handle,
        status: record.status,
        phase: record.phase,
        ...(record.agent !== undefined ? { agent: record.agent } : {}),
        ...(record.model !== undefined ? { model: record.model } : {}),
        isolation: record.isolation,
        cost: Math.round(record.cost * 10_000) / 10_000,
        pending: record.pending.length,
        ...(record.digest.lastText !== undefined
          ? { last_text: clip(record.digest.lastText.trim(), 120) }
          : {}),
        children: [],
      }
      nodes.set(record.handle, node)
    }
    const roots: TaskTreeNode[] = []
    for (const record of this.records.values()) {
      const node = nodes.get(record.handle)!
      const parent = record.parentHandle !== undefined ? nodes.get(record.parentHandle) : undefined
      if (parent !== undefined) parent.children.push(node)
      else roots.push(node)
    }
    return roots
  }

  // --- rehydrate ------------------------------------------------------------

  async rehydrateAll(): Promise<TaskRecord[]> {
    const sessions = await this.port.listSessions({ limit: REHYDRATE_LIST_LIMIT })
    const out: TaskRecord[] = []
    for (const session of sessions) {
      const handle = session.metadata[HANDLE_KEY]
      const isBanyan = session.metadata.origin === MCP_ORIGIN
      if (!isBanyan && handle === undefined) continue
      const resolved = handle ?? newTaskHandle()
      if (!isBanyan) {
        await this.port.updateMetadata({ sessionID: session.id, metadata: { origin: MCP_ORIGIN } }).catch(() => undefined)
      }
      if (this.records.has(resolved)) continue
      out.push(await this.rebuild(session, resolved))
    }
    this.rehydratedAt = this.now()
    return out
  }

  async ensureRehydrated(): Promise<void> {
    if (this.rehydratedAt !== undefined && this.now() - this.rehydratedAt < REHYDRATE_CACHE_MS) return
    await this.rehydrateAll().catch(() => undefined)
  }

  async rehydrate(handle: string): Promise<TaskRecord> {
    if (this.records.has(handle)) return this.get(handle)
    await this.rehydrateAll()
    if (this.records.has(handle)) return this.get(handle)
    throw new UnknownTaskError(handle)
  }

  private async rebuild(session: SessionSummary, handle: string): Promise<TaskRecord> {
    const now = this.now()
    const queuedState = session.metadata[STATE_KEY] === "queued"
    const record: TaskRecord = {
      handle,
      sessionID: session.id,
      status: queuedState ? "queued" : statusFromSession(session),
      phase: queuedState ? "queued" : "executing",
      autonomy: session.metadata[AUTONOMY_KEY] ?? "supervised",
      isolation: session.metadata.banyan_worktree !== undefined ? "worktree" : "shared",
      mcpClient: session.metadata[CLIENT_KEY] ?? "unknown",
      createdAt: session.created > 0 ? session.created : now,
      updatedAt: session.updated > 0 ? session.updated : now,
      prompt: session.title ?? "",
      pending: [],
      cost: session.cost,
      tokens: { input: session.tokens.input, output: session.tokens.output },
      budget: budgetFromMetadata(session.metadata[BUDGET_KEY], this.config.taskBudgetUsd),
      digest: emptyDigest(),
      live: [],
      liveDropped: 0,
      lastCheckupSeq: 0,
    }
    if (session.parentID !== undefined) {
      const parentHandle = session.metadata[PARENT_KEY]
      if (parentHandle !== undefined) record.parentHandle = parentHandle
    }
    if (session.agent !== undefined) record.agent = session.agent
    if (session.model !== undefined) record.model = session.model
    const worktree = session.metadata.banyan_worktree
    if (worktree !== undefined) {
      const project = await this.port
        .projects()
        .then((list) => list.find((item) => session.location !== undefined && samePath(item.canonical, session.location)))
        .catch(() => undefined)
      if (project !== undefined) record.worktree = { directory: worktree, projectID: project.id, created: false }
    }
    if (session.outcome === "failed") record.status = "failed"
    this.records.set(handle, record)
    this.sessionToHandle.set(session.id, handle)
    await this.refresh(handle).catch(() => undefined)
    this.ensureSweepTimer()
    this.ensureBudgetTimer()
    return this.get(handle)
  }

  // --- refresh / events -----------------------------------------------------

  private async refresh(handle: string): Promise<void> {
    const record = this.records.get(handle)
    if (!record) return
    if (record.status === "cancelled" || record.status === "failed") return
    const session = await this.port.getSession({ sessionID: record.sessionID })
    if (session === undefined) {
      this.patch(handle, {
        status: "failed",
        phase: "finished",
        error: "the session backing this task no longer exists",
        errorCode: "SESSION_MISSING",
      })
      return
    }
    const permissions = await this.port.permissions({ sessionID: record.sessionID }).catch(() => [] as PermissionRequest[])
    const forms = await this.port.forms({ sessionID: record.sessionID }).catch(() => [] as FormSummary[])
    const ownSession = record.sessionID
    const carried = record.pending.filter((ask) => ask.sessionID !== undefined && ask.sessionID !== ownSession)
    const pending: PendingAsk[] = [
      ...permissions.map((item) => ({
        kind: "permission" as const,
        id: item.id,
        title: describePermission(item),
        sessionID: ownSession,
        ...(item.message !== undefined ? { detail: item.message } : {}),
        askedAt: this.now(),
      })),
      ...forms.map((item) => ({
        kind: "question" as const,
        id: item.id,
        title: item.title,
        sessionID: ownSession,
        askedAt: this.now(),
      })),
      ...carried,
    ]
    // Preserve the original askedAt across refreshes so age and the
    // auto-answer threshold measure real waiting time.
    const withAges = pending.map((ask) => {
      const previous = record.pending.find((item) => item.id === ask.id)
      return previous !== undefined ? { ...ask, askedAt: previous.askedAt } : ask
    })
    const patch: Partial<TaskRecord> = {
      pending: withAges,
      cost: Math.max(record.cost, session.cost),
      tokens: { input: session.tokens.input, output: session.tokens.output },
    }
    if (withAges.length > 0) {
      patch.status = "needs_input"
      patch.phase = "waiting_input"
    } else if (session.outcome === "failed") {
      patch.status = "failed"
      patch.phase = "finished"
      patch.error = record.error ?? "the session failed"
      patch.errorCode = record.errorCode ?? "SESSION_FAILED"
    } else if (session.outcome === "interrupted") {
      patch.status = "cancelled"
      patch.phase = "finished"
    } else if (session.outcome === "succeeded") {
      patch.status = "done"
      patch.phase = "finished"
    } else {
      const active = await this.port.activeSessionIDs().catch(() => new Set<string>())
      if (active.has(record.sessionID)) {
        patch.status = "running"
        patch.phase = "executing"
      } else if (await this.hasAssistantReply(record)) {
        patch.status = "done"
        patch.phase = "finished"
      } else if (record.status !== "queued") {
        patch.status = "running"
        patch.phase = "executing"
      }
    }
    if (patch.status !== undefined && patch.status !== record.status) {
      await this.port
        .updateMetadata({
          sessionID: record.sessionID,
          metadata: { [STATE_KEY]: patch.status === "needs_input" ? "needs_input" : patch.status },
        })
        .catch(() => undefined)
    }
    this.patch(handle, patch)
    if (patch.status === "needs_input") this.ensureNeedsInputTimer(handle)
    else this.clearNeedsInputTimer(handle)
  }

  private async hasAssistantReply(record: TaskRecord): Promise<boolean> {
    const page = await this.port.messagePage({ sessionID: record.sessionID, order: "desc", limit: 5 })
    const launchedAt = record.launchedAt ?? record.createdAt
    return page.items.some((message) => message.type === "assistant" && message.created >= launchedAt)
  }

  private enqueue(event: EngineEvent): void {
    if (this.closed) return
    if (this.eventQueue.length >= this.eventQueueBound) {
      this.droppedEvents += 1
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
        try {
          await this.apply(event)
        } catch {
          // One bad event must neither kill the loop nor surface as an
          // unhandled rejection; the sweep retries whatever was missed.
        }
      }
    } finally {
      this.draining = false
    }
  }

  private async apply(event: EngineEvent): Promise<void> {
    const handle = await this.resolveHandle(sessionIDOf(event))
    if (handle === undefined) return
    const record = this.records.get(handle)
    if (!record || record.status === "done" || record.status === "failed" || record.status === "cancelled") return
    switch (event.type) {
      case "durable":
        this.pushLive(handle, event.event as DurableEvent)
        return
      case "session.idle":
      case "session.status":
        await this.refresh(handle).catch(() => undefined)
        return
      case "permission.asked": {
        const profile = resolveProfile(this.config.autonomy, record.autonomy)
        const effect = decide(profile.profile, this.root, {
          action: event.ask.action,
          resources: event.ask.resources,
        })
        const auto = autoDecision({
          decision: effect,
          askedAt: this.now(),
          now: this.now(),
          afterSeconds: effect === "ask" ? 0 : 0,
        })
        if (auto === "allow") {
          await this.port
            .replyPermission({ sessionID: record.sessionID, requestID: event.ask.id, decision: "once" })
            .catch(() => undefined)
          return
        }
        if (auto === "deny") {
          await this.port
            .replyPermission({ sessionID: record.sessionID, requestID: event.ask.id, decision: "reject" })
            .catch(() => undefined)
          return
        }
        this.patch(handle, {
          status: "needs_input",
          phase: "waiting_input",
          pending: mergePending(record.pending, {
            kind: "permission",
            id: event.ask.id,
            title: event.ask.title,
            sessionID: event.sessionID,
            ...(event.ask.message !== undefined ? { detail: event.ask.message } : {}),
            askedAt: this.now(),
          }),
        })
        this.ensureNeedsInputTimer(handle)
        return
      }
      case "permission.replied":
        this.patch(handle, { pending: record.pending.filter((item) => item.id !== event.requestID) })
        if (this.records.get(handle)?.pending.length === 0) {
          this.patch(handle, { status: "running", phase: "executing" })
          this.clearNeedsInputTimer(handle)
        }
        return
      case "form.created":
        this.patch(handle, {
          status: "needs_input",
          phase: "waiting_input",
          pending: mergePending(record.pending, {
            kind: "question",
            id: event.form.id,
            title: event.form.title,
            sessionID: event.sessionID,
            askedAt: this.now(),
          }),
        })
        this.ensureNeedsInputTimer(handle)
        return
      case "form.closed":
        this.patch(handle, { pending: record.pending.filter((item) => item.id !== event.formID) })
        if (this.records.get(handle)?.pending.length === 0) {
          this.patch(handle, { status: "running", phase: "executing" })
          this.clearNeedsInputTimer(handle)
        }
        return
    }
  }

  // Subagent sessions created by v2's own subagent tool are not task records;
  // their asks still belong to the parent task. Walk parentID upward once,
  // cache hits in sessionToHandle, and keep a bounded negative cache.
  private async resolveHandle(sessionID: string): Promise<string | undefined> {
    const direct = this.sessionToHandle.get(sessionID)
    if (direct !== undefined) return direct
    const negativeAt = this.unknownSessions.get(sessionID)
    if (negativeAt !== undefined && this.now() - negativeAt < 30_000) return undefined
    let current = sessionID
    for (let depth = 0; depth < 8; depth += 1) {
      const session = await this.port.getSession({ sessionID: current }).catch(() => undefined)
      if (session?.parentID === undefined) break
      const handle = this.sessionToHandle.get(session.parentID)
      if (handle !== undefined) {
        this.sessionToHandle.set(sessionID, handle)
        this.unknownSessions.delete(sessionID)
        return handle
      }
      current = session.parentID
    }
    this.unknownSessions.set(sessionID, this.now())
    if (this.unknownSessions.size > 500) {
      const oldest = this.unknownSessions.keys().next()
      if (!oldest.done) this.unknownSessions.delete(oldest.value)
    }
    return undefined
  }

  // --- pending / autonomy / budget -----------------------------------------

  private async reconcilePending(
    record: TaskRecord,
    elicit?: (ask: PendingAsk, task: TaskRecord) => Promise<"allow" | "deny" | "skip">,
  ): Promise<void> {
    if (record.pending.length === 0) return
    const profile = resolveProfile(this.config.autonomy, record.autonomy)
    for (const ask of [...record.pending]) {
      if (ask.kind !== "permission") continue
      const askSession = ask.sessionID ?? record.sessionID
      const permission = await this.port
        .permissions({ sessionID: askSession })
        .then((list) => list.find((item) => item.id === ask.id))
        .catch(() => undefined)
      if (permission === undefined) continue
      const decision = decide(profile.profile, this.root, {
        action: permission.action,
        resources: permission.resources,
      })
      const auto = autoDecision({
        decision,
        askedAt: ask.askedAt,
        now: this.now(),
        afterSeconds: this.config.autonomy.auto_answer_after_seconds,
      })
      if (auto === "allow") {
        await this.port
          .replyPermission({ sessionID: askSession, requestID: ask.id, decision: "once" })
          .catch(() => undefined)
        this.patch(record.handle, { pending: this.require(record.handle).pending.filter((item) => item.id !== ask.id) })
        continue
      }
      if (auto === "deny") {
        await this.port
          .replyPermission({ sessionID: askSession, requestID: ask.id, decision: "reject" })
          .catch(() => undefined)
        this.patch(record.handle, { pending: this.require(record.handle).pending.filter((item) => item.id !== ask.id) })
        continue
      }
      if (elicit !== undefined) {
        const answer = await elicit(ask, record).catch(() => "skip" as const)
        if (answer === "allow" || answer === "deny") {
          await this.port
            .replyPermission({
              sessionID: askSession,
              requestID: ask.id,
              decision: answer === "allow" ? "once" : "reject",
            })
            .catch(() => undefined)
          this.patch(record.handle, { pending: this.require(record.handle).pending.filter((item) => item.id !== ask.id) })
        }
      }
    }
    const remaining = this.require(record.handle).pending
    if (remaining.length === 0 && this.require(record.handle).status === "needs_input") {
      this.patch(record.handle, { status: "running", phase: "executing" })
      this.clearNeedsInputTimer(record.handle)
    }
  }

  private budgetTrip(record: TaskRecord): { errorCode: string; error: string } | undefined {
    const childCost = [...this.records.values()]
      .filter((item) => item.parentHandle === record.handle)
      .reduce((total, item) => total + item.cost, 0)
    const trip = evaluateBudget(record.budget, {
      steps: record.digest.steps,
      cost: record.cost + childCost,
      startedAt: record.launchedAt ?? record.createdAt,
      now: this.now(),
    })
    if (trip === undefined) return undefined
    return { errorCode: `BUDGET_${trip.reason.toUpperCase()}`, error: trip.detail }
  }

  private ensureNeedsInputTimer(handle: string): void {
    this.clearNeedsInputTimer(handle)
    const record = this.records.get(handle)
    if (!record || record.pending.length === 0) return
    const earliest = Math.min(...record.pending.map((ask) => ask.askedAt))
    const delay = Math.max(0, earliest + this.needsInputTimeoutMs - this.now())
    const timer = setTimeout(() => {
      this.needsInputTimers.delete(handle)
      void this.expireNeedsInput(handle).catch(() => undefined)
    }, delay)
    if (typeof timer.unref === "function") timer.unref()
    this.needsInputTimers.set(handle, timer)
  }

  private clearNeedsInputTimer(handle: string): void {
    const timer = this.needsInputTimers.get(handle)
    if (timer !== undefined) clearTimeout(timer)
    this.needsInputTimers.delete(handle)
  }

  // Unanswered asks time out to deny/cancel: the task keeps running with the
  // model's next step instead of hanging forever.
  private async expireNeedsInput(handle: string): Promise<void> {
    if (this.closed) return
    const record = this.records.get(handle)
    if (!record || record.status !== "needs_input") return
    for (const ask of record.pending) {
      const askSession = ask.sessionID ?? record.sessionID
      if (ask.kind === "permission") {
        await this.port
          .replyPermission({ sessionID: askSession, requestID: ask.id, decision: "reject", message: "timed out" })
          .catch(() => undefined)
      } else {
        await this.port
          .cancelForm({ sessionID: askSession, formID: ask.id, message: "timed out" })
          .catch(() => undefined)
      }
    }
    this.patch(handle, { pending: [], status: "running", phase: "executing" })
    await this.refresh(handle).catch(() => undefined)
  }

  // --- sweep / budget timers ------------------------------------------------

  private ensureSweepTimer(): void {
    if (this.closed || this.sweepTimer !== undefined || !this.hasNonTerminal()) return
    this.sweepTimer = setInterval(() => {
      void this.sweep()
    }, this.sweepIntervalMs)
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref()
  }

  private ensureBudgetTimer(): void {
    if (this.closed || this.budgetTimer !== undefined || !this.hasNonTerminal()) return
    this.budgetTimer = setInterval(() => {
      void this.enforceBudgets()
    }, Math.max(1_000, this.sweepIntervalMs))
    if (typeof this.budgetTimer.unref === "function") this.budgetTimer.unref()
  }

  private stopSweepTimer(): void {
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
  }

  private stopBudgetTimer(): void {
    if (this.budgetTimer !== undefined) clearInterval(this.budgetTimer)
    this.budgetTimer = undefined
  }

  private hasNonTerminal(): boolean {
    for (const record of this.records.values()) {
      if (record.status === "queued" || record.status === "running" || record.status === "needs_input") return true
    }
    return false
  }

  private updateSweepTimer(): void {
    if (!this.hasNonTerminal()) {
      this.stopSweepTimer()
      this.stopBudgetTimer()
      return
    }
    this.ensureSweepTimer()
    this.ensureBudgetTimer()
  }

  private async sweep(): Promise<void> {
    if (this.closed) return
    for (const record of [...this.records.values()]) {
      if (this.closed) return
      if (record.status !== "running" && record.status !== "needs_input") continue
      try {
        await this.refresh(record.handle)
        await this.maybeSettle(record.handle)
      } catch {
        // Next sweep retries.
      }
    }
    try {
      await this.dequeueNext()
    } catch {
      // Next sweep retries.
    }
    this.updateSweepTimer()
  }

  private async enforceBudgets(): Promise<void> {
    if (this.closed) return
    for (const record of [...this.records.values()]) {
      if (record.status !== "running" && record.status !== "needs_input" && record.status !== "queued") continue
      const trip = this.budgetTrip(record)
      if (trip !== undefined) await this.cancelInternal(record.handle, trip).catch(() => undefined)
    }
    this.updateSweepTimer()
  }

  private async dequeueNext(): Promise<void> {
    if (this.runningSlots() >= this.config.maxConcurrentTasks) return
    for (const [handle] of this.records) {
      const queued = this.queued.get(handle)
      if (queued === undefined) continue
      this.queued.delete(handle)
      await this.port
        .updateMetadata({ sessionID: this.require(handle).sessionID, metadata: { [STATE_KEY]: "running" } })
        .catch(() => undefined)
      await this.launch(handle).catch(() => undefined)
      return
    }
  }

  // --- worktrees / helpers --------------------------------------------------

  private async allocateWorktree(requested: string): Promise<TaskWorktree> {
    const projects = await this.port.projects()
    const project =
      projects.find((item) => samePath(item.canonical, this.root)) ??
      (projects.length === 1 ? projects[0] : undefined)
    if (project === undefined) {
      throw new Error(
        `worktree isolation needs a registered project for ${this.root}; open the project once (or pass worktree: "shared")`,
      )
    }
    // A concrete path runs the session there without creating or deleting a
    // checkout; only worktree: "new" allocates one.
    if (requested !== "new") {
      const directory = path.resolve(this.root, requested)
      return { directory, projectID: project.id, created: false }
    }
    const created = await this.port.createWorktree({ projectID: project.id, name: `mcp-${Date.now().toString(36)}` })
    return { directory: created.directory, projectID: project.id, created: true }
  }

  private async releaseWorktree(worktree: TaskWorktree): Promise<void> {
    if (!worktree.created) return
    await this.port.removeWorktree({ projectID: worktree.projectID, directory: worktree.directory, force: true })
  }

  private async maybeSettle(handle: string): Promise<void> {
    const record = this.records.get(handle)
    if (!record) return
    if (record.status !== "done" && record.status !== "failed" && record.status !== "cancelled") return
    if (record.worktree !== undefined) {
      await this.releaseWorktree(record.worktree).catch(() => undefined)
      this.patch(handle, { worktree: undefined })
    }
    await this.dequeueNext().catch(() => undefined)
    this.updateSweepTimer()
  }

  private activeSharedWriter(): TaskRecord | undefined {
    for (const record of this.records.values()) {
      if (record.status === "cancelled" || record.status === "done" || record.status === "failed") continue
      if (record.isolation !== "shared") continue
      const profile = resolveProfile(this.config.autonomy, record.autonomy)
      if (decide(profile.profile, this.root, { action: "edit", resources: [this.root] }) === "allow") return record
    }
    return undefined
  }

  private require(handle: string): TaskRecord {
    const record = this.records.get(handle)
    if (!record) throw new UnknownTaskError(handle)
    return { ...record, pending: [...record.pending] }
  }

  private patch(handle: string, patch: Partial<TaskRecord>): TaskRecord {
    const record = this.records.get(handle)
    if (!record) throw new UnknownTaskError(handle)
    const next: TaskRecord = { ...record, ...patch, updatedAt: this.now() }
    this.records.set(handle, next)
    this.notifyWaiters(handle, next)
    this.updateSweepTimer()
    const snapshot = { ...next, pending: [...next.pending] }
    for (const listener of [...this.transitions]) {
      try {
        listener(snapshot)
      } catch {
        // A failing subscriber never breaks the engine.
      }
    }
    return snapshot
  }

  private notifyWaiters(handle: string, next: TaskRecord): void {
    const owned = this.waiters.get(handle)
    if (owned === undefined || owned.size === 0) return
    for (const waiter of [...owned]) {
      if (waiter.fromStatus !== undefined && next.status === waiter.fromStatus) continue
      clearTimeout(waiter.timer)
      owned.delete(waiter)
      waiter.resolve({ ...next, pending: [...next.pending] })
    }
    if (owned.size === 0) this.waiters.delete(handle)
  }


}

// --- helpers ---------------------------------------------------------------

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

const sessionTitle = (prompt: string): string => {
  const first = prompt.split("\n")[0]?.trim() ?? ""
  return `[banyan] ${first.slice(0, 80) || "delegated task"}`
}

const assertAllowed = (config: ResolvedConfig, input: TaskStartInput): void => {
  if (input.agent !== undefined && config.allowedAgents !== undefined && !config.allowedAgents.includes(input.agent)) {
    throw new Error(`agent "${input.agent}" is not in banyancode_mcp_server.allowed_agents`)
  }
  if (
    input.model !== undefined &&
    config.allowedModels !== undefined &&
    !config.allowedModels.includes(input.model)
  ) {
    throw new Error(`model "${input.model}" is not in banyancode_mcp_server.allowed_models`)
  }
}

const parseMaxSteps = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 200
  return Math.floor(value)
}

const budgetFromMetadata = (raw: string | undefined, fallbackCost: number): Budget => {
  if (raw === undefined) return { maxSteps: 200, maxCost: fallbackCost, timeoutMs: 0 }
  try {
    const parsed = JSON.parse(raw) as { max_steps?: number; max_cost?: number; timeout_s?: number }
    return {
      maxSteps: parseMaxSteps(parsed.max_steps),
      maxCost:
        parsed.max_cost !== undefined && Number.isFinite(parsed.max_cost) ? parsed.max_cost : fallbackCost,
      timeoutMs:
        parsed.timeout_s !== undefined && Number.isFinite(parsed.timeout_s) && parsed.timeout_s > 0
          ? Math.floor(parsed.timeout_s * 1000)
          : 0,
    }
  } catch {
    return { maxSteps: 200, maxCost: fallbackCost, timeoutMs: 0 }
  }
}

const statusFromSession = (session: SessionSummary): TaskStatus => {
  if (session.outcome === "failed") return "failed"
  if (session.outcome === "interrupted") return "cancelled"
  if (session.outcome === "succeeded") return "done"
  return "running"
}

const samePath = (left: string, right: string): boolean => {
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
  return fold(left.replace(/[/\\]+$/, "")) === fold(right.replace(/[/\\]+$/, ""))
}

const describePermission = (request: PermissionRequest): string => {
  const tail = request.resources.join(" ")
  return clip(tail === "" ? request.action : `${request.action} ${tail}`, 200)
}

const mergePending = (pending: PendingAsk[], ask: PendingAsk): PendingAsk[] => {
  const without = pending.filter((item) => item.id !== ask.id)
  return [...without, ask]
}

const sessionIDOf = (event: EngineEvent): string => event.sessionID

// Real durable sequences win; transcript-derived ordinals encode as negative.
const nextCursorFrom = (after: number, events: readonly DurableEvent[]): number => {
  let durable = 0
  let synthetic = 0
  for (const event of events) {
    const seq = event.durable?.seq
    if (typeof seq !== "number" || !Number.isFinite(seq) || seq <= 0) continue
    if (event.durable?.aggregateID === SYNTHETIC_AGGREGATE) synthetic = Math.max(synthetic, seq)
    else durable = Math.max(durable, seq)
  }
  if (durable > 0) return Math.max(after, durable)
  if (synthetic > 0) return -synthetic
  return after
}
export * as TaskEngineModule from "./engine"
