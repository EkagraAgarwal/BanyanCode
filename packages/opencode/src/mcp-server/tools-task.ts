// MCP task-delegation tools (Milestone B, gap-plan §4.7 + §4.8).
//
// Registration surface over the event-driven TaskEngine (task-engine.ts):
// start-then-poll delegation where a task is a normal session tagged
// origin:"mcp". Handles (task_id) are opaque high-entropy strings minted by
// the engine (never the raw `ses_` id); unknown or expired handles return a
// coded UNKNOWN_TASK error so the model can recover by starting a new task.
//
// Schemas are zod v4 (the one MCP-facing dialect, shared with the SDK); handlers use the
// structured result/err helpers from output.ts and the compact result
// builder from result.ts. Task tools are NOT readOnly — only cancel carries
// destructiveHint. Registration order is alphabetical for deterministic
// tools/list.

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/server"
import {
  CLIENT_CAPABILITIES_META_KEY,
  MissingRequiredClientCapabilityError,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server"
import type { ServerContext } from "@modelcontextprotocol/server"
import type { ClientCapabilities, Notification, ServerCapabilities } from "@modelcontextprotocol/server"
import { TaskEngine, UnknownTaskError } from "./task-engine"
import type { TaskRecord, TaskStatus } from "./task-engine"
import { createRequestStateService, RequestStateError } from "./request-state"
import type { RequestStateService } from "./request-state"
import { assertYoloAllowed, buildRuleset } from "./policy"
import type { PermissionPolicy } from "./policy"
import { buildCompactResult, aggregateVerification, DEFAULT_RESULT_MAX_TOKENS } from "./result"
import type { VerifierToolPartInput } from "./result"
import { CodeToolOutputSchema, errorResult, invalidArguments, okResult } from "./output"
import type { McpToolResult } from "./output"
import type { SessionClient } from "./types"

export const TaskCancelToolName = "banyan_task_cancel" as const
export const TaskReplyToolName = "banyan_task_reply" as const
export const TaskResultToolName = "banyan_task_result" as const
export const TaskStartToolName = "banyan_task_start" as const
export const TaskStatusToolName = "banyan_task_status" as const

export const TaskToolNames = [
  TaskCancelToolName,
  TaskReplyToolName,
  TaskResultToolName,
  TaskStartToolName,
  TaskStatusToolName,
] as const
export type TaskToolName = (typeof TaskToolNames)[number]

// Upper bound for wait_seconds (gap-plan B10): a start/status long-poll must
// stay well under Claude Code's 120 s auto-background threshold, and must
// never trip the 30-min stdio idle timeout.
export const MAX_TASK_WAIT_SECONDS = 50

const HANDLE_LIFETIME =
  "Task handles (task_id) are opaque and valid while this MCP server process lives. " +
  "A restarted server rehydrates handles from session metadata when it can; " +
  "an unknown or expired handle returns UNKNOWN_TASK — start a new task with banyan_task_start."

export type TaskToolsConfig = {
  // Server-wide default policy: the session ruleset is built from this at
  // task start (policy.ts buildRuleset) and forwarded through the engine to
  // session creation. A per-call permission must equal it.
  permission: PermissionPolicy
  allowYolo: boolean
  allowedAgents?: string[]
  allowedModels?: string[]
  resultMaxTokens: number
  outputChars: number
}

export type TaskToolsDeps = {
  engine: TaskEngine
  // Full tasks-port client for result assembly (messages/diff/todo/cost).
  // The engine drives lifecycle; this client reads the session back.
  sessions: SessionClient
  directory: string
  // Merged session.metadata write (read-merge-write through session.update,
  // which replaces metadata wholesale). Repair path for the mcp_handle
  // binding when the engine's own write did not land (the engine is primary
  // since E2).
  updateMetadata: (input: { sessionID: string; metadata: Record<string, string> }) => Promise<void>
  // Lazily read so the name reflects the connected client: at registration
  // time initialize has not run yet and getClientVersion() is undefined.
  getMcpClientName: () => string
  // Memory backfill for banyan_task_result (C3/C4 seam, wired in
  // server.ts): session + global entries tagged origin:mcp. Optional so
  // existing fakes keep compiling; absent means the result carries no
  // memory refs.
  listMemory?: (input: { sessionID: string }) => Promise<Array<{ id: string; title?: string }>>
  // MRTR requestState sealer (D2/SEP-2322). Optional so existing fakes
  // keep compiling; absent means a process-ephemeral default service is
  // used for mint/verify. Inject a fixed-secret service in tests.
  requestState?: RequestStateService
  config: TaskToolsConfig
}

const TaskStartInput = z.object({
  prompt: z.string().min(1).max(8000).describe("What the subagent should do. First line becomes the session title."),
  agent: z.string().min(1).max(64).optional().describe("Agent for this task. Defaults to the server default_agent."),
  model: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('Model as "provider/model". Defaults to the server default_model.'),
  isolation: z
    .enum(["shared", "worktree"])
    .optional()
    .describe(
      "Recorded on the task. Worktree isolation lands in a later release; tasks share the project directory for now.",
    ),
  permission: z
    .enum(["reject", "edits", "yolo"])
    .optional()
    .describe(
      "Must equal the server policy (reject by default). yolo additionally needs the server flag --allow-yolo.",
    ),
  wait_seconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_TASK_WAIT_SECONDS)
    .optional()
    .describe(
      "Wait up to N seconds (max 50) for the task to settle past running/queued before returning. Ignored when the caller uses the tasks extension (resultType task) — poll tasks/get instead.",
    ),
})
type TaskStartArgs = z.infer<typeof TaskStartInput>

