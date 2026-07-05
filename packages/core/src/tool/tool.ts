export * as Tool from "./tool"

import { ToolDefinition, ToolFailure, ToolOutput, type ToolCall } from "@opencode-ai/llm"
import { Effect, JsonSchema, Schema } from "effect"
import type { AgentV2 } from "../agent"
import { Banyan } from "../banyancode"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"
import { runOnce, type RepairRecord, type LintRecord } from "./tool-runtime"

export type Visibility = "public" | "advanced" | "internal"

export type ToolContract = {
  readonly visibility?: Visibility
  readonly acceptsNull?: boolean
  readonly acceptsAliases?: Record<string, readonly string[]>
  readonly defaultValues?: Record<string, unknown>
  readonly repairPolicy?: "one-pass" | "strict" | "never"
  readonly acceptsPreviousSymbol?: boolean
}

export type ResolvedContract = {
  readonly visibility: Visibility
  readonly acceptsNull: boolean
  readonly acceptsAliases: Record<string, readonly string[]>
  readonly defaultValues: Record<string, unknown>
  readonly repairPolicy: "one-pass" | "strict" | "never"
  readonly acceptsPreviousSymbol: boolean
}

export const resolveContract = (contract: ToolContract | undefined): ResolvedContract => ({
  visibility: contract?.visibility ?? "public",
  acceptsNull: contract?.acceptsNull ?? true,
  acceptsAliases: contract?.acceptsAliases ?? {},
  defaultValues: contract?.defaultValues ?? {},
  repairPolicy: contract?.repairPolicy ?? "one-pass",
  acceptsPreviousSymbol: contract?.acceptsPreviousSymbol ?? false,
})

export interface Context {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
  readonly modelID?: string
}

export type SchemaType<A> = Schema.Codec<A, any, never, never>

declare const TypeId: unique symbol

export interface Definition<Input extends SchemaType<any>, Output extends SchemaType<any>> {
  readonly [TypeId]: {
    readonly _Input: Input
    readonly _Output: Output
  }
  readonly contract: ResolvedContract
}

export type AnyTool = Definition<any, any>
export const Failure = ToolFailure
export type Failure = ToolFailure

export class RegistrationError extends Schema.TaggedErrorClass<RegistrationError>()("Tool.RegistrationError", {
  name: Schema.String,
  message: Schema.String,
}) {}

export type Content =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly data: string; readonly mime: string; readonly name?: string }

type Config<Input extends SchemaType<any>, Output extends SchemaType<any>> = {
  readonly description: string
  readonly input: Input
  readonly output: Output
  readonly execute: (
    input: Schema.Schema.Type<Input>,
    context: Context,
  ) => Effect.Effect<Schema.Schema.Type<Output>, ToolFailure>
  readonly toModelOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => ReadonlyArray<Content>
  readonly contract?: ToolContract
}

type Runtime = {
  readonly permission?: string
  readonly contract: ResolvedContract
  readonly definition: (name: string) => ToolDefinition
  readonly settle: (call: ToolCall, context: Context) => Effect.Effect<ToolOutput, ToolFailure>
}

const runtimes = new WeakMap<AnyTool, Runtime>()

