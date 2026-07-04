import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions } from "ai"
import { Effect } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutput, ToolContent, type ToolDefinition, type ToolResultValue } from "@opencode-ai/llm"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { PartID } from "@/session/schema"
import { ProviderTransform } from "@/provider/transform"
import type { EffectBridge } from "@/effect/bridge"

const attachmentFromDataUri = (dataUri: string, fallbackMime: string) => {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUri)
  if (!match) return undefined
  return {
    mime: match[1] ?? fallbackMime,
    data: match[2] ?? "",
  }
}

const resultValueToOutput = (result: ToolResultValue, fallbackStructured: unknown): string => {
  switch (result.type) {
    case "text":
      return typeof result.value === "string" ? result.value : JSON.stringify(result.value ?? "")
    case "json":
      return typeof result.value === "string" ? result.value : JSON.stringify(result.value ?? {})
    case "content":
      return (result.value as ReadonlyArray<ToolContent>)
        .filter((part): part is Extract<ToolContent, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n\n")
    case "error":
      return typeof result.value === "string" ? result.value : JSON.stringify(result.value ?? {})
    default:
      return JSON.stringify(fallbackStructured ?? {})
  }
}

const settlementToExecuteResult = (
  settlement: ToolRegistry.Settlement,
  messageID: string,
  sessionID: string,
) => {
  const output = settlement.output
    ? resultValueToOutput(
        ToolOutput.toResultValue(settlement.output),
        settlement.output.structured,
      )
    : resultValueToOutput(settlement.result, undefined)
  const attachments = (settlement.output?.content ?? [])
    .filter((part): part is Extract<ToolOutput["content"][number], { type: "file" }> => part.type === "file")
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
      }
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

export interface V2TransportContext {
  readonly sessionID: string
  readonly messageID: string
  readonly agentID: AgentV2.ID
  readonly model: Parameters<typeof ProviderTransform.schema>[0]
  readonly messages: SessionV1.WithParts[]
  readonly pluginTrigger: (
    event: "tool.execute.before" | "tool.execute.after",
    payload: unknown,
    out: unknown,
  ) => Effect.Effect<void, unknown, never>
  readonly completeToolCall: (callID: string, output: unknown) => Effect.Effect<void, unknown, never>
  readonly run: EffectBridge.Shape
}

/**
 * AI SDK transport adapter for canonical (V2) tool definitions.
 *
 * The adapter takes the location-scoped Materialization produced by the core
 * ToolRegistry (single canonical pipeline; `Tools.Service` registration is one of
 * several sources) and projects each `ToolDefinition` into an AI SDK `tool({...})`
 * entry. The result is consumed by `SessionTools.resolve` alongside the V1
 * primitive tools so the LLM sees a single, merged tool catalog.
 */
export const materializeToAITools = Effect.fn("AITools.fromV2")(function* (input: {
  catalog: ToolRegistry.Interface
  ctx: V2TransportContext
}) {
  const materialization = yield* input.catalog.materialize()
  const definitions: ReadonlyArray<ToolDefinition> = materialization.definitions
  const tools: Record<string, AITool> = {}
  for (const definition of definitions) {
    const id = definition.name
    if (tools[id]) continue
    const inputSchema = ProviderTransform.schema(input.ctx.model, definition.inputSchema)
    tools[id] = tool({
      description: definition.description,
      inputSchema: jsonSchema(inputSchema),
      execute(args, options: ToolExecutionOptions) {
        return input.ctx.run.promise(
          Effect.gen(function* () {
            yield* input.ctx.pluginTrigger(
              "tool.execute.before",
              { tool: id, sessionID: input.ctx.sessionID, callID: options.toolCallId },
              { args },
            )
            const settlement = yield* materialization.settle({
              sessionID: input.ctx.sessionID as never,
              agent: input.ctx.agentID,
              assistantMessageID: input.ctx.messageID as never,
              call: {
                type: "tool-call" as const,
                id: options.toolCallId ?? `call_${id}`,
                name: id,
                input: args,
              },
            })
            const output = settlementToExecuteResult(settlement, input.ctx.messageID, input.ctx.sessionID)
            yield* input.ctx.pluginTrigger(
              "tool.execute.after",
              { tool: id, sessionID: input.ctx.sessionID, callID: options.toolCallId, args },
              output,
            )
            if (options.abortSignal?.aborted) {
              yield* input.ctx.completeToolCall(options.toolCallId ?? "", output)
            }
            return output
          }),
        )
      },
    }) as unknown as AITool
  }
  return tools
})