const TaskStatusInput = z.object({
  task_id: z.string().min(1).max(128).describe("Opaque handle returned by banyan_task_start."),
  wait_seconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_TASK_WAIT_SECONDS)
    .optional()
    .describe("Wait up to N seconds (max 50) for a state change before returning."),
})
type TaskStatusArgs = z.infer<typeof TaskStatusInput>

const TaskResultInput = z.object({
  task_id: z.string().min(1).max(128).describe("Opaque handle returned by banyan_task_start."),
  detail: z
    .enum(["summary", "diff", "transcript"])
    .optional()
    .describe("summary carries counts alone, diff adds patches, transcript pages the session transcript."),
  cursor: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe("Transcript page cursor from a previous result (detail transcript only)."),
})
type TaskResultArgs = z.infer<typeof TaskResultInput>

const TaskReplyInput = z.object({
  task_id: z.string().min(1).max(128).describe("Opaque handle returned by banyan_task_start."),
  decision: z
    .enum(["approve", "reject"])
    .describe("Typed decision for the pending permission or question. No free-text matching."),
  message: z
    .string()
    .min(1)
    .max(8000)
    .optional()
    .describe("Required when approving a question (it becomes the answer). Optional context otherwise."),
})
type TaskReplyArgs = z.infer<typeof TaskReplyInput>

const TaskCancelInput = z.object({
  task_id: z.string().min(1).max(128).describe("Opaque handle returned by banyan_task_start."),
})
type TaskCancelArgs = z.infer<typeof TaskCancelInput>

const NON_READ_ONLY_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const

const metaFor = (outputChars: number): Record<string, unknown> => ({
  "anthropic/maxResultSizeChars": outputChars,
})

const unknownTask = (taskID: string): McpToolResult =>
  errorResult(
    "UNKNOWN_TASK",
    `task handle "${taskID}" is unknown or expired; start a new task with banyan_task_start and use the fresh handle it returns`,
  )

// NOTE: no handle-shape gate here. Handles are opaque btask_ strings minted
// by the engine (task-handle.ts newTaskHandle), so any non-empty string
// flows to resolveRecord: known handles resolve, everything else is
// UNKNOWN_TASK with recovery text.

// Resolve a handle to a live record, rehydrating from session metadata when
// the engine table lost it (process restart, --attach reconnect). A handle
// that matches nothing anywhere is UNKNOWN_TASK with recovery text.
async function resolveRecord(
  engine: TaskEngine,
  taskID: string,
): Promise<{ record: TaskRecord } | { error: McpToolResult }> {
  try {
    return { record: await engine.status(taskID) }
  } catch (error) {
    if (!(error instanceof UnknownTaskError)) throw error
    try {
      return { record: await engine.rehydrate(taskID) }
    } catch {
      return { error: unknownTask(taskID) }
    }
  }
}

const toError = (error: unknown, what: string): McpToolResult => {
  if (error instanceof UnknownTaskError) return unknownTask(error.message)
  return errorResult("UPSTREAM_ERROR", `${what} failed: ${error instanceof Error ? error.message : String(error)}`)
}

// Long-poll on the engine's event-driven wait hook (E4): each leg resolves
// on the next state change for the task or its slice of the deadline — no
// fixed-interval refresh. Bounded by the schema max (50 s), so B10's timing
// constraints hold by construction.
async function waitForSettled(engine: TaskEngine, handle: string, waitSeconds: number): Promise<TaskRecord> {
  let record = await engine.status(handle)
  if (waitSeconds <= 0) return record
  const deadline = Date.now() + waitSeconds * 1000
  while (record.status === "running" || record.status === "queued") {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    record = await engine.waitForStateChange(handle, { timeoutMs: remaining, fromStatus: record.status })
  }
  return record
}

type StatusView = {
  task_id: string
  status: string
  permission: string
  isolation: string
  agent?: string
  model?: string
  // Accumulated USD spend for the task (C6), the machine-readable failure
  // code when it failed, and the worktree checkout for isolated tasks (C2).
  cost: number
  errorCode?: string
  worktree?: { name: string; directory: string; branch: string }
  createdAt: number
  updatedAt: number
  elapsedMs: number
  pendingQuestion?: {
    kind: string
    title: string
    detail?: string
    askedAt: number
  }
}

const statusView = (record: TaskRecord): StatusView => {
  const view: StatusView = {
    task_id: record.handle,
    status: record.status,
    permission: record.permission,
    isolation: record.isolation,
    cost: record.cost,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    elapsedMs: record.updatedAt - record.createdAt,
  }
  if (record.agent !== undefined) view.agent = record.agent
  if (record.model !== undefined) view.model = record.model
  if (record.errorCode !== undefined) view.errorCode = record.errorCode
  if (record.worktree !== undefined) view.worktree = { ...record.worktree }
  if (record.pendingQuestion !== undefined) {
    const pending: StatusView["pendingQuestion"] = {
      kind: record.pendingQuestion.kind,
      title: record.pendingQuestion.title,
      askedAt: record.pendingQuestion.askedAt,
    }
    if (record.pendingQuestion.detail !== undefined) pending.detail = record.pendingQuestion.detail
    view.pendingQuestion = pending
  }
  return view
}

