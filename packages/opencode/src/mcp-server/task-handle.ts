export * as McpTaskHandle from "./task-handle"

import { randomBytes } from "node:crypto"

// Opaque handle minted at task start and mapped to the session ID by the
// engine. Never the raw `ses_…` ID: it is high-entropy, unguessable, and
// safe to hand to unauthenticated callers. Dependency-free (node stdlib
// only) so both the engine and the tools can import it.
export const TASK_HANDLE_PREFIX = "btask_" as const

const HANDLE_BYTES = 32
const HANDLE_PATTERN = /^btask_[0-9a-f]{64}$/

export const newTaskHandle = (): string => `${TASK_HANDLE_PREFIX}${randomBytes(HANDLE_BYTES).toString("hex")}`

export const isTaskHandleShape = (id: unknown): id is string =>
  typeof id === "string" && HANDLE_PATTERN.test(id)

export function assertHandleShape(id: unknown): asserts id is string {
  if (!isTaskHandleShape(id)) {
    const seen = typeof id === "string" ? id.slice(0, 80) : String(id).slice(0, 80)
    throw new Error(`not a banyan task handle: expected "${TASK_HANDLE_PREFIX}<64 hex chars>", got "${seen}"`)
  }
}

type TaskHandleErrorResult = {
  content: Array<{ type: "text"; text: string }>
  isError: true
}

// Same envelope as McpOutput.errorResult("UNKNOWN_TASK", …), defined here so
// this module stays dependency-free.
export const expiredOrUnknown = (id: string): TaskHandleErrorResult => ({
  content: [
    {
      type: "text",
      text: `UNKNOWN_TASK: task handle "${id}" is unknown or expired; start a new task with banyan_task_start and use the fresh handle it returns`,
    },
  ],
  isError: true,
})
