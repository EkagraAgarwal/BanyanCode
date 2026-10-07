import { Agent } from "@/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry as OpencodeToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"

import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Effect, Option } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import * as AiSdkTransportModule from "@/effect/transport-ai-sdk"
import { ToolCatalog } from "@opencode-ai/core/tool/tool-catalog"
import { AgentV2 } from "@opencode-ai/core/agent"
import type { ToolMaterializationContext } from "@/effect/tool-transport"
import { BanyanToolsManifest } from "@opencode-ai/core/banyancode/banyan-tools-manifest"
import { Banyan } from "@opencode-ai/core/banyancode"
import { GatewayV1 } from "./gateway-v1"

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  runID?: string
  rootSessionID?: string
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
}) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* OpencodeToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps, runID: input.runID },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  for (const item of yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            // Repository Gateway interception (Gate A, plan §2.1/§2.2): the
            // optional service never widens R (`serviceOption`), so a missing
            // gateway is a byte-for-byte no-op. Gated to the conventional
            // repository tools; every fetch is fail-closed (catchCause ->
            // undefined outcome) so a defective gateway can never change the
            // tool's error/abort behavior.
            const gatewayOpt = yield* Effect.serviceOption(Banyan.RepositoryGateway)
            let outcome: unknown = undefined
            if (Option.isSome(gatewayOpt) && GatewayV1.GATEWAY_TOOLS.has(item.id) && (yield* GatewayV1.routeAllowed(item.id))) {
              const gateB = GatewayV1.deriveGateB(ctx.messages)
              const agentID = ctx.agent as AgentV2.ID
              const investigationOpt = yield* Effect.serviceOption(Banyan.InvestigationStateService)
              const investigationState = Option.isSome(investigationOpt)
                ? yield* investigationOpt.value.get(ctx.sessionID, agentID).pipe(
                    Effect.catchCause(() => Effect.succeed(undefined)),
                  )
                : undefined
              if (Option.isSome(investigationOpt)) {
                yield* investigationOpt.value
                  .note(
                    ctx.sessionID,
                    agentID,
                    Banyan.InvestigationState.deriveNote(item.id, args as Record<string, unknown>),
                  )
                  .pipe(Effect.catchCause(() => Effect.void))
              }
              outcome = yield* gatewayOpt.value
                .execute({
                  source: "model-tool",
                  originalTool: item.id,
                  arguments: args as Record<string, unknown>,
                  sessionID: ctx.sessionID,
                  userRequest: gateB.userRequest,
                  recentToolCalls: gateB.recentToolCalls,
                  investigationState,
                })
                .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
            }
            const result = yield* item.execute(args, ctx)
            const final = GatewayV1.applyOutcome(item.id, outcome, result)
            const output = {
              ...result,
              output: final.output,
              // The TUI renders the codegraph gear glyph on intercepted tool
              // calls (read/grep/glob answered by the repository gateway).
              metadata: final.codegraph ? { ...result.metadata, codegraph: true } : result.metadata,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              output,
            )
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  const banyanEnabled = process.env.BANYANCODE_ENABLE !== "0"
  const transportOption = yield* Effect.serviceOption(AiSdkTransportModule.Service)
  const catalogOption = yield* Effect.serviceOption(ToolCatalog.Service)
  if (banyanEnabled && (Option.isNone(transportOption) || Option.isNone(catalogOption))) {
    const missing: string[] = []
    if (Option.isNone(transportOption)) missing.push("AiSdkTransport")
    if (Option.isNone(catalogOption)) missing.push("ToolCatalog")
    return yield* Effect.die(
      new Error(
        `SessionTools.resolve: BanyanCode is enabled but [${missing.join(", ")}] service(s) are missing from the AppRuntime. ` +
          `Refusing to send an LLM request without the canonical tool catalog. ` +
          `Set BANYANCODE_ENABLE=0 to disable BanyanCode, or check the AppLayer composition.`,
      ),
    )
  }
  if (Option.isSome(transportOption) && Option.isSome(catalogOption)) {
    type CatalogInterface = ToolCatalog.Service["Service"]
    type Materialization = ReadonlyArray<{ id: string; tool: AITool }>
    type TransportBuildTools = (
      catalog: CatalogInterface,
      ctx: ToolMaterializationContext,
    ) => Effect.Effect<Materialization, never, never>
    const transport: { buildTools: TransportBuildTools } = transportOption.value as never
    const catalog: CatalogInterface = catalogOption.value
    const materializations: Materialization = yield* (
      transport.buildTools as (
        c: CatalogInterface,
        x: ToolMaterializationContext,
      ) => Effect.Effect<Materialization, never, never>
    )(catalog, {
      sessionID: input.session.id,
      runID: input.runID,
      parentSessionID: input.session.parentID,
      rootSessionID: input.rootSessionID,
      assistantMessageID: input.processor.message.id,
      agent: input.agent.name,
      model: input.model,
      messages: input.messages,
      workspace: undefined,
      permissions: Permission.merge(input.agent.permission, input.session.permission ?? []) as never,
      run,
      pluginTrigger: (event: "tool.execute.before" | "tool.execute.after", payload: unknown, out: unknown) =>
        plugin.trigger(event, payload as never, out as never),
      completeToolCall: (callID: string, output: unknown) =>
        input.processor.completeToolCall(callID, output as never),
    })
    if (banyanEnabled) {
      const materializedIds = new Set(materializations.map((m) => m.id))
      const missingPublic = BanyanToolsManifest.BANYAN_PUBLIC_TOOL_IDS.filter((id: string) => !materializedIds.has(id))
      if (missingPublic.length > 0) {
        return yield* Effect.die(
          new Error(
            `SessionTools.resolve: BanyanCode is enabled but the following public Banyan tools are missing from the materialized catalog: [${missingPublic.join(", ")}]. ` +
              `Refusing to send an LLM request with an incomplete tool list. ` +
              `Check that the Banyan tool layers are included in the AppLayer and that each tool is registered.`,
          ),
        )
      }
    }
    for (const { id, tool: v2Tool } of materializations) {
      if (tools[id]) continue
      tools[id] = v2Tool
    }
  }

  for (const [key, item] of Object.entries(yield* mcp.tools())) {
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, schema)
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            return yield* Effect.promise(() => execute(args, opts))
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
          )
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          const textParts: string[] = []
          const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                attachments.push({
                  type: "file",
                  mime: resource.mimeType ?? "application/octet-stream",
                  url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          const output = {
            title: "",
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }),
      )
    tools[key] = item
  }

  return tools
})

