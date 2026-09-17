/**
 * Shared ChatGPT/Codex OAuth refresh primitives.
 *
 * `codex.ts` (plugin loader, plain async) and `provider/usage/openai-codex.ts`
 * (Effect adapter) previously risked duplicating the refresh-token request,
 * JWT account-id parsing, and refresh-and-persist flow. This module owns all
 * three so both callers share one implementation:
 *
 * - `refreshCodexAccessToken` — the raw refresh-token HTTP request + parsing.
 * - `codexSessionFromTokens` — pure expiry/account-id derivation.
 * - `refreshAndPersistCodexSession` — Effect wrapper that refreshes once and
 *   persists via a caller-supplied callback (best-effort: persist failures
 *   never fail the refresh). Refresh failures surface as secret-safe
 *   `ProviderUsageError` with reason `unauthenticated`.
 */

import { Effect } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const CODEX_DEFAULT_ISSUER = "https://auth.openai.com"

export interface CodexFetchInit extends RequestInit {}

export type CodexFetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface CodexTokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountId(tokens: CodexTokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

/** Raw refresh-token request + response parsing. Throws `Token refresh failed: <status>` on rejection. */
export async function refreshCodexAccessToken(
  refreshToken: string,
  options: { issuer?: string; fetchImpl?: CodexFetchImpl } = {},
): Promise<CodexTokenResponse> {
  const issuer = options.issuer ?? CODEX_DEFAULT_ISSUER
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return response.json()
}

export interface CodexRefreshedSession {
  access: string
  refresh: string
  expires: number
  accountId?: string
}

/** Pure derivation: expiry timestamp plus account id with fallback to the previous value. */
export const codexSessionFromTokens = (
  tokens: CodexTokenResponse,
  fallbackAccountId?: string,
): CodexRefreshedSession => {
  const accountId = extractAccountId(tokens) ?? fallbackAccountId
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    ...(accountId ? { accountId } : {}),
  }
}

/**
 * Effect wrapper: refresh once, derive the session, persist via the caller's
 * callback. Persist failures are swallowed (best-effort) so a write error
 * never masks a successful refresh. Refresh failures become secret-safe
 * `unauthenticated` errors — upstream messages are redacted before they can
 * carry tokens or account ids.
 */
export const refreshAndPersistCodexSession = (input: {
  providerID: string
  refreshToken: string
  previousAccountId?: string
  issuer?: string
  fetchImpl?: CodexFetchImpl
  persist: (session: CodexRefreshedSession) => Effect.Effect<void, unknown>
}): Effect.Effect<CodexRefreshedSession, Banyan.ProviderUsageError> =>
  Effect.gen(function* () {
    const tokens = yield* Effect.tryPromise({
      try: () =>
        refreshCodexAccessToken(input.refreshToken, { issuer: input.issuer, fetchImpl: input.fetchImpl }),
      catch: (cause) =>
        new Banyan.ProviderUsageError({
          providerID: input.providerID,
          reason: "unauthenticated",
          message:
            Banyan.redactSecrets(cause instanceof Error ? cause.message : String(cause)) ||
            "ChatGPT session refresh failed",
        }),
    })
    const session = codexSessionFromTokens(tokens, input.previousAccountId)
    yield* input.persist(session).pipe(Effect.catchCause(() => Effect.void))
    return session
  })
