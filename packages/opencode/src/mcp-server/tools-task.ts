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
import { TaskEngine, UnknownTaskError } from "./task-engine"
import type { TaskRecord } from "./task-engine"
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
    .describe("Wait up to N seconds (max 50) for the task to settle past running/queued before returning."),
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

export function registerTaskTools(mcp: McpServer, deps: TaskToolsDeps): void {
  const { engine, sessions, config } = deps
  const outputChars = config.outputChars
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
    async (args: TaskReplyArgs) => {
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
        const record = resolved.record
        const sessionID = record.sessionID
        // Per-task SDK root (C2): worktree tasks scope every read to the
        // checkout, mirroring the engine's dirForRecord. Memory reads need
        // no scope (the memory routes are location-wide).
        const scope = record.worktree !== undefined ? { directory: record.worktree.directory } : {}
        const [messages, diffFiles, todos, cost, subagents, parts, memory] = await Promise.all([
          sessions.messages({ sessionID, limit: 200, ...scope }),
          sessions.diff({ sessionID, ...scope }),
          sessions.todo({ sessionID, ...scope }),
          sessions.cost({ sessionID, ...scope }),
          sessions.subagents({ sessionID, ...scope }),
          // Legacy fakes predate the port method: without it the
          // verification field stays absent, same as a transcript with no
          // verifier parts.
          typeof sessions.toolParts === "function"
            ? sessions.toolParts({ sessionID, ...scope })
            : Promise.resolve([] as VerifierToolPartInput[]),
          deps.listMemory !== undefined ? deps.listMemory({ sessionID }) : Promise.resolve([]),
        ])
        const verification = aggregateVerification(parts)
        const assistantTexts = messages.filter((msg) => msg.role === "assistant" && msg.text.length > 0)
        const compact = buildCompactResult(
          {
            task_id: record.handle,
            status: record.status,
            ...(assistantTexts.length > 0
              ? { finalMessage: assistantTexts[assistantTexts.length - 1]?.text ?? "" }
              : {}),
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
            maxTokens: config.resultMaxTokens,
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
    async (args: TaskStartArgs) => {
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
    async (args: TaskStatusArgs) => {
      try {
        const resolved = await resolveRecord(engine, args.task_id)
        if ("error" in resolved) return resolved.error
        const record = await waitForSettled(engine, resolved.record.handle, args.wait_seconds ?? 0)
        return okResult(statusView(record), outputChars)
      } catch (error) {
        return toError(error, "banyan_task_status")
      }
    },
  )
}

export * as McpTaskTools from "./tools-task"
