export * as Telemetry from "./telemetry.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Cause, Effect, Stream, type Scope } from "effect"
import type { BanyanConfig } from "../config/index.js"
import type { Storage } from "../storage/index.js"
import { Definition } from "./rpc.js"
import { make, retentionMsFromDays } from "./tokens.js"
import { listToolUsage, recordToolUsage } from "./usage.js"

export interface TelemetryDeps {
  readonly storage: Storage.Interface
  readonly config: BanyanConfig.Interface
}

/**
 * Tool usage rows in the plugin DB (`codegraph_tool_usage`), the
 * `banyancode.usage` RPC, and a bounded token-attribution ring fed by
 * `session.usage.updated`.
 */
export const register = (ctx: Context, deps: TelemetryDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const loaded = yield* deps.config.get()
    const config = loaded.config
    const tokens = make({
      enabled: config.banyancode_agent_telemetry !== "off",
      ...(config.banyancode_agent_telemetry_max_events === undefined
        ? {}
        : { maxEvents: config.banyancode_agent_telemetry_max_events }),
      ...(config.banyancode_agent_telemetry_retention_days === undefined
        ? {}
        : { retentionMs: retentionMsFromDays(config.banyancode_agent_telemetry_retention_days) }),
    })

    yield* ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed") return Effect.void
      return recordToolUsage(deps.storage, event.tool, event.sessionID)
    })

    yield* ctx.rpc
      .register(Definition, {
        toolUsage: (input) =>
          listToolUsage(deps.storage, input.session === undefined ? undefined : { session: input.session }),
        tokenUsage: (input) =>
          Effect.sync(() => ({
            events: tokens.recent({
              ...(input.session === undefined ? {} : { sessionID: input.session }),
              ...(input.since === undefined ? {} : { since: input.since }),
            }),
          })),
      })
      .pipe(Effect.orDie)

    yield* ctx.event
      .subscribe({ types: ["session.usage.updated"] })
      .pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type !== "session.usage.updated") return
            const session = yield* ctx.session
              .get({ sessionID: event.data.sessionID })
              .pipe(Effect.orElseSucceed(() => undefined))
            tokens.record({
              sessionID: event.data.sessionID,
              ...(session?.model === undefined
                ? {}
                : { providerID: session.model.providerID, modelID: session.model.id }),
              ...(session?.agent === undefined ? {} : { agent: session.agent }),
              costUsd: event.data.cost,
              tokens: event.data.tokens,
            })
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("token attribution stream failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
  })
