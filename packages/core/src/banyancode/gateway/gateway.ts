export * as RepositoryGateway from "./gateway"

import { Clock, Context, Effect, Layer } from "effect"
import { NoopRouter, ToolRouterService } from "./router"
import { normalize } from "./normalizer"
import { emitTrace, traceFor } from "./trace"
import type { RepositoryOperation, RepositoryRequest, RepositoryResult, RouteDecision } from "./types"

// Phase 0 outcome: the gateway never executes a backend while the default
// NoopRouter routes every request DIRECT. `{ route: "intelligence" }` is the
// seam a later phase fills once INTELLIGENCE execution is wired (plan §2.4).
export type GatewayOutcome =
  | { readonly route: "direct" }
  | { readonly route: "intelligence"; readonly result: RepositoryResult }

export interface Interface {
  readonly execute: (request: RepositoryRequest) => Effect.Effect<GatewayOutcome, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/RepositoryGateway") {}

// Backend seam (plan §2.4): one unit of INTELLIGENCE execution. A BackendSelector
// picks the first backend that `supports` a normalized operation.
export interface RepositoryBackend {
  readonly supports: (operation: RepositoryOperation) => boolean
  readonly execute: (operation: RepositoryOperation) => Effect.Effect<RepositoryResult, never, never>
}

export interface BackendSelector {
  readonly select: (operation: RepositoryOperation) => RepositoryBackend | undefined
}

export const makeBackendSelector = (backends: readonly RepositoryBackend[]): BackendSelector => ({
  select: (operation) => backends.find((backend) => backend.supports(operation)),
})

// Resolve the GatewayOutcome for a decision through the backend selector seam.
// DIRECT short-circuits; a non-DIRECT decision with no matching backend falls
// back to DIRECT (fail-closed, spec §35 — never widen R).
const resolveOutcome = (
  operation: RepositoryOperation,
  decision: RouteDecision,
  selector: BackendSelector,
): Effect.Effect<GatewayOutcome, never, never> => {
  if (decision.route === "direct") return Effect.succeed({ route: "direct" } as const)
  const backend = selector.select(operation)
  if (!backend) return Effect.succeed({ route: "direct" } as const)
  return backend.execute(operation).pipe(Effect.map((result) => ({ route: "intelligence", result } as const)))
}

// Minimal DIRECT executor for content operations: emits a filesystem-source
// result without touching the graph. Defined here as the reference backend
// for the selector seam; Phase 0 does not invoke it — execute() short-circuits
// to `{ route: "direct" }` before backend selection, so behavior is unchanged.
export const directBackend: RepositoryBackend = {
  supports: (operation) => operation.kind === "content",
  execute: (operation) =>
    Effect.succeed({
      route: "direct",
      operation,
      source: "filesystem",
      results: operation.kind === "content" ? [{ path: operation.path, line: operation.range?.startLine ?? 1 }] : [],
      provenance: {
        originalTool: "internal",
        resolvedOperation: operation.kind,
        router: "noop",
        routerVersion: "0",
      },
    }),
}

export const layer: Layer.Layer<Service, never, ToolRouterService> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const router = yield* ToolRouterService
    const selector = makeBackendSelector([directBackend])

    const execute = (request: RepositoryRequest): Effect.Effect<GatewayOutcome, never, never> =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const operation = yield* normalize(request)
        const decision = yield* router.classify({
          userRequest: request.userRequest,
          toolName: request.originalTool,
          arguments: request.arguments,
          recentToolCalls: request.recentToolCalls ?? [],
          investigationState: request.investigationState,
          repositoryContext: request.repositoryContext,
        })
        const outcome = yield* resolveOutcome(operation, decision, selector)
        // Phase 1 tracing (spec §44): one `repository_route` event per routed
        // request, written to the per-session JSONL trace file. emitTrace never
        // fails (catchCause inside), so R stays never.
        const trace = traceFor(request, decision, outcome, startedAt)
        yield* emitTrace(trace, {
          worktree: request.repositoryContext?.root,
          sessionID: request.sessionID,
        })
        return outcome
      })

    return Service.of({ execute })
  }),
)

export const defaultLayer: Layer.Layer<Service, never, never> = layer.pipe(
  Layer.provide(Layer.succeed(ToolRouterService, NoopRouter)),
)
