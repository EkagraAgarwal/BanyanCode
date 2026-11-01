// Subscribable MCP resources: `banyan://tasks` (the tree) and
// `banyan://task/{id}` (one task). Pushes ride the engine's transition
// notifications, throttled per URI so a chatty task cannot flood the client.

import { ResourceTemplate } from "@modelcontextprotocol/server"
import type { McpServer } from "@modelcontextprotocol/server"
import type { TaskEngine, TaskRecord } from "./engine"
import { suggestCheckupSeconds } from "./stuck"

export const TASKS_URI = "banyan://tasks"
export const taskURI = (taskID: string): string => `banyan://task/${encodeURIComponent(taskID)}`
export const TASK_URI_PREFIX = "banyan://task/"

const PUSH_INTERVAL_MS = 250

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

export type ResourceDeps = {
  engine: TaskEngine
  root: string
}

export type ResourceHandle = {
  /** Push `resources/updated` for a task and the list, honoring subscribe support. */
  push: (record: TaskRecord) => void
  /** Push `resources/list_changed` when the task set changed. */
  listChanged: () => void
}

export function registerResources(
  mcp: McpServer,
  deps: ResourceDeps,
  supportsSubscribe: () => boolean,
): ResourceHandle {
  const lastPush = new Map<string, number>()

  const snapshot = (record: TaskRecord) => {
    const now = Date.now()
    return {
      task_id: record.handle,
      status: record.status,
      phase: record.phase,
      agent: record.agent,
      model: record.model,
      isolation: record.isolation,
      pending: record.pending.map((ask) => ({
        id: ask.id,
        kind: ask.kind,
        title: ask.title,
        age_s: Math.max(0, Math.round((now - ask.askedAt) / 1000)),
      })),
      cost: Math.round(record.cost * 10_000) / 10_000,
      tokens: record.tokens,
      files_changed: record.digest.files.length,
      last_text: record.digest.lastText !== undefined ? clip(record.digest.lastText.trim(), 400) : undefined,
      error: record.error,
      error_code: record.errorCode,
      worktree: record.worktree?.directory,
      next_checkup_in_s: suggestCheckupSeconds({
        status: record.status,
        now,
        lastEventAt: record.digest.lastEventAt,
      }),
    }
  }

  mcp.registerResource(
    "tasks",
    TASKS_URI,
    {
      title: "BanyanCode tasks",
      description: "The delegated task and subagent tree, with status, cost and pending asks.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ tasks: deps.engine.tree() }),
        },
      ],
    }),
  )

  mcp.registerResource(
    "task",
    new ResourceTemplate("banyan://task/{id}", {
      list: () => ({
        resources: deps.engine.list().map((record) => ({
          uri: taskURI(record.handle),
          name: record.handle,
          title: clip(record.prompt.split("\n")[0] ?? record.handle, 80),
          mimeType: "application/json",
        })),
      }),
      complete: {
        id: (value) =>
          deps.engine
            .list()
            .map((record) => record.handle)
            .filter((handle) => handle.startsWith(value)),
      },
    }),
    {
      title: "BanyanCode task",
      description: "One delegated task: status, phase, digest tail, pending asks, cost and tokens.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = typeof variables.id === "string" ? variables.id : ""
      const record = deps.engine.has(id) ? deps.engine.get(id) : undefined
      if (record === undefined) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: "UNKNOWN_TASK", task_id: id }),
            },
          ],
        }
      }
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(snapshot(record)) }],
      }
    },
  )

  const push = (record: TaskRecord) => {
    // Clients that did not subscribe would treat unsolicited updates as noise.
    if (!supportsSubscribe()) return
    const now = Date.now()
    for (const uri of [TASKS_URI, taskURI(record.handle)]) {
      const previous = lastPush.get(uri) ?? 0
      if (now - previous < PUSH_INTERVAL_MS) continue
      lastPush.set(uri, now)
      void mcp.server.sendResourceUpdated({ uri }).catch(() => undefined)
    }
  }

  return {
    push,
    listChanged: () => {
      if (!supportsSubscribe()) return
      mcp.sendResourceListChanged()
    },
  }
}

export * as Resources from "./resources"
