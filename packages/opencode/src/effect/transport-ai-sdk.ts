import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions } from "ai"
import { Context, Effect, Layer } from "effect"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import type { ToolCatalog } from "@opencode-ai/core/tool/tool-catalog"
import type { ResolvedContract } from "@opencode-ai/core/tool/tool"
import { ToolOutput, ToolContent, type ToolDefinition } from "@opencode-ai/llm"
import { ModelV2 } from "@opencode-ai/core/model"
import { PartID } from "@/session/schema"
import { ProviderTransform } from "@/provider/transform"
import { isStrongModel } from "@/tool/registry"
import type { AiSdkToolMaterialization, ToolMaterializationContext, ToolTransport } from "./tool-transport"

export const AiSdkTransportId = Symbol.for("@opencode/AiSdkToolTransport")

const attachmentFromDataUri = (dataUri: string, fallbackMime: string) => {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUri)
  if (!match) return undefined
  return {
    mime: match[1] ?? fallbackMime,
    data: match[2] ?? "",
  }
}

const resultValueToOutput = (result: { type: string; value: unknown }, fallbackStructured: unknown): string => {
  if (result.type === "text") {
    return typeof result.value === "string" ? result.value : JSON.stringify(result.value ?? "")
  }
  if (result.type === "json") {
    return typeof result.value === "string" ? result.value : JSON.stringify(result.value ?? {})
  }
  if (result.type === "content") {
    return (result.value as ReadonlyArray<ToolContent>)
      .filter((part): part is Extract<ToolContent, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n\n")
  }
  return typeof result.value === "string" ? result.value : JSON.stringify(fallbackStructured ?? {})
}

export interface ToolCallOutput {
  readonly title: string
  readonly metadata: Record<string, unknown>
  readonly output: string
  readonly attachments: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly messageID: string
    readonly type: "file"
    readonly mime: string
    readonly url: string
    readonly filename?: string
  }>
}

export const settlementToToolCallOutput = (
  settlement: ToolRegistry.Settlement,
  messageID: string,
  sessionID: string,
): ToolCallOutput => {
  const output = settlement.output
    ? resultValueToOutput(ToolOutput.toResultValue(settlement.output), settlement.output.structured)
    : resultValueToOutput(
        settlement.result as { type: string; value: unknown },
        undefined,
      )
  const attachments = (settlement.output?.content ?? [])
    .filter((part): part is Extract<ToolContent, { type: "file" }> => part.type === "file")
    .map((part) => {
      const data = attachmentFromDataUri(part.uri, part.mime)
      return {
        type: "file" as const,
        mime: part.mime,
        url: part.uri,
        ...(part.name ? { filename: part.name } : {}),
        id: PartID.ascending(),
        sessionID,
        messageID,
        ...(data ? { data: data.data } : {}),
      } as ToolCallOutput["attachments"][number]
    })
  return {
    title: "",
    metadata: settlement.outputPaths
      ? { outputPath: settlement.outputPaths[0], truncated: settlement.outputPaths.length > 0 }
      : {},
    output,
    attachments,
  }
}

const definitionToAITool = (
  definition: ToolDefinition,
  ctx: ToolMaterializationContext,
  materialization: ToolRegistry.Materialization,
): AITool => {
  const id = definition.name
  const inputSchema = ProviderTransform.schema(ctx.model, definition.inputSchema)
  return tool({
    description: definition.description,
    inputSchema: jsonSchema(inputSchema),
    execute(args: unknown, options: ToolExecutionOptions) {
      const callID = options.toolCallId ?? `call_${id}`
      return ctx.run.promise(
        Effect.gen(function* () {
          yield* ctx.pluginTrigger(
            "tool.execute.before",
            { tool: id, sessionID: ctx.sessionID, callID },
            { args },
          )
          const settlement = yield* materialization.settle({
            sessionID: ctx.sessionID as never,
            agent: ctx.agent as never,
            assistantMessageID: ctx.assistantMessageID as never,
            call: {
              type: "tool-call" as const,
              id: callID,
              name: id,
              input: args,
            },
          })
          const output = settlementToToolCallOutput(
            settlement,
            ctx.assistantMessageID,
            ctx.sessionID,
          )
          yield* ctx.pluginTrigger(
            "tool.execute.after",
            { tool: id, sessionID: ctx.sessionID, callID, args },
            output,
          )
          if (options.abortSignal?.aborted) {
            yield* ctx.completeToolCall(callID, output)
          }
          return output
        }),
      )
    },
  })
}

export class Service extends Context.Service<Service, ToolTransport<AITool>>()(
  "@opencode/AiSdkToolTransport",
) {
  static readonly id = AiSdkTransportId
}

export const buildTools = Effect.fn("AiSdkTransport.buildTools")(function* (input: {
  catalog: ToolCatalog.Interface
  ctx: ToolMaterializationContext
}) {
  const materialization = yield* input.catalog.materialize(input.ctx.permissions)
  const listed = yield* input.catalog.list()
  const contractsByName = new Map<string, ResolvedContract>()
  for (const [name, tool] of listed) {
    contractsByName.set(name, tool.contract)
  }
  const modelID = ModelV2.ID.make(input.ctx.model.api.id)
  const out: AiSdkToolMaterialization[] = []
  for (const definition of materialization.definitions) {
    const visibility = contractsByName.get(definition.name)?.visibility ?? "public"
    if (visibility === "internal") continue
    if (visibility === "advanced" && !isStrongModel(modelID)) continue
    out.push({ id: definition.name, tool: definitionToAITool(definition, input.ctx, materialization) })
  }
  return out
})

const materializationEffectRef: { current: ReturnType<typeof buildTools> | null } = {
  current: null,
}

export const layer: Layer.Layer<Service, never, never> = Layer.succeed(
  Service,
  {
    id: AiSdkTransportId,
    buildTools: ((catalog: ToolCatalog.Interface, ctx: ToolMaterializationContext) =>
      buildTools({ catalog, ctx })) as never,
  } as never,
)


