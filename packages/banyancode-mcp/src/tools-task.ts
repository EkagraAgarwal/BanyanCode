// MCP task tools: delegate, supervise cheaply with `banyan_checkup`, answer
// questions, collect results. Schemas are zod v4 (the dialect the MCP SDK
// resolves), and every successful result carries a `structuredContent` that
// matches the declared output schema.

import { z } from "zod"
import type { McpServer, ServerContext } from "@modelcontextprotocol/server"
import type { ResolvedConfig } from "./config"
import { decodeCursor } from "./digest"
import {
  McpKilledError,
  SharedWriteConflictError,
  TaskEngine,
  UnknownTaskError,
  taskDoneWithFailures,
  taskFilesChanged,
  type PendingAsk,
  type ResultDetail,
  type TaskRecord,
} from "./engine"
import { suggestCheckupSeconds } from "./stuck"
import { messageOf } from "./rpc"
import { log } from "./logging"

export const TaskToolNames = [
  "banyan_task_start",
  "banyan_task_spawn",
  "banyan_checkup",
  "banyan_task_status",
  "banyan_task_result",
  "banyan_task_reply",
  "banyan_task_cancel",
  "banyan_task_list",
  "banyan_kill",
] as const
export type TaskToolName = (typeof TaskToolNames)[number]

// Long-polls stay well under Claude Code's 120 s auto-background threshold and
// the stdio idle timeout.
export const MAX_WAIT_SECONDS = 50

const HANDLE_LIFETIME =
  "Task handles (task_id) are opaque and survive MCP client disconnects and server restarts " +
  "(rehydrated from session metadata). An unknown handle returns UNKNOWN_TASK — start a new task."

// --- schemas -----------------------------------------------------------------

const BudgetSchema = z
  .object({
    max_steps: z.number().int().min(1).max(100_000).optional().describe("Abort after this many model steps."),
    max_cost: z.number().min(0).max(10_000).optional().describe("Abort after this many USD."),
    timeout_s: z.number().int().min(1).max(604_800).optional().describe("Abort after this many seconds."),
  })
  .describe("Hard caps. The task is cancelled (status failed, error_code BUDGET_*) when one trips.")

const WorktreeSchema = z
  .union([z.literal("new"), z.literal("shared"), z.string().min(1).max(512)])
  .describe(
    '"new" allocates a git worktree for the task, "shared" runs in the project root, ' +
      "any other string is a directory to run in.",
  )

const StartInput = z
  .object({
    prompt: z.string().min(1).max(32_000).optional().describe("What BanyanCode should do. First line becomes the title."),
    goal: z.string().min(1).max(32_000).optional().describe("Alias for prompt."),
    agent: z.string().min(1).max(64).optional().describe("Agent name. Defaults to the server default_agent."),
    model: z.string().min(1).max(256).optional().describe('Model as "provider/model" (or "provider/model#variant").'),
    worktree: WorktreeSchema.optional(),
    isolation: z
      .enum(["shared", "worktree"])
      .optional()
      .describe(
        'Older name for worktree: "worktree" allocates a fresh git worktree, ' +
          '"shared" runs in the project root. Prefer `worktree` for new callers.',
      ),
    permission: z
      .enum(["reject", "edits", "yolo"])
      .optional()
      .describe(
        "Must equal the server permission policy (reject by default). yolo additionally needs the server flag --allow-yolo.",
      ),
    autonomy: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('Autonomy profile from banyancode.json (built-ins: observe, supervised, trusted; "yolo" needs --allow-yolo).'),
    max_subagents: z.number().int().min(0).max(32).optional().describe("Soft cap for subtasks this task may spawn."),
    budget: BudgetSchema.optional(),
    wait_seconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .optional()
      .describe("Wait up to N seconds for the task to leave its initial state before returning."),
  })
  .refine((value) => (value.prompt ?? value.goal) !== undefined, {
    message: "one of prompt or goal is required",
    path: ["prompt"],
  })
type StartArgs = z.infer<typeof StartInput>

