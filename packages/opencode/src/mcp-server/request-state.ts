// MRTR requestState protection (gap-plan Milestone D2, SEP-2322).
//
// Security design: `requestState` round-trips through the client and is
// attacker-controlled input on re-entry (spec: basic/patterns/mrtr §Server
// Requirements). Every token minted here is HMAC-SHA256 sealed and binds
// four claims: the connection principal (MCP client name), the task handle,
// the pending request ID, and a short expiry. Verification is fail-closed:
// a token that is malformed, mis-signed, expired, replayed, or presented
// under a different principal/handle/request is rejected with a typed
// RequestStateError (never the decoded payload).
//
// Why HMAC (signed) and not AEAD (encrypted): the payload carries no
// secrets — principal name, task handle and request ID are already visible
// to the client that holds the token. Integrity is the requirement, and
// HMAC-SHA256 gives it with a sync node:crypto API (the SDK's async
// createRequestStateCodec is the same construction; this module stays sync
// so the sync DetailedTask builders can mint inline). If a future payload
// ever carries secrets, switch to AES-256-GCM.
//
// Replay: each token carries a random 128-bit nonce. verify() consumes the
// nonce into a bounded single-use set (pruned by expiry), so a captured
// token answers at most one tasks/update. Re-polling tasks/get mints a
// fresh nonce, so concurrent polls never invalidate each other.
//
// Secret lifecycle: one 256-bit secret per server process, generated at
// bootstrap in server.ts and held in memory only. Handle-scoped binding
// means a restart invalidates outstanding tokens anyway (records rehydrate,
// nonces do not) — the client re-polls tasks/get for a fresh token.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

// Wire version prefix. Bumped only when the seal format changes; verify
// rejects anything else as malformed.
export const REQUEST_STATE_VERSION = "v1" as const
// Short expiry: a question answer window, not a session. Bounded above by
// the needs_input timeout the server passes as ttlMs at bootstrap.
export const DEFAULT_REQUEST_STATE_TTL_MS = 300_000
const SECRET_BYTES = 32
const NONCE_BYTES = 16
// Bound on the consumed-nonce set. Nonces prune by expiry, so steady state
// is ~ (questions per TTL window); the cap is backstop only.
const MAX_CONSUMED_NONCES = 4096

export interface RequestStatePayload {
  principal: string
  taskHandle: string
  requestID: string
  expiresAt: number
  nonce: string
}

export type RequestStateRejectReason =
  | "malformed"
  | "mac"
  | "expired"
  | "replay"
  | "principal"
  | "handle"
  | "request"

export class RequestStateError extends Error {
  readonly reason: RequestStateRejectReason
  constructor(reason: RequestStateRejectReason, detail?: string) {
    super(`invalid requestState (${reason})${detail ? `: ${detail}` : ""}`)
    this.name = "RequestStateError"
    this.reason = reason
  }
}

export interface RequestStateMintInput {
  principal: string
  taskHandle: string
  requestID: string
  ttlMs?: number
}

// Expected bindings at verify time. Every field present is enforced;
// absent fields are decoded but not matched (the tasks/update handler
// always passes all three).
export interface RequestStateExpect {
  principal?: string
  taskHandle?: string
  requestID?: string
}

export interface RequestStateService {
  mint(input: RequestStateMintInput): string
  verify(token: unknown, expected?: RequestStateExpect): RequestStatePayload
}

const b64urlEncode = (bytes: Buffer): string =>
  bytes.toString("base64url")

