import type { Context } from "@opencode/plugin/effect/plugin"
import { Cause, Effect, Stream, type Scope } from "effect"
import { randomUUID } from "node:crypto"
import type { BanyanConfig } from "../config/index.js"
import type { Storage } from "../storage/index.js"
import {
  DEFAULT_MAX_EVENTS,
  DEFAULT_RETENTION_DAYS,
  exportAgentEvents,
  makeAgentTelemetryStore,
  summarizeAgentEvents,
  type AgentEfficiencyEvent,
} from "./agent-telemetry.js"
import { makeProviderUsage, observeRateLimitResponse } from "./provider-usage.js"
import { Definition } from "./rpc.js"
import { make, retentionMsFromDays } from "./tokens.js"
import { listToolUsage, recordToolUsage } from "./usage.js"

export interface TelemetryDeps {
  readonly storage: Storage.Interface
  readonly config: BanyanConfig.Interface
}

/**
 * Tool usage rows in the plugin DB (`codegraph_tool_usage`), the
 * `banyancode.usage` RPC (tool/token/provider/agent telemetry), a bounded
 * token-attribution ring fed by `session.usage.updated`, the provider-usage
 * collector fed by observed rate-limit headers, and the local
 * agent-efficiency event store.
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

    const providerUsage = makeProviderUsage({
      providers: () =>
        ctx.provider.list().pipe(
          Effect.map((result) => result.data.map((provider) => ({ id: provider.id, name: provider.name }))),
          Effect.orElseSucceed(() => []),
        ),
      // Result-only seam: core resolves the credential and performs the
      // provider's fixed usage request. The plugin never sees a key or token
      // and cannot choose a URL, header, or fetch implementation.
      usage: (input) =>
        typeof ctx.provider.usage === "function"
          ? ctx.provider.usage(input)
          : Effect.succeed({ snapshots: [] }),
    })

    const agentTelemetry = makeAgentTelemetryStore(ctx.storage)
    const agentEnabled = config.banyancode_agent_telemetry !== "off"
    const retentionDays = config.banyancode_agent_telemetry_retention_days ?? DEFAULT_RETENTION_DAYS
    const maxEvents = config.banyancode_agent_telemetry_max_events ?? DEFAULT_MAX_EVENTS

    const record = (event: AgentEfficiencyEvent) => (agentEnabled ? agentTelemetry.record(event) : Effect.void)

    yield* ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed") return Effect.void
      return recordToolUsage(deps.storage, event.tool, event.sessionID).pipe(
        Effect.andThen(
          record({
            schemaVersion: 1,
            eventID: `evt-${randomUUID()}`,
            eventType: "tool.finished",
            occurredAt: Date.now(),
            runID: event.sessionID,
            sessionID: event.sessionID,
            agentRole: event.agent,
            toolCallID: event.id,
            metadata: { tool_name: event.tool },
          }),
        ),
      )
    })

    yield* ctx.session
      .hook("http.response", (event) =>
        Effect.sync(() => {
          // Only normalized numeric/reset values are stored; raw headers and
          // credentials never leave this function.
          observeRateLimitResponse(event.model.providerID, event.response.headers)
        }),
      )
      .pipe(Effect.orDie)

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
        providers: () => providerUsage.snapshots(),
        providersRefresh: (input) =>
          providerUsage.snapshots({
            force: true,
            ...(input.providerID === undefined ? {} : { providerID: input.providerID }),
          }),
        providerList: () => providerUsage.snapshots(),
        providerRefresh: (input) =>
          providerUsage.snapshots({
            force: true,
            ...(input.providerID === undefined ? {} : { providerID: input.providerID }),
          }),
        "telemetry.agentReport": (input) =>
          agentTelemetry
            .list(input)
            .pipe(Effect.map((events) => summarizeAgentEvents(events))),
        "telemetry.agentExport": (input) =>
          agentTelemetry.list(input).pipe(
            Effect.map((events) => ({
              jsonl: exportAgentEvents(events),
              count: events.length,
              events: [...events],
            })),
          ),
        "telemetry.agentPrune": (input) =>
          agentTelemetry
            .prune({
              ...(input.retentionMs === undefined ? {} : { retentionMs: input.retentionMs }),
              ...(input.maxEvents === undefined ? {} : { maxEvents: input.maxEvents }),
            })
            .pipe(Effect.as({ ok: true })),
      })
      .pipe(Effect.orDie)

    yield* agentTelemetry
      .prune({
        retentionMs: Math.max(0, retentionDays) * 24 * 60 * 60 * 1000,
        maxEvents: Math.max(1, maxEvents),
      })
      .pipe(Effect.forkScoped({ startImmediately: true }))

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
            const input = event.data.tokens.input
            const cached = event.data.tokens.cache.read
            yield* record({
              schemaVersion: 1,
              eventID: `evt-${randomUUID()}`,
              eventType: "model.finished",
              occurredAt: Date.now(),
              runID: event.data.sessionID,
              sessionID: event.data.sessionID,
              ...(session?.agent === undefined ? {} : { agentRole: session.agent }),
              modelCallID: randomUUID(),
              metadata: {
                ...(session?.model === undefined
                  ? {}
                  : { provider: session.model.providerID, requested_model: session.model.id }),
                input_tokens: input,
                output_tokens: event.data.tokens.output,
                cached_input_tokens: cached,
                uncached_input_tokens: Math.max(0, input - cached),
                cost: event.data.cost,
              },
            })
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("token attribution stream failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
  })
