import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Auth } from "@/auth"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "../message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "../system"
import { SessionTools } from "../tools"
import { SessionEffort } from "../effort"
import { maybePrewarm } from "../prewarm"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Effect, Option, Record } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"

const USER_AGENT = `opencode/${InstallationVersion}`

type PrepareInput = {
  readonly user: SessionV1.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  readonly tools: Record<string, Tool>
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  readonly isWorkflow: boolean
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  // WS5a sticky tools: names currently callable ∩ the frozen snapshot.
  // Absent when the sticky gate is off (non-OpenAI, cache mode "off", small).
  readonly allowedTools?: readonly string[] | undefined
  // "none" when allowedTools is empty. Consumed by ProviderTransform.options,
  // which emits tool_choice: { type: "allowed_tools", mode, tools } / "none"
  // so permission narrowing stops rewriting the wire tools array
  // (tools_changed cache miss).
  readonly toolChoiceHint?: "none" | undefined
  // The frozen snapshot backing tools/allowedTools for this session+model.
  readonly toolSnapshot?: SessionTools.StickyToolSnapshot | undefined
  // tool_search defer (banyancode_tool_search_defer, default off): wire
  // names marked `defer_loading: true` this turn (a `tool_search` provider
  // tool is added to `tools` iff non-empty). Absent when the gate is off.
  // The sticky snapshot is untouched — toolNames still freezes the FULL
  // catalog; only wire serialization changes.
  readonly deferredTools?: readonly string[] | undefined
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, any>
  }
  readonly messageTransformOptions: Record<string, any>
  readonly headers: Record<string, string>
}

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