// WS5a sticky per-session tool snapshot (prompt-caching plan WS5). Frozen on
// the first non-small OpenAI request of a sessionID+modelID key; later
// permission narrowing shrinks allowedTools instead of the wire `tools` array
// (mutating wire tools is a `tools_changed` cache miss). Entries are tiny
// (frozen name lists) and intentionally live for the process lifetime — the
// model belongs to the snapshot key because the apply_patch/edit/write swap
// is model-stable.
export type StickyToolSnapshot = {
  readonly sessionID: string
  readonly modelID: string
  /** Wire tool names in alpha-sorted order, frozen at the first request. */
  readonly toolNames: readonly string[]
}

const stickySnapshots = new Map<string, StickyToolSnapshot>()

const stickyKey = (sessionID: string, modelID: string) => `${sessionID}\u0000${modelID}`

export function stickySnapshot(sessionID: string, modelID: string): StickyToolSnapshot | undefined {
  return stickySnapshots.get(stickyKey(sessionID, modelID))
}

export function freezeStickySnapshot(
  sessionID: string,
  modelID: string,
  toolNames: readonly string[],
): StickyToolSnapshot {
  const snapshot: StickyToolSnapshot = { sessionID, modelID, toolNames: [...toolNames] }
  stickySnapshots.set(stickyKey(sessionID, modelID), snapshot)
  return snapshot
}

/** Test hook — drop every frozen snapshot so sessions re-freeze. */
export function resetStickySnapshots(): void {
  stickySnapshots.clear()
}

