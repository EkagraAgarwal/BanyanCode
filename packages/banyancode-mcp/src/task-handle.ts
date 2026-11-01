// Opaque task handles. Never the raw `ses_…` id: the handle is
// high-entropy, unguessable, and safe to hand to an unauthenticated caller.
// Dependency-free so both the engine and the MCP layer can import it.
export const TASK_HANDLE_PREFIX = "btask_" as const

const HANDLE_BYTES = 32
const HANDLE_PATTERN = /^btask_[0-9a-f]{64}$/

export const newTaskHandle = (): string => `${TASK_HANDLE_PREFIX}${randomHex(HANDLE_BYTES)}`

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export const isTaskHandleShape = (id: unknown): id is string =>
  typeof id === "string" && HANDLE_PATTERN.test(id)

export function assertHandleShape(id: unknown): asserts id is string {
  if (!isTaskHandleShape(id)) {
    const seen = typeof id === "string" ? id.slice(0, 80) : String(id).slice(0, 80)
    throw new Error(`not a banyan task handle: expected "${TASK_HANDLE_PREFIX}<64 hex chars>", got "${seen}"`)
  }
}

export * as TaskHandle from "./task-handle"
