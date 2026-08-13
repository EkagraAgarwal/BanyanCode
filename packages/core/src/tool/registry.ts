export * as ToolRegistry from "./registry"

import { ToolOutput, type ToolCall, type ToolDefinition, type ToolResultValue } from "@opencode-ai/llm"
import { Context, Effect, Layer, Option, Scope } from "effect"
import {
  RepositoryGatewayFormatter,
  Service as RepositoryGateway,
  type GatewayOutcome,
} from "../banyancode/gateway"
import { Service as BanyanConfigService, type Interface as BanyanConfigInterface } from "../banyancode/banyan-config"
import { deriveNote, Service as InvestigationStateService } from "../banyancode/gateway/investigation"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import { definition, permission, settle, validateName, type AnyTool, type RegistrationError } from "./tool"
import { Tools } from "./tools"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
}

// Gate A/§116: the repository gateway intercepts only the conventional
// repository tools. Non-listed tools skip the hook entirely — byte-identical
// path. (read/glob activation follows grep per the plan's rollout sequence.)
const GATEWAY_TOOLS = new Set(["read", "grep", "glob"])

// Phase 7 merge (spec §6.2, §29, §117): prepend the gateway's AUGMENT header
// to the read tool's model-facing page content. The result keeps type "json"
// and the page keeps its shape with `content = `${header}\n${page.content}``.
// Read-only and fail-closed by contract (spec §35): only the read tool, only a
// TextPage-shaped json settlement (TextPage discriminator `type: "text-page"`,
// `content: string`) — grep/glob, error settlements, non-page json values, and
// an absent/non-augment outcome all fall through byte-identical. Never throws;
// an unexpected shape simply skips the merge and keeps the original result.
const mergeAugmentHeader = (
  outcome: GatewayOutcome | undefined,
  toolName: string,
  result: ToolResultValue,
): ToolResultValue => {
  if (outcome?.route !== "augment") return result
  if (toolName !== "read") return result
  if (result.type !== "json") return result
  const page = result.value
  if (typeof page !== "object" || page === null) return result
  const record = page as Record<string, unknown>
  if (record.type !== "text-page" || typeof record.content !== "string") return result
  return { type: "json", value: { ...record, content: `${outcome.header}\n${record.content}` } }
}

// INTELLIGENCE substitution (needle2 gateway plan §4): when the gateway
// resolved an INTELLIGENCE outcome, the model-facing result is replaced by a
// rendered text of the graph-derived payload (same Formatter the V1 seam
// uses). Read-only and fail-closed by contract (spec §35): only read/grep/glob
// (GATEWAY_TOOLS), only a "json" or "text" settlement, and the rendered text
// never throws (the Formatter is pure over the typed RepositoryResult). Any
// mismatch returns the result unchanged; storage `bounded.output` is untouched
// (the TUI keeps showing the raw tool ran — same precedent as the augment
// merge).
const substituteIntelligence = (
  outcome: GatewayOutcome | undefined,
  toolName: string,
  result: ToolResultValue,
): ToolResultValue => {
  if (outcome?.route !== "intelligence") return result
  if (!GATEWAY_TOOLS.has(toolName)) return result
  if (result.type !== "json" && result.type !== "text") return result
  const rendered = RepositoryGatewayFormatter.format(outcome.result.operation, outcome.result)
  return { type: "text", value: rendered }
}

// Per-tool routing kill-switches (needle2 gateway plan §4): an explicit
// `banyancode_route_<tool>: false` bypasses the gateway for that tool (the
// settle is byte-identical). A missing BanyanConfigService or an absent flag
// means routing allowed — the config only ever DISABLES the hook for a single
// tool, never enables it for a non-listed one.
const routeAllowedFor = (
  configOpt: Option.Option<BanyanConfigInterface>,
  toolName: string,
): Effect.Effect<boolean, never, never> =>
  Effect.gen(function* () {
    if (Option.isNone(configOpt)) return true
    const config = yield* configOpt.value.get()
    if (toolName === "grep" && config.banyancode_route_grep === false) return false
    if (toolName === "read" && config.banyancode_route_read === false) return false
    if (toolName === "glob" && config.banyancode_route_glob === false) return false
    return true
  })