const checkAgentModel = (
  args: { agent?: string; model?: string },
  config: TaskToolsConfig,
): McpToolResult | undefined => {
  if (args.agent !== undefined && config.allowedAgents !== undefined && !config.allowedAgents.includes(args.agent)) {
    return errorResult(
      "POLICY_REJECTED",
      `agent "${args.agent}" is not in the server allowed_agents list (${config.allowedAgents.join(", ") || "empty"})`,
    )
  }
  if (args.model !== undefined && config.allowedModels !== undefined && !config.allowedModels.includes(args.model)) {
    return errorResult(
      "POLICY_REJECTED",
      `model "${args.model}" is not in the server allowed_models list (${config.allowedModels.join(", ") || "empty"})`,
    )
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Tasks extension (gap-plan Milestone D1, SEP-2663
// `io.modelcontextprotocol/tasks`).
//
// One engine serves both surfaces: the `banyan_task_*` tools stay as the
// fallback for clients without the extension, and the `tasks/*` extension
// methods serve clients whose per-request capabilities include it. There is
// deliberately NO `tasks/list` — the spec removed it so servers cannot leak
// one caller's task IDs to another.
//
// Wire notes (verified against @modelcontextprotocol/server 2.2.0):
// - The server advertises the extension in `server/discover` capabilities.
// - `banyan_task_start` returns a `CreateTaskResult` (`resultType: "task"`)
//   when the per-request envelope carries the extension. The task fields ride
//   alongside the normal `content`/`structuredContent` — the SDK passes
//   handler-authored top-level fields through untouched.
// - `tasks/get`, `tasks/update`, `tasks/cancel` are custom request methods
//   (the SDK has no first-class tasks runtime); unknown task IDs answer
//   `-32602`, and callers without the extension answer `-32021`. Transport
//   caveat: the SDK 2.2.0 modern HTTP entry answers -32601 for the removed
//   2025 names (tasks/get, tasks/cancel) before Server dispatch, while the
//   unknown-to-both-eras tasks/update falls through to our handler (with
//   params.inputResponses lifted to ctx). Stdio/InMemory dispatch reaches
//   all three; the D3 HTTP work lifts the name gate.
// - `notifications/tasks` is broadcast best-effort on every status change.
//   The SDK's serving entries own `subscriptions/listen` streams (the filter
//   schema drops `taskIds`), so there is no per-subscription filtering here —
//   polling `tasks/get` is the primary mechanism and notifications are the
//   fast path for connected (stdio/in-process) clients.
// ---------------------------------------------------------------------------

export const TasksExtensionID = "io.modelcontextprotocol/tasks" as const
// Suggested polling cadence for tasks/get (matches the engine's 7.5 s
// safety-net sweep), and an advisory TTL. Records persist for the process
// lifetime (plus metadata rehydrate), so the TTL never elapses in practice.
export const TASK_TTL_MS = 3_600_000
export const TASK_POLL_INTERVAL_MS = 5_000

export type ExtensionTaskStatus = "working" | "input_required" | "completed" | "cancelled" | "failed"

export function toExtensionStatus(status: TaskStatus): ExtensionTaskStatus {
  switch (status) {
    case "queued":
    case "running":
      return "working"
    case "needs_input":
      return "input_required"
    case "done":
      return "completed"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
  }
}

// True when the request's own capabilities declare the tasks extension.
// Per-request envelope only (2026-07-28): legacy `initialize` clients never
// take the extension path — they use the banyan_task_* fallback tools.
export function hasTasksExtension(ctx: unknown): boolean {
  const envelope = (ctx as { mcpReq?: { envelope?: Record<string, unknown> } } | undefined)?.mcpReq?.envelope
  const caps = envelope?.[CLIENT_CAPABILITIES_META_KEY] as { extensions?: Record<string, unknown> } | undefined
  const extensions = caps?.extensions
  return !!extensions && typeof extensions === "object" && TasksExtensionID in extensions
}

export function requireTasksExtension(ctx: unknown): void {
  if (hasTasksExtension(ctx)) return
  const requiredCapabilities = { extensions: { [TasksExtensionID]: {} } } as unknown as ClientCapabilities
  throw new MissingRequiredClientCapabilityError({ requiredCapabilities })
}

const invalidTaskParams = (message: string): ProtocolError =>
  new ProtocolError(ProtocolErrorCode.InvalidParams, message)

// D2 MRTR elicitation forms (SEP-2322): the inputRequests payload for an
// input_required task. Keyed by the pending request ID (stable over the
// task lifetime — keys are never reused). Each entry is a real
// `elicitation/create` FORM request (message + requestedSchema); the sealed
// requestState rides alongside at the payload top level (DetailedTask or
// InputRequiredResult), never inside the form params. tasks/update accepts
// both the D1 answer shape ({decision, message?}) and MRTR elicitation
// results ({action: accept/decline/cancel, content}).
//
// Capability rule: the ONLY request kind this server ever sends is
// elicitation/create (form mode). Sampling (`sampling/createMessage`) and
// roots (`roots/list`) are deprecated per §8.1 and are never constructed —
// there is no code path that emits them. The tools/call surface additionally
// pre-checks clientSupportsElicitation (per-request envelope, same pattern
// as hasTasksExtension) and falls back to the normal status payload when
// the client did not declare elicitation; the SDK seam would answer -32021
// otherwise. tasks/get always carries the keyed form (a tasks-extension
// client answers it via tasks/update in either shape), so the D1 key
// contract is unchanged.
export const ElicitationCreateMethod = "elicitation/create" as const

// Form schema for answering a pending permission/question. `decision` is
// the typed signal (no free-text matching); `message` is required when
// approving a question (it becomes the answer) and optional context
// otherwise — mirroring the TaskReplyInput tool schema.
export function answerRequestedSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["approve", "reject"] },
      message: { type: "string" },
    },
    required: ["decision"],
  }
}

