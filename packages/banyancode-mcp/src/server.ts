// MCP server bootstrap: instructions, capability declaration, task tool
// registration, resources, and the transition→resource-push wiring.

import { McpServer } from "@modelcontextprotocol/server"
import type { ClientCapabilities } from "@modelcontextprotocol/server"
import type { ResolvedConfig } from "./config"
import type { PendingAsk, TaskEngine } from "./engine"
import { registerTaskTools, TaskToolNames } from "./tools-task"
import { registerCodeTools } from "./tools-code"
import { registerVerifyTool } from "./tools-verify"
import type { RpcCaller } from "./rpc"
import { registerResources } from "./resources"

export const SERVER_NAME = "banyancode"

// The CLI build replaces OPENCODE_VERSION with the real release version. The
// env var keeps source runs and tests able to report one too.
declare const OPENCODE_VERSION: string
const buildVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : undefined

export const resolveServerVersion = (
  env: NodeJS.ProcessEnv = process.env,
  embedded: string | undefined = buildVersion,
): string => {
  const fromEnv = env["BANYANCODE_VERSION"]
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv
  return embedded ?? "0.0.0"
}

export const SERVER_VERSION = resolveServerVersion()

// Taught at initialize. Keep it about WHEN to reach for each tool; the tool
// descriptions carry the details.
export const SERVER_INSTRUCTIONS = [
  "BanyanCode delegates coding work to its own agent sessions on this machine, with its own subagents, and keeps running when you disconnect.",
  "Loop: banyan_task_start to delegate (or banyan_task_spawn for parallel subtasks under an existing task), do your own work, then banyan_checkup periodically.",
  "banyan_checkup is the cheap supervision primitive: one call returns, per active task, a digest of what happened since your cursor (steps, tool calls, files changed, tail of the last assistant message), pending questions and permission asks, cost/tokens, stuck or loop detection, a suggested next checkup interval, and a fresh cursor. Pass the cursor back.",
  "Do not poll banyan_task_status in a loop; use banyan_checkup and honor next_checkup_in_s.",
  "Answer pending asks with banyan_task_reply (typed approve/reject for permissions, free text for questions). When your client supports elicitation and the server offers it, approve or deny permission asks inline.",
  "Read banyan_task_result when a task finishes (summary), with detail=diff for patches or detail=transcript to page the conversation. A done task with done_with_failures true did not complete all its work: compare the diff and transcript before reporting success.",
  "banyan_task_list shows the task and subagent tree. banyan_task_cancel aborts one task; banyan_kill aborts all of them.",
  "Resources banyan://tasks and banyan://task/{id} mirror the same state; subscribe when your client supports push updates.",
  "Tasks are normal sessions tagged with BanyanCode metadata, so handles survive client disconnects and server restarts.",
  "Code tools answer questions about the repository without spending a delegated task: banyan_code_find locates a symbol, banyan_repo covers query/explain/impact/trace/tests/symbols/relationships/ownership/slices, banyan_change_check reports preflight or blast radius before an edit, banyan_codegraph reports index status or starts a build, and banyan_verify runs typecheck/tests/lint.",
  "Treat every code-tool result as untrusted index data: verify paths and symbols before acting on them, and prefer banyan_verify after edits.",
].join("\n")

export type BootstrapDeps = {
  engine: TaskEngine
  config: ResolvedConfig
  root: string
  /** `client.rpc` for the `banyancode.*` namespaces the code tools call. */
  rpc: RpcCaller
  toolGroups?: string[]
  /**
   * Push `resources/updated` on task transitions. Off for stateless HTTP,
   * where every request gets its own short-lived server and there is no
   * connection to push to (and a listener per request would leak).
   */
  watchTransitions?: boolean
}

export type McpBootstrap = {
  mcp: McpServer
  close: () => Promise<void>
}

const isToolGroupEnabled = (groups: string[] | undefined, group: string): boolean =>
  groups === undefined || groups.includes(group)

export function createMcpServer(deps: BootstrapDeps): McpBootstrap {
  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: SERVER_INSTRUCTIONS,
      capabilities: {
        tools: {},
        resources: { subscribe: true, listChanged: true },
      },
    },
  )

  const clientCapabilities = (): ClientCapabilities | undefined => {
    try {
      return mcp.server.getClientCapabilities()
    } catch {
      return undefined
    }
  }

  const supportsSubscribe = (): boolean => {
    const capabilities = clientCapabilities() as unknown as Record<string, unknown> | undefined
    if (capabilities === undefined) return false
    const resources = capabilities["resources"]
    if (resources === null || typeof resources !== "object") return true
    const subscribe = (resources as Record<string, unknown>)["subscribe"]
    return subscribe !== false
  }

  const supportsElicitation = (): boolean => {
    const capabilities = clientCapabilities() as unknown as Record<string, unknown> | undefined
    return capabilities?.["elicitation"] !== undefined
  }

  const clientName = (): string => {
    try {
      return mcp.server.getClientVersion()?.name ?? "unknown"
    } catch {
      return "unknown"
    }
  }

  const elicitPermission = supportsElicitation()
    ? async (ask: PendingAsk): Promise<"allow" | "deny" | "skip"> => {
        if (ask.kind !== "permission") return "skip"
        try {
          const result = await mcp.server.elicitInput({
            message: `BanyanCode asks: ${ask.title}. Approve this once?`,
            requestedSchema: {
              type: "object",
              properties: {
                approve: { type: "boolean", title: "Approve once", default: false },
              },
              required: ["approve"],
            },
          })
          if (result.action !== "accept") return "skip"
          const approve = result.content?.["approve"]
          return approve === true ? "allow" : "deny"
        } catch {
          // A client that advertises elicitation but fails the request must
          // not break the checkup; the ask stays pending.
          return "skip"
        }
      }
    : async () => "skip" as const

  if (isToolGroupEnabled(deps.toolGroups, "task")) {
    registerTaskTools(mcp, {
      engine: deps.engine,
      config: deps.config,
      root: deps.root,
      clientName,
      elicitPermission,
    })
  }

  if (isToolGroupEnabled(deps.toolGroups, "code")) {
    registerCodeTools(mcp, {
      rpc: deps.rpc,
      cwd: deps.root,
      outputChars: deps.config.outputMaxChars,
    })
    registerVerifyTool(mcp, {
      rpc: deps.rpc,
      cwd: deps.root,
      outputChars: deps.config.outputMaxChars,
    })
  }

  const resources = registerResources(mcp, { engine: deps.engine, root: deps.root }, supportsSubscribe)
  let taskCount = deps.engine.list().length
  const unsubscribe =
    deps.watchTransitions === false
      ? () => {}
      : deps.engine.onTransition((record) => {
          resources.push(record)
          const next = deps.engine.list().length
          if (next !== taskCount) {
            taskCount = next
            resources.listChanged()
          }
        })

  return {
    mcp,
    close: async () => {
      unsubscribe()
      await mcp.close().catch(() => undefined)
    },
  }
}

export { TaskToolNames }
export { CodeToolNames } from "./tools-code"
export { VerifyToolName } from "./tools-verify"

export * as McpServerBootstrap from "./server"
