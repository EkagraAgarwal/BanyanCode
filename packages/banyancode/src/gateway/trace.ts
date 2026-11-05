export * as GatewayTrace from "./trace.js"

import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { Cause, Effect } from "effect"
import type { Decision, ProbeResult } from "./types.js"

// One `repository_route` event per routed call, when tracing is enabled
// (`banyancode_router_trace` / `BANYANCODE_ROUTER_TRACE=true`). Same file
// convention as v1: `<worktree>/.banyancode/trace/<sessionID>.jsonl`.

export interface RepositoryRouteTrace {
  readonly event: "repository_route"
  readonly originalTool: string
  readonly arguments: Record<string, unknown>
  readonly route: "direct" | "swap" | "fallback" | "augment"
  readonly to?: string
  readonly op?: string
  readonly reason: string
  readonly graphBuilt: boolean
  readonly graphStale: boolean
  readonly latencyMs: number
}

export interface TraceInput {
  readonly tool: string
  readonly arguments: Record<string, unknown>
  readonly decision: Decision
  readonly probe: ProbeResult | undefined
  readonly startedAt: number
}

export const traceFor = (input: TraceInput): RepositoryRouteTrace => ({
  event: "repository_route",
  originalTool: input.tool,
  arguments: input.arguments,
  route: input.decision.route,
  ...(input.decision.target === undefined
    ? {}
    : { to: input.decision.target.tool, op: input.decision.target.op }),
  reason: input.decision.reason,
  graphBuilt: input.probe?.graphBuilt === true,
  graphStale: input.probe?.stale === true,
  latencyMs: Math.max(0, Date.now() - input.startedAt),
})

const traceDir = (worktree: string) => path.join(worktree, ".banyancode", "trace")

/** Never fails: a trace write problem must not affect the routed tool call. */
export const emitTrace = (
  trace: RepositoryRouteTrace,
  input: { readonly worktree?: string; readonly sessionID?: string },
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const worktree = input.worktree
    const sessionID = input.sessionID
    if (!worktree || !sessionID) return
    const line = JSON.stringify({ ...trace, ts: Date.now(), sessionID })
    yield* Effect.tryPromise({
      try: async () => {
        const dir = traceDir(worktree)
        await mkdir(dir, { recursive: true })
        await appendFile(path.join(dir, `${sessionID}.jsonl`), `${line}\n`, "utf8")
      },
      catch: (error) =>
        new Error(`repository_route trace emit failed: ${error instanceof Error ? error.message : String(error)}`),
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("repository_route trace emit failed", { cause: Cause.pretty(cause) }),
      ),
    )
  })
