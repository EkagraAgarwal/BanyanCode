import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Option } from "effect"
import type { Tool as AITool } from "ai"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { Reference } from "@opencode-ai/core/reference"
import { Banyan } from "@opencode-ai/core/banyancode"

export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  readonly codegraph: (tools?: Record<string, AITool>) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const locations = yield* LocationServiceMap

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        const references = yield* Effect.gen(function* () {
          yield* (yield* PluginBoot.Service).wait()
          return (yield* (yield* Reference.Service).list()).filter((reference) => reference.description !== undefined)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
          references.length === 0
            ? undefined
            : [
                "Project references provide additional directories that can be accessed when relevant.",
                "<available_references>",
                ...references
                  .toSorted((a, b) => a.name.localeCompare(b.name))
                  .flatMap((reference) => [
                    "  <reference>",
                    `    <name>${reference.name}</name>`,
                    `    <path>${reference.path}</path>`,
                    ...(reference.description === undefined
                      ? []
                      : [`    <description>${reference.description}</description>`]),
                    "  </reference>",
                  ]),
                "</available_references>",
              ].join("\n"),
        ].filter((part): part is string => part !== undefined)
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),

      codegraph: Effect.fn("SystemPrompt.codegraph")(function* (tools?: Record<string, AITool>) {
        const enabled = process.env.BANYANCODE_ENABLE !== "0"
        if (!enabled) return

        // Map the resolved AI-SDK tool set into the source's
        // CodegraphToolDescription shape so the rendered guide carries the
        // per-tool descriptions the model will see in its function list.
        const descriptions = tools
          ? Object.entries(tools).map(([id, tool]) => ({
              id,
              description: tool.description ?? "",
            }))
          : undefined

        // Prefer the BanyanCode source module when it is in scope (e.g. tests
        // that provide the layer, or SystemPrompt.defaultLayer which mounts
        // `CodegraphSystemSource` explicitly). Falls back to the exported
        // `POLICY_TEXT` constant when the service is not available so
        // isolated test layers that build the raw `layer` still ship the
        // model-facing preference for graph + repository tools.
        const source = yield* Effect.serviceOption(Banyan.CodegraphSystemSource)

        // Phase A: read the graph bootstrap state so the rendered policy can
        // tell the model whether a graph is ready, building, or missing. The
        // bootstrap service is optional — when it is not in scope (tests that
        // only provide SystemPrompt.defaultLayer) the Graph state line is
        // omitted entirely and behavior is unchanged.
        const bootstrap = yield* Effect.serviceOption(Banyan.CodegraphBootstrap)
        const graphState = Option.isSome(bootstrap)
          ? yield* bootstrap.value.status().pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : undefined

        return yield* Option.match(source, {
          onSome: (svc) =>
            descriptions === undefined && graphState === undefined
              ? svc.load(undefined)
              : svc.load({
                  ...(descriptions ? { tools: descriptions } : {}),
                  ...(graphState ? { graph: graphState } : {}),
                }),
          onNone: () => Effect.succeed(Banyan.CodegraphSystemSourceNS.POLICY_TEXT),
        })
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Skill.defaultLayer),
  Layer.provide(LocationServiceMap.layer),
  // Mount the dynamic codegraph source so the V1 prompt composes the per-session
  // tool guide + graph state whenever SystemPrompt is built in production
  // (AppLayer / createRoutes) instead of silently degrading to the static
  // POLICY_TEXT. The bootstrap state service is wired by the runtime
  // composition (AppLayer / createRoutes mount the root-bound
  // `codegraphBootstrapDefaultLayer` facade), not here — it needs the graph
  // DB, which is out of scope for this renderer-only layer.
  Layer.provide(Banyan.CodegraphSystemSourceNS.defaultLayer),
)

const locationServiceMapNode = LayerNode.make(LocationServiceMap.layer, [])

export const node = LayerNode.make(layer, [Skill.node, locationServiceMapNode])

export * as SystemPrompt from "./system"