export function buildInputRequests(record: TaskRecord): Record<string, unknown> | undefined {
  const pending = record.pendingQuestion
  if (!pending) return undefined
  const message = pending.detail ? `${pending.title}\n${pending.detail}` : pending.title
  return {
    [pending.requestID]: {
      method: ElicitationCreateMethod,
      params: { message, requestedSchema: answerRequestedSchema() },
    },
  }
}

// Reads the per-request client capabilities from the 2026-07-28 envelope
// (D1's hasTasksExtension pattern). Legacy transports have no envelope, so
// they never take the MRTR path.
export function readClientCapabilities(ctx: unknown): Record<string, unknown> | undefined {
  const envelope = (ctx as { mcpReq?: { envelope?: Record<string, unknown> } } | undefined)?.mcpReq?.envelope
  const caps = envelope?.[CLIENT_CAPABILITIES_META_KEY]
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return undefined
  return caps as Record<string, unknown>
}

// True when the request declared form-mode elicitation. A bare
// `elicitation: {}` counts as form support (the SDK's own lenient reading:
// pre-mode meaning of a bare declaration). An explicit `url`-only
// declaration does NOT satisfy a form request, and sampling/roots-only
// declarations never do.
export function clientSupportsElicitation(ctx: unknown): boolean {
  const caps = readClientCapabilities(ctx)
  const elicitation = caps?.["elicitation"]
  if (!elicitation || typeof elicitation !== "object" || Array.isArray(elicitation)) return false
  const modes = elicitation as Record<string, unknown>
  if (modes["form"] !== undefined || modes["url"] === undefined) return true
  return false
}

// Process-ephemeral fallback sealer for deps without an injected service
// (same lifetime as the handle table: this process). Lazy so importing the
// module never touches randomness.
let defaultRequestStateService: RequestStateService | undefined

export function defaultRequestState(): RequestStateService {
  if (!defaultRequestStateService) defaultRequestStateService = createRequestStateService()
  return defaultRequestStateService
}

const requestStateFor = (deps: TaskToolsDeps): RequestStateService => deps.requestState ?? defaultRequestState()

// Mint the requestState binding for a pending question: principal (the
// connection's MCP client name — one consistent source for mint and
// verify), task handle, request ID, short expiry.
export function mintTaskRequestState(
  deps: TaskToolsDeps,
  record: TaskRecord,
  requestID: string,
): string | undefined {
  try {
    return requestStateFor(deps).mint({
      principal: deps.getMcpClientName(),
      taskHandle: record.handle,
      requestID,
    })
  } catch {
    return undefined
  }
}

// The tools/call MRTR return for a needs_input task (D2 §b):
// InputRequiredResult with inputRequests + requestState. Undefined when
// there is nothing to ask. Callers pre-check clientSupportsElicitation;
// the returned literal goes back to the handler unmodified (cast at the
// call site — the SDK seam reads the resultType discriminator at runtime).
export function toToolInputRequired(
  deps: TaskToolsDeps,
  record: TaskRecord,
): { resultType: "input_required"; inputRequests: Record<string, unknown>; requestState: string } | undefined {
  const pending = record.pendingQuestion
  if (!pending) return undefined
  const inputRequests = buildInputRequests(record)
  const requestState = mintTaskRequestState(deps, record, pending.requestID)
  if (!inputRequests || !requestState) return undefined
  return { resultType: "input_required", inputRequests, requestState }
}

export type CreateTaskResultShape = {
  resultType: "task"
  taskId: string
  status: "working"
  statusMessage?: string
  createdAt: string
  lastUpdatedAt: string
  ttlMs: number
  pollIntervalMs: number
}

// Returned only after the session exists (durably created): engine.start
// resolves after createSession + the handle binding, so a tasks/get for the
// returned taskId resolves immediately.
export function toCreateTaskResult(record: TaskRecord): CreateTaskResultShape {
  const shaped: CreateTaskResultShape = {
    resultType: "task",
    taskId: record.handle,
    status: "working",
    createdAt: new Date(record.createdAt).toISOString(),
    lastUpdatedAt: new Date(record.updatedAt).toISOString(),
    ttlMs: TASK_TTL_MS,
    pollIntervalMs: TASK_POLL_INTERVAL_MS,
  }
  if (record.status === "queued") shaped.statusMessage = "queued for a concurrency slot"
  return shaped
}

