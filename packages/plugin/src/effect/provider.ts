import type { ProviderApi } from "@opencode/client/effect/api"
import type { Model } from "@opencode/schema/model"
import type { Provider } from "@opencode/schema/provider"
import type { ConnectionInfo } from "@opencode/client"
import type { Effect, Types } from "effect"
import type { Transform } from "./registration.js"

/** Provider metadata and immutable source definitions, including inactive providers. */
export interface ProviderRecord {
  readonly provider: Provider.Info
  readonly models: ReadonlyMap<string, Model.Info>
  readonly sourceConnection?: ConnectionInfo
}

export interface ProviderEditor {
  list(): readonly ProviderRecord[]
  get(providerID: string): ProviderRecord | undefined
  /** A discovered account-specific inventory can be bound to the connection that produced it. */
  add(input: { info: Provider.Info; models: readonly Model.Info[]; sourceConnection?: ConnectionInfo }): void
  update(providerID: string, update: (provider: Types.DeepMutable<Provider.Info>) => void): void
  remove(providerID: string): void
  readonly models: {
    set(providerID: string, models: readonly Model.Info[]): void
    /** Updates an owned copy of a source definition. */
    update(providerID: string, modelID: string, update: (model: Types.DeepMutable<Model.Info>) => void): void
    remove(providerID: string, modelID: string): void
  }
}

/**
 * Provider quota result. These are the only fields a plugin can ever receive
 * from the usage seam: normalized numbers and labels, never credentials,
 * request headers, or upstream bodies.
 */
export interface ProviderUsageWindow {
  readonly id: string
  readonly label: string
  readonly kind: "quota" | "rate_limit"
  readonly usedPercent?: number
  readonly remainingPercent?: number
  readonly resetsAt?: number
  readonly durationSeconds?: number
  readonly limit?: number
  readonly remaining?: number
}

export interface ProviderUsageSnapshot {
  readonly providerID: string
  readonly displayName: string
  readonly status: "available" | "stale" | "unsupported" | "unauthenticated" | "error"
  readonly confidence: "exact" | "reported" | "estimated"
  readonly windows: ReadonlyArray<ProviderUsageWindow>
  readonly balance?: { readonly remaining: number; readonly currency?: string }
  readonly message?: string
  readonly fetchedAt: number
}

export interface ProviderUsageList {
  readonly snapshots: ReadonlyArray<ProviderUsageSnapshot>
}

export interface ProviderUsageInput {
  /** Bypass the TTL cache and refresh every selected provider. */
  readonly force?: boolean
  /** Restrict the result to one provider (canonical aliases match). */
  readonly providerID?: string
}

export interface ProviderDomain extends ProviderApi<unknown> {
  readonly transform: Transform<ProviderEditor>
  readonly reload: () => Effect.Effect<void>
  /**
   * Result-only quota lookup. Core resolves the credential, performs the
   * provider's fixed usage request, and returns sanitized windows; the plugin
   * supplies no URL, header, token, or request callback and receives none.
   */
  readonly usage: (input?: ProviderUsageInput) => Effect.Effect<ProviderUsageList, unknown>
}
