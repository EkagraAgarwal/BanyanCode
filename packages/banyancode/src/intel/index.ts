import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, type Scope } from "effect"
import type { Interface as ConfigInterface } from "../config/service.js"
import type { Interface as StorageInterface } from "../storage/service.js"
import type { CodegraphPort } from "./codegraph-port.js"
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
}

export const register = (ctx: Context, deps: IntelDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const intel = make(deps.codegraph)
    const planner = makeEditPlanner(deps.codegraph)
    const tools = buildTools({ ctx, port: deps.codegraph, intel })

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
  })

export { Definition as IntelRpcDefinition, NAMES as INTEL_TOOL_NAMES }
export type { CodegraphPort } from "./codegraph-port.js"
export { make as makeRepositoryIntelligence }
export type { Interface as RepositoryIntelligence } from "./service.js"