const SpawnInput = z.object({
  task_id: z.string().min(1).max(128).describe("Parent task handle."),
  subtasks: z
    .array(
      z.object({
        prompt: z.string().min(1).max(32_000).optional(),
        goal: z.string().min(1).max(32_000).optional(),
        agent: z.string().min(1).max(64).optional(),
        model: z.string().min(1).max(256).optional(),
        autonomy: z.string().min(1).max(64).optional(),
        budget: BudgetSchema.optional(),
        worktree: WorktreeSchema.optional(),
      }).refine((value) => (value.prompt ?? value.goal) !== undefined, {
        message: "one of prompt or goal is required for every subtask",
        path: ["prompt"],
      }),
    )
    .min(1)
    .max(16)
    .describe("Independent subtasks, each its own child session under the parent."),
})
type SpawnArgs = z.infer<typeof SpawnInput>

const CheckupInput = z.object({
  cursor: z
    .string()
    .min(1)
    .max(16_384)
    .optional()
    .describe("Opaque cursor from the previous checkup. Omit for 'since each task's last checkup'."),
  task_ids: z.array(z.string().min(1).max(128)).max(64).optional().describe("Limit the checkup to these handles."),
  max_text_chars: z.number().int().min(40).max(2_000).optional().describe("Tail of the last assistant text (default 200)."),
})
type CheckupArgs = z.infer<typeof CheckupInput>

const StatusInput = z.object({
  task_id: z.string().min(1).max(128).describe("Opaque handle returned by banyan_task_start."),
  wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe("Long-poll for a state change."),
})
type StatusArgs = z.infer<typeof StatusInput>

const ResultInput = z.object({
  task_id: z.string().min(1).max(128).describe("Opaque handle returned by banyan_task_start."),
  detail: z
    .enum(["summary", "diff", "transcript"])
    .optional()
    .describe("summary carries counts, diff adds patches, transcript pages the conversation."),
  cursor: z.string().min(1).max(16_384).optional().describe("Transcript page cursor from a previous result."),
})
type ResultArgs = z.infer<typeof ResultInput>

const ReplyInput = z.object({
  task_id: z.string().min(1).max(128).describe("Opaque handle returned by banyan_task_start."),
  decision: z
    .enum(["approve", "reject"])
    .optional()
    .describe("Typed decision for the pending permission or question. Omit to send a free-text steering message."),
  message: z
    .string()
    .min(1)
    .max(32_000)
    .optional()
    .describe("Answer text (required to answer a question), or the steering message when nothing is pending."),
  request_id: z.string().min(1).max(128).optional().describe("Answer a specific pending ask instead of the first one."),
  delivery: z
    .enum(["steer", "queue"])
    .optional()
    .describe('How a free-text message reaches a busy task: "steer" interrupts the current step, "queue" waits.'),
})
type ReplyArgs = z.infer<typeof ReplyInput>

const CancelInput = z.object({
  task_id: z.string().min(1).max(128).optional().describe("Task to cancel."),
  all: z.boolean().optional().describe("Cancel every active task (global kill switch)."),
})
type CancelArgs = z.infer<typeof CancelInput>

const ListInput = z.object({})

// --- output schemas ----------------------------------------------------------

const PendingSchema = z.object({
  id: z.string(),
  kind: z.enum(["permission", "question"]),
  title: z.string(),
  age_s: z.number().int().min(0),
})

const TaskStartOutput = z.object({
  task_id: z.string(),
  status: z.string(),
  phase: z.string(),
  autonomy: z.string(),
  isolation: z.enum(["shared", "worktree"]),
  next_checkup_in_s: z.number().int().min(0).optional(),
  pending: z.array(PendingSchema).optional(),
  error: z.string().optional(),
  error_code: z.string().optional(),
})

