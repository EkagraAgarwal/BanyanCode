export * as Gateway from "./gateway.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { Session } from "@opencode/schema/session"
import type { Tool } from "@opencode/schema/tool"
import { Cause, Effect, type Scope } from "effect"
import type { BanyanConfig } from "../config/index.js"
import type { Info } from "../config/schema.js"
import type { Storage } from "../storage/index.js"
import { directDecision, isCodePath, NoopRouter, RulesRouter, deriveOperation } from "./router.js"
import { emitTrace, traceFor } from "./trace.js"
import type {
  CodegraphQuery,
  RepositoryRequest,
  RepositoryToolCall,
  RouteDecision,
  GatewayRewrite,
} from "./types.js"

// v2 seam for the Repository Gateway (ported from v1
// `packages/core/src/banyancode/gateway/gateway.ts`).
//
// v1 rendered graph INTELLIGENCE payloads over the original tool result. v2 can
// rewrite the call itself (`execute.before` may change `tool` + `input`), so an
// INTELLIGENCE decision is delegated by swapping in a codegraph tool call. Read
// AUGMENT keeps v1 semantics: the original read runs, then `execute.after`
// prepends the compact symbol header.

export const GATEWAY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob"])

export interface GatewayDeps {
  readonly storage: Storage.Interface
  readonly config: BanyanConfig.Interface
  /** Optional until the codegraph port lands; every feature no-ops without it. */
  readonly codegraph?: CodegraphQuery
}

interface PendingRoute {
  readonly route: "augment" | "intelligence"
  readonly path?: string
}

const MAX_PENDING = 1024

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const readPath = (args: Record<string, unknown>): string => {
  const target = args.path ?? args.filePath
  return typeof target === "string" ? target : ""
}

const loadConfig = (deps: GatewayDeps): Effect.Effect<Info> =>
  deps.config.get().pipe(Effect.map((loaded) => loaded.config))

const routerFor = (config: Info) => {
  const env = process.env.BANYANCODE_ROUTER
  if (env === "off") return NoopRouter
  if (env === "rules") return RulesRouter
  if (config.banyancode_router === "off") return NoopRouter
  return RulesRouter
}

const routeAllowed = (config: Info, toolName: string): boolean => {
  if (toolName === "grep" && config.banyancode_route_grep === false) return false
  if (toolName === "read" && config.banyancode_route_read === false) return false
  if (toolName === "glob" && config.banyancode_route_glob === false) return false
  return true
}

export const augmentEnabled = (config: Info): boolean => config.banyancode_augment_read !== false

export const traceEnabled = (config: Info): boolean =>
  process.env.BANYANCODE_ROUTER_TRACE === "true" || config.banyancode_router_trace === true

const gateB = (
  ctx: Context,
  sessionID: Session.ID,
): Effect.Effect<{ readonly userRequest?: string; readonly recentToolCalls: readonly RepositoryToolCall[] }> =>
  ctx.session.context({ sessionID }).pipe(
    Effect.map((messages) => {
      const lastUser = messages.filter((message) => message.type === "user").at(-1)
      const recentToolCalls = messages
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .filter((part) => part.type === "tool")
        .slice(-5)
        .map((part) => ({
          tool: part.name,
          arguments: part.state.status === "streaming" ? {} : part.state.input,
        }))
      return {
        ...(lastUser === undefined ? {} : { userRequest: lastUser.text.slice(0, 200) }),
        recentToolCalls,
      }
    }),
    Effect.catchCause(() =>
      Effect.succeed({
        recentToolCalls: [] as readonly RepositoryToolCall[],
      }),
    ),
  )

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
    metadata: { ...(result.metadata ?? {}), codegraph: true },
  }
}

const markCodegraph = (result: Tool.Result): Tool.Result => ({
  ...result,
  metadata: { ...(result.metadata ?? {}), codegraph: true },
})

export const register = (ctx: Context, deps: GatewayDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const worktree = ctx.location.project.canonical || ctx.location.project.directory
    const pending = new Map<string, PendingRoute>()

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        if (!GATEWAY_TOOLS.has(event.tool)) return
        const config = yield* loadConfig(deps)
        if (!routeAllowed(config, event.tool)) return

        const startedAt = Date.now()
        const originalArguments = asRecord(event.input)
        const context = yield* gateB(ctx, event.sessionID)
        const request: RepositoryRequest = {
          source: "model-tool",
          originalTool: event.tool,
          arguments: originalArguments,
          sessionID: event.sessionID,
          ...(context.userRequest === undefined ? {} : { userRequest: context.userRequest }),
          recentToolCalls: context.recentToolCalls,
        }
        const decision = yield* routerFor(config).classify({
          toolName: event.tool,
          arguments: originalArguments,
          recentToolCalls: context.recentToolCalls,
          ...(context.userRequest === undefined ? {} : { userRequest: context.userRequest }),
        })

        let effective: RouteDecision = decision
        let rewrite: GatewayRewrite | undefined

        if (decision.route === "augment") {
          const path = readPath(originalArguments)
          if (!augmentEnabled(config) || !isCodePath(path) || deps.codegraph?.augmentRead === undefined) {
            effective = directDecision(decision)
          }
        }

        if (decision.route === "intelligence") {
          const route = deps.codegraph?.route
          if (route === undefined) {
            effective = directDecision(decision)
          } else {
            const operation = decision.operation ?? deriveOperation({
              toolName: event.tool,
              arguments: originalArguments,
              recentToolCalls: context.recentToolCalls,
              ...(context.userRequest === undefined ? {} : { userRequest: context.userRequest }),
            })
            const candidate = yield* route({
              operation,
              call: { tool: event.tool, input: originalArguments },
              sessionID: event.sessionID,
            }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
            if (candidate === undefined || candidate.tool.trim() === "") {
              effective = directDecision(decision)
            } else {
              rewrite = candidate
            }
          }
        }

        if (effective.route === "direct") {
          pending.delete(event.id)
        } else {
          if (pending.size >= MAX_PENDING) {
            const oldest = pending.keys().next().value
            if (oldest !== undefined) pending.delete(oldest)
          }
          pending.set(event.id, {
            route: effective.route,
            ...(effective.route === "augment" ? { path: readPath(originalArguments) } : {}),
          })
        }

        if (rewrite !== undefined) {
          event.tool = rewrite.tool
          event.input = rewrite.input
        }

        if (traceEnabled(config)) {
          yield* emitTrace(
            traceFor({
              request,
              decision: effective,
              route: effective.route,
              backend: effective.route === "direct" ? "filesystem" : "codegraph",
              startedAt,
            }),
            { worktree, sessionID: event.sessionID },
          )
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("repository gateway execute.before failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    )

    yield* ctx.tool.hook("execute.after", (event) => {
      const route = pending.get(event.id)
      pending.delete(event.id)
      if (route === undefined) return Effect.void
      if (event.status !== "completed") return Effect.void
      if (route.route === "intelligence") {
        event.result = markCodegraph(event.result)
        return Effect.void
      }
      const augmentRead = deps.codegraph?.augmentRead
      if (augmentRead === undefined || route.path === undefined) return Effect.void
      return augmentRead({ path: route.path, sessionID: event.sessionID }).pipe(
        Effect.map((header) => {
          if (header !== undefined && header !== "") event.result = prependHeader(event.result, header)
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("repository gateway execute.after failed", { cause: Cause.pretty(cause) }),
        ),
      )
    })
  })
