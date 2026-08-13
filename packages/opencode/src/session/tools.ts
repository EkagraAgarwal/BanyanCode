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
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
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

export * as SessionTools from "./tools"
