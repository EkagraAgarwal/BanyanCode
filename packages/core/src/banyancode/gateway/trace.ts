export * as RepositoryGatewayTrace from "./trace"

import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { Cause, Effect } from "effect"
import type { GatewayOutcome } from "./gateway"
import type {
  RepositoryRequest,
  RepositoryResultSource,
  RepositoryRoute,
  RouteDecision,
} from "./types"

// `repository_route` trace events (spec §44-45, §43). One event per routed
// request, written as a JSON line into the shared Banyan JSONL trace file
// `<worktree>/.banyancode/trace/<sessionID>.jsonl` — the same directory and
// per-session file convention used by `observability/trace.ts` record().
// Phase 1 emits on every execute(); the plan's bridge/drain for bus delivery
// is a later wave and lives in the opencode package.

export interface RepositoryRouteTrace {
  readonly event: "repository_route"
  readonly originalTool: string
  readonly arguments: Record<string, unknown>
  readonly route: RepositoryRoute
  readonly confidence: number
  readonly backend: RepositoryResultSource
  readonly reasonCodes: readonly string[]
  readonly graphFreshness: "fresh" | "stale" | "building" | "unavailable"
  readonly latencyMs: number
  // Router provenance (spec §43): implementation name + versions so benchmark
  // comparisons stay meaningful across router/policy releases.
  readonly router: string
  readonly routerVersion: string
  readonly policyVersion?: string
}

const traceDir = (worktree: string) => path.join(worktree, ".banyancode", "trace")

// Pure builder: maps the request/decision/outcome onto the §44 trace shape.
// `startedAt` is a `Clock.currentTimeMillis` timestamp captured at execute()
// entry; latencyMs is the wall-clock delta.
export const traceFor = (
  request: RepositoryRequest,
  decision: RouteDecision,
  outcome: GatewayOutcome,
  startedAt: number,
): RepositoryRouteTrace => ({
  event: "repository_route",
  originalTool: request.originalTool,
  arguments: request.arguments,
  route: outcome.route,
  confidence: decision.confidence,
  backend: outcome.route === "direct" ? "filesystem" : outcome.result.source,
  reasonCodes: decision.reasonCodes,
  graphFreshness: request.repositoryContext?.graphStatus ?? "unavailable",
  latencyMs: Math.max(0, Date.now() - startedAt),
  router: decision.router ?? "noop",
  routerVersion: decision.routerVersion ?? "0",
  ...(decision.policyVersion !== undefined ? { policyVersion: decision.policyVersion } : {}),
})

// Never-failing by contract (spec §35): any write failure is logged and
// swallowed so a trace problem can never fail the routed request.
// A missing worktree (no repositoryContext) or sessionID simply skips the
// write — there is no per-session file to append to.
export const emitTrace = (
  trace: RepositoryRouteTrace,
  input: { readonly worktree?: string; readonly sessionID?: string },
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const worktree = input.worktree
    const sessionID = input.sessionID
    if (!worktree || !sessionID) return
    const line: RepositoryRouteTrace & { readonly ts: number; readonly sessionID: string } = {
      ...trace,
      ts: Date.now(),
      sessionID,
    }
    yield* Effect.tryPromise({
      try: async () => {
        const dir = traceDir(worktree)
        await mkdir(dir, { recursive: true })
        await appendFile(path.join(dir, `${sessionID}.jsonl`), `${JSON.stringify(line)}\n`, "utf8")
      },
      catch: (error) =>
        new Error(`repository_route trace emit failed: ${error instanceof Error ? error.message : String(error)}`),
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("repository_route trace emit failed", { cause: Cause.pretty(cause) }),
      ),
    )
  })
