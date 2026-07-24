import { SessionV1 } from "@opencode-ai/core/v1/session"

// V1 loop no-progress detector.
//
// Builds a canonical fingerprint set for a settled tool batch (one assistant
// turn) so the surrounding loop can decide whether the last
// `NO_PROGRESS_THRESHOLD` consecutive turns had the same fingerprint set. The
// detector runs at the persisted-history seam — after the assistant message
// has been written and before the next loop iteration — and exits the loop
// with the `"noProgress"` outcome when the threshold is reached.
//
// Fingerprint rule: `tool name + canonical-JSON of state.input` plus the
// settled status (`completed` or `error`). Pending/running states are excluded
// so an in-flight tool call never counts as "no progress". Provider-executed
// and interrupted-orphan tool parts are filtered out (matching the existing
// `hasToolCalls` rule at the seam) so the detector never confuses a harmless
// retry/cleanup for an agent-stuck loop.

export const NO_PROGRESS_THRESHOLD = 3

type WithParts = SessionV1.WithParts

function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

function canonicalizeValue(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value)
    return `n:${value}`
  }
  if (typeof value === "string") return `s:${JSON.stringify(value)}`
  if (typeof value === "boolean") return `b:${value}`
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeValue).join(",")}]`
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalizeValue(obj[key])}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value)
}

function fingerprintToolPart(part: SessionV1.ToolPart): string | undefined {
  if (part.state.status !== "completed" && part.state.status !== "error") return undefined
  return `${part.tool}|${part.state.status}|${canonicalizeValue(part.state.input)}`
}

// Build the canonical fingerprint set for a settled tool batch. The returned
// set is order-independent across parallel calls and collapses duplicates
// (two equal completed calls produce one key). Provider-executed and
// interrupted-orphan tool parts are excluded; an empty input still produces a
// distinct key (so a "completed tool with empty input" is a stable fingerprint
// across turns).
export function canonicalizeToolBatch(msgs: ReadonlyArray<WithParts>): Set<string> {
  const fingerprints = new Set<string>()
  for (const msg of msgs) {
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (part.metadata?.providerExecuted) continue
      if (isOrphanedInterruptedTool(part)) continue
      const fingerprint = fingerprintToolPart(part)
      if (fingerprint) fingerprints.add(fingerprint)
    }
  }
  return fingerprints
}

// Convenience: compare two fingerprint sets for equality (set semantics, not
// multiset). Order-independent and multiplicity-independent.
export function sameFingerprintSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}