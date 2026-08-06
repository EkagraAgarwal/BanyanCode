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
import { Effect, Option, Ref } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import * as AiSdkTransportModule from "@/effect/transport-ai-sdk"
import { ToolCatalog } from "@opencode-ai/core/tool/tool-catalog"
import type { ToolMaterializationContext } from "@/effect/tool-transport"
import { Banyan } from "@opencode-ai/core/banyancode"
import type { GraphFirstMode, GraphOutcome } from "@opencode-ai/core/banyancode/types"

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

  // Phase 5 (graph-first): per-turn graph-policy state. `resolve` runs once
  // per model turn (see `session/prompt.ts`), so a fresh `graphAttempted` Ref
  // per resolve gives per-turn state. Telemetry is recorded through the
  // `AdaptedCatalog` service when it is in scope (AppRuntime); it is
  // best-effort and never fails the tool call.
  const banyanEnabled = process.env.BANYANCODE_ENABLE !== "0"
  const graphFirstMode: GraphFirstMode = Banyan.GraphFirstPolicy.graphFirstMode()
  const adaptedCatalogOpt = yield* Effect.serviceOption(Banyan.AdaptedCatalog)
  const bootstrapOpt = yield* Effect.serviceOption(Banyan.CodegraphBootstrap)
  const graphState = Option.isSome(bootstrapOpt)
    ? yield* bootstrapOpt.value.status().pipe(
        Effect.map((s) => s.state),
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
    : undefined
  const graphAttempted = yield* Ref.make(false)

  const recordUsage = (toolID: string) =>
    Option.isSome(adaptedCatalogOpt)
      ? adaptedCatalogOpt.value.recordUsage(toolID, input.session.id).pipe(Effect.catchCause(() => Effect.void))
      : Effect.void

  const policyEvent = (toolID: string, eventType: "call" | "redirect" | "graph_attempt", outcome?: GraphOutcome) =>
    Option.isSome(adaptedCatalogOpt)
      ? adaptedCatalogOpt.value
          .recordPolicyEvent({
            sessionID: input.session.id,
            messageID: input.processor.message.id,
            toolID,
            eventType,
            mode: graphFirstMode,
            ts: Date.now(),
            ...(graphState === undefined ? {} : { graphState }),
            ...(outcome === undefined ? {} : { outcome }),
          })
          .pipe(Effect.catchCause(() => Effect.void))
      : Effect.void

  const markGraphAttempt = (toolID: string, resultText?: string) =>
    Effect.gen(function* () {
      yield* Ref.set(graphAttempted, true)
      if (resultText !== undefined) {
        yield* policyEvent(toolID, "graph_attempt", Banyan.GraphFirstPolicy.graphOutcome(resultText))
      }
    })

  // One structured redirect for early source-code reads/searches made before
  // any task-specific graph attempt in this turn. Returns undefined in `off`
  // mode (default — zero behavior change) and for non-code artifacts.
  const redirectFor = Effect.fn("SessionTools.redirectFor")(function* (toolID: string, args: Record<string, unknown>) {
    if (!banyanEnabled || graphFirstMode === "off") return undefined
    if (!Banyan.GraphFirstPolicy.isSourceRead(toolID)) return undefined
    if (yield* Ref.get(graphAttempted)) return undefined
    return Banyan.GraphFirstPolicy.redirectFor(toolID, args)
  })

  const enforceBlock = (
    toolID: string,
    redirect: NonNullable<ReturnType<typeof Banyan.GraphFirstPolicy.redirectFor>>,
  ) => ({
    title: "Graph-first redirect",
    metadata: { graphRedirect: { mode: graphFirstMode, tool: redirect.tool, hint: redirect.hint } },
    output: [
      "<graph-first-policy>",
      `The \`${toolID}\` tool was redirected because no codegraph/repository tool has been attempted in this turn (BANYANCODE_GRAPH_FIRST_MODE=enforce).`,
      "",
      `Call \`${redirect.tool}\` first — ${redirect.hint}`,
      'See the "Codegraph-first search policy (ALWAYS)" section of the system prompt.',
      "</graph-first-policy>",
    ].join("\n"),
    attachments: [],
  })

  const advisoryNote = (
    toolID: string,
    redirect: NonNullable<ReturnType<typeof Banyan.GraphFirstPolicy.redirectFor>>,
  ) =>
    `\n\n<graph-first-policy>Consider \`${redirect.tool}\` first — ${redirect.hint} (${toolID} ran before any graph attempt in this turn).</graph-first-policy>`

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
            const redirect = yield* redirectFor(item.id, args)
            yield* recordUsage(item.id)
            if (redirect !== undefined && graphFirstMode === "enforce") {
              // Block until the model attempts a graph/repository tool in
              // this turn. ONE structured redirect naming the tool to use.
              yield* policyEvent(item.id, "redirect")
              const output = enforceBlock(item.id, redirect)
              yield* plugin.trigger(
                "tool.execute.after",
                { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
                output,
              )
              if (options.abortSignal?.aborted) {
                yield* input.processor.completeToolCall(options.toolCallId, output)
              }
              return output
            }
            yield* policyEvent(item.id, "call")
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            const result = yield* item.execute(args, ctx)
            // A graph/repository tool call satisfies the per-turn graph
            // attempt requirement and supplies the fallback-classified outcome.
            if (Banyan.GraphFirstPolicy.isGraphAttempt(item.id)) {
              const resultText = typeof result.output === "string" ? result.output : ""
              yield* markGraphAttempt(item.id, resultText)
            }
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            // Advisory: let the read/search run but append a structured
            // redirect note when it happened before any graph attempt.
            if (redirect !== undefined && graphFirstMode === "advisory") {
              yield* policyEvent(item.id, "redirect")
              output.output = `${output.output ?? ""}${advisoryNote(item.id, redirect)}`
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
      workspace: input.session.directory,
      permissions: Permission.merge(input.agent.permission, input.session.permission ?? []) as never,
      run,
      pluginTrigger: (event: "tool.execute.before" | "tool.execute.after", payload: unknown, out: unknown) =>
        plugin.trigger(event, payload as never, out as never),
      completeToolCall: (callID: string, output: unknown) =>
        input.processor.completeToolCall(callID, output as never),
    })
    if (banyanEnabled) {
      const materializedIds = new Set(materializations.map((m) => m.id))
      const missingPublic = Banyan.BanyanToolsManifest.BANYAN_PUBLIC_TOOL_IDS.filter((id: string) => !materializedIds.has(id))
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
    const wrapGraphAttemptTool = (id: string, inner: AITool): AITool => {
      const innerExecute = inner.execute
      if (!innerExecute) return inner
      return {
        ...inner,
        execute(args: unknown, options: ToolExecutionOptions) {
          return run.promise(
            Effect.gen(function* () {
              if (Banyan.GraphFirstPolicy.isGraphAttempt(id)) {
                yield* Ref.set(graphAttempted, true)
              }
              yield* policyEvent(id, "call")
              const result = yield* Effect.promise(() => innerExecute(args, options))
              if (Banyan.GraphFirstPolicy.isGraphAttempt(id)) {
                const text = typeof result === "object" && result !== null && "output" in result
                  ? String((result as { output: unknown }).output)
                  : undefined
                yield* markGraphAttempt(id, text)
              }
              return result
            }),
          )
        },
      }
    }
    for (const { id, tool: v2Tool } of materializations) {
      if (tools[id]) continue
      // Phase 5: wrap every V2 tool so a graph/repository call marks the
      // per-turn `graphAttempted` state (unblocking later read/grep/glob in
      // enforce mode) and records a graph-attempt telemetry event with an
      // outcome. Only applied when BanyanCode is enabled.
      tools[id] = banyanEnabled ? wrapGraphAttemptTool(id, v2Tool) : v2Tool
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
          yield* recordUsage(key)
          yield* policyEvent(key, "call")
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