export interface Interface {
  readonly materialize: (permissions?: PermissionV2.Ruleset) => Effect.Effect<Materialization>
  /**
   * Snapshot of all currently-registered tool entries (location-local + process-scoped
   * application). The map is keyed by tool name and orders nothing; use
   * `materialize(...).definitions` for an LLM-facing, permission-filtered projection.
   */
  readonly list: () => ReadonlyMap<string, AnyTool>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolRegistry") {}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (input: ExecuteInput, advertised?: object) {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ?? applications.entries().get(input.call.name)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised ? `Stale tool call: ${input.call.name}` : `Unknown tool: ${input.call.name}`,
          },
        }
      if (advertised && registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      // Repository Gateway interception (plan §2.1, Gate A). Optional by
      // contract: `serviceOption` never widens R, so a missing/disabled gateway
      // is a byte-for-byte no-op passthrough (precedent: tool.ts:128-129).
      // Gated to the conventional tools (read/grep/glob) — everything else
      // skips the hook. A per-tool kill-switch (`banyancode_route_<tool>:
      // false`, plan §4) bypasses the whole gateway block for that tool. The
      // outcome is captured for the Phase 7 AUGMENT merge (spec §6.2/§29/§117)
      // and the INTELLIGENCE substitution (plan §4): the read tool's json page
      // content gets the header prepended, and an intelligence outcome
      // replaces the model-facing result with the rendered graph payload;
      // every other route/tool falls through to the leaf settle unchanged, so
      // observable tool behavior is preserved while the router feature is on.
      let outcome: GatewayOutcome | undefined = undefined
      const gatewayOpt = yield* Effect.serviceOption(RepositoryGateway)
      if (Option.isSome(gatewayOpt) && GATEWAY_TOOLS.has(input.call.name)) {
        const configOpt = yield* Effect.serviceOption(BanyanConfigService)
        if (yield* routeAllowedFor(configOpt, input.call.name)) {
          // Phase 6 — Gate B context (plan §2.2): resolve the session's user
          // request, the recent tool-call names, and the per-(session, agent)
          // investigation state before routing. Every fetch is fail-closed: a
          // missing service or a failed load yields undefined/empty context and
          // the tool still runs unchanged (serviceOption + catchCause, R stays
          // never).
          const storeOpt = yield* Effect.serviceOption(SessionStore.Service)
          const messages = Option.isSome(storeOpt)
            ? yield* storeOpt.value.context(input.sessionID).pipe(Effect.catchCause(() => Effect.succeed([])))
            : []
          const userRequest = messages.filter((m) => m.type === "user").at(-1)?.text.slice(0, 200)
          const recentToolCalls = messages
            .flatMap((m) => (m.type === "assistant" ? m.content : []))
            .filter((part): part is SessionMessage.AssistantTool => part.type === "tool")
            .slice(-5)
            .map((part) => ({
              tool: part.name,
              arguments: part.state.status === "pending" ? {} : (part.state.input ?? {}),
            }))
          const investigationOpt = yield* Effect.serviceOption(InvestigationStateService)
          const investigationState = Option.isSome(investigationOpt)
            ? yield* investigationOpt.value.get(input.sessionID, input.agent)
            : undefined
          if (Option.isSome(investigationOpt)) {
            yield* investigationOpt.value.note(
              input.sessionID,
              input.agent,
              deriveNote(input.call.name, (input.call.input ?? {}) as Record<string, unknown>),
            )
          }
          outcome = yield* gatewayOpt.value.execute({
            source: "model-tool",
            originalTool: input.call.name,
            arguments: (input.call.input ?? {}) as Record<string, unknown>,
            sessionID: input.sessionID,
            userRequest,
            recentToolCalls,
            investigationState,
          })
        }
      }
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
        ),
      )
      if ("result" in pending) return pending
      const output = pending.output
      const bounded = yield* resources.bound({ sessionID: input.sessionID, toolCallID: input.call.id, output })
      const result = substituteIntelligence(
        outcome,
        input.call.name,
        mergeAugmentHeader(outcome, input.call.name, ToolOutput.toResultValue(bounded.output)),
      )
      if (result.type === "error")
        return bounded.outputPaths.length > 0 ? { result, outputPaths: bounded.outputPaths } : { result }
      return bounded.outputPaths.length > 0
        ? { result, output: bounded.output, outputPaths: bounded.outputPaths }
        : { result, output: bounded.output }
    })

    return Service.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [...(local.get(name) ?? []), { token, registration: { identity: {}, tool } }])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      }),
      list: () => {
        const snapshot = new Map<string, AnyTool>()
        for (const [name, entry] of applications.entries()) snapshot.set(name, entry.tool)
        for (const [name, entries] of local) {
          const last = entries.at(-1)?.registration.tool
          if (last !== undefined) snapshot.set(name, last)
        }
        return snapshot
      },
      materialize: Effect.fn("ToolRegistry.materialize")(function* (permissions = []) {
        const registrations = new Map(applications.entries())
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        for (const [name, registration] of registrations)
          if (whollyDisabled(permission(registration.tool, name), permissions)) registrations.delete(name)
        return {
          definitions: Array.from(registrations, ([name, registration]) => definition(name, registration.tool)),
          settle: (input) => {
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration.identity)
            return Effect.succeed({ result: { type: "error", value: `Unknown tool: ${input.call.name}` } })
          },
        }
      }),
    })
  }),
)

export const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
).pipe(Layer.provideMerge(registryLayer))

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const defaultLayer = layer.pipe(
  Layer.provide(ApplicationTools.layer),
  Layer.provide(ToolOutputStore.defaultLayer),
)