// tool_search / defer_loading (prompt-caching plan NEXT; flag
// `banyancode_tool_search_defer`, default OFF). The eager set is the ~15
// always-on coding-agent tools the model needs most turns; every other name
// on the wire gets `defer_loading: true` plus a `{ type: "tool_search" }`
// entry so its parameter schema loads at end-of-context instead of being
// billed as input on every turn (gpt-5.4+ Responses only). Names absent
// from the wire set are simply not classified. apply_patch/edit/multiedit
// all sit in the set because the registry's gpt- apply_patch↔edit/write swap
// is model-stable but direction-dependent.
export const TOOL_SEARCH_EAGER_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "read",
  "edit",
  "write",
  "multiedit",
  "apply_patch",
  "ls",
  "grep",
  "glob",
  "task",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "skill",
])

// Anchored like transform.ts/openai-options gates so "gpt-60"/"gpt-50" never
// match. tool_search is documented for Responses gpt-5.4 and later (plus the
// gpt-6 family); "gpt-5" with no minor is 5.0 and stays off.
const GPT5_TOOL_SEARCH_RE = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/
const GPT6_FAMILY_RE = /(?:^|\/)gpt-6(?:[.-]|$)/

export function supportsToolSearchDefer(modelID: string): boolean {
  const id = modelID.toLowerCase()
  if (GPT6_FAMILY_RE.test(id)) return true
  const match = GPT5_TOOL_SEARCH_RE.exec(id)
  return match !== null && Number(match[1]) >= 4
}

export function toolSearchSplit(names: readonly string[]): {
  readonly eager: readonly string[]
  readonly deferred: readonly string[]
} {
  const eager = names.filter((name) => TOOL_SEARCH_EAGER_NAMES.has(name))
  const deferred = names.filter((name) => !TOOL_SEARCH_EAGER_NAMES.has(name))
  return { eager, deferred }
}

// @ai-sdk/openai lowers `providerOptions.openai.deferLoading` on a function
// tool to wire `defer_loading: true` (prepareResponsesTools), and recognizes
// this provider-tool descriptor as wire `{ type: "tool_search" }` — the exact
// output of `openai.tools.toolSearch()`. Constructed inline so request prep
// never statically imports the OpenAI SDK (provider.ts loads it lazily).
const toolSearchProviderTool = (): AITool =>
  ({ type: "provider", id: "openai.tool_search", args: {} }) as unknown as AITool

const withDeferLoading = (def: AITool): AITool =>
  ({
    ...def,
    providerOptions: {
      ...def.providerOptions,
      openai: { ...def.providerOptions?.openai, deferLoading: true },
    },
  }) as AITool

/**
 * Split a wire tool record for tool_search defer: non-eager defs get
 * `providerOptions.openai.deferLoading = true` and a `tool_search` provider
 * tool is appended (unless a real tool already owns that name). Returns the
 * original record untouched when nothing is deferred, so an all-eager set
 * stays byte-for-byte identical.
 */
export function applyToolSearchDefer(tools: Record<string, AITool>): {
  readonly tools: Record<string, AITool>
  readonly deferred: readonly string[]
} {
  const { deferred } = toolSearchSplit(Object.keys(tools))
  if (deferred.length === 0) return { tools, deferred }
  const deferredSet = new Set(deferred)
  const next = Object.fromEntries(
    Object.entries(tools).map(([name, def]) => (deferredSet.has(name) ? [name, withDeferLoading(def)] : [name, def])),
  )
  if (next["tool_search"] === undefined) next["tool_search"] = toolSearchProviderTool()
  return { tools: next, deferred }
}

// TODO(tool_search prompt guide): when banyancode_tool_search_defer is on,
// CodegraphSystemSource's rendered tool guide still presents the FULL
// catalog as eagerly callable. session/system.ts is out of scope for this
// slice — a follow-up should teach the guide (via codegraphParts) to mark
// TOOL_SEARCH_EAGER_NAMES as always-available and note the remainder loads
// via tool_search (defer_loading), or filter the guide to the eager set.
// Follow-up 2: the processor/stateless replay must round-trip hosted
// `tool_search_call` / `tool_search_output` output items (plan.md replay
// completeness), like encrypted reasoning.

export * as SessionTools from "./tools"