// The effort a request actually sends: OpenAI-shaped variants merge as
// { reasoning: { effort } }, openai-compatible ones as { reasoningEffort }.
const requestLevelEffort = (options: Record<string, any>): string | undefined => {
  if (typeof options.reasoning?.effort === "string") return options.reasoning.effort
  if (typeof options.reasoningEffort === "string") return options.reasoningEffort
  return undefined
}

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  const system = [
    [
      ...(input.agent.prompt
        ? input.agent.systemPrompt === "append"
          ? [...SystemPrompt.provider(input.model), input.agent.prompt]
          : [input.agent.prompt]
        : SystemPrompt.provider(input.model)),
      ...input.system,
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  ]

  const header = system[0]
  yield* input.plugin.trigger(
    "experimental.chat.system.transform",
    { sessionID: input.sessionID, model: input.model },
    { system },
  )
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }

  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  // Prompt-cache config (WS1): mode + diagnostics gates for OpenAI
  // prompt_cache_options. A missing BanyanConfigService falls back to the
  // schema defaults (implicit, diagnostics off).
  const banyanOption = yield* Effect.serviceOption(Banyan.BanyanConfigService)
  const banyanConfig = Option.isNone(banyanOption) ? undefined : yield* banyanOption.value.get()
  const promptCacheMode = banyanConfig?.banyancode_prompt_cache_mode ?? "implicit"
  // WS6 prewarm: gate + 30-min idempotency live in maybePrewarm; the wire
  // fire is TODO(network). enabled from banyancode_prompt_cache_prewarm
  // (default off). TODO improve hash input: stablePrefix is the model id
  // today — hash the assembled stable system prefix when handy.
  yield* Effect.promise(() =>
    maybePrewarm({
      providerID: input.model.providerID,
      modelID: input.model.api.id,
      promptCacheMode,
      enabled: banyanConfig?.banyancode_prompt_cache_prewarm ?? false,
      stablePrefix: input.model.api.id,
    }),
  )
  // WS5a sticky tools: freeze the wire tool set on the first non-small
  // OpenAI request of a sessionID+modelID key. Later permission narrowing
  // shrinks allowedTools (and toolChoiceHint) instead of wire `tools` —
  // changing the wire array would be a `tools_changed` cache miss. Non-OpenAI,
  // cache mode "off", and small (title/summarize) requests keep today's
  // filtering so an auxiliary `tools: {}` call can't freeze an empty snapshot
  // for the real conversation. Computed before options() so tool_choice
  // emission rides the same request-level options object.
  const resolved = resolveTools(input)
  const sticky = !input.small && input.model.providerID === "openai" && promptCacheMode !== "off"
  const snapshot = sticky
    ? (SessionTools.stickySnapshot(input.sessionID, input.model.api.id) ??
      SessionTools.freezeStickySnapshot(
        input.sessionID,
        input.model.api.id,
        Object.keys(resolved).toSorted((a, b) => a.localeCompare(b)),
      ))
    : undefined
  const allowedTools = snapshot ? snapshot.toolNames.filter((name) => resolved[name] !== undefined) : undefined
  const toolChoiceHint = allowedTools && allowedTools.length === 0 ? ("none" as const) : undefined
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
        promptCacheMode,
        promptCacheDiagnostics: banyanConfig?.banyancode_prompt_cache_diagnostics ?? false,
        allowedTools,
        toolChoiceHint,
        toolSnapshot: snapshot,
      })
  const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
  // WS4 reasoning effort: the variant merge above IS the request-level
  // `reasoning.effort`. On configuration-update-eligible models (gpt-6*)
  // baseReasoningEffort freezes here at the first non-small request and is
  // never mutated by applyEffortChange — mid-conversation thinking changes
  // append a persisted `configuration_update` input item instead of
  // rewriting this field (rewriting = reasoning_effort_changed cache miss).
  // Telemetry: effective (post-update) effort must come from LOCAL state
  // (SessionEffort.effectiveReasoningEffort), never from the response's
  // `reasoning.effort` — the API echoes the REQUEST-level value there, not
  // the configuration_update-selected effort (telemetry trap).
  // Pin: once the base is frozen, write it back over the merge every request
  // (same field shapes requestLevelEffort reads: reasoning.effort OR
  // reasoningEffort) so a legacy variant rewrite can't move top-level effort
  // mid-conversation — the effective effort rides the marker. Gated by
  // banyancode_reasoning_configuration_update, the same flag as
  // applyEffortChange (off = legacy top-level rewrite behavior).
  // TODO(WS4): TUI thinking hooks (dialog-thinking.tsx / variant.cycle) still
  // have no HTTP route to the marker writer — a TUI variant change on an
  // eligible session is pinned away with no marker.
  if (!input.small && SessionEffort.isConfigurationUpdateEligible(input.model.api.id)) {
    SessionEffort.freezeBaseReasoningEffort(input.sessionID, requestLevelEffort(options))
    const pinned =
      banyanConfig?.banyancode_reasoning_configuration_update !== false
        ? SessionEffort.baseReasoningEffort(input.sessionID)
        : undefined
    if (pinned !== undefined) {
      if (typeof options.reasoning?.effort === "string") options.reasoning = { ...options.reasoning, effort: pinned }
      else if (typeof options.reasoningEffort === "string") options.reasoningEffort = pinned
    }
  }
  if (
    input.model.api.npm === "@ai-sdk/azure" &&
    (input.provider.options.useCompletionUrls || input.model.options.useCompletionUrls || options.useCompletionUrls)
  ) {
    delete options.reasoningSummary
    delete options.include
  }
  if (isOpenaiOauth) options.instructions = system.join("\n")

  const messages =
    isOpenaiOauth || input.isWorkflow
      ? input.messages
      : [
          ...system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          ),
          ...input.messages,
        ]

  const params = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      maxOutputTokens: ProviderTransform.maxOutputTokens(input.model, input.flags.outputTokenMax),
      options,
    },
  )

  const { headers } = yield* input.plugin.trigger(
    "chat.headers",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )

  // Defs are rebuilt per request (execute closures capture request-scoped
  // message/processor state); only names + order are frozen. A frozen name
  // missing from input.tools (e.g. MCP disconnect) drops out of the wire set
  // rather than sending a def we no longer have.
  const wire = snapshot
    ? Object.fromEntries(
        snapshot.toolNames.flatMap((name) => {
          const def = input.tools[name]
          return def ? ([[name, def]] as const) : []
        }),
      )
    : resolved

  if (input.model.providerID.includes("github-copilot") && Object.keys(wire).length === 0 && hasToolCalls(input.messages)) {
    // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
    wire["_noop"] = aiTool({
      description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: { type: "string", description: "Unused" },
        },
      }),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  // tool_search / defer_loading (prompt-caching plan NEXT; flag
  // `banyancode_tool_search_defer`, DEFAULT OFF — unset/false leaves `wire`
  // byte-for-byte untouched). When ON: OpenAI + gpt-5.4+ + AI SDK runtime +
  // non-small. The native experimental runtime does not lower tool_search
  // yet (see the TODO at openai-responses lowerTool), so the gate stays
  // closed when experimentalNativeLlm is set. The sticky snapshot is never
  // rewritten: toolNames keeps the FULL frozen catalog, only the wire
  // record's serialization changes (defer_loading + tool_search entry).
  const toolSearchGate =
    !input.small &&
    banyanConfig?.banyancode_tool_search_defer === true &&
    input.model.providerID === "openai" &&
    !input.flags.experimentalNativeLlm &&
    SessionTools.supportsToolSearchDefer(input.model.api.id)
  const toolSearch = toolSearchGate ? SessionTools.applyToolSearchDefer(wire) : undefined
  const finalTools = toolSearch?.tools ?? wire

  const opencodeProjectID = input.model.providerID.startsWith("opencode")
    ? (yield* InstanceState.context).project.id
    : undefined

  return {
    system,
    messages,
    tools: Object.fromEntries(Object.entries(finalTools).toSorted(([a], [b]) => a.localeCompare(b))),
    allowedTools,
    toolChoiceHint,
    toolSnapshot: snapshot,
    deferredTools: toolSearch?.deferred,
    params,
    messageTransformOptions: options,
    headers: {
      ...(input.model.providerID.startsWith("opencode")
        ? {
            ...(opencodeProjectID ? { "x-opencode-project": opencodeProjectID } : {}),
            "x-opencode-session": input.sessionID,
            "x-opencode-request": input.user.id,
            "x-opencode-client": input.flags.client,
            "User-Agent": USER_AGENT,
          }
        : {
            "x-session-affinity": input.sessionID,
            "X-Session-Id": input.sessionID,
            ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
            "User-Agent": USER_AGENT,
          }),
      ...input.model.headers,
      ...headers,
    },
  }
})

function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLMRequestPrep from "./request"
