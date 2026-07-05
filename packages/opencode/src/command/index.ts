import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { SessionID, MessageID } from "@/session/schema"
import { Effect, Layer, Context, Schema, Option } from "effect"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import { EventV2 } from "@opencode-ai/core/event"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Database } from "@opencode-ai/core/database/database"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import PROMPT_CODEGRAPH_BUILD from "./template/codegraph-build.txt"
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
   * Optional side-effecting executor for slash-commands that don't need the
   * LLM in the loop (e.g. /codegraph-build, /codegraph-remove,
   * /refresh-models, /yolo). The returned string (if any) is rendered as a
   * synthetic assistant text part on the command response, so the user sees
   * the real completion message (e.g. "Codegraph index removed. Freed 12.3
   * MB (45.1 MB -> 32.8 MB).") instead of an empty parts array.
   */
  execute?: (input: { command: string; arguments: string }) => Effect.Effect<string | void, never, any>
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
  REFRESH_MODELS: "refresh-models",
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
              return "Codegraph build skipped: CodegraphBuildService is unavailable in this session."
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
              return `Codegraph build failed: ${status.error ?? "unknown error"}`
            }
            if (status.status === "cancelled") {
              return "Codegraph build cancelled."
            }
            if (status.status === "completed" && status.result) {
              const r = status.result
              return `Codegraph build complete. indexed=${r.indexed} skipped=${r.skipped} (cached=${r.skippedByReason.cached}) symbols=${r.symbolsIndexed} duration_ms=${r.duration_ms} root=${root}`
            }
            return `Codegraph build ${status.status} for ${root}.`
          }),
        hints: hints(PROMPT_CODEGRAPH_BUILD),
      }
      commands[Default.CODEGRAPH_REMOVE] = {
        name: Default.CODEGRAPH_REMOVE,
        description: "remove the current codegraph index",
        source: "command",
        get template() {
          return "Remove the current codegraph index."
        },
        execute: () =>
          Effect.gen(function* () {
            const repoOpt = yield* Effect.serviceOption(Banyan.CodegraphRepo)
            if (Option.isNone(repoOpt)) {
              yield* Effect.logWarning("codegraph-remove invoked but CodegraphRepo is unavailable in scope")
              return "Codegraph remove skipped: CodegraphRepo is unavailable in this session."
            }
            // default dropFile is false: banyancode.db is shared with sessions/memory/projects,
            // so wiping the file would also wipe unrelated state.
            const { sizeBefore, sizeAfter } = yield* repoOpt.value.clearAll({ dropFile: false })
            if (sizeBefore === 0) {
              return `Codegraph index removed (DB size unknown).`
            }
            const freedBytes = Math.max(0, sizeBefore - sizeAfter)
            return `Codegraph index removed. Freed ${formatBytes(freedBytes)} (${formatBytes(sizeBefore)} -> ${formatBytes(sizeAfter)}).`
          }).pipe(Effect.provide(Banyan.codegraphRepoDefaultLayer)),
        hints: [],
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
            if (Option.isNone(banyanOption)) return Effect.succeed({ toggled: false }) as any
            const banyan = banyanOption.value
            const current = yield* banyan.get()
            const newValue = !current.banyancode_yolo_mode
            yield* banyan.update({ banyancode_yolo_mode: newValue })
            return Effect.succeed({ toggled: newValue }) as any
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
          Effect.flatMap(Effect.serviceOption(ModelsDev.Service), (option) =>
            option._tag === "Some" ? option.value.refresh(true) : Effect.void,
          ),
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`
}

export * as Command from "."