const b64urlDecode = (text: string): Buffer => {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new RequestStateError("malformed", "body is not base64url")
  return Buffer.from(text, "base64url")
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export function createRequestStateService(opts?: {
  secret?: Buffer
  ttlMs?: number
  now?: () => number
}): RequestStateService {
  const secret = opts?.secret ?? randomBytes(SECRET_BYTES)
  if (secret.length < SECRET_BYTES) {
    throw new RangeError(`requestState secret must be at least ${SECRET_BYTES} bytes, got ${secret.length}`)
  }
  const defaultTtlMs = opts?.ttlMs ?? DEFAULT_REQUEST_STATE_TTL_MS
  const now = opts?.now ?? Date.now
  // Consumed nonces → expiry, for single-use replay rejection.
  const consumed = new Map<string, number>()

  const prune = (at: number): void => {
    if (consumed.size <= MAX_CONSUMED_NONCES) return
    for (const [nonce, exp] of consumed) {
      if (exp <= at) consumed.delete(nonce)
      if (consumed.size <= MAX_CONSUMED_NONCES / 2) break
    }
    // Still over cap (many live nonces): evict oldest first. Map preserves
    // insertion order, so the head is the oldest mint.
    while (consumed.size > MAX_CONSUMED_NONCES) {
      const oldest = consumed.keys().next()
      if (oldest.done) break
      consumed.delete(oldest.value)
    }
  }

  const macFor = (body: string): Buffer =>
    createHmac("sha256", secret).update(`mcp.request-state.${REQUEST_STATE_VERSION}.${body}`, "utf8").digest()

  return {
    mint(input: RequestStateMintInput): string {
      if (!input.principal || !input.taskHandle || !input.requestID) {
        throw new RequestStateError("malformed", "principal, taskHandle and requestID are all required to mint")
      }
      const ttlMs = input.ttlMs ?? defaultTtlMs
      const payload = {
        v: 1,
        principal: input.principal,
        task: input.taskHandle,
        req: input.requestID,
        exp: now() + Math.max(1, Math.floor(ttlMs)),
        nonce: randomBytes(NONCE_BYTES).toString("hex"),
      }
      const body = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"))
      return `${REQUEST_STATE_VERSION}.${body}.${b64urlEncode(macFor(body))}`
    },

    verify(token: unknown, expected: RequestStateExpect = {}): RequestStatePayload {
      if (typeof token !== "string") throw new RequestStateError("malformed", "requestState is not a string")
      const parts = token.split(".")
      if (parts.length !== 3 || parts[0] !== REQUEST_STATE_VERSION) {
        throw new RequestStateError("malformed", "expected v1.<body>.<mac>")
      }
      const [_, body, macText] = parts as [string, string, string]
      let raw: Buffer
      let decoded: unknown
      try {
        raw = b64urlDecode(body)
        decoded = JSON.parse(raw.toString("utf8"))
      } catch {
        throw new RequestStateError("malformed", "body is not decodable JSON")
      }
      if (!isRecord(decoded)) throw new RequestStateError("malformed", "payload is not an object")
      // Constant-time MAC check BEFORE trusting any payload field.
      let presented: Buffer
      try {
        presented = b64urlDecode(macText)
      } catch {
        throw new RequestStateError("malformed", "mac is not base64url")
      }
      const expectedMac = macFor(body)
      if (presented.length !== expectedMac.length || !timingSafeEqual(presented, expectedMac)) {
        throw new RequestStateError("mac", "signature mismatch")
      }
      const payload: RequestStatePayload = {
        principal: decoded["principal"] as string,
        taskHandle: decoded["task"] as string,
        requestID: decoded["req"] as string,
        expiresAt: decoded["exp"] as number,
        nonce: decoded["nonce"] as string,
      }
      if (
        decoded["v"] !== 1 ||
        typeof payload.principal !== "string" ||
        typeof payload.taskHandle !== "string" ||
        typeof payload.requestID !== "string" ||
        typeof payload.expiresAt !== "number" ||
        typeof payload.nonce !== "string" ||
        !payload.principal ||
        !payload.taskHandle ||
        !payload.requestID ||
        !payload.nonce
      ) {
        throw new RequestStateError("malformed", "payload shape mismatch")
      }
      if (!Number.isFinite(payload.expiresAt) || now() > payload.expiresAt) {
        throw new RequestStateError("expired", "token past its expiry")
      }
      if (expected.principal !== undefined && payload.principal !== expected.principal) {
        throw new RequestStateError("principal", "token was minted for a different principal")
      }
      if (expected.taskHandle !== undefined && payload.taskHandle !== expected.taskHandle) {
        throw new RequestStateError("handle", "token was minted for a different task")
      }
      if (expected.requestID !== undefined && payload.requestID !== expected.requestID) {
        throw new RequestStateError("request", "token was minted for a different request")
      }
      // Single-use: consume the nonce as the last step, so only a fully
      // valid token burns its replay budget.
      const at = now()
      const consumedExp = consumed.get(payload.nonce)
      if (consumedExp !== undefined && consumedExp > at) throw new RequestStateError("replay", "token already redeemed")
      prune(at)
      consumed.set(payload.nonce, payload.expiresAt)
      return payload
    },
  }
}

export * as McpRequestState from "./request-state"
