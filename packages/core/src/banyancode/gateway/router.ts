export * as RepositoryGatewayRouter from "./router"

import { Context, Effect } from "effect"
import type { RouteDecision, RouterInput, ToolRouter } from "./types"

// Context tag for the ToolRouter dependency consumed by the gateway layer.
// `defaultLayer` supplies the NoopRouter; a later wave swaps in RulesRouter /
// NeedleRouter behind BANYANCODE_ROUTER (plan §2.7) by replacing this tag.
export class ToolRouterService extends Context.Service<ToolRouterService, ToolRouter>()("@banyancode/ToolRouter") {}

// Passthrough router — the default. Every request routes DIRECT with full
// confidence so the gateway is a byte-for-byte behavioral no-op when the
// router feature is off (plan §4: "Disabled router (default) must be a
// byte-for-byte behavioral no-op").
export const NoopRouter: ToolRouter = {
  classify: (_input: RouterInput): Effect.Effect<RouteDecision, never, never> =>
    Effect.succeed({
      route: "direct",
      confidence: 1,
      reasonCodes: ["noop"],
      router: "noop",
      routerVersion: "0",
    }),
}

// Deterministic-rules router STUB. The full signal-based rules (plan §2.7,
// Phase 2 — strong DIRECT indicators for docs/config/exact-file requests and
// INTELLIGENCE indicators for callers/references/dependents/imports/etc.)
// land with the routing module in a later wave. Heuristics are intentionally
// NOT implemented here; this stub keeps every request DIRECT.
export const RulesRouter: ToolRouter = {
  classify: (_input: RouterInput): Effect.Effect<RouteDecision, never, never> =>
    Effect.succeed({
      route: "direct",
      confidence: 1,
      reasonCodes: ["rules-stub"],
      router: "rules",
      routerVersion: "0",
    }),
}
