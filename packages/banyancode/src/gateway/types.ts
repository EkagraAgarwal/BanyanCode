export * as GatewayTypes from "./types.js"

import type { Effect } from "effect"

// v2 repository gateway seam.
//
// Routing is a pure function of (tool, arguments, graph probe result, this
// session's swap ledger). Nothing reads the conversation: the same call routes
// the same way whatever the user typed.

export type GatewayRouteName = "swapped" | "fallback" | "augmented" | "direct"

/** Stamped on the tool result (and persisted on the tool part). */
export interface GatewayMetadata {
  readonly route: GatewayRouteName
  readonly from: string
  readonly to?: string
  /** Target operation (`outline`, `files`, `usages`). */
  readonly op?: string
  readonly reason: string
  /** Only for an outline read: file bytes minus returned bytes. */
  readonly bytesSaved?: number
}

export interface GatewayTarget {
  readonly tool: string
  readonly input: Record<string, unknown>
  readonly op: string
}

/**
 * What the graph knows about one call, measured in `execute.before`. Cheap,
 * bounded, indexed lookups only; an error or a timeout yields
 * `UNPROBED` (which always falls back).
 */
export interface ProbeResult {
  readonly graphBuilt: boolean
  /** Graph-level staleness (age/coverage) for grep and glob. */
  readonly stale: boolean
  /** Exact-name node candidates for a grep identifier. */
  readonly symbolHits?: number
  /** Indexed file facts for a read. */
  readonly indexed?: boolean
  readonly fileStale?: boolean
  readonly lines?: number
  readonly bytes?: number
  /** Indexed paths matching a glob, bounded to 1. */
  readonly matchCount?: number
}

export interface ProbeInput {
  readonly tool: string
  readonly arguments: Record<string, unknown>
  readonly root: string
}

/** Never fails: a probe problem falls back to the original tool. */
export interface GatewayProbe {
  readonly probe: (input: ProbeInput) => Effect.Effect<ProbeResult, never, never>
  /** Compact symbol header for a code-file read. */
  readonly augmentRead?: (input: { readonly path: string; readonly sessionID: string }) => Effect.Effect<
    string | undefined,
    never,
    never
  >
}

export const UNPROBED: ProbeResult = { graphBuilt: false, stale: true }

export type RouteKind = "direct" | "swap" | "fallback" | "augment"

export interface Decision {
  readonly route: RouteKind
  readonly reason: string
  readonly target?: GatewayTarget
}

/** The pure routing input. `repeat` is the session ledger's only contribution. */
export interface DecideInput {
  readonly tool: string
  readonly arguments: Record<string, unknown>
  readonly probe: ProbeResult
  /** An identical call was already swapped in this session. */
  readonly repeat: boolean
  /** Project root, forward slashes. Paths outside it never swap. */
  readonly root: string
  /** `banyancode_read_outline_lines`. */
  readonly readOutlineLines: number
  /** Whether a rewrite target is registered and permitted for this agent. */
  readonly allows: (tool: string) => boolean
}
