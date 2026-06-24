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
  execute?: (input: { command: string; arguments: string }) => Effect.Effect<void, never, any>
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
            if (Option.isNone(buildServiceOpt)) return
            const args = parseArgs(input.arguments)
            const root = args.positional[0] ?? ctx.worktree
            const force = args.flags.force === true || args.flags.force === "true"
            const dbPath = Database.path()
            yield* buildServiceOpt.value.start({ root, force, dbPath })
          }).pipe(Effect.provide(Banyan.codegraphBuildServiceDefaultLayer)),
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
            if (Option.isNone(repoOpt)) return
            yield* repoOpt.value.clearAll()
          }).pipe(Effect.provide(Banyan.codegraphRepoDefaultLayer)),
        hints: [],
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

export * as Command from "."