export function toDetailedTask(
  record: TaskRecord,
  completedResult?: unknown,
  opts?: { requestState?: string },
): Record<string, unknown> {
  const status = toExtensionStatus(record.status)
  const base: Record<string, unknown> = {
    resultType: "complete",
    taskId: record.handle,
    status,
    createdAt: new Date(record.createdAt).toISOString(),
    lastUpdatedAt: new Date(record.updatedAt).toISOString(),
    ttlMs: TASK_TTL_MS,
    pollIntervalMs: TASK_POLL_INTERVAL_MS,
  }
  if (record.status === "queued") base["statusMessage"] = "queued for a concurrency slot"
  switch (status) {
    case "working":
    case "cancelled":
      return base
    case "input_required": {
      const requests = buildInputRequests(record)
      if (requests !== undefined) base["inputRequests"] = requests
      if (opts?.requestState !== undefined) base["requestState"] = opts.requestState
      return base
    }
    case "completed":
      base["result"] = {
        content: [{ type: "text", text: JSON.stringify(completedResult ?? {}) }],
        structuredContent: completedResult ?? {},
      }
      return base
    case "failed": {
      const message = record.error ?? "task failed"
      base["statusMessage"] = message
      base["error"] = { code: -32603, message }
      return base
    }
  }
}

export async function readDetailedTask(deps: TaskToolsDeps, record: TaskRecord): Promise<Record<string, unknown>> {
  if (record.status !== "done") {
    if (record.status === "needs_input" && record.pendingQuestion) {
      const requestState = mintTaskRequestState(deps, record, record.pendingQuestion.requestID)
      return toDetailedTask(record, undefined, requestState !== undefined ? { requestState } : undefined)
    }
    return toDetailedTask(record)
  }
  return toDetailedTask(record, await readCompactResult(deps, record))
}

// Shared compact-result assembly for banyan_task_result and the extension
// tasks/get (completed). Reads scope to the task's worktree checkout when
// the task is isolated (C2), mirroring the engine's dirForRecord.
async function readCompactResult(
  deps: TaskToolsDeps,
  record: TaskRecord,
  opts?: { detail?: "summary" | "diff" | "transcript"; cursor?: string },
): Promise<Record<string, unknown>> {
  const sessionID = record.sessionID
  const scope = record.worktree !== undefined ? { directory: record.worktree.directory } : {}
  const [messages, diffFiles, todos, cost, subagents, parts, memory] = await Promise.all([
    deps.sessions.messages({ sessionID, limit: 200, ...scope }),
    deps.sessions.diff({ sessionID, ...scope }),
    deps.sessions.todo({ sessionID, ...scope }),
    deps.sessions.cost({ sessionID, ...scope }),
    deps.sessions.subagents({ sessionID, ...scope }),
    // Legacy fakes predate the port method: without it the
    // verification field stays absent, same as a transcript with no
    // verifier parts.
    typeof deps.sessions.toolParts === "function"
      ? deps.sessions.toolParts({ sessionID, ...scope })
      : Promise.resolve([] as VerifierToolPartInput[]),
    deps.listMemory !== undefined ? deps.listMemory({ sessionID }) : Promise.resolve([]),
  ])
  const verification = aggregateVerification(parts)
  const assistantTexts = messages.filter((msg) => msg.role === "assistant" && msg.text.length > 0)
  return buildCompactResult(
    {
      task_id: record.handle,
      status: record.status,
      ...(assistantTexts.length > 0 ? { finalMessage: assistantTexts[assistantTexts.length - 1]?.text ?? "" } : {}),
      diffFiles,
      transcript: messages.map((msg) => ({ role: msg.role, text: msg.text })),
      todos,
      cost: cost.cost,
      tokensByModel: cost.tokensByModel,
      subagentCount: subagents.length,
      ...(verification !== undefined ? { verification } : {}),
      ...(memory.length > 0 ? { memory } : {}),
      ...(record.worktree !== undefined
        ? { worktree: { path: record.worktree.directory, branch: record.worktree.branch } }
        : {}),
    },
    {
      maxTokens: deps.config.resultMaxTokens,
      ...(opts?.detail !== undefined ? { detail: opts.detail } : {}),
      ...(opts?.cursor !== undefined ? { cursor: opts.cursor } : {}),
    },
  ) as unknown as Record<string, unknown>
}

// Map a tasks/update inputResponses entry onto an engine reply. Accepts the
// D1 answer shape ({decision, message?}) and MRTR elicitation results
// ({action: accept/decline/cancel, content}). Unknown shapes are caller
// errors (-32602); a missing entry for the outstanding key is NOT an error —
// the server ignores it per spec and the task stays input_required.
export function replyFromInputResponses(
  entry: unknown,
  requestID: string,
): { decision: "approve" | "reject"; message?: string } | undefined {
  if (entry === undefined) return undefined
  if (typeof entry === "string") return { decision: "approve", message: entry }
  if (!entry || typeof entry !== "object") {
    throw invalidTaskParams(`inputResponses["${requestID}"] must be an object or a string answer`)
  }
  const rec = entry as Record<string, unknown>
  const contentMessage = (content: unknown): string | undefined => {
    if (typeof content === "string") return content
    if (!content || typeof content !== "object") return undefined
    const obj = content as Record<string, unknown>
    for (const key of ["message", "text", "input"]) {
      if (typeof obj[key] === "string") return obj[key] as string
    }
    return undefined
  }
  if (rec["decision"] === "approve" || rec["decision"] === "reject") {
    const decision = rec["decision"]
    const message =
      typeof rec["message"] === "string" ? (rec["message"] as string) : contentMessage(rec["content"])
    return message !== undefined ? { decision, message } : { decision }
  }
  if (rec["action"] === "accept") {
    const message = contentMessage(rec["content"])
    return message !== undefined ? { decision: "approve", message } : { decision: "approve" }
  }
  if (rec["action"] === "decline" || rec["action"] === "cancel") return { decision: "reject" }
  throw invalidTaskParams(
    `inputResponses["${requestID}"] needs decision "approve"|"reject" or action "accept"|"decline"|"cancel"`,
  )
}