export function make<Input extends SchemaType<any>, Output extends SchemaType<any>>(
  config: Config<Input, Output>,
): Definition<Input, Output> {
  const resolvedContract = resolveContract(config.contract)
  const tool = {} as Definition<Input, Output>
  Object.defineProperty(tool, "contract", {
    value: resolvedContract,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  Object.freeze(tool)
  const definitions = new Map<string, ToolDefinition>()
  runtimes.set(tool, {
    contract: resolvedContract,
    definition: (name) => {
      const cached = definitions.get(name)
      if (cached) return cached
      const definition = new ToolDefinition({
        name,
        description: config.description,
        inputSchema: toJsonSchema(config.input),
        outputSchema: toJsonSchema(config.output),
      })
      definitions.set(name, definition)
      return definition
    },
    settle: (call, context) =>
      Effect.gen(function* () {
        const telemetryOpt = yield* Effect.serviceOption(Banyan.ToolTelemetry)
        const toolID = call.name
        const sessionID = context.sessionID
        const agent = context.agent
        const toolCallID = context.toolCallID
        const modelID = context.modelID ?? "unknown"
        const startedAt = Date.now()
        const rawInput = call.input
        const contract = config.contract ?? {}
        const runtimeResult = runOnce(rawInput, contract, config.input as Schema.Top)
        const repairs: readonly string[] = runtimeResult.repairs
        const warnings: readonly LintRecord[] = runtimeResult.warnings

        const record = (event: Banyan.ToolRuntimeEvent) =>
          telemetryOpt._tag === "Some"
            ? telemetryOpt.value.recordEvent(event)
            : Effect.void

        yield* record({
          kind: "raw",
          toolID,
          sessionID,
          agent,
          modelID,
          toolCallID,
          rawInput,
          repairs: [],
          warnings: [],
          startedAt,
        })

        if (runtimeResult.input === undefined) {
          yield* record({
            kind: "normalized",
            toolID,
            sessionID,
            agent,
            modelID,
            toolCallID,
            rawInput,
            normalizedInput: runtimeResult.normalized,
            repairs,
            warnings,
            startedAt,
          })
          yield* record({
            kind: "failed",
            toolID,
            sessionID,
            agent,
            modelID,
            toolCallID,
            rawInput,
            repairs,
            warnings,
            startedAt,
            finishedAt: Date.now(),
            latencyMs: Date.now() - startedAt,
            success: false,
            errorMessage: runtimeResult.error ?? `Invalid tool input: runtime failed`,
          })
          return yield* Effect.fail(
            new ToolFailure({
              message: runtimeResult.error ?? `Invalid tool input: runtime failed`,
            }),
          )
        }

        const decoded = runtimeResult.input as Schema.Schema.Type<Input>

        yield* record({
          kind: "normalized",
          toolID,
          sessionID,
          agent,
          modelID,
          toolCallID,
          rawInput,
          normalizedInput: runtimeResult.normalized,
          repairs,
          warnings,
          startedAt,
        })
        yield* record({
          kind: "validated",
          toolID,
          sessionID,
          agent,
          modelID,
          toolCallID,
          rawInput,
          normalizedInput: runtimeResult.normalized,
          validatedInput: decoded,
          repairs,
          warnings,
          startedAt,
        })

        const retryNeeded = repairs.length > 0
        return yield* config.execute(decoded, context).pipe(
          Effect.flatMap((output) =>
            Schema.encodeEffect(config.output)(output).pipe(
              Effect.mapError(
                (error) =>
                  new ToolFailure({
                    message: `Tool returned an invalid value for its output schema: ${error.message}`,
                  }),
              ),
            ),
          ),
          Effect.tap((output) => {
            const outputStr = JSON.stringify(output)
            const outputSize = outputStr.length
            const fallbackUsed = (output && typeof output === "object" && "fallbackUsed" in output) ? !!(output as any).fallbackUsed : undefined
            const degraded = (output && typeof output === "object" && "degraded" in output) ? !!(output as any).degraded : undefined
            return record({
              kind: "executed",
              toolID,
              sessionID,
              agent,
              modelID,
              toolCallID,
              rawInput,
              normalizedInput: decoded,
              validatedInput: decoded,
              repairs,
              warnings,
              startedAt,
              finishedAt: Date.now(),
              latencyMs: Date.now() - startedAt,
              success: true,
              outputSize,
              fallbackUsed,
              degraded,
              retryNeeded,
            })
          }),
          Effect.tapError((error) =>
            record({
              kind: "failed",
              toolID,
              sessionID,
              agent,
              modelID,
              toolCallID,
              rawInput,
              normalizedInput: decoded,
              validatedInput: decoded,
              repairs,
              warnings,
              startedAt,
              finishedAt: Date.now(),
              latencyMs: Date.now() - startedAt,
              success: false,
              errorMessage: error.message,
              retryNeeded,
            }),
          ),
          Effect.map((output) => ({
            structured: output,
            content:
              config.toModelOutput?.({ input: decoded, output }).map((part) =>
                part.type === "text"
                  ? { type: "text" as const, text: part.text }
                  : {
                      type: "file" as const,
                      uri: `data:${part.mime};base64,${part.data}`,
                      mime: part.mime,
                      name: part.name,
                    },
              ) ?? (typeof output === "string" ? [{ type: "text" as const, text: output }] : []),
          })),
        )
      }),
  })
  return tool
}

export const validateName = (name: string) =>
  /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)
    ? Effect.void
    : Effect.fail(new RegistrationError({ name, message: `Invalid tool name: ${name}` }))

export const withPermission = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
  permission: string,
) => {
  const decorated = {} as Definition<Input, Output>
  Object.defineProperty(decorated, "contract", {
    value: runtimeOf(tool).contract,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  Object.freeze(decorated)
  runtimes.set(decorated, { ...runtimeOf(tool), permission })
  return decorated
}

export const permission = (tool: AnyTool, name: string) => runtimeOf(tool).permission ?? name
export const definition = (name: string, tool: AnyTool) => runtimeOf(tool).definition(name)
export const settle = (tool: AnyTool, call: ToolCall, context: Context) => runtimeOf(tool).settle(call, context)
export const contractOf = (tool: AnyTool): ResolvedContract => runtimeOf(tool).contract

function runtimeOf(tool: AnyTool) {
  const runtime = runtimes.get(tool)
  if (!runtime) throw new TypeError("Invalid Core Tool value")
  return runtime
}

function toJsonSchema(schema: Schema.Top): JsonSchema.JsonSchema {
  const document = Schema.toJsonSchemaDocument(schema)
  if (Object.keys(document.definitions).length === 0) return document.schema
  return { ...document.schema, $defs: document.definitions }
}
