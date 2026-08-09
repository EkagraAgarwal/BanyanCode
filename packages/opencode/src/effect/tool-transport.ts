import { Effect } from "effect"
import { type Tool as AITool } from "ai"
import { ProviderTransform } from "@/provider/transform"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"
import type { PermissionV2 } from "@opencode-ai/core/permission"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { EffectBridge } from "@/effect/bridge"

/**
 * Transport-neutral context handed to every {@link ToolTransport} during
 * materialization. Persisted as a single struct so future transports (MCP, CLI,
 * REST, plugin runtime) reuse the same fields without each inventing its own
 * shape.
 */
export interface ToolMaterializationContext {
  readonly sessionID: string
  readonly assistantMessageID: string
  readonly agent: string
  readonly model: Parameters<typeof ProviderTransform.schema>[0]
  readonly messages: SessionV1.WithParts[]
  readonly workspace: WorkspaceV2.ID | undefined
  readonly permissions: PermissionV2.Ruleset
  readonly run: EffectBridge.Shape
  readonly pluginTrigger: (
    event: "tool.execute.before" | "tool.execute.after",
    payload: unknown,
    out: unknown,
  ) => Effect.Effect<void, unknown, never>
  readonly completeToolCall: (callID: string, output: unknown) => Effect.Effect<void, unknown, never>
}

/**
 * A single tool as produced by a {@link ToolTransport}. The transport maps
 * canonical V2 `ToolDefinition`s into whatever shape `T` requires (an AI SDK
 * `tool({...})`, an MCP `Tool`, a CLI text row, etc.).
 */
export interface ToolMaterialization<T> {
  readonly id: string
  readonly tool: T
}

/**
 * Peer interface for tool transports. Each transport consumes
 * {@link ToolCatalog.materialize} and produces transport-specific tool entries.
 *
 * The catalog remains the canonical source; transports are peers of each other.
 * `s.builtin` is an implementation detail of the V1 legacy transport and
 * never receives banyan tools.
 */
export interface ToolTransport<T> {
  readonly id: symbol
  readonly buildTools: (
    catalog: import("@opencode-ai/core/tool/tool-catalog").Service,
    context: ToolMaterializationContext,
  ) => Effect.Effect<readonly ToolMaterialization<T>[], never, never>
}

export type AiSdkToolMaterialization = ToolMaterialization<AITool>
