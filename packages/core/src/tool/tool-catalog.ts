export * as ToolCatalog from "./tool-catalog"

import { Context, Effect, Layer } from "effect"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import {
  defaultLayer as registryDefaultLayer,
  type Materialization,
  Service as RegistryService,
} from "./registry"
import { Service as ToolsService } from "./tools"

/**
 * Single canonical tool pipeline exposed to all transports (AI SDK, CLI, TUI, SDK).
 *
 * Replaces the previous "V1 vs V2" framing — there is exactly one tool catalog.
 * `Tools.Service` continues to expose the narrow registration-only view per the
 * Location-producer contract; `ToolCatalog.Service` exposes the full surface for
 * consumers (transport adapters, debug CLIs, the orchestrator prompt).
 */
export interface Interface {
  readonly register: (tools: Readonly<Record<string, Tool.AnyTool>>) => Effect.Effect<void, never, never>
  readonly list: () => Effect.Effect<ReadonlyMap<string, Tool.AnyTool>, never, never>
  readonly materialize: (permissions?: PermissionV2.Ruleset) => Effect.Effect<Materialization, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolCatalog") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* RegistryService
    const tools = yield* ToolsService

    const register: Interface["register"] = tools.register as never
    const list: Interface["list"] = () => Effect.sync(() => registry.list())
    const materialize: Interface["materialize"] = (permissions) =>
      registry.materialize(permissions) as Effect.Effect<Materialization, never, never>

    return Service.of({ register, list, materialize })
  }),
).pipe(Layer.provide(registryDefaultLayer))

export const defaultLayer = layer
