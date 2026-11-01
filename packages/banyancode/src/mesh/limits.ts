import type { Permission } from "@opencode/schema/permission"
import type { Info as BanyanConfigInfo } from "../config/schema.js"
import { AGENT, type MeshSessionSnapshot } from "./types.js"
import { countRunningDescendants, descendantsOf, rootOf, stateOf, type LiveState } from "./status.js"

export const DEFAULT_MAX_SUBAGENTS = 5
export const MAX_SUBAGENTS_LIMIT = 20

/** v1 nested explore budget: one concurrent, five per coder per hour. */
export const MAX_NESTED_EXPLORE_PER_CODER = 1
export const MAX_NESTED_EXPLORE_LIFETIME_PER_CODER = 5
export const NESTED_LIFETIME_WINDOW_MS = 60 * 60 * 1000

export interface LimitsConfigSnapshot {
  readonly maxSubagents: number
  readonly backgroundSubagents: boolean
  readonly swarmMode: boolean
}

export interface LimitsState {
  maxSubagents?: number
  swarmMode?: boolean
}

export const readLimits = (config: BanyanConfigInfo, state: LimitsState = {}): LimitsConfigSnapshot => {
  const raw = state.maxSubagents ?? config.banyancode_max_subagents ?? DEFAULT_MAX_SUBAGENTS
  const maxSubagents = Number.isFinite(raw)
    ? Math.min(MAX_SUBAGENTS_LIMIT, Math.max(1, Math.trunc(raw)))
    : DEFAULT_MAX_SUBAGENTS
  return {
    maxSubagents,
    backgroundSubagents: config.banyancode_background_subagents !== false,
    swarmMode: state.swarmMode ?? config.banyancode_swarm_mode === true,
  }
}

export type MaxValidation = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string }

export const validateMaxSubagents = (value: number): MaxValidation => {
  if (!Number.isInteger(value) || value < 1 || value > MAX_SUBAGENTS_LIMIT) {
    return { ok: false, error: `Max subagents must be between 1 and ${MAX_SUBAGENTS_LIMIT}` }
  }
  return { ok: true, value }
}

export interface SubagentLimitDecision {
  readonly deny: boolean
  readonly message?: string
  readonly running: number
  readonly max: number
}

/**
 * `permission.evaluate` decision for action `subagent`. v2's built-in subagent
 * tool asserts `{ action: "subagent", resources: [agentID] }` before it creates
 * the child, so denying here blocks the spawn at the same gate. Depth remains
 * v2's `experimental.subagent_depth`; this cap is the BanyanCode breadth limit.
 */
export const subagentLimitDecision = (input: {
  readonly sessions: ReadonlyMap<string, MeshSessionSnapshot>
  readonly live?: ReadonlyMap<string, LiveState>
  readonly sessionID: string
  readonly maxSubagents: number
}): SubagentLimitDecision => {
  const root = rootOf(input.sessions, input.sessionID) ?? input.sessionID
  const running = countRunningDescendants(input.sessions, root, input.live)
  if (running < input.maxSubagents) return { deny: false, running, max: input.maxSubagents }
  return {
    deny: true,
    message: `Max ${input.maxSubagents} subagents reached for this orchestration tree (${running} running). Wait for a subagent to finish, increase banyancode_max_subagents, or use /max-subagents to change the limit.`,
    running,
    max: input.maxSubagents,
  }
}

/** Mutates a `permission.evaluate` event; returns the same object for easy testing. */
export const applySubagentPermissionDecision = (
  event: {
    readonly action: string
    readonly sessionID: string
    effect: Permission.Effect
    message?: string
  },
  input: {
    readonly sessions: ReadonlyMap<string, MeshSessionSnapshot>
    readonly live?: ReadonlyMap<string, LiveState>
    readonly maxSubagents: number
  },
): typeof event => {
  if (event.action !== "subagent" || event.effect === "deny") return event
  const decision = subagentLimitDecision({
    sessions: input.sessions,
    live: input.live,
    sessionID: event.sessionID,
    maxSubagents: input.maxSubagents,
  })
  if (!decision.deny) return event
  event.effect = "deny"
  event.message = decision.message
  return event
}

export interface NestedBudgetEntry {
  readonly lifetimeCount: number
  readonly windowStart: number
}

export type NestedDecision =
  | { readonly ok: true; readonly entry: NestedBudgetEntry }
  | { readonly ok: false; readonly error: "concurrent" | "lifetime"; readonly entry: NestedBudgetEntry }

const freshWindow = (now: number): NestedBudgetEntry => ({ lifetimeCount: 0, windowStart: now })

const windowed = (entry: NestedBudgetEntry | undefined, now: number): NestedBudgetEntry => {
  if (entry === undefined) return freshWindow(now)
  if (now - entry.windowStart > NESTED_LIFETIME_WINDOW_MS) return freshWindow(now)
  return entry
}

