export * as Gateway from "./gateway.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import type { Permission } from "@opencode/schema/permission"
import { Cause, Effect, Option, type Scope } from "effect"
import type { BanyanConfig } from "../config/index.js"
import type { Info } from "../config/schema.js"
import type { Storage } from "../storage/index.js"
import { recordGatewayUsage } from "../telemetry/usage.js"
import { decide, DEFAULT_READ_OUTLINE_LINES, GATEWAY_TOOLS, normalizePath, routeName } from "./routing.js"
import { emitTrace, traceFor } from "./trace.js"
import type { Decision, GatewayMetadata, GatewayProbe, ProbeResult } from "./types.js"
import { UNPROBED } from "./types.js"

// v2 repository gateway.
//
// `execute.before` probes the graph, decides with a pure function, and rewrites
// the call. `execute.after` stamps provenance on the result, prepends the
// symbol header for an augmented read, appends the escape-hatch line for a
// swap, and records the gateway ledger row. Nothing here reads the
// conversation: the same tool call routes the same way whatever the user said.

export { GATEWAY_TOOLS }

/** `execute.before` probes the graph; past this the call runs unprobed. */
export const PROBE_TIMEOUT_MS = 40

export interface GatewayDeps {
  readonly storage: Storage.Interface
  readonly config: BanyanConfig.Interface
  /** Optional until the codegraph port lands; every feature no-ops without it. */
  readonly codegraph?: GatewayProbe
  /** Tool ids the host registered. A rewrite never targets an absent tool. */
  readonly availableTools?: ReadonlySet<string>
}

interface PendingRoute {
  readonly from: string
  readonly arguments: Record<string, unknown>
  readonly decision: Decision
  readonly probe: ProbeResult
  readonly targetTool?: string
}

const MAX_PENDING = 1024
const MAX_LEDGER_ENTRIES = 256
const MAX_LEDGER_SESSIONS = 128

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const readPath = (args: Record<string, unknown>): string => {
  const target = args.path ?? args.filePath
  return typeof target === "string" ? target : ""
}

const loadConfig = (deps: GatewayDeps): Effect.Effect<Info> => deps.config.get().pipe(Effect.map((loaded) => loaded.config))

const routerOff = (config: Info): boolean =>
  process.env.BANYANCODE_ROUTER === "off" || config.banyancode_router === "off"

const routeAllowed = (config: Info, toolName: string): boolean => {
  if (toolName === "grep" && config.banyancode_route_grep === false) return false
  if (toolName === "read" && config.banyancode_route_read === false) return false
  if (toolName === "glob" && config.banyancode_route_glob === false) return false
  return true
}

export const augmentEnabled = (config: Info): boolean => config.banyancode_augment_read !== false

export const traceEnabled = (config: Info): boolean =>
  process.env.BANYANCODE_ROUTER_TRACE === "true" || config.banyancode_router_trace === true

const readOutlineLines = (config: Info): number => {
  const value = config.banyancode_read_outline_lines
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_READ_OUTLINE_LINES
}

