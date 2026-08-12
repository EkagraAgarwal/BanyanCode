export * as RepositoryGateway from "./gateway"

import { Clock, Context, Effect, Layer, Option } from "effect"
import { Service as BanyanConfigService } from "../banyan-config"
import { intelligenceBackend } from "./backends"
import { NoopRouter, ROUTER_IDENTITY, ROUTER_VERSION, RulesRouter, ToolRouterService } from "./router"
import { normalize } from "./normalizer"
import { emitTrace, traceFor } from "./trace"
import type { RepositoryOperation, RepositoryRequest, RepositoryResult, RouteDecision, ToolRouter } from "./types"

// Outcome of a routed request. DIRECT falls through to the original tool;
// INTELLIGENCE carries a backend-produced result the caller may use (Phase 2
// discards it at the registry hook per the Phase 0 contract — the original
// tool always runs).
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
// back to DIRECT (fail-closed, spec §35 — never widen R). The backend executes
// the ROUTER's operation (the resolved semantic op) when present, falling back
// to the normalized one.
const resolveOutcome = (
  request: RepositoryRequest,
  operation: RepositoryOperation,
  decision: RouteDecision,
  selector: BackendSelector,
): Effect.Effect<GatewayOutcome, never, never> => {
  if (decision.route === "direct") return Effect.succeed({ route: "direct" } as const)
  const targetOperation = decision.operation ?? operation
  const backend = selector.select(targetOperation)
  if (!backend) return Effect.succeed({ route: "direct" } as const)
  return backend.execute(targetOperation).pipe(
    Effect.map((result) => {
      // Fail-closed passthrough: a backend that cannot answer cleanly returns a
      // result with route "direct" (e.g. a relation without a graph mapping) —
      // the gateway falls through to the original tool untouched.
      if (result.route !== "intelligence") return { route: "direct" } as const
      return {
        route: "intelligence",
        result: {
          ...result,
          // Authoritative provenance (spec §43): stamped here from the request
          // + decision because the backend only sees the operation.
          provenance: {
            originalTool: request.originalTool,
            resolvedOperation:
              targetOperation.kind === "relationship"
                ? `relationship:${targetOperation.relation}`
                : targetOperation.kind,
            router: decision.router ?? ROUTER_IDENTITY,
            routerVersion: decision.routerVersion ?? ROUTER_VERSION,
          },
        },
      } as const
    }),
  )
}

// Minimal DIRECT executor for content operations: emits a filesystem-source
// result without touching the graph. Defined here as the reference backend
// for the selector seam; the default NoopRouter never produces a non-DIRECT
// decision, so this backend is not invoked on the default install.
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

// Shared gateway construction given a concrete router.
const buildGateway = (router: ToolRouter): Effect.Effect<Interface, never, never> =>
  Effect.gen(function* () {
    const selector = makeBackendSelector([directBackend, intelligenceBackend])

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
        const outcome = yield* resolveOutcome(request, operation, decision, selector)
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
  })

export const layer: Layer.Layer<Service, never, ToolRouterService> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const router = yield* ToolRouterService
    return yield* buildGateway(router)
  }),
)

// Router selection (plan §2.7, §4): env override (`BANYANCODE_ROUTER=rules`)
// wins over the `banyancode_router` config key, which in turn defaults OFF.
// "rules" activates the deterministic RulesRouter; anything else (unset/
// "off"/"needle" — the needle classifier is a later wave) resolves to the
// NoopRouter passthrough, so the default install is a byte-for-byte
// behavioral no-op (plan §78). Missing BanyanConfigService (serviceOption
// None) also means OFF.
const routerFromConfig: Effect.Effect<ToolRouter, never, never> = Effect.gen(function* () {
  if (process.env.BANYANCODE_ROUTER === "rules") return RulesRouter
  const configOpt = yield* Effect.serviceOption(BanyanConfigService)
  if (Option.isNone(configOpt)) return NoopRouter
  const config = yield* configOpt.value.get()
  return config.banyancode_router === "rules" ? RulesRouter : NoopRouter
})

export const defaultLayer: Layer.Layer<Service, never, never> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const router = yield* routerFromConfig
    return yield* buildGateway(router)
  }),
)