const StatusOutput = z.object({
  task_id: z.string(),
  status: z.string(),
  phase: z.string(),
  agent: z.string().optional(),
  model: z.string().optional(),
  pending: z.array(PendingSchema),
  cost: z.number(),
  tokens: z.object({ input: z.number(), output: z.number() }),
  files_changed: z.number().int().min(0),
  steps: z.number().int().min(0),
  done_with_failures: z.boolean().optional(),
  last_text: z.string().optional(),
  error: z.string().optional(),
  error_code: z.string().optional(),
  worktree: z.string().optional(),
  next_checkup_in_s: z.number().int().min(0).optional(),
})

const CheckupOutput = z.object({
  now: z.number().int().min(0),
  cursor: z.string(),
  summary: z.object({
    active: z.number().int().min(0),
    needs_input: z.number().int().min(0),
    done: z.number().int().min(0),
    failed: z.number().int().min(0),
  }),
  tasks: z.array(
    z.object({
      task_id: z.string(),
      status: z.string(),
      phase: z.string(),
      agent: z.string().optional(),
      model: z.string().optional(),
      progress: z.object({
        steps: z.number().int().min(0),
        tool_calls: z.number().int().min(0),
        tool_failures: z.number().int().min(0),
        retries: z.number().int().min(0),
        compactions: z.number().int().min(0),
        files: z.array(z.string()),
        files_count: z.number().int().min(0),
        tools: z.array(z.object({ name: z.string(), count: z.number().int().min(0) })),
        last_text: z.string().optional(),
        cost: z.number(),
        tokens: z.object({ input: z.number(), output: z.number() }),
        last_event_at: z.number().optional(),
        total_steps: z.number().int().min(0),
        total_tool_calls: z.number().int().min(0),
        total_tool_failures: z.number().int().min(0),
      }),
      pending: z.array(PendingSchema),
      files_changed: z.number().int().min(0),
      done_with_failures: z.boolean().optional(),
      cost: z.number(),
      tokens: z.object({ input: z.number(), output: z.number() }),
      stuck: z.object({ kind: z.enum(["no_progress", "loop"]), detail: z.string() }).optional(),
      next_checkup_in_s: z.number().int().min(0).optional(),
      budget: z.object({
        max_steps: z.number().int().min(0),
        max_cost: z.number(),
        timeout_s: z.number().int().min(0).optional(),
        steps: z.number().int().min(0),
      }),
    }),
  ),
  terminal: z.array(
    z.object({
      task_id: z.string(),
      status: z.string(),
      error: z.string().optional(),
      error_code: z.string().optional(),
    }),
  ),
})

const ResultOutput = z.object({
  task_id: z.string(),
  status: z.string(),
  detail: z.enum(["summary", "diff", "transcript"]),
  summary: z.object({
    status: z.string(),
    phase: z.string(),
    cost: z.number(),
    tokens: z.object({ input: z.number(), output: z.number() }),
    files_changed: z.number().int().min(0),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
    steps: z.number().int().min(0),
    tool_calls: z.number().int().min(0),
    tool_failures: z.number().int().min(0),
    done_with_failures: z.boolean().optional(),
    last_text: z.string().optional(),
    error: z.string().optional(),
    error_code: z.string().optional(),
    worktree: z.string().optional(),
  }),
  diff: z
    .array(
      z.object({
        file: z.string(),
        status: z.string(),
        additions: z.number().int().min(0),
        deletions: z.number().int().min(0),
        patch: z.string().optional(),
      }),
    )
    .optional(),
  transcript: z
    .object({
      messages: z.array(
        z.object({
          role: z.string(),
          text: z.string(),
          tool_calls: z
            .array(
              z.object({
                name: z.string(),
                status: z.string().optional(),
                error: z.string().optional(),
              }),
            )
            .optional(),
        }),
      ),
      cursor: z.string().optional(),
      truncated: z.boolean(),
    })
    .optional(),
})

const ReplyOutput = z.object({
  task_id: z.string(),
  status: z.string(),
  phase: z.string(),
  pending: z.array(PendingSchema),
})

const CancelOutput = z.object({
  cancelled: z.array(z.object({ task_id: z.string(), status: z.string() })),
})

const ListOutput = z.object({
  tasks: z.array(z.unknown()),
})

const KillOutput = z.object({
  killed: z.number().int().min(0),
  task_ids: z.array(z.string()),
})

