export * as McpIsolation from "./isolation"

import path from "node:path"

export const IsolationModes = ["shared", "worktree"] as const
export type IsolationMode = (typeof IsolationModes)[number]

export const PermissionPolicies = ["reject", "edits", "yolo"] as const
export type PermissionPolicy = (typeof PermissionPolicies)[number]

export class McpPolicyError extends Error {
  readonly code = "MCP_POLICY_REJECTED" as const
}

export const resolvePermission = (input: {
  readonly requested?: PermissionPolicy
  readonly configured?: PermissionPolicy
  readonly allowYolo: boolean
}): PermissionPolicy => {
  const effective = input.requested ?? input.configured ?? "reject"
  if (effective === "yolo" && !input.allowYolo) {
    throw new McpPolicyError(
      'permission "yolo" requires the server flag --allow-yolo (maps banyancode_yolo_mode); retry with "edits" or "reject"',
    )
  }
  return effective
}

export const isInsideRoot = (root: string, target: string): boolean => {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, target)
  const rel = path.relative(resolvedRoot, resolved)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export type PermissionDecision = "approve" | "reject" | "defer"

export const decidePermissionRequest = (input: {
  readonly policy: PermissionPolicy
  readonly cwd: string
  readonly worktreeRoot?: string
  readonly kind: "edit" | "write" | "bash" | "network" | "other"
  readonly target?: string
}): PermissionDecision => {
  if (input.kind === "edit" || input.kind === "write") {
    if (input.policy === "reject") return "reject"
    // Edits auto-approve inside --cwd (or inside the task worktree) only.
    const root = input.worktreeRoot ?? input.cwd
    if (input.target !== undefined && !isInsideRoot(root, input.target)) return "reject"
    return "approve"
  }
  // Bash and network follow the existing config rules, never the MCP policy.
  if (input.kind === "bash" || input.kind === "network") return "defer"
  return "reject"
}

export interface TaskStart {
  readonly taskId: string
  readonly isolation: IsolationMode
  readonly writeCapable: boolean
}

export interface TaskStartResult {
  readonly status: "running" | "queued"
  readonly worktreePath?: string
  readonly branch?: string
}

interface Slot extends TaskStart {
  status: "running" | "queued"
  worktreePath?: string
  branch?: string
}

// Worktree tasks leave changes uncommitted. Merging stays with the caller or
// user; BanyanCode never commits on MCP's behalf.
export const MCP_NO_COMMIT = true as const

export class McpTaskTracker {
  private readonly slots = new Map<string, Slot>()
  private readonly queue: Array<string> = []

  constructor(
    private readonly opts: {
      readonly maxConcurrentTasks: number
      readonly maxSubagents: number
      readonly allocateWorktree?: (taskId: string) => { readonly path: string; readonly branch: string }
    },
  ) {}

  get runningCount(): number {
    let count = 0
    for (const slot of this.slots.values()) {
      if (slot.status === "running") count += 1
    }
    return count
  }

  get queuedCount(): number {
    return this.queue.length
  }

  get effectiveCap(): number {
    return Math.max(1, Math.min(this.opts.maxConcurrentTasks, this.opts.maxSubagents))
  }

  tryStart(input: TaskStart): TaskStartResult {
    if (input.isolation === "shared" && input.writeCapable) {
      for (const slot of this.slots.values()) {
        if (slot.isolation === "shared" && slot.writeCapable && slot.status === "running") {
          throw new McpPolicyError(
            `second write-capable shared task rejected while "${slot.taskId}" is running; retry with isolation "worktree"`,
          )
        }
      }
    }
    let worktreePath: string | undefined
    let branch: string | undefined
    if (input.isolation === "worktree") {
      const allocated = this.opts.allocateWorktree
        ? this.opts.allocateWorktree(input.taskId)
        : { path: path.join("worktrees", input.taskId), branch: `mcp/${input.taskId}` }
      worktreePath = allocated.path
      branch = allocated.branch
    }
    if (this.runningCount >= this.effectiveCap) {
      this.slots.set(input.taskId, { ...input, status: "queued", worktreePath, branch })
      this.queue.push(input.taskId)
      return { status: "queued", ...(worktreePath !== undefined ? { worktreePath, branch } : {}) }
    }
    this.slots.set(input.taskId, { ...input, status: "running", worktreePath, branch })
    return { status: "running", ...(worktreePath !== undefined ? { worktreePath, branch } : {}) }
  }

  finish(taskId: string): void {
    this.slots.delete(taskId)
    const index = this.queue.indexOf(taskId)
    if (index >= 0) this.queue.splice(index, 1)
    while (this.runningCount < this.effectiveCap) {
      const nextId = this.queue.shift()
      if (nextId === undefined) return
      const next = this.slots.get(nextId)
      if (next === undefined) continue
      this.slots.set(nextId, { ...next, status: "running" })
    }
  }

  statusOf(taskId: string): Slot | undefined {
    return this.slots.get(taskId)
  }

  // Stdio disconnect aborts the task; with --attach it keeps running on the
  // attached server and stays pickable again by task_id.
  onDisconnect(
    taskId: string,
    opts: { readonly attached: boolean; readonly abortRunning?: (taskId: string) => void },
  ): "aborted" | "kept" {
    if (opts.attached) return "kept"
    opts.abortRunning?.(taskId)
    this.finish(taskId)
    return "aborted"
  }
}
