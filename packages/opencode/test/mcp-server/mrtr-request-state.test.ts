// MRTR requestState security (gap-plan Milestone D2, SEP-2322).
//
// The token round-trips through the client as attacker-controlled input:
// every rejection branch below (tamper, wrong secret, expiry, replay,
// binding mismatch, malformed) must fail closed with a typed
// RequestStateError.

import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import {
  createRequestStateService,
  DEFAULT_REQUEST_STATE_TTL_MS,
  RequestStateError,
} from "../../src/mcp-server/request-state"

const SECRET = Buffer.alloc(32, 7)
const OTHER_SECRET = Buffer.alloc(32, 9)

const mintInput = { principal: "test-client", taskHandle: "btask_abc", requestID: "req-1" }

describe("request-state mint/verify round-trip", () => {
  test("verifies and returns the bound claims", () => {
    let at = 1_700_000_000_000
    const svc = createRequestStateService({ secret: SECRET, now: () => at })
    const token = svc.mint(mintInput)
    expect(typeof token).toBe("string")
    expect(token.startsWith("v1.")).toBe(true)
    const payload = svc.verify(token, { ...mintInput })
    expect(payload.principal).toBe("test-client")
    expect(payload.taskHandle).toBe("btask_abc")
    expect(payload.requestID).toBe("req-1")
    expect(payload.expiresAt).toBe(at + DEFAULT_REQUEST_STATE_TTL_MS)
    expect(typeof payload.nonce).toBe("string")
  })

  test("honors a per-mint ttl", () => {
    const at = 1_700_000_000_000
    const svc = createRequestStateService({ secret: SECRET, now: () => at })
    const payload = svc.verify(svc.mint({ ...mintInput, ttlMs: 1_000 }))
    expect(payload.expiresAt).toBe(at + 1_000)
  })

  test("verifies without expected bindings", () => {
    const svc = createRequestStateService({ secret: SECRET })
    expect(svc.verify(svc.mint(mintInput)).requestID).toBe("req-1")
  })

  test("mint requires all binding fields", () => {
    const svc = createRequestStateService({ secret: SECRET })
    expect(() => svc.mint({ ...mintInput, principal: "" })).toThrow(RequestStateError)
    expect(() => svc.mint({ ...mintInput, taskHandle: "" })).toThrow(RequestStateError)
    expect(() => svc.mint({ ...mintInput, requestID: "" })).toThrow(RequestStateError)
  })

  test("rejects short secrets at construction", () => {
    expect(() => createRequestStateService({ secret: Buffer.alloc(16, 1) })).toThrow(RangeError)
  })
})

describe("request-state tamper rejection", () => {
  test("flipped body character fails the MAC", () => {
    const svc = createRequestStateService({ secret: SECRET })
    const token = svc.mint(mintInput)
    const parts = token.split(".")
    // Rewrite one JSON string byte (still valid JSON and shape) so the
    // failure lands on the MAC check, not on decode.
    const raw = Buffer.from(parts[1] ?? "", "base64url").toString("utf8")
    const edited = raw.replace("test-client", "test-clienX")
    expect(edited).not.toBe(raw)
    const forged = Buffer.from(edited, "utf8").toString("base64url")
    expect(rejectReason(svc, `${parts[0]}.${forged}.${parts[2]}`)).toBe("mac")
  })

  test("flipped signature character fails the MAC", () => {
    const svc = createRequestStateService({ secret: SECRET })
    const token = svc.mint(mintInput)
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")
    expect(rejectReason(svc, tampered)).toBe("mac")
  })

  test("token sealed under another secret fails the MAC", () => {
    const a = createRequestStateService({ secret: SECRET })
    const b = createRequestStateService({ secret: OTHER_SECRET })
    expect(rejectReason(b, a.mint(mintInput))).toBe("mac")
  })

  test("truncated and garbage tokens are malformed", () => {
    const svc = createRequestStateService({ secret: SECRET })
    const token = svc.mint(mintInput)
    expect(rejectReason(svc, token.split(".").slice(0, 2).join("."))).toBe("malformed")
    expect(rejectReason(svc, "not-a-token")).toBe("malformed")
    expect(rejectReason(svc, "")).toBe("malformed")
    expect(rejectReason(svc, 42)).toBe("malformed")
    expect(rejectReason(svc, undefined)).toBe("malformed")
    expect(rejectReason(svc, "v9.e30.e30")).toBe("malformed")
  })

  test("valid MAC over a bad-shape payload is malformed", () => {
    const body = Buffer.from(JSON.stringify({ v: 1, principal: "", task: "t", req: "r", exp: 1, nonce: "n" })).toString(
      "base64url",
    )
    const mac = createHmac("sha256", SECRET).update(`mcp.request-state.v1.${body}`, "utf8").digest().toString("base64url")
    const svc = createRequestStateService({ secret: SECRET })
    expect(rejectReason(svc, `v1.${body}.${mac}`)).toBe("malformed")
  })
})

describe("request-state expiry", () => {
  test("past-expiry tokens are rejected", () => {
    let at = 1_700_000_000_000
    const svc = createRequestStateService({ secret: SECRET, ttlMs: 1_000, now: () => at })
    const token = svc.mint(mintInput)
    at += 1_001
    expect(rejectReason(svc, token)).toBe("expired")
  })

  test("token at the exact expiry second still verifies", () => {
    let at = 1_700_000_000_000
    const svc = createRequestStateService({ secret: SECRET, ttlMs: 1_000, now: () => at })
    const token = svc.mint(mintInput)
    at += 1_000
    expect(svc.verify(token).requestID).toBe("req-1")
  })
})

describe("request-state replay rejection", () => {
  test("second verify of the same token is a replay", () => {
    const svc = createRequestStateService({ secret: SECRET })
    const token = svc.mint(mintInput)
    expect(svc.verify(token, { ...mintInput }).nonce.length).toBeGreaterThan(0)
    expect(rejectReason(svc, token)).toBe("replay")
  })

  test("re-poll mints stay independently redeemable", () => {
    const svc = createRequestStateService({ secret: SECRET })
    const first = svc.mint(mintInput)
    const second = svc.mint(mintInput)
    expect(first).not.toBe(second)
    expect(svc.verify(first, { ...mintInput }).requestID).toBe("req-1")
    expect(svc.verify(second, { ...mintInput }).requestID).toBe("req-1")
  })
})

describe("request-state binding", () => {
  test("principal, handle and request mismatches are rejected", () => {
    const svc = createRequestStateService({ secret: SECRET })
    // Each mismatch check runs against a fresh token (verify consumes).
    expect(rejectReason(svc, svc.mint(mintInput), { principal: "other-client" })).toBe("principal")
    expect(rejectReason(svc, svc.mint(mintInput), { taskHandle: "btask_other" })).toBe("handle")
    expect(rejectReason(svc, svc.mint(mintInput), { requestID: "req-2" })).toBe("request")
  })
})

const rejectReason = (
  svc: ReturnType<typeof createRequestStateService>,
  token: unknown,
  expected?: { principal?: string; taskHandle?: string; requestID?: string },
): string => {
  try {
    svc.verify(token, expected)
  } catch (error) {
    expect(error).toBeInstanceOf(RequestStateError)
    return (error as RequestStateError).reason
  }
  throw new Error("invalid token verified")
}
