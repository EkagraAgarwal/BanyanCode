export * as GatewayTrace from "./trace.js"

import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { Cause, Effect } from "effect"
import type { RepositoryRequest, RepositoryRoute, RouteDecision } from "./types.js"

// One `repository_route` event per routed request (v1 spec §44-45). Same file
// convention as v1: `<worktree>/.banyancode/trace/<sessionID>.jsonl`.

export interface RepositoryRouteTrace {
  readonly event: "repository_route"
  readonly originalTool: string
  readonly arguments: Record<string, unknown>
  readonly route: RepositoryRoute
  readonly confidence: number
  readonly backend: "filesystem" | "codegraph"
  readonly reasonCodes: readonly string[]
  readonly graphFreshness: "fresh" | "stale" | "building" | "unavailable"
  readonly latencyMs: number
  readonly router: string
  readonly routerVersion: string
  readonly policyVersion?: string
}

export interface TraceInput {
  readonly request: RepositoryRequest
  readonly decision: RouteDecision
  readonly route: RepositoryRoute
  readonly backend: "filesystem" | "codegraph"
  readonly startedAt: number
}

export const traceFor = (input: TraceInput): RepositoryRouteTrace => ({
  event: "repository_route",
  originalTool: input.request.originalTool,
  arguments: input.request.arguments,
  route: input.route,
  confidence: input.decision.confidence,
  backend: input.backend,
  reasonCodes: input.decision.reasonCodes,
  // v1's model-tool path never supplied repositoryContext, so the emitted
  // value was always "unavailable". Keep that byte-identical.
  graphFreshness: "unavailable",
  latencyMs: Math.max(0, Date.now() - input.startedAt),
  router: input.decision.router ?? "noop",
  routerVersion: input.decision.routerVersion ?? "0",
  ...(input.decision.policyVersion === undefined ? {} : { policyVersion: input.decision.policyVersion }),
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
