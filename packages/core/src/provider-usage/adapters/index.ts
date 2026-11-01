export * as ProviderUsageAdapters from "./index.js"

import { AnthropicAdapter } from "./anthropic.js"
import { CodexAdapter } from "./openai-codex.js"
import { CopilotAdapter } from "./github-copilot.js"
import { KimiAdapter } from "./kimi.js"
import { MiniMaxAdapter } from "./minimax.js"
import { OpenCodeGoAdapter } from "./opencode-go.js"
import { OpenRouterAdapter } from "./openrouter.js"
import { ZhipuAdapter } from "./zhipu.js"
import type { Adapter } from "./types.js"

/**
 * Exact adapters, in v1 order. The generic rate-limit fallback is not here:
 * in v2 response-header observation is a plugin session hook
 * (`http.response`), so the fallback lives in the BanyanCode telemetry
 * plugin, which merges observed windows over `unsupported` results.
 */
export const BUILT_IN_ADAPTERS: ReadonlyArray<Adapter> = [
  OpenCodeGoAdapter,
  CodexAdapter,
  OpenRouterAdapter,
  AnthropicAdapter,
  CopilotAdapter,
  KimiAdapter,
  ZhipuAdapter,
  MiniMaxAdapter,
]

export { AnthropicAdapter, CodexAdapter, CopilotAdapter, KimiAdapter, MiniMaxAdapter }
export { OpenCodeGoAdapter, OpenRouterAdapter, ZhipuAdapter }
export type { Adapter, AdapterContext, AdapterSupport, Endpoints, FetchImpl } from "./types.js"
export { DEFAULT_ENDPOINTS } from "./types.js"
