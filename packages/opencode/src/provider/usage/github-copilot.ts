/**
 * GitHub Copilot usage adapter (provider-usage sidebar).
 *
 * Calls `GET https://api.github.com/copilot_internal/user` with the Copilot
 * OAuth token using the `token` authorization scheme and VS Code client
 * headers. Normalizes the `quota_snapshots.premium_interactions` monthly
 * quota into a single remaining-percent window with its reset time.
 *
 * Contract follows the MIT-licensed `xihuai18/opencode-quota-sidebar`
 * copilot adapter. The official organization billing REST API is org-owner
 * only and is not usable for an ordinary user's sidebar, so only this
 * internal user endpoint is queried. Non-OAuth callers resolve to
 * `unsupported`, never to fabricated limits.
 */

import { Effect } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import type { Adapter, AdapterContext } from "../usage"

export const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const toFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/** Upstream sends either a 0-1 fraction or a 0-100 percent. */
const toRemainingPercent = (value: unknown): number | undefined => {
  const numeric = toFiniteNumber(value)
  if (numeric === undefined) return undefined
  return numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric
}

const toResetsAt = (value: unknown): number | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Pure normalizer; throws a secret-safe ProviderUsageError on malformed payloads. */
export const normalizeCopilotUsage = (
  payload: unknown,
  input: { providerID: string; displayName: string; fetchedAt?: number },
): Banyan.ProviderUsageSnapshot => {
  const fail = (message: string): never => {
    throw new Banyan.ProviderUsageError({
      providerID: input.providerID,
      reason: "upstream",
      message,
    })
  }
  if (!isRecord(payload)) fail("Copilot returned an unrecognized user payload")
  const root: Record<string, unknown> = isRecord(payload) ? payload : fail("unreachable")
  const snapshots = isRecord(root["quota_snapshots"]) ? root["quota_snapshots"] : undefined
  const premium = snapshots !== undefined && isRecord(snapshots["premium_interactions"])
    ? snapshots["premium_interactions"]
    : undefined
  if (!premium) fail("Copilot returned no quota snapshot")
  const interactions: Record<string, unknown> = isRecord(premium) ? premium : fail("unreachable")
  const remainingPercent =
    toRemainingPercent(interactions["percent_remaining"]) ??
    (() => {
      const entitlement = toFiniteNumber(interactions["entitlement"])
      const remaining = toFiniteNumber(interactions["remaining"])
      if (entitlement === undefined || remaining === undefined || entitlement <= 0) return undefined
      return (remaining / entitlement) * 100
    })()
  if (remainingPercent === undefined) fail("Copilot returned no quota snapshot")
  const percent: number = toFiniteNumber(remainingPercent) ?? fail("unreachable")
  return new Banyan.ProviderUsageSnapshot({
    providerID: input.providerID,
    displayName: input.displayName,
    status: "available",
    confidence: "exact",
    windows: [
      Banyan.normalizeWindow({
        id: "monthly",
        label: "Monthly",
        kind: "quota",
        remainingPercent: percent,
        resetsAt: toResetsAt(root["quota_reset_date"]) ?? toResetsAt(interactions["quota_reset_date_utc"]),
      }),
    ],
    fetchedAt: input.fetchedAt ?? Date.now(),
  })
}

export const CopilotAdapter: Adapter = {
  id: "banyan-usage-github-copilot",
  providerID: "github-copilot",
  refreshIntervalSeconds: 120,
  supports: (input) => input.providerID.startsWith("github-copilot"),
  fetch: (ctx: AdapterContext) =>
    Effect.gen(function* () {
      const auth = ctx.auth
      if (!auth) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "GitHub Copilot is not connected",
        })
      }
      if (auth.type !== "oauth") {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unsupported",
          message: "GitHub Copilot usage requires an OAuth session",
        })
      }
      if (auth.expires < Date.now()) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "GitHub Copilot session expired — re-authenticate to refresh usage",
        })
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          ctx.fetch(COPILOT_USER_URL, {
            method: "GET",
            headers: {
              accept: "application/json",
              authorization: `token ${auth.access}`,
              "user-agent": "GitHubCopilotChat/0.35.0",
              "editor-version": "vscode/1.107.0",
              "editor-plugin-version": "copilot-chat/0.35.0",
              "copilot-integration-id": "vscode-chat",
            },
          }),
        catch: () =>
          new Banyan.ProviderUsageError({
            providerID: ctx.providerID,
            reason: "network",
            message: "GitHub Copilot usage request failed",
          }),
      })
      if (response.status === 401 || response.status === 403) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "GitHub Copilot rejected the session — re-authenticate to refresh usage",
        })
      }
      if (response.status === 429) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "rate_limited",
          message: "GitHub Copilot usage rate limited",
        })
      }
      if (!response.ok) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "upstream",
          message: `GitHub Copilot usage returned status ${response.status}`,
        })
      }
      const payload: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () =>
          new Banyan.ProviderUsageError({
            providerID: ctx.providerID,
            reason: "upstream",
            message: "GitHub Copilot returned an unreadable usage payload",
          }),
      })
      return normalizeCopilotUsage(payload, {
        providerID: ctx.providerID,
        displayName: ctx.displayName,
      })
    }),
}
