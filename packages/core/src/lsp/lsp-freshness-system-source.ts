/**
 * BanyanCode LSP freshness system source.
 *
 * Renders a one-line note in the system prompt when the LspFreshnessService
 * is active (i.e. a `start()` call has been made and the watcher is
 * observing file changes). Mirrors the `CodegraphSystemSource` pattern
 * (static policy + dynamic state) but stays a one-liner because the
 * freshness service is plumbing, not a behavior change for the model.
 *
 * V1 callers reach the text through `load({...})` (the service path) when
 * `LspFreshnessService` is in scope, and a fallback no-op otherwise. V2
 * callers register the source through `register(registry)` against
 * `SystemContextRegistry.Service`; registration is skipped entirely when
 * BanyanCode is disabled.
 */

import { Context, Effect, Layer, Schema } from "effect"
import { LspFreshnessService } from "./lsp-freshness-service"
import { SystemContext } from "../system-context"
import { SystemContextRegistry } from "../system-context/registry"

export interface LspFreshnessSystemInput {
  readonly status?: { readonly running: boolean; readonly root?: string }
}

export interface Interface {
  readonly load: (input?: LspFreshnessSystemInput) => Effect.Effect<string, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/LspFreshnessSystemSource") {}

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

const formatText = (input: LspFreshnessSystemInput | undefined): string => {
  const status = input?.status
  if (!status || !status.running) return ""
  const root = status.root ? ` (root: ${status.root})` : ""
  return `LSP freshness watcher is active${root}. File changes are recorded in \`lsp_invalidation_events\`; any subsequent LSP tool call may surface stale state until the next file save settles.`
}

const loadImpl: Interface["load"] = Effect.fn("LspFreshnessSystemSource.load")(function* (input) {
  // If the service is in scope, prefer its live status. Otherwise accept
  // the caller-supplied status (e.g. V1 path that already has a snapshot).
  const opt = yield* Effect.serviceOption(LspFreshnessService.Service)
  if (opt._tag === "Some") {
    const status = yield* opt.value.status()
    return formatText({ status: { running: status.running, ...(status.root !== undefined ? { root: status.root } : {}) } })
  }
  return formatText(input)
})

export const layer: Layer.Layer<Service, never, LspFreshnessService.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of({ load: loadImpl })
  }),
)

export const defaultLayer: Layer.Layer<Service, never, LspFreshnessService.Service> = layer

const sourceKey = SystemContext.Key.make("banyancode/lsp-freshness-status")
const stringCodec = Schema.toCodecJson(Schema.String)

export const register = Effect.fn("LspFreshnessSystemSource.register")(function* (
  registry: SystemContextRegistry.Interface,
) {
  if (!banyancodeEnabled()) return
  const source = SystemContext.make<string>({
    key: sourceKey,
    codec: stringCodec,
    load: Effect.gen(function* () {
      const opt = yield* Effect.serviceOption(LspFreshnessService.Service)
      if (opt._tag === "None") return ""
      const status = yield* opt.value.status()
      return formatText({ status: { running: status.running, ...(status.root !== undefined ? { root: status.root } : {}) } })
    }),
    baseline: (current) => current,
    update: (_previous, current) => current,
  })
  const entry: SystemContextRegistry.Entry = {
    key: sourceKey,
    load: Effect.succeed(source),
  }
  yield* registry.register(entry)
})

export * as LspFreshnessSystemSource from "./lsp-freshness-system-source"