// Throwing twin of resolveRecord: extension methods answer -32602 for
// unknown handles (spec MUST for tasks/get, SHOULD for update/cancel),
// never the tool-shaped UNKNOWN_TASK error.
async function resolveRecordOrThrow(engine: TaskEngine, taskID: string): Promise<TaskRecord> {
  try {
    return await engine.status(taskID)
  } catch (error) {
    if (!(error instanceof UnknownTaskError)) throw error
    try {
      return await engine.rehydrate(taskID)
    } catch {
      throw invalidTaskParams(`unknown task: "${taskID}"`)
    }
  }
}

const TasksGetParams = z.object({ taskId: z.string().min(1).max(128) })
// inputResponses is optional because the modern HTTP entry lifts it out of
// params into ctx.mcpReq.inputResponses (MRTR retry seam) before dispatch —
// a stripped request still validates. The handler merges both sources.
const TasksUpdateParams = z.object({
  taskId: z.string().min(1).max(128),
  inputResponses: z.record(z.string(), z.unknown()).optional(),
  // MRTR echo (D2): the requestState the server sent alongside inputRequests.
  // Optional for legacy D1 clients (decision/message answers keep working);
  // when present it is verified before the answer is applied.
  requestState: z.string().min(1).max(4096).optional(),
})
const TasksCancelParams = z.object({ taskId: z.string().min(1).max(128) })
// Custom-method results carry no runtime validation in the SDK (the schema
// only types the handler return); passthrough keeps the DetailedTask shape.
const TasksResultShape = z.object({}).passthrough()

async function pushTaskNotification(
  mcp: McpServer,
  deps: TaskToolsDeps,
  record: TaskRecord,
  lastSent: Map<string, string>,
): Promise<void> {
  const status = toExtensionStatus(record.status)
  const key = `${status}:${record.pendingQuestion?.requestID ?? ""}`
  if (lastSent.get(record.handle) === key) return
  lastSent.set(record.handle, key)
  try {
    const detailed = await readDetailedTask(deps, record)
    const note = { method: "notifications/tasks", params: detailed } as unknown as Notification
    await mcp.server.notification(note)
  } catch {
    // Best-effort broadcast: unconnected (per-request HTTP instances) or
    // closed servers drop notifications; polling tasks/get stays correct.
  }
}

// MRTR lift readers: the modern entry moves params.inputResponses into
// ctx.mcpReq.inputResponses (dropping malformed entries into
// droppedInputResponseKeys) before dispatch. Legacy transports leave params
// untouched. Handlers merge both so answers arrive on every transport.
function readCtxInputResponses(ctx: unknown): Record<string, unknown> {
  const lifted = (ctx as { mcpReq?: { inputResponses?: unknown } } | undefined)?.mcpReq?.inputResponses
  if (!lifted || typeof lifted !== "object" || Array.isArray(lifted)) return {}
  return lifted as Record<string, unknown>
}

function readCtxDroppedKeys(ctx: unknown): string[] {
  const dropped = (ctx as { mcpReq?: { droppedInputResponseKeys?: unknown } } | undefined)?.mcpReq
    ?.droppedInputResponseKeys
  return Array.isArray(dropped) ? dropped.filter((key): key is string => typeof key === "string") : []
}

