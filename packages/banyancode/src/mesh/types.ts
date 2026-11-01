/**
 * Workstream 3f — mesh/orchestrator data model.
 *
 * The shapes and literals match v1 (`packages/core/src/banyancode/types.ts`)
 * so the LLM-facing tool surface is unchanged. Storage is the plugin's own
 * SQLite database (tables created by `storage/migrations.ts`), not v2's
 * session tables: the mesh never reads or writes v2 internals directly.
 */

export const MESSAGE_KINDS = [
  "request",
  "inform",
  "answer",
  "poll",
  "steer",
  "checkpoint",
  "plan",
  "plan_update",
  "kill",
  "review",
] as const
export type MessageKind = (typeof MESSAGE_KINDS)[number]

export interface SubagentMessage {
  readonly id: string
  readonly parentSessionID: string
  readonly fromSession: string
  readonly fromAgent: string
  readonly toSession?: string
  readonly toAgent?: string
  readonly kind: MessageKind
  /** planID correlation for `plan` / `plan_update` messages (v1 G3 invariant). */
  readonly planID?: string
  /** reviewID correlation for `review` messages (v1 G4 invariant). */
  readonly reviewID?: string
  readonly payload: unknown
  readonly deliveredAt?: number
  readonly createdAt: number
}

export const PLAN_STEP_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number]

export interface PlanStep {
  readonly content: string
  readonly status: PlanStepStatus
}

export const PLAN_STATUSES = ["active", "completed", "cancelled"] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]

export interface SubagentPlan {
  readonly id: string
  readonly parentSessionID: string
  readonly agent: string
  readonly sessionID: string
  readonly title: string
  readonly steps: readonly PlanStep[]
  readonly exitCriteria: string
  readonly status: PlanStatus
  readonly createdAt: number
  readonly updatedAt: number
}

export interface PlanDefinition {
  readonly title: string
  readonly steps: readonly PlanStep[]
  readonly exitCriteria: string
}

export const REVIEW_STATUSES = ["pending", "dispatched", "completed", "failed"] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

export interface SubagentReviewRequest {
  readonly id: string
  readonly parentSessionID: string
  readonly targetAgent: string
  readonly diff: string | null
  readonly description: string | null
  readonly paths: readonly string[] | null
  readonly priority: string | null
  readonly reason: string | null
  readonly status: ReviewStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly result: unknown
}

export type AgentState = "running" | "retry" | "idle" | "failed" | "interrupted" | "unknown"

export interface TokenCounts {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

/** Host-neutral session snapshot. Built from `ctx.session.list/get` or test fixtures. */
export interface MeshSessionSnapshot {
  readonly sessionID: string
  readonly parentID?: string
  readonly title?: string
  readonly agent?: string
  readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string }
  readonly cost: number
  readonly tokens: TokenCounts
  readonly createdAt: number
  readonly updatedAt: number
  /** Start of the most recent execution while it runs. */
  readonly busyAt?: number
  /** End of the most recent completed execution. */
  readonly idleAt?: number
  readonly outcome?: "succeeded" | "failed" | "interrupted"
}

export interface MeshNode {
  readonly sessionID: string
  readonly parentID?: string
  readonly title?: string
  readonly agent?: string
  readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string }
  readonly state: AgentState
  readonly cost: number
  readonly tokens: TokenCounts
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastActivityAt?: number
  readonly children: readonly MeshNode[]
}

export interface MeshStatus {
  readonly roots: readonly MeshNode[]
  readonly generatedAt: number
}

export interface CheckinPeer {
  readonly agent: string
  readonly sessionID: string
  readonly lastSeenAt: number
  readonly lastCheckpoint?: { readonly summary: string; readonly todos: unknown }
}

export interface PeerInfo {
  readonly sessionID: string
  readonly agent: string
  readonly status: "active" | "idle" | "disconnected"
  readonly lastSeenAt: number
  readonly cost?: number
  readonly tokens?: TokenCounts
  readonly lastActivityAt?: number
  readonly blockedReason?: string
}

/** v2 agent ids owned by workstream 3d. Referenced by id only. */
export const AGENT = {
  orchestrator: "orchestrator",
  coder: "coder",
  scout: "scout",
  researcher: "researcher",
  reviewer: "reviewer",
  explore: "explore",
  build: "build",
} as const

/** Agents allowed to write canonical `scope=global` shared notes (v1 rule). */
export const GLOBAL_NOTE_AGENTS: ReadonlySet<string> = new Set([AGENT.build, AGENT.orchestrator])

export const emptyTokens = (): TokenCounts => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
})