/** Sorted-key JSON so two identical calls produce one ledger key. */
const stableArguments = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableArguments).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableArguments(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

const ledgerKey = (tool: string, args: Record<string, unknown>): string => `${tool}\u0000${stableArguments(args)}`

interface Ledger {
  readonly keys: Map<string, true>
  readonly order: string[]
}

/** Bounded per-session ledgers of calls that already swapped. */
const makeLedgers = () => {
  const sessions = new Map<string, Ledger>()

  const ledgerFor = (sessionID: string): Ledger => {
    const existing = sessions.get(sessionID)
    if (existing !== undefined) return existing
    if (sessions.size >= MAX_LEDGER_SESSIONS) {
      const oldest = sessions.keys().next().value
      if (oldest !== undefined) sessions.delete(oldest)
    }
    const created: Ledger = { keys: new Map(), order: [] }
    sessions.set(sessionID, created)
    return created
  }

  return {
    has: (sessionID: string, tool: string, args: Record<string, unknown>): boolean =>
      ledgerFor(sessionID).keys.has(ledgerKey(tool, args)),
    add: (sessionID: string, tool: string, args: Record<string, unknown>): void => {
      const ledger = ledgerFor(sessionID)
      const key = ledgerKey(tool, args)
      if (ledger.keys.has(key)) return
      ledger.keys.set(key, true)
      ledger.order.push(key)
      if (ledger.order.length > MAX_LEDGER_ENTRIES) {
        const evicted = ledger.order.shift()
        if (evicted !== undefined) ledger.keys.delete(evicted)
      }
    },
  }
}

const wildcardMatch = (input: string, pattern: string): boolean => {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp(`^${escaped}$`, "s").test(normalized)
}

/** Mirrors the host's whole-tool filter: a trailing `*: deny` hides the tool. */
const toolDisabled = (rules: Permission.Ruleset, action: string): boolean => {
  const rule = rules.findLast((candidate) => wildcardMatch(action, candidate.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

const agentRules = (ctx: Context, agent: string): Effect.Effect<Permission.Ruleset> =>
  ctx.agent.get({ agentID: agent as never }).pipe(
    Effect.map((result) => result.data.permissions),
    Effect.catchCause(() => Effect.succeed([] as Permission.Ruleset)),
  )

const appendText = (result: Tool.Result, note: string): Tool.Result => {
  const content = result.content
  if (typeof content === "string") return { ...result, content: `${content}\n${note}` }
  if (Array.isArray(content)) {
    const last = content[content.length - 1]
    if (last !== undefined && last.type === "text") {
      return {
        ...result,
        content: [...content.slice(0, -1), { type: "text" as const, text: `${last.text}\n${note}` }],
      }
    }
    return { ...result, content: [...content, { type: "text" as const, text: note }] }
  }
  return { ...result, content: note }
}

const prependHeader = (result: Tool.Result, header: string): Tool.Result => {
  const content = result.content
  const output = result.output
  const textPage =
    typeof output === "object" &&
    output !== null &&
    (output as Record<string, unknown>).type === "text-page" &&
    typeof (output as Record<string, unknown>).content === "string"
      ? {
          ...(output as Record<string, unknown>),
          content: `${header}\n${String((output as Record<string, unknown>).content)}`,
        }
      : undefined
  const nextContent =
    typeof content === "string"
      ? `${header}\n${content}`
      : Array.isArray(content)
        ? [{ type: "text" as const, text: header }, ...content]
        : undefined
  if (nextContent === undefined && textPage === undefined) return result
  return {
    ...result,
    ...(nextContent === undefined ? {} : { content: nextContent }),
    ...(textPage === undefined ? {} : { output: textPage }),
  }
}

const resultBytes = (result: Tool.Result): number => {
  const content = result.content
  if (typeof content === "string") return Buffer.byteLength(content, "utf8")
  if (!Array.isArray(content)) return 0
  return content.reduce(
    (sum, part) => sum + (part.type === "text" ? Buffer.byteLength(part.text, "utf8") : 0),
    0,
  )
}

const swapNote = (from: string, to: string, op: string): string => {
  const repeat = `Repeat this ${from} for raw text.]`
  if (from === "read") return `[gateway: read -> ${to} (${op}). Symbols only, not the file body. ${repeat}`
  if (from === "glob") return `[gateway: glob -> ${to} (${op}). Indexed files only. Repeat this glob for the filesystem list.]`
  return `[gateway: grep -> ${to} (${op}). Comments and strings are not included. ${repeat}`
}

const errorNote = (from: string, to: string): string =>
  `[gateway: this ${from} was swapped to ${to} and failed. Repeat this ${from} to run the real tool.]`

const withGateway = (result: Tool.Result, gateway: GatewayMetadata, codegraph: boolean): Tool.Result => ({
  ...result,
  metadata: {
    ...(result.metadata ?? {}),
    gateway,
    ...(codegraph ? { codegraph: true } : {}),
  },
})

export const register = (ctx: Context, deps: GatewayDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const worktree = ctx.location.project.canonical || ctx.location.project.directory
    const root = normalizePath(worktree)
    const pending = new Map<string, PendingRoute>()
    const ledgers = makeLedgers()

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        if (!GATEWAY_TOOLS.has(event.tool)) return
        const config = yield* loadConfig(deps)
        if (routerOff(config) || !routeAllowed(config, event.tool)) return

        const startedAt = Date.now()
        const from = event.tool
        const originalArguments = asRecord(event.input)
        const repeat = ledgers.has(event.sessionID, from, originalArguments)

        const probe: ProbeResult =
          repeat || deps.codegraph?.probe === undefined
            ? UNPROBED
            : yield* deps.codegraph.probe({ tool: from, arguments: originalArguments, root }).pipe(
                // A probe that cannot answer in time falls back; it never delays a tool call.
                Effect.timeoutOption(PROBE_TIMEOUT_MS),
                Effect.map((value) => Option.getOrElse(value, () => UNPROBED)),
                Effect.catchCause((cause) =>
                  Effect.logWarning("repository gateway probe failed", { cause: Cause.pretty(cause) }).pipe(
                    Effect.as(UNPROBED),
                  ),
                ),
              )

        const rules = repeat ? ([] as Permission.Ruleset) : yield* agentRules(ctx, event.agent)
        const available = deps.availableTools
        const decision = decide({
          tool: from,
          arguments: originalArguments,
          probe,
          repeat,
          root,
          readOutlineLines: readOutlineLines(config),
          allows: (tool) => (available === undefined || available.has(tool)) && !toolDisabled(rules, tool),
        })

        // An outline bypasses the read tool's authorization, so a read this agent
        // may not make without asking has to stay a real read.
        const readRule =
          from === "read"
            ? rules.findLast(
                (rule) => wildcardMatch("read", rule.action) && wildcardMatch(readPath(originalArguments), rule.resource),
              )
            : undefined
        const readRestricted = readRule !== undefined && readRule.effect !== "allow"

        // An augmented read of a non-code file or with augmentation off runs the plain read.
        const effective: Decision =
          decision.route === "swap" && readRestricted
            ? { route: "fallback", reason: "read-restricted" }
            : decision.route === "augment" && (!augmentEnabled(config) || deps.codegraph?.augmentRead === undefined)
              ? { route: "direct", reason: "augment-disabled" }
              : decision

        if (pending.size >= MAX_PENDING) {
          const oldest = pending.keys().next().value
          if (oldest !== undefined) pending.delete(oldest)
        }
        pending.set(event.id, {
          from,
          arguments: originalArguments,
          decision: effective,
          probe,
          ...(effective.target === undefined ? {} : { targetTool: effective.target.tool }),
        })

        if (effective.target !== undefined) {
          event.tool = effective.target.tool
          event.input = effective.target.input
        }

        if (traceEnabled(config)) {
          yield* emitTrace(
            traceFor({ tool: from, arguments: originalArguments, decision: effective, probe, startedAt }),
            { worktree, sessionID: event.sessionID },
          )
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("repository gateway execute.before failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    )

    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.gen(function* () {
        const route = pending.get(event.id)
        pending.delete(event.id)
        if (route === undefined) return

        const swapped = route.targetTool !== undefined && route.targetTool === event.tool
        const outcome = route.decision.target

        if (event.status === "error") {
          if (route.targetTool === undefined) return
          const error = event.error as { message: string; metadata?: Record<string, unknown> }
          if (!swapped) {
            // The host refused the rewrite, so the original tool failed. Nothing to escape from.
            error.metadata = {
              ...(error.metadata ?? {}),
              gateway: { route: "fallback", from: route.from, reason: "rewrite-refused" },
            }
            return
          }
          // The model must be able to reach the real tool: the repeat goes direct.
          ledgers.add(event.sessionID, route.from, route.arguments)
          if (typeof error.message === "string") {
            error.message = `${error.message}\n${errorNote(route.from, route.targetTool)}`
          }
          error.metadata = {
            ...(error.metadata ?? {}),
            gateway: {
              route: "swapped",
              from: route.from,
              to: route.targetTool,
              op: outcome?.op,
              reason: route.decision.reason,
            },
          }
          return
        }

        // The host may have refused the rewrite and run the original tool (its
        // request did not advertise the target). Provenance must not lie.
        const refused = outcome !== undefined && !swapped
        const initial: GatewayMetadata = refused
          ? { route: "fallback", from: route.from, reason: "rewrite-refused" }
          : outcome === undefined
            ? { route: routeName(route.decision), from: route.from, reason: route.decision.reason }
            : {
                route: "swapped",
                from: route.from,
                to: outcome.tool,
                op: outcome.op,
                reason: route.decision.reason,
                ...(outcome.op === "outline" && route.probe.bytes !== undefined
                  ? { bytesSaved: Math.max(0, route.probe.bytes - resultBytes(event.result)) }
                  : {}),
              }

        const augmentRead = deps.codegraph?.augmentRead
        const wantsHeader = route.decision.route === "augment" && !refused && augmentRead !== undefined
        const header =
          wantsHeader && augmentRead !== undefined
            ? yield* augmentRead({ path: readPath(route.arguments), sessionID: event.sessionID }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("repository gateway execute.after failed", { cause: Cause.pretty(cause) }).pipe(
                    Effect.as(undefined),
                  ),
                ),
              )
            : undefined

        const gateway: GatewayMetadata =
          wantsHeader && header !== undefined && header !== ""
            ? { route: "augmented", from: route.from, reason: "symbol-header" }
            : wantsHeader
              ? { route: "direct", from: route.from, reason: "augment-empty" }
              : initial

        if (header !== undefined && header !== "") event.result = prependHeader(event.result, header)
        if (gateway.route === "swapped" && gateway.to !== undefined) {
          event.result = appendText(event.result, swapNote(route.from, gateway.to, gateway.op ?? ""))
          ledgers.add(event.sessionID, route.from, route.arguments)
        }
        event.result = withGateway(event.result, gateway, gateway.route === "swapped" || gateway.route === "augmented")

        yield* recordGatewayUsage(deps.storage, {
          sessionID: event.sessionID,
          from: route.from,
          ...(gateway.route === "swapped" && gateway.to !== undefined ? { to: gateway.to } : {}),
          route: gateway.route,
          ...(gateway.bytesSaved === undefined ? {} : { bytesSaved: gateway.bytesSaved }),
        })
      }),
    )
  })
