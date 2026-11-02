import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, type Scope } from "effect"
import type { Interface as ConfigInterface } from "../config/service.js"
import type { Interface as StorageInterface } from "../storage/service.js"
import type { CodegraphPort } from "./codegraph-port.js"
import { registerCommands } from "./commands.js"
import { makeEditPlanner } from "./edit-planner.js"
import { Definition, handlers } from "./rpc.js"
import { make } from "./service.js"
import { buildTools, NAMES } from "./tools.js"

/**
 * Workstream 3c entry point (repository intelligence + change check).
 *
 * `deps.codegraph` is the only graph dependency; the lead binds it to the
 * codegraph service from workstream 3a. `storage` and `config` are part of the
 * shared plugin dependency bag (and used by the verify twin); intel itself
 * persists nothing and reads no config yet.
 */

export interface IntelDeps {
  readonly storage: StorageInterface
  readonly config: ConfigInterface
  readonly codegraph: CodegraphPort
  /** Builds the graph first when it is missing or empty, as the repository tools promise. */
  readonly ensureGraph?: () => Effect.Effect<unknown>
}

export const register = (ctx: Context, deps: IntelDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const projectRoot = ctx.location.project.canonical || ctx.location.project.directory
    // Git reads (ownership, recent commits) must resolve against the project,
    // not the host process cwd (which is the user's home for the server).
    const intel = make(deps.codegraph, { cwd: projectRoot })
    const planner = makeEditPlanner(deps.codegraph)
    const ensureGraph = deps.ensureGraph
    const tools = buildTools({ ctx, port: deps.codegraph, intel }).map((tool) =>
      ensureGraph === undefined
        ? tool
        : {
            ...tool,
            execute: ((...args: never[]) =>
              ensureGraph().pipe(
                Effect.andThen((tool.execute as (...args: never[]) => Effect.Effect<never, never>)(...args)),
              )) as typeof tool.execute,
          },
    )

    yield* ctx.tool
      .transform((editor) => {
        editor.namespace({
          name: "banyan",
          description: "BanyanCode repository intelligence, verification and orchestration tools.",
        })
        for (const tool of tools) editor.add(tool)
      })
      .pipe(Effect.orDie)

    yield* ctx.rpc
      .register(Definition, handlers({ port: deps.codegraph, intel, planner }))
      .pipe(Effect.orDie)

    // `/repository-*` slash commands (v1 command templates).
    yield* registerCommands(ctx)
  })

export { Definition as IntelRpcDefinition, NAMES as INTEL_TOOL_NAMES }
export { REPOSITORY_COMMANDS, REPOSITORY_COMMAND_NAMES, commandText, registerCommands } from "./commands.js"
export type { CodegraphPort } from "./codegraph-port.js"
export { make as makeRepositoryIntelligence }
export type { Interface as RepositoryIntelligence } from "./service.js"
