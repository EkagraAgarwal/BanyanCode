export * as ProviderUsageAdapter from "./types.js"

import type { Credential } from "@opencode/schema/credential"
import type { Provider } from "@opencode/schema/provider"
import type { Effect } from "effect"
import type { ProviderUsageError } from "../error.js"
import type { Snapshot } from "../schema.js"

/**
 * Fixed usage endpoints. Adapters only ever build requests against these
 * values; there is no caller-supplied URL anywhere in the plugin-facing
 * surface. `endpoints` is replaced as a whole by the service test seam so a
 * test can point every adapter at a local fake server.
 */
export interface Endpoints {
  readonly anthropic: string
  readonly chatgpt: string
  readonly openrouter: string
  readonly githubCopilot: string
  readonly kimi: string
  readonly zhipu: string
  readonly zhipuIntl: string
  readonly minimax: string
  readonly minimaxIntl: string
  readonly opencodeGo: string
}

/** Port of the v1 endpoints. Pinned vendor hosts only. */
export const DEFAULT_ENDPOINTS: Endpoints = {
  anthropic: "https://api.anthropic.com/api/oauth/usage",
  chatgpt: "https://chatgpt.com/backend-api/wham/usage",
  openrouter: "https://openrouter.ai/api/v1/key",
  githubCopilot: "https://api.github.com/copilot_internal/user",
  kimi: "https://api.kimi.com/coding/v1/usages",
  zhipu: "https://bigmodel.cn/api/monitor/usage/quota/limit",
  zhipuIntl: "https://api.z.ai/api/monitor/usage/quota/limit",
  minimax: "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains",
  minimaxIntl: "https://www.minimax.io/v1/api/openplatform/coding_plan/remains",
  opencodeGo: "https://opencode.ai/zen/go/v1/usage",
}

export type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>

/**
 * Adapter input. The credential is a thunk resolved by the core service; it
 * never crosses into plugin-visible code because adapters are core-internal.
 */
export interface AdapterContext {
  readonly providerID: string
  readonly displayName: string
  readonly credential: () => Effect.Effect<Credential.Value | undefined>
  readonly settings: Provider.Settings | undefined
  readonly accountKey: string
  readonly fetch: FetchImpl
  readonly endpoints: Endpoints
}

export interface AdapterSupport {
  readonly providerID: string
  readonly hasAuth: boolean
  readonly authType?: string
}

export interface Adapter {
  readonly id: string
  readonly providerID: string
  readonly refreshIntervalSeconds: number
  readonly supports: (input: AdapterSupport) => boolean
  readonly fetch: (ctx: AdapterContext) => Effect.Effect<Snapshot, ProviderUsageError>
}
