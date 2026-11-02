export * as OpenCodeGoUsage from "./opencode-go.js"

import { Effect } from "effect"
import { ProviderUsageError } from "../error.js"
import { normalizeWindow, type NormalizeWindowInput, type Snapshot } from "../schema.js"
import { fromThrow, isRecord, requestJson, toFiniteNumber, toResetsAt } from "./http.js"
import type { Adapter, AdapterContext } from "./types.js"

/**
 * OpenCode Go usage adapter (provider-usage sidebar parity).
 *
 * Calls `GET <Console origin>/zen/go/v1/usage` with the workspace credential.
 * In v2 the credential is the active integration
 * connection: a workspace API key, or the OpenCode Console device-login OAuth
 * token. Console's own usage service reads the same endpoint with the OAuth
 * access token plus the workspace id (`packages/core/src/usage-limits.ts`),
 * so both credential kinds are accepted here. Env and configured `apiKey`
 * options surface as env/key connections.
 *
 * Live contract: `{ usage: { rolling, weekly, monthly } }` where each window
 * carries `percent` (used percent, 0-100) and a reset. The endpoint returns no
 * credit balance, so none is inferred.
 */

export const PROVIDER_IDS = ["opencode", "opencode-go"] as const

const WINDOW_DEFS = [
  { field: "rolling", durationSeconds: 18_000 },
  { field: "weekly", durationSeconds: 604_800 },
  { field: "monthly", durationSeconds: 2_592_000 },
] as const

const pickNumber = (entry: Record<string, unknown>, names: ReadonlyArray<string>): number | undefined => {
  for (const name of names) {
    const value = toFiniteNumber(entry[name])
    if (value !== undefined) return value
  }
  return undefined
}

const pickString = (entry: Record<string, unknown>, names: ReadonlyArray<string>): string | undefined => {
  for (const name of names) {
    const value = entry[name]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

const RESET_NAMES = ["resetsAt", "resets_at", "reset_at", "resetAt", "resets", "reset"] as const

const toWindowInput = (
  key: string,
  entry: Record<string, unknown>,
  durationSeconds?: number,
): NormalizeWindowInput => ({
  id: pickString(entry, ["id"]) ?? key,
  label: pickString(entry, ["label", "name", "title"]),
  kind: "quota",
  usedPercent: pickNumber(entry, ["percent", "used_percent", "usedPercent", "used"]),
  remainingPercent: pickNumber(entry, ["remaining_percent", "remainingPercent"]),
  resetsAt: (() => {
    for (const name of RESET_NAMES) {
      const parsed = toResetsAt(entry[name])
      if (parsed !== undefined) return parsed
    }
    return undefined
  })(),
  durationSeconds:
    pickNumber(entry, ["duration_seconds", "durationSeconds", "duration", "window_seconds"]) ?? durationSeconds,
  limit: pickNumber(entry, ["limit", "total"]),
  remaining: pickNumber(entry, ["remaining", "left"]),
})

/** Live shape first; falls back to `windows[]`, then a top-level map. */
const collectEntries = (
  payload: unknown,
): Array<{ key: string; entry: Record<string, unknown>; durationSeconds?: number }> => {
  if (!isRecord(payload)) return []
  const usage = payload["usage"]
  if (isRecord(usage)) {
    const entries: Array<{ key: string; entry: Record<string, unknown>; durationSeconds?: number }> = []
    for (const def of WINDOW_DEFS) {
      const entry = usage[def.field]
      if (isRecord(entry)) entries.push({ key: def.field, entry, durationSeconds: def.durationSeconds })
    }
    for (const [key, value] of Object.entries(usage)) {
      if (isRecord(value) && !WINDOW_DEFS.some((def) => def.field === key)) entries.push({ key, entry: value })
    }
    return entries
  }
  const windows = payload["windows"]
  if (Array.isArray(windows)) {
    return windows
      .filter((item) => isRecord(item))
      .map((entry, index) => ({
        key: pickString(entry, ["id", "label", "name"]) ?? `windows-${index}`,
        entry,
      }))
  }
  const entries: Array<{ key: string; entry: Record<string, unknown>; durationSeconds?: number }> = []
  for (const [key, value] of Object.entries(payload)) {
    if (!isRecord(value)) continue
    const def = WINDOW_DEFS.find((item) => item.field === key)
    entries.push(def ? { key, entry: value, durationSeconds: def.durationSeconds } : { key, entry: value })
  }
  return entries
}

/** Pure normalizer; throws a secret-safe error on malformed payloads. */
export const normalizeOpenCodeGoUsage = (
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
  if (!isRecord(payload)) fail("OpenCode Go returned an unrecognized usage payload")
  const entries = collectEntries(payload)
  if (entries.length === 0) fail("OpenCode Go returned no usage windows")
  return {
    providerID: input.providerID,
    displayName: input.displayName,
    status: "available",
    confidence: "exact",
    windows: entries.map(({ key, entry, durationSeconds }) =>
      normalizeWindow(toWindowInput(key, entry, durationSeconds)),
    ),
    fetchedAt: input.fetchedAt ?? Date.now(),
  }
}

/** Console serves the Go allowance from the origin the member signed in to. */
const usageURL = (fallback: string, server: unknown): string => {
  if (typeof server !== "string" || server.length === 0) return fallback
  try {
    const url = new URL(server)
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback
    return `${url.origin}/zen/go/v1/usage`
  } catch {
    return fallback
  }
}

export const OpenCodeGoAdapter: Adapter = {
  id: "banyan-usage-opencode-go",
  providerID: "opencode",
  refreshIntervalSeconds: 60,
  supports: (input) => (PROVIDER_IDS as readonly string[]).includes(input.providerID),
  fetch: (ctx: AdapterContext) =>
    Effect.gen(function* () {
      const credential = yield* ctx.credential()
      const isOAuth = credential?.type === "oauth"
      const token =
        credential?.type === "key" && credential.key.length > 0
          ? credential.key
          : isOAuth && credential.access.length > 0
            ? credential.access
            : undefined
      if (!token)
        return yield* new ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "OpenCode Go is not connected",
        })
      const workspaceID =
        isOAuth && typeof credential.metadata?.orgID === "string" && credential.metadata.orgID.length > 0
          ? credential.metadata.orgID
          : undefined
      const payload = yield* requestJson({
        providerID: ctx.providerID,
        fetch: ctx.fetch,
        url: isOAuth ? usageURL(ctx.endpoints.opencodeGo, credential.metadata?.server) : ctx.endpoints.opencodeGo,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(workspaceID === undefined ? {} : { "x-opencode-org-id": workspaceID }),
        },
        label: "OpenCode Go usage",
        unauthorized: "OpenCode Go rejected the API key",
        rateLimited: "OpenCode Go usage rate limited",
        unreadable: "OpenCode Go returned an unreadable usage payload",
      }).pipe(
        // An OAuth connection exists even when the quota endpoint refuses it
        // (for example an account without Go). Reporting that as "Not
        // connected" would be false; surface the refusal instead.
        Effect.catchIf(
          (error): error is ProviderUsageError =>
            isOAuth && error instanceof ProviderUsageError && error.reason === "unauthenticated",
          () =>
            Effect.fail(
              new ProviderUsageError({
                providerID: ctx.providerID,
                reason: "unsupported",
                message: "OpenCode Go usage is unavailable for this account",
              }),
            ),
        ),
      )
      return yield* fromThrow(ctx.providerID, () =>
        normalizeOpenCodeGoUsage(payload, { providerID: ctx.providerID, displayName: ctx.displayName }),
      )
    }),
}
