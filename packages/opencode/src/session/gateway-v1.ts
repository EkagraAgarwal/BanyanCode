import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Effect, Option } from "effect"

// V1 runtime seam for the Repository Intelligence Gateway (plan §2.1 Gate A /
// §2.2 Gate B, mirroring the V2 hook in core/tool/registry.ts). Pure,
// fail-closed helpers: a missing gateway, malformed session history, or an
// unexpected outcome shape must leave tool execution byte-for-byte unchanged.
// The interception itself lives in session/tools.ts; this module only derives
// the Gate B context and applies the outcome so both are unit-testable
// without an Effect runtime.

// Gate A allowlist: the gateway intercepts only the conventional repository
// tools. Not exported from core's registry (V2 owns its own copy there), so a
// local const keeps this seam self-contained.
export const GATEWAY_TOOLS = new Set(["read", "grep", "glob"])

// Per-tool routing kill-switches (plan §4), the V1 twin of core's
// `routeAllowedFor`: an explicit `banyancode_route_<tool>: false` bypasses the
// gateway for that tool (the settle is byte-identical). Fail-closed by
// contract — a missing BanyanConfigService or an absent flag means routing is
// allowed; config can only ever DISABLE the hook for a single tool.
export const routeAllowed = (toolName: string): Effect.Effect<boolean, never, never> =>
  Effect.gen(function* () {
    const configOpt = yield* Effect.serviceOption(Banyan.BanyanConfigService)
    if (Option.isNone(configOpt)) return true
    const config = yield* configOpt.value.get()
    if (toolName === "grep" && config.banyancode_route_grep === false) return false
    if (toolName === "read" && config.banyancode_route_read === false) return false
    if (toolName === "glob" && config.banyancode_route_glob === false) return false
    return true
  })

export interface GateB {
  readonly userRequest?: string
  readonly recentToolCalls: {
    readonly tool: string
    readonly arguments: Record<string, unknown>
  }[]
}

// Gate B context (spec §2.2): the last user message's text-part content
// truncated to 200 chars, plus the last 5 assistant tool parts as
// { tool, arguments }. Fail-closed by contract — no user message / no text
// part / no tool parts all yield empty fields, never a throw.
export const deriveGateB = (messages: SessionV1.WithParts[]): GateB => {
  const userRequest = messages
    .filter((message) => message.info.role === "user")
    .at(-1)
    ?.parts.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .slice(0, 200)
  const recentToolCalls = messages
    .flatMap((message) => (message.info.role === "assistant" ? message.parts : []))
    .filter((part): part is SessionV1.ToolPart => part.type === "tool")
    .slice(-5)
    .map((part) => ({
      tool: part.tool,
      arguments:
        part.state.status === "pending" || part.state.status === "error"
          ? {}
          : (part.state.input as Record<string, unknown>),
    }))
  return { userRequest, recentToolCalls }
}

const OPERATION_KINDS = new Set([
  "content",
  "text_search",
  "file_discovery",
  "symbol",
  "relationship",
  "structural",
  "architecture",
  "ownership",
])

// Shape guard for the Formatter's inputs (RepositoryResult + its operation):
// both must be present with exactly the discriminated fields the renderer
// reads. Anything else falls back to the compact summary.
const isRenderableResult = (value: unknown): value is Banyan.RepositoryGatewayTypes.RepositoryResult => {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.operation !== "object" || record.operation === null) return false
  const operation = record.operation as Record<string, unknown>
  if (typeof operation.kind !== "string" || !OPERATION_KINDS.has(operation.kind)) return false
  return (
    Array.isArray(record.results) &&
    record.results.every(
      (item) =>
        typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).path === "string",
    )
  )
}

// Compact fallback rendering when the result is present but not Formatter-
// shaped: route, resolved operation, freshness, and each item's path/name +
// snippet. Never throws — malformed entries are skipped.
const renderCompactSummary = (record: Record<string, unknown>): string => {
  const lines: string[] = ["route: intelligence"]
  const provenance =
    typeof record.provenance === "object" && record.provenance !== null
      ? (record.provenance as Record<string, unknown>)
      : undefined
  if (typeof provenance?.resolvedOperation === "string") {
    lines.push(`resolvedOperation: ${provenance.resolvedOperation}`)
  }
  if (typeof record.freshness === "object" && record.freshness !== null) {
    const graph = (record.freshness as Record<string, unknown>).graph
    if (typeof graph === "string") lines.push(`freshness: ${graph}`)
  }
  if (Array.isArray(record.results)) {
    for (const item of record.results) {
      if (typeof item !== "object" || item === null) continue
      const entry = item as Record<string, unknown>
      if (typeof entry.path !== "string") continue
      const base = typeof entry.line === "number" ? `${entry.path}:${entry.line}` : entry.path
      const name = typeof entry.name === "string" ? ` (${entry.name})` : ""
      const snippet = typeof entry.text === "string" ? ` ${entry.text.slice(0, 200)}` : ""
      lines.push(`${base}${name}${snippet}`)
    }
  }
  return lines.join("\n")
}

// Apply a gateway outcome to a tool result. Pure and never throws:
// - AUGMENT on the read tool prepends the compact symbol header to the output.
// - INTELLIGENCE replaces the output with a rendered text of the result
//   (Formatter when the shape fits, compact summary otherwise).
// - Anything else returns the result unchanged (title/attachments untouched).
// `codegraph` is true when the outcome routed through the code graph
// (AUGMENT header produced or INTELLIGENCE answer rendered) — the TUI shows
// the gear glyph on such calls.
export const applyOutcome = (
  itemID: string,
  outcome: unknown,
  result: { readonly title: string; readonly output: string },
): { title: string; output: string; codegraph: boolean } => {
  if (typeof outcome !== "object" || outcome === null) return { ...result, codegraph: false }
  const record = outcome as Record<string, unknown>
  if (record.route === "augment" && itemID === "read" && typeof record.header === "string") {
    return { ...result, output: `${record.header}\n${result.output}`, codegraph: true }
  }
  if (record.route === "intelligence" && record.result !== undefined) {
    if (isRenderableResult(record.result)) {
      return {
        ...result,
        output: Banyan.RepositoryGatewayFormatter.format(record.result.operation, record.result),
        codegraph: true,
      }
    }
    if (typeof record.result === "object") {
      return { ...result, output: renderCompactSummary(record.result as Record<string, unknown>), codegraph: true }
    }
  }
  return { ...result, codegraph: false }
}

export * as GatewayV1 from "./gateway-v1"