// --- result helpers ----------------------------------------------------------

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

const text = (value: unknown): string => JSON.stringify(value)

export const errorResult = (code: string, message: string): ToolResult => ({
  content: [{ type: "text", text: `${code}: ${message}` }],
  isError: true,
})

const invalidArguments = (message: string): ToolResult => errorResult("INVALID_ARGUMENTS", message)

const mapError = (error: unknown): ToolResult => {
  if (error instanceof UnknownTaskError) return errorResult("UNKNOWN_TASK", error.message)
  if (error instanceof SharedWriteConflictError) return errorResult("SHARED_WRITE_CONFLICT", error.message)
  if (error instanceof McpKilledError) return errorResult("MCP_KILLED", error.message)
  const message = messageOf(error)
  if (/unknown autonomy profile/.test(message)) return errorResult("INVALID_ARGUMENTS", message)
  if (/not in banyancode_mcp_server/.test(message)) return errorResult("POLICY_REJECTED", message)
  return errorResult("UPSTREAM_ERROR", message)
}

type ToolContext = ServerContext

// Optional progress notification for long-polling tools. Best-effort: a client
// that omitted a progress token simply gets nothing.
const notifyProgress = async (ctx: ToolContext | undefined, progress: number, total: number, message: string) => {
  const meta = ctx?.mcpReq?._meta as { progressToken?: string | number } | undefined
  const token = meta?.progressToken
  if (token === undefined || ctx === undefined) return
  await ctx.mcpReq
    .notify({ method: "notifications/progress", params: { progressToken: token, progress, total, message } })
    .catch(() => undefined)
}

// --- public tool deps --------------------------------------------------------

export type TaskToolsDeps = {
  engine: TaskEngine
  config: ResolvedConfig
  root: string
  /** Current MCP client name, read lazily (initialize has not run at registration time). */
  clientName: () => string
  /** Elicit a permission decision; returns "skip" when unsupported or declined. */
  elicitPermission?: (ask: PendingAsk, task: TaskRecord) => Promise<"allow" | "deny" | "skip">
}

const assertAlive = (): void => {
  const raw = process.env["BANYANCODE_MCP_KILL"]?.toLowerCase()
  if (raw === "1" || raw === "true") throw new McpKilledError()
}

const pendingOut = (record: TaskRecord) => {
  const now = Date.now()
  return record.pending.map((ask) => ({
    id: ask.id,
    kind: ask.kind,
    title: ask.title,
    age_s: Math.max(0, Math.round((now - ask.askedAt) / 1000)),
  }))
}

const statusOut = (record: TaskRecord) => ({
  task_id: record.handle,
  status: record.status,
  phase: record.phase,
  ...(record.agent !== undefined ? { agent: record.agent } : {}),
  ...(record.model !== undefined ? { model: record.model } : {}),
  pending: pendingOut(record),
  cost: Math.round(record.cost * 10_000) / 10_000,
  tokens: { ...record.tokens },
  files_changed: taskFilesChanged(record),
  steps: record.digest.steps,
  ...(taskDoneWithFailures(record) ? { done_with_failures: true } : {}),
  ...(record.digest.lastText !== undefined ? { last_text: clip(record.digest.lastText.trim(), 240) } : {}),
  ...(record.error !== undefined ? { error: record.error } : {}),
  ...(record.errorCode !== undefined ? { error_code: record.errorCode } : {}),
  ...(record.worktree !== undefined ? { worktree: record.worktree.directory } : {}),
  ...(suggestCheckupSeconds({ status: record.status, now: Date.now(), lastEventAt: record.digest.lastEventAt }) !==
  undefined
    ? {
        next_checkup_in_s: suggestCheckupSeconds({
          status: record.status,
          now: Date.now(),
          lastEventAt: record.digest.lastEventAt,
        })!,
      }
    : {}),
})

