import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { SessionID, MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { Effect, Layer, Context, Schema, Option } from "effect"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import { EventV2 } from "@opencode-ai/core/event"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Database } from "@opencode-ai/core/database/database"
import { GlobalBus } from "@/bus/global"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import PROMPT_CODEGRAPH_BUILD from "./template/codegraph-build.txt"
import PROMPT_GOAL from "./template/goal.txt"
import PROMPT_REPOSITORY_QUERY from "./template/repository-query.txt"
import PROMPT_REPOSITORY_EXPLAIN from "./template/repository-explain.txt"
import PROMPT_REPOSITORY_TRACE from "./template/repository-trace.txt"
import PROMPT_REPOSITORY_IMPACT from "./template/repository-impact.txt"
import PROMPT_REPOSITORY_TESTS from "./template/repository-tests.txt"
import PROMPT_REPOSITORY_SYMBOLS from "./template/repository-symbols.txt"
import PROMPT_REPOSITORY_RELATIONSHIPS from "./template/repository-relationships.txt"
import PROMPT_REPOSITORY_OWNERSHIP from "./template/repository-ownership.txt"
import PROMPT_WEBSEARCH_FREE from "./template/websearch-free.txt"

type State = {
  commands: Record<string, Info>
}

export const Event = {
  Executed: EventV2.define({
    type: "command.executed",
    schema: {
      name: Schema.String,
      sessionID: SessionID,
      arguments: Schema.String,
      messageID: MessageID,
    },
  }),
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  template: Schema.Unknown,
  execute: Schema.optional(Schema.Unknown),
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template" | "execute"> & {
  template: Promise<string> | string
  /**
   * Discriminated executor return. Handlers that finish the slash command
   * without needing the LLM (e.g. /codegraph-build, /refresh-models, /yolo)
   * return `{ kind: "terminal", message? }`; the optional `message` is
   * rendered as a synthetic assistant text part so the user sees the real
   * completion. Handlers that perform setup work and want the command's
   * template to continue into the agent loop (e.g. /goal, which persists a
   * goal row and then asks the orchestrator to drive it) return
   * `{ kind: "continue" }`; `SessionPrompt.command` then proceeds with the
   * normal template + `prompt(...)` path.
   *
   * `sessionID` is the session that issued the slash command and is required
   * by per-session tools like /goal. Handlers that don't need it (e.g.
   * /yolo, /max-subagents, /refresh-models) may ignore it via destructuring.
   */
  execute?: (input: { command: string; arguments: string; sessionID: SessionID }) => Effect.Effect<
    | { kind: "terminal"; message?: string }
    | { kind: "continue" },
    never,
    any
  >
}

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
  CODEGRAPH_BUILD: "codegraph-build",
  CODEGRAPH_REMOVE: "codegraph-remove",
  GOAL: "goal",
  REPOSITORY_QUERY: "repository-query",
  REPOSITORY_EXPLAIN: "repository-explain",
  REPOSITORY_TRACE: "repository-trace",
  REPOSITORY_IMPACT: "repository-impact",
  REPOSITORY_TESTS: "repository-tests",
  REPOSITORY_SYMBOLS: "repository-symbols",
  REPOSITORY_RELATIONSHIPS: "repository-relationships",
  REPOSITORY_OWNERSHIP: "repository-ownership",
  WEBSEARCH_FREE: "websearch-free",
  YOLO: "yolo",
  MAX_SUBAGENTS: "max-subagents",
  REFRESH_MODELS: "refresh-models",
  LSP: "lsp",
  IMPORT: "import",
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

function parseArgs(input: string): { positional: string[]; flags: Record<string, string | boolean> } {
  const parts = input.trim().split(/\s+/).filter(Boolean)
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.startsWith("--")) {
      const key = p.slice(2)
      const next = parts[i + 1]
      if (next && !next.startsWith("--")) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(p)
    }
  }
  return { positional, flags }
}

