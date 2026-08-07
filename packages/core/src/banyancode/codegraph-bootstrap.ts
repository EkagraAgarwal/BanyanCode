export * as CodegraphBootstrap from "./codegraph-bootstrap"

import { Cause, Context, Duration, Effect, Layer, Option, Ref, Schema } from "effect"
import path from "path"
import { FSUtil } from "../fs-util"
import { BanyanConfigService } from "./banyan-config"
import { CodegraphReadiness } from "./codegraph-readiness"

/**
 * Session-start graph bootstrap (Phase A of the codegraph adoption plan).
 *
 * The graph/repository tools are almost never called by the model because
 * (R1) the graph is only built lazily when the model first calls a graph
 * tool (a cold-start the model learns to avoid), and (R2) the policy text
 * cannot distinguish "graph ready" from "graph absent". This service gives
 * the session layer a non-blocking kick: on session start it ensures a
 * build is running in the background (once per root), and exposes a
 * `status()` that the policy renderer reads to stamp a "Graph state:" line
 * into the model prompt.
 *
 * Everything here is deliberately non-fatal: `ensureGraph` and `status`
 * never fail and never block on a build. A missing/stale graph is still a
 * working state — the lazy auto-trigger on the first graph-tool call
 * remains the safety net.
 */

export const BootstrapState = Schema.Struct({
  state: Schema.Literals(["ready", "building", "missing"]),
  symbols: Schema.optional(Schema.Number),
})
export type BootstrapState = typeof BootstrapState.Type

export interface Interface {
  readonly ensureGraph: (input: { root: string }) => Effect.Effect<BootstrapState, never, never>
  readonly status: () => Effect.Effect<BootstrapState, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphBootstrap") {}

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

// Map a CodegraphReadiness result onto the model-facing bootstrap state.
// A stale graph is still a graph (the watcher handles drift), so stale
// maps to ready with the symbol count attached.
const mapState = (result: CodegraphReadiness.ReadinessResult): BootstrapState => {
  switch (result.reason) {
    case "ready":
    case "stale":
      return { state: "ready", symbols: result.totalFiles }
    case "building":
      return { state: "building" }
    case "missing":
    case "failed":
      return { state: "missing" }
  }
}

export const layer: Layer.Layer<Service, never, CodegraphReadiness.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (!banyancodeEnabled()) {
      const noop: BootstrapState = { state: "missing" }
      return Service.of({
        ensureGraph: () => Effect.succeed(noop),
        status: () => Effect.succeed(noop),
      })
    }

    const readiness = yield* CodegraphReadiness.Service
    // One background build per root, ever. The value is irrelevant — the
    // map is only used as a set of in-flight roots.
    const inflight = yield* Ref.make<Map<string, boolean>>(new Map())

    const ensureGraph: Interface["ensureGraph"] = Effect.fn("CodegraphBootstrap.ensureGraph")(function* (input) {
      // Opt-out: the bootstrap env flag turns ensureGraph into a pure
      // status probe (the lazy auto-trigger on tool call still works).
      if (process.env.BANYANCODEGRAPH_BOOTSTRAP === "0") return yield* status()

      // Filesystem-root guard: never treat a whole drive as a workspace.
      if (!input.root) return { state: "missing" }
      if (path.parse(path.resolve(input.root)).root === path.resolve(input.root)) {
        return { state: "missing" }
      }

      // Honor the codegraph_auto_update disable semantics: watch_enabled
      // false means the user does not want background builds, so we only
      // report status (the lazy auto-trigger on tool call still works).
      const configOpt = yield* Effect.serviceOption(BanyanConfigService.Service)
      if (Option.isSome(configOpt)) {
        const cfg = yield* configOpt.value.get()
        if (cfg.banyancode_codegraph_watch_enabled === false) return yield* status()
      }

      // Quick read: a usable graph (or a build already running) means
      // there is nothing to kick.
      const result = yield* readiness.status()
      if (result.reason === "ready" || result.reason === "stale" || result.reason === "building") {
        return mapState(result)
      }

      // missing/failed: kick a background build, once per root. The fork
      // is detached so the caller never waits on the build; a timeout only
      // interrupts the ensureReady poll — the underlying build fiber owns
      // its own lifecycle and keeps running, which is exactly the desired
      // "pending marker" semantics.
      const root = input.root
      const alreadyInflight = yield* Ref.modify(inflight, (m) => {
        if (m.has(root)) return [true, m] as const
        const next = new Map(m)
        next.set(root, true)
        return [false, next] as const
      })
      if (alreadyInflight) return { state: "building" }

      const rawTimeout = Number(process.env.BANYANCODEGRAPH_BOOTSTRAP_TIMEOUT_MS ?? 60000)
      const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 60000

      yield* Effect.forkDetach(
        readiness
          .ensureReady({ root })
          .pipe(
            Effect.timeout(Duration.millis(timeoutMs)),
            Effect.catchCause((cause) =>
              Effect.logWarning("codegraph bootstrap: background build failed", { cause: Cause.pretty(cause) }),
            ),
          )
          .pipe(
            Effect.ensuring(
              Ref.update(inflight, (m) => {
                const next = new Map(m)
                next.delete(root)
                return next
              }),
            ),
          ),
      )
      return { state: "building" }
    })

    const status: Interface["status"] = () =>
      Effect.gen(function* () {
        const result = yield* readiness.status()
        return mapState(result)
      })

    return Service.of({ ensureGraph, status })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CodegraphReadiness.defaultLayer),
  // CodegraphIndexer.defaultLayer leaves FSUtil.Service in R (the indexer
  // layer's own defaultLayer only provides CodegraphRepo), so satisfy it
  // here to keep the bootstrap defaultLayer closed at the type level.
  Layer.provide(FSUtil.defaultLayer),
  // The readiness defaultLayer does not pull BanyanConfig into scope; the
  // ensureGraph watch_enabled check uses serviceOption, so provide the
  // config layer here for the option to ever be Some.
  Layer.provide(BanyanConfigService.defaultLayer),
)