// MRTR echo reader: the retried requestState arrives either as a params
// field (tasks/update schema above) or lifted into ctx by the modern entry
// (same seam as readCtxInputResponses). Non-strings are ignored — the
// caller falls back to the legacy unverified path.
function readCtxRequestState(ctx: unknown): string | undefined {
  const holder = (ctx as { mcpReq?: { requestState?: unknown } } | undefined)?.mcpReq?.requestState
  if (typeof holder === "string") return holder
  if (typeof holder === "function") {
    try {
      const value = (holder as () => unknown)()
      return typeof value === "string" ? value : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

// Verify an echoed requestState before applying the answer (D2 §6).
// Absent state means a legacy D1 client — the answer proceeds unverified
// for backward compatibility. A PRESENT but invalid state (tampered,
// expired, replayed, or bound to another principal/task/request) is a
// caller error (-32602): the task stays input_required and the client
// re-polls tasks/get for a fresh token.
function verifyUpdateRequestState(
  deps: TaskToolsDeps,
  record: TaskRecord,
  requestID: string,
  presented: unknown,
): void {
  if (presented === undefined) return
  if (typeof presented !== "string") return
  try {
    requestStateFor(deps).verify(presented, {
      principal: deps.getMcpClientName(),
      taskHandle: record.handle,
      requestID,
    })
  } catch (error) {
    const reason = error instanceof RequestStateError ? error.reason : "malformed"
    throw invalidTaskParams(
      `requestState rejected (${reason}); re-poll tasks/get for a fresh token and retry the answer`,
    )
  }
}

export type TasksExtensionHandlers = {
  get: (params: { taskId: string }, ctx: unknown) => Promise<Record<string, unknown>>
  update: (
    params: { taskId: string; inputResponses?: Record<string, unknown>; requestState?: string },
    ctx: unknown,
  ) => Promise<Record<string, unknown>>
  cancel: (params: { taskId: string }, ctx: unknown) => Promise<Record<string, unknown>>
}

// Handler units behind the tasks/* methods, exported so tests can drive the
// real engine flow with a forged per-request envelope (SDK 2.2.0 clients
// cannot send tasks/* on modern or decode task results — see the header
// note). registerTasksExtension wires these to the transport.
export function createTasksExtensionHandlers(deps: TaskToolsDeps): TasksExtensionHandlers {
  const { engine } = deps
  return {
    get: async (params, ctx) => {
      requireTasksExtension(ctx)
      const record = await resolveRecordOrThrow(engine, params.taskId)
      return readDetailedTask(deps, record)
    },
    update: async (params, ctx) => {
      requireTasksExtension(ctx)
      const record = await resolveRecordOrThrow(engine, params.taskId)
      if (record.status === "done" || record.status === "failed" || record.status === "cancelled") {
        return { resultType: "complete" }
      }
      const pending = record.pendingQuestion
      if (record.status !== "needs_input" || !pending) return { resultType: "complete" }
      const responses = { ...readCtxInputResponses(ctx), ...(params.inputResponses ?? {}) }
      if (readCtxDroppedKeys(ctx).includes(pending.requestID) && responses[pending.requestID] === undefined) {
        throw invalidTaskParams(`inputResponses["${pending.requestID}"] was malformed and dropped; resend the answer`)
      }
      // D2: validate the echoed requestState before the answer touches the
      // engine. Absent state = legacy D1 client, proceeds unverified.
      verifyUpdateRequestState(deps, record, pending.requestID, params.requestState ?? readCtxRequestState(ctx))
      const reply = replyFromInputResponses(responses[pending.requestID], pending.requestID)
      if (reply === undefined) return { resultType: "complete" }
      try {
        await engine.reply(record.handle, reply)
      } catch (error) {
        throw invalidTaskParams(`tasks/update failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return { resultType: "complete" }
    },
    cancel: async (params, ctx) => {
      requireTasksExtension(ctx)
      const record = await resolveRecordOrThrow(engine, params.taskId)
      await engine.cancel(record.handle)
      return { resultType: "complete" }
    },
  }
}

export function registerTasksExtension(mcp: McpServer, deps: TaskToolsDeps): void {
  const { engine } = deps
  const advertisement = { extensions: { [TasksExtensionID]: {} } } as unknown as ServerCapabilities
  mcp.server.registerCapabilities(advertisement)
  const handlers = createTasksExtensionHandlers(deps)

  mcp.server.setRequestHandler("tasks/get", { params: TasksGetParams, result: TasksResultShape }, handlers.get)

  mcp.server.setRequestHandler("tasks/update", { params: TasksUpdateParams, result: TasksResultShape }, handlers.update)

  mcp.server.setRequestHandler(
    "tasks/cancel",
    { params: TasksCancelParams, result: TasksResultShape },
    handlers.cancel,
  )

  // No tasks/list: the spec removed it on purpose (cross-caller handle
  // leakage). An unregistered method answers -32601 from the SDK itself.
  const lastSent = new Map<string, string>()
  engine.onTransition((record) => {
    void pushTaskNotification(mcp, deps, record, lastSent)
  })
}

export function registerTaskTools(mcp: McpServer, deps: TaskToolsDeps): void {
  const { engine, config } = deps
  const outputChars = config.outputChars
  // Tasks extension (D1) rides the same registration: one engine serves the
  // banyan_task_* fallback tools and the tasks/* extension surface.
  registerTasksExtension(mcp, deps)
  // Registration order is alphabetical so tools/list is deterministic.
  mcp.registerTool(
    TaskCancelToolName,
    {
      title: "Cancel a delegated task",
      description: `Abort a running or queued delegated task and free its concurrency slot. ${HANDLE_LIFETIME}`,
      inputSchema: TaskCancelInput,
      outputSchema: CodeToolOutputSchema,
      annotations: {
        ...NON_READ_ONLY_ANNOTATIONS,
        destructiveHint: true,
      },
      _meta: metaFor(outputChars),
    },
    async (args: TaskCancelArgs) => {
      try {
        const resolved = await resolveRecord(engine, args.task_id)
        if ("error" in resolved) return resolved.error
        const record = await engine.cancel(resolved.record.handle)
        return okResult({ task_id: record.handle, status: record.status }, outputChars)
      } catch (error) {
        return toError(error, "banyan_task_cancel")
      }
    },
  )

  mcp.registerTool(
    TaskReplyToolName,
    {
      title: "Reply to a task waiting for input",
      description: `Answer the pending permission or question on a needs_input task with a typed decision. An approve on a permission grants only that ask and never widens the server policy. ${HANDLE_LIFETIME}`,
      inputSchema: TaskReplyInput,
      outputSchema: CodeToolOutputSchema,
      annotations: NON_READ_ONLY_ANNOTATIONS,
      _meta: metaFor(outputChars),
    },
    async (args: TaskReplyArgs, ctx: ServerContext) => {
      try {
        const resolved = await resolveRecord(engine, args.task_id)
        if ("error" in resolved) return resolved.error
        let record: TaskRecord
        try {
          record = await engine.reply(resolved.record.handle, {
            decision: args.decision,
            ...(args.message !== undefined ? { message: args.message } : {}),
          })
        } catch (error) {
          // Engine precondition failures (e.g. "needs message …") are
          // caller-correctable argument errors, not upstream failures.
          return invalidArguments(error instanceof Error ? error.message : String(error))
        }
        // D2: a reply that leaves a follow-up question pending returns the
        // MRTR input_required for the NEW question when the client declared
        // elicitation; otherwise the normal status view.
        if (record.status === "needs_input" && record.pendingQuestion && clientSupportsElicitation(ctx)) {
          const required = toToolInputRequired(deps, record)
          if (required) return required as unknown as McpToolResult
        }
        return okResult(statusView(record), outputChars)
      } catch (error) {
        return toError(error, "banyan_task_reply")
      }
    },
  )

  mcp.registerTool(
    TaskResultToolName,
    {
      title: "Compact result of a delegated task",
      description: `Bounded summary of a delegated task: file change counts, verification outcome, todos, cost, and (with detail transcript) a paged transcript. Never the full transcript. ${HANDLE_LIFETIME}`,
      inputSchema: TaskResultInput,
      outputSchema: CodeToolOutputSchema,
      annotations: {
        ...NON_READ_ONLY_ANNOTATIONS,
        idempotentHint: true,
      },
      _meta: metaFor(outputChars),
    },
    async (args: TaskResultArgs) => {
      try {
        const resolved = await resolveRecord(engine, args.task_id)
        if ("error" in resolved) return resolved.error
        const compact = await readCompactResult(
          deps,
          resolved.record,
          {
            ...(args.detail !== undefined ? { detail: args.detail } : {}),
            ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
          },
        )
        return okResult(compact, outputChars)
      } catch (error) {
        return toError(error, "banyan_task_result")
      }
    },
  )

  mcp.registerTool(
    TaskStartToolName,
    {
      title: "Start a delegated task",
      description: `Delegate a task to a subagent session and return an opaque task handle for banyan_task_status/result/reply/cancel. A queued task starts when a concurrency slot frees. ${HANDLE_LIFETIME}`,
      inputSchema: TaskStartInput,
      outputSchema: CodeToolOutputSchema,
      annotations: NON_READ_ONLY_ANNOTATIONS,
      _meta: metaFor(outputChars),
    },
    async (args: TaskStartArgs, ctx: ServerContext) => {
      const allowlisted = checkAgentModel(args, config)
      if (allowlisted) return allowlisted
      const permission = (args.permission ?? config.permission) as PermissionPolicy
      try {
        assertYoloAllowed(config.allowYolo, permission)
      } catch (error) {
        return errorResult("POLICY_REJECTED", error instanceof Error ? error.message : String(error))
      }
      if (permission !== config.permission) {
        return invalidArguments(
          `permission "${permission}" does not match the server policy "${config.permission}"; retry without the permission argument`,
        )
      }
      try {
        const started = await engine.start({
          prompt: args.prompt,
          ...(args.agent !== undefined ? { agent: args.agent } : {}),
          ...(args.model !== undefined ? { model: args.model } : {}),
          ...(args.isolation !== undefined ? { isolation: args.isolation } : {}),
          permission,
          // Ruleset for the server policy, enforced at session creation
          // through the engine (E1). Matches config.permission by the check
          // above, so this equals the server default.
          permissionRuleset: buildRuleset(permission, deps.directory),
          mcpClient: deps.getMcpClientName(),
        })
        // Repair the handle binding when the engine's own write did not
        // land (the engine writes mcp_handle itself since E2).
        // Best-effort; the live record table is authoritative for this process.
        await deps
          .updateMetadata({ sessionID: started.sessionID, metadata: { mcp_handle: started.handle } })
          .catch(() => {})
        if (hasTasksExtension(ctx)) {
          // Tasks-extension surface (D1/SEP-2663): CreateTaskResult
          // immediately after durable creation. wait_seconds is a
          // fallback-surface concept — extension clients poll tasks/get.
          const current = engine.get(started.handle)
          const shaped = okResult(statusView(current), outputChars)
          return { ...shaped, ...toCreateTaskResult(current) } as McpToolResult
        }
        const record = await waitForSettled(engine, started.handle, args.wait_seconds ?? 0)
        return okResult(statusView(record), outputChars)
      } catch (error) {
        return toError(error, "banyan_task_start")
      }
    },
  )

  mcp.registerTool(
    TaskStatusToolName,
    {
      title: "Status of a delegated task",
      description: `Poll a delegated task: running, queued, needs_input (with the pending question), done, failed, or cancelled. wait_seconds long-polls up to 50 s. ${HANDLE_LIFETIME}`,
      inputSchema: TaskStatusInput,
      outputSchema: CodeToolOutputSchema,
      annotations: {
        ...NON_READ_ONLY_ANNOTATIONS,
        idempotentHint: true,
      },
      _meta: metaFor(outputChars),
    },
    async (args: TaskStatusArgs, ctx: ServerContext) => {
      try {
        const resolved = await resolveRecord(engine, args.task_id)
        if ("error" in resolved) return resolved.error
        const record = await waitForSettled(engine, resolved.record.handle, args.wait_seconds ?? 0)
        // D2 tool path: a needs_input task returns the MRTR
        // InputRequiredResult (inputRequests + requestState) when the
        // client declared elicitation. Anything else — including clients
        // without the capability — gets the normal status view with the
        // pending question inline, answerable via banyan_task_reply.
        if (record.status === "needs_input" && record.pendingQuestion && clientSupportsElicitation(ctx)) {
          const required = toToolInputRequired(deps, record)
          if (required) return required as unknown as McpToolResult
        }
        return okResult(statusView(record), outputChars)
      } catch (error) {
        return toError(error, "banyan_task_status")
      }
    },
  )
}

export * as McpTaskTools from "./tools-task"
