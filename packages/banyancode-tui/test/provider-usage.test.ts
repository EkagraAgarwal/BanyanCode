import { expect, test } from "bun:test"
import type { ProviderUsageSnapshot } from "../src/data/pending-rpc"
import { statusLine } from "../src/data/usage"

const snapshot = (
  input: Pick<ProviderUsageSnapshot, "status"> & Partial<ProviderUsageSnapshot>,
): ProviderUsageSnapshot => ({
  providerID: "claude-agent",
  displayName: "Claude Agent",
  confidence: "reported",
  windows: [],
  fetchedAt: 1,
  ...input,
})

test("an unsupported provider shows its own message", () => {
  expect(statusLine(snapshot({ status: "unsupported", message: "Limits appear after the first response" }))).toBe(
    "Limits appear after the first response",
  )
})

test("an unsupported provider without a message keeps the v1 label", () => {
  expect(statusLine(snapshot({ status: "unsupported" }))).toBe("Usage unavailable")
})

test("a disconnected provider says Not connected", () => {
  expect(statusLine(snapshot({ status: "unauthenticated", message: "ignored" }))).toBe("Not connected")
})