/**
 * Re-join the user-provided goal condition from the parsed args, dropping
 * recognized flags. `/goal build a feature --priority high` yields
 * "build a feature". Without this, `positional[0]` would silently truncate
 * multi-word conditions.
 *
 * `parseArgs` already strips recognized `--flag value` and `--flag=value`
 * pairs into `flags`, so positional is mostly free of flag tokens. We
 * only drop the rare leftover `--` sentinel and the `--flag[=value]` form
 * for the recognized keys (defensive — should not happen in practice).
 *
 * Exported for testing — do not use elsewhere.
 */
export const joinCondition = (args: {
  positional: string[]
  flags: Record<string, string | boolean>
}): string => {
  const FLAG_KEYS = new Set(["plan", "priority"])
  const trimmed: string[] = []
  for (const part of args.positional) {
    if (part === "--") continue
    const match = part.match(/^--([a-zA-Z][\w-]*)=(.*)$/)
    if (match && FLAG_KEYS.has(match[1])) continue
    trimmed.push(part)
  }
  return trimmed.join(" ").trim()
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }
      commands[Default.CODEGRAPH_BUILD] = {
        name: Default.CODEGRAPH_BUILD,
        description: "build the code graph index for the codebase",
        source: "command",
        get template() {
          return PROMPT_CODEGRAPH_BUILD
        },
        execute: (input) =>
          Effect.gen(function* () {
            const buildServiceOpt = yield* Effect.serviceOption(Banyan.CodegraphBuildService)
            if (Option.isNone(buildServiceOpt)) {
              yield* Effect.logWarning("codegraph-build invoked but CodegraphBuildService is unavailable in scope")
              return { kind: "terminal" as const, message: "Codegraph build skipped: CodegraphBuildService is unavailable in this session." }
            }
            const args = parseArgs(input.arguments)
            const root = args.positional[0] ?? ctx.worktree
            const force = args.flags.force === true || args.flags.force === "true"
            const dbPath = Database.path()
            yield* buildServiceOpt.value.start({ root, force, dbPath })

            // Poll until the build leaves "running". Build is synchronous
            // from the worker's perspective, so this is bounded by the
            // indexing pass on the user's workspace.
            let status = yield* buildServiceOpt.value.status()
            while (status.status === "running") {
              yield* Effect.sleep("500 millis")
              status = yield* buildServiceOpt.value.status()
            }

            if (status.status === "failed") {
              return { kind: "terminal" as const, message: `Codegraph build failed: ${status.error ?? "unknown error"}` }
            }
            if (status.status === "cancelled") {
              return { kind: "terminal" as const, message: "Codegraph build cancelled." }
            }
            if (status.status === "completed" && status.result) {
              const r = status.result
              return {
                kind: "terminal" as const,
                message: `Codegraph build complete. indexed=${r.indexed} skipped=${r.skipped} (cached=${r.skippedByReason.cached}) symbols=${r.symbolsIndexed} duration_ms=${r.duration_ms} root=${root}`,
              }
            }
            return { kind: "terminal" as const, message: `Codegraph build ${status.status} for ${root}.` }
          }),
        hints: hints(PROMPT_CODEGRAPH_BUILD),
      }
      commands[Default.GOAL] = {
        name: Default.GOAL,
        description: "drive the orchestrator loop until a stated goal is achieved",
        source: "command",
        agent: "orchestrator",
        get template() {
          return PROMPT_GOAL
        },
        execute: (input) =>
          Effect.gen(function* () {
            const goalServiceOpt = yield* Effect.serviceOption(Banyan.GoalService)
            if (Option.isNone(goalServiceOpt)) {
              return {
                kind: "terminal" as const,
                message: "Goal commands skipped: GoalService is unavailable in this session.",
              }
            }
            const svc = goalServiceOpt.value
            const args = parseArgs(input.arguments)
            // The full condition is everything after /goal (excluding flags).
            // Re-stitch by removing recognized flags rather than relying on
            // positional[0], which truncates at the first whitespace.
            const condition = joinCondition(args)
            const sessionID = input.sessionID

            if (condition === "status") {
              const active = yield* svc.getActiveGoal(sessionID)
              if (!active) return { kind: "terminal" as const, message: `No active goal for session ${sessionID}.` }
              const cond = active.condition.length > 80 ? active.condition.slice(0, 80) + "…" : active.condition
              return {
                kind: "terminal" as const,
                message: [
                  `Active goal ${active.id} for session ${sessionID}:`,
                  `  condition:     ${cond}`,
                  `  plan:          ${active.planPath ?? "(none)"}`,
                  `  priority:      ${active.priority ?? "(default)"}`,
                  `  iteration:     ${active.iterationCount}`,
                  `  last verdict:  ${active.lastReviewVerdict ?? "(none)"}`,
                  `  last reason:   ${active.lastReviewReason ?? "(none)"}`,
                  `  created:       ${new Date(active.createdAt).toISOString()}`,
                ].join("\n"),
              }
            }

            if (condition === "cancel" || condition === "clear") {
              const active = yield* svc.getActiveGoal(sessionID)
              if (!active) return { kind: "terminal" as const, message: `No active goal to cancel for session ${sessionID}.` }
              const updated = yield* svc.cancel(active.id, "user-cancelled")
              return { kind: "terminal" as const, message: `Goal ${updated.id} cancelled for session ${sessionID}.` }
            }

            if (!condition) {
              // Bare `/goal` with no active goal -> show usage. With an
              // active goal, fall through to status (the user is asking
              // "what's the current goal?").
              const active = yield* svc.getActiveGoal(sessionID)
              if (active) {
                const cond = active.condition.length > 80 ? active.condition.slice(0, 80) + "…" : active.condition
                return {
                  kind: "terminal" as const,
                  message: [
                    `Active goal ${active.id} for session ${sessionID}:`,
                    `  condition:     ${cond}`,
                    `  plan:          ${active.planPath ?? "(none)"}`,
                    `  priority:      ${active.priority ?? "(default)"}`,
                    `  iteration:     ${active.iterationCount}`,
                    `  last verdict:  ${active.lastReviewVerdict ?? "(none)"}`,
                  ].join("\n"),
                }
              }
              return {
                kind: "terminal" as const,
                message: "Usage: /goal <condition> [--plan <path>] [--priority low|normal|high] | /goal status | /goal cancel",
              }
            }

            const conflictMessage = yield* svc
              .setGoal({
                parentSessionID: sessionID,
                condition,
                planPath: typeof args.flags.plan === "string" ? args.flags.plan : "./plan.md",
                priority:
                  typeof args.flags.priority === "string"
                    ? (args.flags.priority as "low" | "normal" | "high")
                    : "normal",
              })
              .pipe(
                Effect.map((goal) => ({ kind: "ok" as const, goal })),
                Effect.catchTag("Banyan/GoalConflictError", (e: Banyan.GoalConflictError) =>
                  Effect.succeed({
                    kind: "conflict" as const,
                    message: `An active goal already exists for session ${sessionID}: ${e.existingGoalID}. Run /goal cancel first.`,
                  }),
                ),
              )

            if (conflictMessage.kind === "conflict") {
              return { kind: "terminal" as const, message: conflictMessage.message }
            }

            // Starting a goal takes over the session for the orchestrator
            // loop. Persist both the agent override AND neutralize the
            // session's permission deny rules via the same Session.Service
            // patch path the session-update route uses (event publish →
            // SessionProjector → SessionTable). Without this, a goal started
            // from plan mode stays read-only: the session's stored agent is
            // still `plan`, and plan's deny rules (edit, task) are merged
            // into every effective ruleset on each follow-up turn
            // (session/tools.ts) and inherited by spawned subagents
            // (agent/subagent-permissions.ts). The orchestrator agent then
            // resolves on every turn (both V1 tools and PermissionV2's
            // agents.resolve) and the empty permission list lets the merged
            // ruleset fall back to the agent's own allows.
            const sessionOpt = yield* Effect.serviceOption(Session.Service)
            if (Option.isSome(sessionOpt)) {
              const sessions = sessionOpt.value
              yield* sessions.setAgent({ sessionID, agent: "orchestrator" })
              yield* sessions.setPermission({ sessionID, permission: [] })
            } else {
              yield* Effect.logWarning("goal: Session.Service unavailable; agent/permission overrides not persisted", {
                "session.id": sessionID,
              })
            }

            // Persisted. Hand off to the orchestrator via the template path.
            // The synthetic summary lives on the message itself; the template
            // expansion in SessionPrompt.command also runs, then prompt(...)
            // fires.
            yield* Effect.logInfo("goal set; continuing into orchestrator prompt", {
              "session.id": sessionID,
              goalID: conflictMessage.goal.id,
            })
            return { kind: "continue" as const }
          }),
        hints: hints(PROMPT_GOAL),
      }
      commands[Default.REPOSITORY_QUERY] = {
        name: Default.REPOSITORY_QUERY,
        description: "run a unified repository query (symbols, tests, docs, configs)",
        source: "command",
        get template() {
          return PROMPT_REPOSITORY_QUERY
        },
        hints: hints(PROMPT_REPOSITORY_QUERY),
      }
      commands[Default.REPOSITORY_EXPLAIN] = {
        name: Default.REPOSITORY_EXPLAIN,
        description: "explain a symbol by name (entrypoints, tests, docs, configs)",
        source: "command",
        get template() {
          return PROMPT_REPOSITORY_EXPLAIN
        },
        hints: hints(PROMPT_REPOSITORY_EXPLAIN),
      }
      commands[Default.REPOSITORY_TRACE] = {
        name: Default.REPOSITORY_TRACE,
        description: "trace a symbol through the code graph to its downstream dependents",
        source: "command",
        get template() {
          return PROMPT_REPOSITORY_TRACE
        },
        hints: hints(PROMPT_REPOSITORY_TRACE),
      }
      commands[Default.REPOSITORY_IMPACT] = {
        name: Default.REPOSITORY_IMPACT,
        description: "analyze the impact of changing a file by path",
        source: "command",
        get template() {
          return PROMPT_REPOSITORY_IMPACT
        },
        hints: hints(PROMPT_REPOSITORY_IMPACT),
      }
      commands[Default.REPOSITORY_TESTS] = {
        name: Default.REPOSITORY_TESTS,
        description: "find tests that reference a given symbol",
        source: "command",
        get template() {
          return PROMPT_REPOSITORY_TESTS
        },
        hints: hints(PROMPT_REPOSITORY_TESTS),
      }
      commands[Default.REPOSITORY_SYMBOLS] = {
        name: Default.REPOSITORY_SYMBOLS,
        description: "look up symbols by name across the code graph",
        source: "command",
        get template() {
          return PROMPT_REPOSITORY_SYMBOLS
        },
        hints: hints(PROMPT_REPOSITORY_SYMBOLS),
      }
      commands[Default.REPOSITORY_RELATIONSHIPS] = {
        name: Default.REPOSITORY_RELATIONSHIPS,
        description: "walk the code graph from a node to its related nodes",
        source: "command",
        get template() {
          return PROMPT_REPOSITORY_RELATIONSHIPS
        },
        hints: hints(PROMPT_REPOSITORY_RELATIONSHIPS),
      }
      commands[Default.REPOSITORY_OWNERSHIP] = {
        name: Default.REPOSITORY_OWNERSHIP,
        description: "find the most active author for a file by path",
        source: "command",
        get template() {
          return PROMPT_REPOSITORY_OWNERSHIP
        },
        hints: hints(PROMPT_REPOSITORY_OWNERSHIP),
      }
      commands[Default.WEBSEARCH_FREE] = {
        name: Default.WEBSEARCH_FREE,
        description: "search the web using DuckDuckGo HTML",
        source: "command",
        get template() {
          return PROMPT_WEBSEARCH_FREE
        },
        hints: hints(PROMPT_WEBSEARCH_FREE),
      }
      commands[Default.YOLO] = {
        name: Default.YOLO,
        description: "toggle YOLO mode (auto-approve all permissions, including dangerous)",
        source: "command",
        get template() {
          return "Toggle YOLO mode."
        },
        execute: () =>
          Effect.gen(function* () {
            const banyanOption = yield* Effect.serviceOption(Banyan.BanyanConfigService)
            if (Option.isNone(banyanOption)) {
              return { kind: "terminal" as const, message: "YOLO toggle skipped: BanyanConfigService is unavailable." }
            }
            const banyan = banyanOption.value
            const current = yield* banyan.get()
            const newValue = !current.banyancode_yolo_mode
            yield* banyan.update({ banyancode_yolo_mode: newValue })
            GlobalBus.emit("event", {
              directory: "global",
              payload: {
                type: "banyancode.config.updated" as any,
                properties: { scope: "global" },
              },
            })
            return { kind: "terminal" as const, message: `YOLO mode is now ${newValue ? "on" : "off"}.` }
          }),
        hints: [],
      }
      commands[Default.MAX_SUBAGENTS] = {
        name: Default.MAX_SUBAGENTS,
        description: "set max concurrent subagents (1-20); with no arg, prints the current value",
        source: "command",
        get template() {
          return "Set the max concurrent subagents limit (1-20)."
        },
        execute: (input) =>
          Effect.gen(function* () {
            const opt = yield* Effect.serviceOption(Banyan.MaxSubagentsService)
            if (Option.isNone(opt)) return { kind: "terminal" as const, message: "Max-subagents disabled (BanyanCode off)." }
            const svc = opt.value
            const trimmed = input.arguments.trim()
            if (trimmed === "") {
              const cur = yield* svc.current()
              return { kind: "terminal" as const, message: `Max subagents is ${cur}. Usage: /max-subagents <1-20>` }
            }
            const n = Number(trimmed)
            if (!Number.isFinite(n) || !Number.isInteger(n)) {
              return { kind: "terminal" as const, message: `Max subagents must be an integer; got "${trimmed}".` }
            }
            const validated = yield* svc.validate(n).pipe(
              Effect.catchTag("Banyan/MaxSubagentsError", (e) =>
                Effect.succeed<number | { error: string }>({ error: e.message }),
              ),
            )
            if (typeof validated === "object" && "error" in validated) {
              return { kind: "terminal" as const, message: validated.error }
            }
            const validatedNumber = validated as number
            const banyanOpt = yield* Effect.serviceOption(Banyan.BanyanConfigService)
            if (Option.isNone(banyanOpt)) {
              return {
                kind: "terminal" as const,
                message: `Max subagents set to ${validatedNumber} (BanyanCode disabled; not persisted).`,
              }
            }
            yield* banyanOpt.value.update({ banyancode_max_subagents: validatedNumber })
            return { kind: "terminal" as const, message: `Max subagents set to ${validatedNumber}.` }
          }),
        hints: [],
      }
      commands[Default.REFRESH_MODELS] = {
        name: Default.REFRESH_MODELS,
        description: "refresh the models catalog from models.dev",
        source: "command",
        get template() {
          return "Refresh the models catalog."
        },
        execute: () =>
          Effect.gen(function* () {
            const option = yield* Effect.serviceOption(ModelsDev.Service)
            if (option._tag === "Some") {
              yield* option.value.refresh(true)
              return { kind: "terminal" as const, message: "Models catalog refreshed." }
            }
            return { kind: "terminal" as const, message: "ModelsDev service unavailable." }
          }),
        hints: [],
      }
      commands[Default.LSP] = {
        name: Default.LSP,
        description: "toggle BanyanCode LSP servers (banyancode_lsp); with no arg, prints the current value",
        source: "command",
        get template() {
          return "Toggle BanyanCode's LSP servers on or off."
        },
        execute: (input) =>
          Effect.gen(function* () {
            const opt = yield* Effect.serviceOption(Banyan.BanyanConfigService)
            if (Option.isNone(opt)) return { kind: "terminal" as const, message: "LSP toggle disabled (BanyanCode off)." }
            const svc = opt.value
            const trimmed = input.arguments.trim()
            const current = yield* svc.get()
            const currentValue = (current as Banyan.BanyanConfigInfo).banyancode_lsp
            const isOn = currentValue === true || (typeof currentValue === "object" && currentValue !== null)
            const arg = trimmed.toLowerCase()
            if (arg === "") {
              return { kind: "terminal" as const, message: `BanyanCode LSP is ${isOn ? "on" : "off"}. Usage: /lsp <on|off|toggle>` }
            }
            let next: typeof currentValue
            if (arg === "on" || arg === "true" || arg === "enable" || arg === "enabled") {
              next = true
            } else if (arg === "off" || arg === "false" || arg === "disable" || arg === "disabled") {
              next = false as any
            } else if (arg === "toggle") {
              next = (isOn ? false : true) as any
            } else {
              return { kind: "terminal" as const, message: `Unknown argument "${trimmed}". Usage: /lsp <on|off|toggle>` }
            }
            const updated = yield* svc.update({ banyancode_lsp: next })
            const finalIsOn =
              (updated as Banyan.BanyanConfigInfo).banyancode_lsp === true ||
              (typeof (updated as Banyan.BanyanConfigInfo).banyancode_lsp === "object" &&
                (updated as Banyan.BanyanConfigInfo).banyancode_lsp !== null)
            const eventsOpt = yield* Effect.serviceOption(EventV2Bridge.Service)
            if (Option.isSome(eventsOpt)) {
              yield* eventsOpt.value.publish(Banyan.BanyanConfig.Event.Updated, { scope: "global" })
            }
            GlobalBus.emit("event", {
              directory: "global",
              payload: {
                type: "banyancode.config.updated" as any,
                properties: { scope: "global" },
              },
            })
            return {
              kind: "terminal" as const,
              message: `BanyanCode LSP is now ${finalIsOn ? "on" : "off"}. Built-in servers will attach as files are opened.`,
            }
          }),
        hints: [],
      }
      commands[Default.IMPORT] = {
        name: Default.IMPORT,
        description: "import a session from a Markdown transcript file (the format produced by /export); with no arg, prompts for a path",
        source: "command",
        get template() {
          return "Import a session from a Markdown transcript file."
        },
        execute: (input) =>
          Effect.gen(function* () {
            const arg = input.arguments.trim()
            if (arg === "") {
              return {
                kind: "terminal" as const,
                message: "Usage: /import <path-to-transcript.md>. Reads the file, parses it, and creates a new session containing the parsed messages.",
              }
            }
            // The TUI intercepts /import and shows the import result as a
            // toast. From a non-TUI context (CLI session, scripted run), the
            // user can call the same /global/session/import endpoint via the
            // SDK, but the simplest portable path here is to return the
            // usage hint and let the TUI handler take over once available.
            return {
              kind: "terminal" as const,
              message: `Run /import from the TUI to read ${arg} and create a new session, or POST {content} to /global/session/import directly.`,
            }
          }),
        hints: [],
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        commands[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      for (const item of yield* skill.all()) {
        if (commands[item.name]) continue
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            return item.content
          },
          hints: [],
        }
      }

      return {
        commands,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.commands[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.commands)
    })

    return Service.of({ get, list })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(MCP.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

export const node = LayerNode.make(layer, [Config.node, MCP.node, Skill.node])

export * as Command from "."