/** Running explore children of a coder session (the v1 concurrent budget). */
export const nestedExploreRunning = (
  sessions: ReadonlyMap<string, MeshSessionSnapshot>,
  coderSessionID: string,
  live?: ReadonlyMap<string, LiveState>,
): number =>
  Array.from(sessions.values()).filter(
    (snapshot) =>
      snapshot.parentID === coderSessionID &&
      snapshot.agent === AGENT.explore &&
      stateOf(snapshot, live?.get(snapshot.sessionID)) === "running",
  ).length

/**
 * Nested spawn budget for a coder spawning a fresh explore. v1 counted a
 * concurrent cap and a 1-hour lifetime cap; the concurrent half is derived from
 * live session state here, so it survives a plugin restart better than the v1
 * in-memory fiber registry did.
 */
export const checkNestedSpawn = (input: {
  readonly sessions: ReadonlyMap<string, MeshSessionSnapshot>
  readonly live?: ReadonlyMap<string, LiveState>
  readonly coderSessionID: string
  readonly entry?: NestedBudgetEntry
  readonly now: number
}): NestedDecision => {
  const current = windowed(input.entry, input.now)
  if (nestedExploreRunning(input.sessions, input.coderSessionID, input.live) >= MAX_NESTED_EXPLORE_PER_CODER) {
    return { ok: false, error: "concurrent", entry: current }
  }
  if (current.lifetimeCount >= MAX_NESTED_EXPLORE_LIFETIME_PER_CODER) {
    return { ok: false, error: "lifetime", entry: current }
  }
  return {
    ok: true,
    entry: { lifetimeCount: current.lifetimeCount + 1, windowStart: current.windowStart },
  }
}

export interface ToolGuardDecision {
  readonly deny: boolean
  readonly message?: string
  readonly nested?: NestedBudgetEntry
}

/**
 * `tool` hook `execute.before` decision for the v2 `subagent` tool. The
 * permission hook cannot see `background` or nested-spawn intent (v2 passes
 * only resources/source), so the background gate and the coder→explore budget
 * live here. `experimental.subagent_depth` is still enforced by v2 itself.
 */
export const subagentToolGuard = (input: {
  readonly tool: string
  readonly callerSessionID: string
  readonly callerAgent: string
  readonly targetAgent: string
  readonly followUpSessionID?: string
  readonly background: boolean
  readonly backgroundEnabled: boolean
  readonly sessions: ReadonlyMap<string, MeshSessionSnapshot>
  readonly live?: ReadonlyMap<string, LiveState>
  readonly maxSubagents: number
  readonly nestedEntry?: NestedBudgetEntry
  readonly now: number
}): ToolGuardDecision => {
  if (input.tool !== "subagent") return { deny: false }
  // Follow-ups continue an existing child; they consume no new slot and carry
  // no background intent, so neither limit applies.
  if (input.followUpSessionID !== undefined) return { deny: false }
  if (input.background && !input.backgroundEnabled) {
    return {
      deny: true,
      message:
        "Background subagents are disabled by banyancode_background_subagents=false. Spawn this subagent in the foreground (background omitted or false).",
    }
  }
  const limit = subagentLimitDecision({
    sessions: input.sessions,
    live: input.live,
    sessionID: input.callerSessionID,
    maxSubagents: input.maxSubagents,
  })
  if (limit.deny) return { deny: true, message: limit.message }
  if (
    input.callerAgent === AGENT.coder &&
    input.targetAgent === AGENT.explore &&
    input.followUpSessionID === undefined
  ) {
    const nested = checkNestedSpawn({
      sessions: input.sessions,
      live: input.live,
      coderSessionID: input.callerSessionID,
      entry: input.nestedEntry,
      now: input.now,
    })
    if (!nested.ok) {
      return {
        deny: true,
        message:
          nested.error === "concurrent"
            ? `Nested explore budget reached: a coder may run ${MAX_NESTED_EXPLORE_PER_CODER} explore subagent at a time.`
            : `Nested explore budget reached: a coder may spawn ${MAX_NESTED_EXPLORE_LIFETIME_PER_CODER} explore subagents per hour.`,
        nested: nested.entry,
      }
    }
    return { deny: false, nested: nested.entry }
  }
  return { deny: false }
}

/** `--agents N` clamp for /swarm and the wave primitive. */
export const resolveWaveSize = (requested: number | undefined, running: number, max: number): number => {
  const available = Math.max(0, max - running)
  if (requested === undefined) return available
  return Math.min(Math.max(1, Math.trunc(requested)), available)
}

export const runningForRoot = (
  sessions: ReadonlyMap<string, MeshSessionSnapshot>,
  sessionID: string,
  live?: ReadonlyMap<string, LiveState>,
): number => {
  const root = rootOf(sessions, sessionID) ?? sessionID
  return countRunningDescendants(sessions, root, live)
}

export { descendantsOf, stateOf }
