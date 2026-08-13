export * as RepositoryGateway from "./gateway"

import { Clock, Context, Effect, Layer, Option } from "effect"
import { Service as BanyanConfigService } from "../banyan-config"
import { augmentBackend } from "./augment"
import { intelligenceBackend } from "./backends"
import { NoopRouter, ROUTER_IDENTITY, ROUTER_VERSION, RulesRouter, ToolRouterService } from "./router"
import { normalize } from "./normalizer"
import { emitTrace, traceFor } from "./trace"
import type { RepositoryOperation, RepositoryRequest, RepositoryResult, RouteDecision, ToolRouter } from "./types"

// Outcome of a routed request. DIRECT falls through to the original tool;
// INTELLIGENCE carries a backend-produced result the caller may substitute
// for the model-facing output (the V2 registry hook renders it; the original
// tool still runs and its storage output is preserved). AUGMENT (Phase 7,
// spec §6.2/§29/§117) keeps the original operation and carries an optional
// compact symbol header the caller may append to the exact content; `header`
// is the model-facing one-liner, `result` is the graph-derived internal
// payload (source "codegraph").
export type GatewayOutcome =
  | { readonly route: "direct" }
  | { readonly route: "intelligence"; readonly result: RepositoryResult }
  | { readonly route: "augment"; readonly header: string; readonly result: RepositoryResult }

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

// Authoritative provenance (spec §43, §60): stamped from the request +
// decision because backends only see the operation. Applies to both
// INTELLIGENCE and AUGMENT results so graph-derived payloads never masquerade
// as filesystem output.
const stampProvenance = (
  request: RepositoryRequest,
  targetOperation: RepositoryOperation,
  decision: RouteDecision,
  result: RepositoryResult,
): RepositoryResult => ({
  ...result,
  provenance: {
    originalTool: request.originalTool,
    resolvedOperation:
      targetOperation.kind === "relationship"
        ? `relationship:${targetOperation.relation}`
        : targetOperation.kind,
    router: decision.router ?? ROUTER_IDENTITY,
    routerVersion: decision.routerVersion ?? ROUTER_VERSION,
  },
})

// Resolve the GatewayOutcome for a decision through the backend selector seam.
// DIRECT short-circuits; a non-DIRECT decision with no matching backend falls
// back to DIRECT (fail-closed, spec §35 — never widen R). The backend executes
// the ROUTER's operation (the resolved semantic op) when present, falling back
// to the normalized one. A backend result with route "augment" (from the
// augment backend on a content op, reached by an "augment" decision OR an
// "intelligence" decision on a content operation) produces the AUGMENT
// outcome carrying the compact header; any other non-intelligence result
// falls through to DIRECT.
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
      if (result.route === "augment") {
        const stamped = stampProvenance(request, targetOperation, decision, result)
        return { route: "augment", header: stamped.header ?? "", result: stamped } as const
      }
      // Fail-closed passthrough: a backend that cannot answer cleanly returns a
      // result with route "direct" (e.g. a relation without a graph mapping) —
      // the gateway falls through to the original tool untouched.
      if (result.route !== "intelligence") return { route: "direct" } as const
      return {
        route: "intelligence",
        result: stampProvenance(request, targetOperation, decision, result),
      } as const
    }),
  )
}

// Minimal DIRECT executor for content operations: emits a filesystem-source
// result without touching the graph. Defined here as the reference backend
// for the selector seam; the NoopRouter (explicit "off") never produces a
// non-DIRECT decision, so this backend is not invoked on an opt-out install.
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
    // augmentBackend first: it claims every content operation, so a content op
    // reached via an "augment" RouteDecision OR an "intelligence" decision on
    // a content read resolves to AUGMENT (gated by banyancode_augment_read,
    // fail-closed to direct when off). directBackend remains as the reference
    // filesystem backend for the seam; intelligenceBackend handles
    // symbol/relationship ops.
    const selector = makeBackendSelector([augmentBackend, directBackend, intelligenceBackend])

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
        // request, written to the per-session JSONL trace file. Gated by
        // `banyancode_router_trace` (or env BANYANCODE_ROUTER_TRACE=true) —
        // off by default, so the default install writes nothing. emitTrace
        // never fails (catchCause inside), so R stays never.
        if (yield* traceEnabled()) {
          const trace = traceFor(request, decision, outcome, startedAt)
          yield* emitTrace(trace, {
            worktree: request.repositoryContext?.root,
            sessionID: request.sessionID,
          })
        }
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

// Trace emission gate (plan §4): `repository_route` traces are OFF by default.
// Emit only when the env override BANYANCODE_ROUTER_TRACE=true is set OR the
// `banyancode_router_trace` config key is explicitly true. A missing
// BanyanConfigService (serviceOption None) means no trace. Never fails.
const traceEnabled = (): Effect.Effect<boolean, never, never> =>
  Effect.gen(function* () {
    if (process.env.BANYANCODE_ROUTER_TRACE === "true") return true
    const configOpt = yield* Effect.serviceOption(BanyanConfigService)
    if (Option.isNone(configOpt)) return false
    const config = yield* configOpt.value.get()
    return config.banyancode_router_trace === true
  })

// Router selection (plan §2.7, §4): the env override (`BANYANCODE_ROUTER`)
// wins, then the `banyancode_router` config key. "off" (env or config)
// resolves to the NoopRouter passthrough (byte-for-byte behavioral no-op);
// "rules" activates the deterministic RulesRouter. Everything else — unset
// env, unset config key, unknown values, or a missing BanyanConfigService
// (serviceOption None) — defaults to the RulesRouter: the gateway is ON by
// default and must be opted out of explicitly.
const routerFromConfig: Effect.Effect<ToolRouter, never, never> = Effect.gen(function* () {
  const env = process.env.BANYANCODE_ROUTER
  if (env === "off") return NoopRouter
  if (env === "rules") return RulesRouter
  const configOpt = yield* Effect.serviceOption(BanyanConfigService)
  if (Option.isNone(configOpt)) return RulesRouter
  const config = yield* configOpt.value.get()
  if (config.banyancode_router === "off") return NoopRouter
  return RulesRouter
})

// Router resolution deferred to per-classify time instead of layer build time
// (FIX 2): a BanyanConfigService supplied as a Layer.mergeAll sibling (not a
// provide dependency) is invisible inside defaultLayer's construction gen, so
// a build-time routerFromConfig would silently ignore `banyancode_router:
// "off"` in such compositions — only env or a direct Layer.provideMerge
// dependency worked. routerFromConfig never fails (catchAll inside), so R
// stays never. This makes config/env effective per request regardless of layer
// composition order.
const lazyRouter: ToolRouter = {
  classify: (input) => Effect.flatMap(routerFromConfig, (router) => router.classify(input)),
}

export const defaultLayer: Layer.Layer<Service, never, never> = Layer.effect(
  Service,
  Effect.gen(function* () {
    return yield* buildGateway(lazyRouter)
  }),
)