const startOut = (record: TaskRecord) => ({
  task_id: record.handle,
  status: record.status,
  phase: record.phase,
  autonomy: record.autonomy,
  isolation: record.isolation,
  ...(record.pending.length > 0 ? { pending: pendingOut(record) } : {}),
  ...(record.error !== undefined ? { error: record.error } : {}),
  ...(record.errorCode !== undefined ? { error_code: record.errorCode } : {}),
})

const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`

const waitFor = async (
  engine: TaskEngine,
  record: TaskRecord,
  waitSeconds: number | undefined,
): Promise<TaskRecord> => {
  if (waitSeconds === undefined || waitSeconds <= 0) return record
  return engine.waitForStateChange(record.handle, {
    fromStatus: record.status,
    timeoutMs: waitSeconds * 1000,
  })
}

// --- registration ------------------------------------------------------------

export function registerTaskTools(mcp: McpServer, deps: TaskToolsDeps): void {
  const { engine } = deps

  mcp.registerTool(
    "banyan_task_start",
    {
      title: "Start a BanyanCode task",
      description:
        "Delegate work to BanyanCode and return an opaque task handle. BanyanCode runs the task on its own " +
        "(with its own subagents) and keeps running after this client disconnects. " +
        "Then supervise cheaply with banyan_checkup instead of polling. " +
        HANDLE_LIFETIME,
      inputSchema: StartInput,
      outputSchema: TaskStartOutput,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args: StartArgs, ctx?: ToolContext): Promise<ToolResult> => {
      try {
        assertAlive()
        const prompt = args.prompt ?? args.goal
        if (prompt === undefined) return invalidArguments("one of prompt or goal is required")
        if (args.permission !== undefined && args.permission !== deps.config.permission) {
          return invalidArguments(
            `permission "${args.permission}" does not match the server policy "${deps.config.permission}"; ` +
              "retry without the permission argument",
          )
        }
        // v1's `isolation` maps onto the v2 worktree parameter; "worktree"
        // really allocates a git worktree now (the v2 worktree API).
        const worktree =
          args.worktree ?? (args.isolation === "worktree" ? "new" : args.isolation === "shared" ? "shared" : undefined)
        await notifyProgress(ctx, 0, 1, "starting task")
        const started = await engine.start({
          prompt,
          ...(args.agent !== undefined ? { agent: args.agent } : {}),
          ...(args.model !== undefined ? { model: args.model } : {}),
          ...(worktree !== undefined ? { worktree } : {}),
          ...(args.autonomy !== undefined ? { autonomy: args.autonomy } : {}),
          ...(args.max_subagents !== undefined ? { maxSubagents: args.max_subagents } : {}),
          ...(args.budget !== undefined ? { budget: args.budget } : {}),
          mcpClient: deps.clientName(),
        })
        const settled = await waitFor(engine, started, args.wait_seconds)
        await notifyProgress(ctx, 1, 1, "task queued or running")
        const output = TaskStartOutput.parse(startOut(settled))
        return { content: [{ type: "text", text: text(output) }], structuredContent: output }
      } catch (error) {
        return mapError(error)
      }
    },
  )

  mcp.registerTool(
    "banyan_task_spawn",
    {
      title: "Spawn subtasks under a task",
      description:
        "Fan out independent subtasks under an existing task. Each subtask is a child session; " +
        "banyan_checkup reports all of them and banyan_task_list shows the tree. " +
        HANDLE_LIFETIME,
      inputSchema: SpawnInput,
      outputSchema: z.object({ parent_task_id: z.string(), tasks: z.array(TaskStartOutput) }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args: SpawnArgs, ctx?: ToolContext): Promise<ToolResult> => {
      try {
        assertAlive()
        await notifyProgress(ctx, 0, 1, "spawning subtasks")
        const created = await engine.spawn(
          args.task_id,
          args.subtasks.map((subtask) => ({
            prompt: subtask.prompt ?? subtask.goal ?? "",
            ...(subtask.agent !== undefined ? { agent: subtask.agent } : {}),
            ...(subtask.model !== undefined ? { model: subtask.model } : {}),
            ...(subtask.autonomy !== undefined ? { autonomy: subtask.autonomy } : {}),
            ...(subtask.budget !== undefined ? { budget: subtask.budget } : {}),
            ...(subtask.worktree !== undefined ? { worktree: subtask.worktree } : {}),
            mcpClient: deps.clientName(),
          })),
        )
        await notifyProgress(ctx, 1, 1, "subtasks created")
        const output = {
          parent_task_id: args.task_id,
          tasks: created.map((record) => TaskStartOutput.parse(startOut(record))),
        }
        return { content: [{ type: "text", text: text(output) }], structuredContent: output }
      } catch (error) {
        return mapError(error)
      }
    },
  )

  mcp.registerTool(
    "banyan_checkup",
    {
      title: "Check up on delegated tasks",
      description:
        "One cheap supervision call for every active task: status, progress digest of new durable events " +
        "since the cursor (steps, tool calls, files, last assistant text), pending questions and permission " +
        "asks, cost/tokens, stuck or loop detection, a suggested next checkup interval, and a new cursor. " +
        "Prefer this over repeated banyan_task_status calls.",
      inputSchema: CheckupInput,
      outputSchema: CheckupOutput,
      annotations: { readOnlyHint: true },
    },
    async (args: CheckupArgs): Promise<ToolResult> => {
      try {
        assertAlive()
        await engine.ensureRehydrated()
        const seed =
          args.cursor !== undefined
            ? decodeCursor(args.cursor)
            : Object.fromEntries(engine.list().map((record) => [record.handle, record.lastCheckupSeq]))
        const { report } = await engine.checkup({
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
          cursorState: seed,
          ...(args.task_ids !== undefined ? { taskIDs: args.task_ids } : {}),
          ...(args.max_text_chars !== undefined ? { maxTextChars: args.max_text_chars } : {}),
          ...(deps.elicitPermission !== undefined ? { elicit: deps.elicitPermission } : {}),
        })
        const output = CheckupOutput.parse(report)
        // Keep the wire payload small: JSON without indentation.
        return { content: [{ type: "text", text: text(output) }], structuredContent: output }
      } catch (error) {
        return mapError(error)
      }
    },
  )

  mcp.registerTool(
    "banyan_task_status",
    {
      title: "Task status",
      description:
        "Poll one task: status, phase, pending asks, cost, tokens, files changed, last assistant text. " +
        "wait_seconds long-polls for a state change. For many tasks use banyan_checkup. " +
        HANDLE_LIFETIME,
      inputSchema: StatusInput,
      outputSchema: StatusOutput,
      annotations: { readOnlyHint: true },
    },
    async (args: StatusArgs, ctx?: ToolContext): Promise<ToolResult> => {
      try {
        assertAlive()
        const record = await engine.status(args.task_id)
        await notifyProgress(ctx, 0, 1, "waiting for a state change")
        const settled = await waitFor(engine, record, args.wait_seconds)
        await notifyProgress(ctx, 1, 1, settled.status)
        const output = StatusOutput.parse(statusOut(settled))
        return { content: [{ type: "text", text: text(output) }], structuredContent: output }
      } catch (error) {
        return mapError(error)
      }
    },
  )

  mcp.registerTool(
    "banyan_task_result",
    {
      title: "Task result",
      description:
        "Bounded result for a finished (or running) task: counts, verification outcome, cost and the tail of " +
        "the last assistant message. summary carries done_with_failures when the task finished but a tool " +
        "failed or an approval was refused. detail=diff adds patches, detail=transcript pages the " +
        "conversation with a cursor. " +
        HANDLE_LIFETIME,
      inputSchema: ResultInput,
      outputSchema: ResultOutput,
      annotations: { readOnlyHint: true },
    },
    async (args: ResultArgs): Promise<ToolResult> => {
      try {
        assertAlive()
        const detail: ResultDetail = args.detail ?? "summary"
        const result = await engine.result(args.task_id, detail, args.cursor)
        const output = ResultOutput.parse(result)
        return { content: [{ type: "text", text: text(output) }], structuredContent: output }
      } catch (error) {
        return mapError(error)
      }
    },
  )

  mcp.registerTool(
    "banyan_task_reply",
    {
      title: "Answer a task",
      description:
        "Answer the pending permission or question on a task (typed decision), or send a free-text steering " +
        "message with delivery steer|queue when nothing is pending. " +
        HANDLE_LIFETIME,
      inputSchema: ReplyInput,
      outputSchema: ReplyOutput,
      annotations: { readOnlyHint: false },
    },
    async (args: ReplyArgs): Promise<ToolResult> => {
      try {
        assertAlive()
        const record = await engine.reply(args.task_id, {
          ...(args.decision !== undefined ? { decision: args.decision } : {}),
          ...(args.message !== undefined ? { message: args.message } : {}),
          ...(args.delivery !== undefined ? { delivery: args.delivery } : {}),
          ...(args.request_id !== undefined ? { requestID: args.request_id } : {}),
        })
        const output = ReplyOutput.parse({
          task_id: record.handle,
          status: record.status,
          phase: record.phase,
          pending: pendingOut(record),
        })
        return { content: [{ type: "text", text: text(output) }], structuredContent: output }
      } catch (error) {
        return mapError(error)
      }
    },
  )

  mcp.registerTool(
    "banyan_task_cancel",
    {
      title: "Cancel a task",
      description:
        "Abort a running or queued task and free its concurrency slot (worktrees the engine created are " +
        "removed). Pass all: true to cancel every active task — the global kill switch. " +
        HANDLE_LIFETIME,
      inputSchema: CancelInput,
      outputSchema: CancelOutput,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args: CancelArgs): Promise<ToolResult> => {
      try {
        assertAlive()
        if (args.all === true) {
          const cancelled = await engine.cancelAll()
          const output = { cancelled: cancelled.map((record) => ({ task_id: record.handle, status: record.status })) }
          return { content: [{ type: "text", text: text(output) }], structuredContent: output }
        }
        if (args.task_id === undefined) return invalidArguments("pass task_id or all: true")
        const record = await engine.cancel(args.task_id)
        const output = { cancelled: [{ task_id: record.handle, status: record.status }] }
        return { content: [{ type: "text", text: text(output) }], structuredContent: output }
      } catch (error) {
        return mapError(error)
      }
    },
  )

  mcp.registerTool(
    "banyan_task_list",
    {
      title: "List tasks",
      description:
        "The task and subagent tree: handle, status, agent, model, cost, pending ask count and the task's own " +
        "children. Survives restarts by rehydrating from session metadata.",
      inputSchema: ListInput,
      outputSchema: ListOutput,
      annotations: { readOnlyHint: true },
    },
    async (): Promise<ToolResult> => {
      try {
        assertAlive()
        await engine.ensureRehydrated()
        const output = { tasks: engine.tree() }
        return { content: [{ type: "text", text: text(output) }], structuredContent: output }
      } catch (error) {
        return mapError(error)
      }
    },
  )

  mcp.registerTool(
    "banyan_kill",
    {
      title: "Kill switch",
      description:
        "Cancel every active delegated task immediately. Use when a delegate is out of control or a caller " +
        "budget is exhausted. Equivalent to banyan_task_cancel with all: true; BANYANCODE_MCP_KILL=1 disables " +
        "the whole server at runtime.",
      inputSchema: z.object({}),
      outputSchema: KillOutput,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (): Promise<ToolResult> => {
      try {
        // The kill switch must work even when the env gate is engaged.
        const cancelled = await engine.cancelAll()
        const output = { killed: cancelled.length, task_ids: cancelled.map((record) => record.handle) }
        log(`kill switch cancelled ${cancelled.length} task(s)`)
        return { content: [{ type: "text", text: text(output) }], structuredContent: output }
      } catch (error) {
        return mapError(error)
      }
    },
  )
}

export const TOOL_LAYER_NOTE =
  "Task tools delegate work. Code tools (banyan_code_find, banyan_repo, banyan_change_check, " +
  "banyan_codegraph, banyan_verify) answer questions about the repository directly."
