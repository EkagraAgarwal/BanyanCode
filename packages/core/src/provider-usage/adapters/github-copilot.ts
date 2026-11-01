export * as CopilotUsage from "./github-copilot.js"

import { Effect } from "effect"
import { ProviderUsageError } from "../error.js"
import { normalizeWindow, type Snapshot } from "../schema.js"
import { fromThrow, isRecord, requestJson, toFiniteNumber, toResetsAt } from "./http.js"
import type { Adapter, AdapterContext } from "./types.js"

/**
 * GitHub Copilot usage adapter (provider-usage sidebar parity).
 *
 * Calls the fixed `GET https://api.github.com/copilot_internal/user`
 * endpoint with the Copilot OAuth token using the `token` authorization
 * scheme and VS Code client headers. Normalizes
 * `quota_snapshots.premium_interactions` into a monthly remaining-percent
 * window. Non-OAuth callers resolve to `unsupported`, never to fabricated
 * limits.
 */

/** Upstream sends either a 0-1 fraction or a 0-100 percent. */
const toRemainingPercent = (value: unknown): number | undefined => {
  const numeric = toFiniteNumber(value)
  if (numeric === undefined) return undefined
  return numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric
}

/** Pure normalizer; throws a secret-safe error on malformed payloads. */
export const normalizeCopilotUsage = (
  payload: unknown,
  input: { providerID: string; displayName: string; fetchedAt?: number },
): Snapshot => {
  const fail = (message: string): never => {
    throw new ProviderUsageError({
      providerID: input.providerID,
      reason: "upstream",
      message,
    })
  }
  if (!isRecord(payload)) fail("Copilot returned an unrecognized user payload")
  const root: Record<string, unknown> = isRecord(payload) ? payload : fail("unreachable")
  const snapshots = isRecord(root["quota_snapshots"]) ? root["quota_snapshots"] : undefined
  const premium =
    snapshots !== undefined && isRecord(snapshots["premium_interactions"])
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
  return {
    providerID: input.providerID,
    displayName: input.displayName,
    status: "available",
    confidence: "exact",
    windows: [
      normalizeWindow({
        id: "monthly",
        label: "Monthly",
        kind: "quota",
        remainingPercent: percent,
        resetsAt: toResetsAt(root["quota_reset_date"]) ?? toResetsAt(interactions["quota_reset_date_utc"]),
      }),
    ],
    fetchedAt: input.fetchedAt ?? Date.now(),
  }
}

export const CopilotAdapter: Adapter = {
  id: "banyan-usage-github-copilot",
  providerID: "github-copilot",
  refreshIntervalSeconds: 120,
  supports: (input) => input.providerID.startsWith("github-copilot"),
  fetch: (ctx: AdapterContext) =>
    Effect.gen(function* () {
      const credential = yield* ctx.credential()
      if (!credential)
        return yield* new ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "GitHub Copilot is not connected",
        })
      if (credential.type !== "oauth")
        return yield* new ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unsupported",
          message: "GitHub Copilot usage requires an OAuth session",
        })
      if (credential.expires < Date.now())
        return yield* new ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "GitHub Copilot session expired — re-authenticate to refresh usage",
        })
      const payload = yield* requestJson({
        providerID: ctx.providerID,
        fetch: ctx.fetch,
        url: ctx.endpoints.githubCopilot,
        headers: {
          accept: "application/json",
          authorization: `token ${credential.access}`,
          "user-agent": "GitHubCopilotChat/0.35.0",
          "editor-version": "vscode/1.107.0",
          "editor-plugin-version": "copilot-chat/0.35.0",
          "copilot-integration-id": "vscode-chat",
        },
        label: "GitHub Copilot usage",
        unauthorized: "GitHub Copilot rejected the session — re-authenticate to refresh usage",
        rateLimited: "GitHub Copilot usage rate limited",
        unreadable: "GitHub Copilot returned an unreadable usage payload",
      })
      return yield* fromThrow(ctx.providerID, () =>
        normalizeCopilotUsage(payload, { providerID: ctx.providerID, displayName: ctx.displayName }),
      )
    }),
}
