import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, type Scope } from "effect"
import type { Interface as ConfigInterface } from "../config/service.js"
import type { Interface as StorageInterface } from "../storage/service.js"
import type { CodegraphPort } from "../intel/codegraph-port.js"
import { Definition, handlers } from "./rpc.js"
import { make } from "./service.js"
import { buildTools, NAME_COMPILE, NAME_LINT, NAME_TEST, NAME_TYPECHECK } from "./tools.js"

/**
 * Workstream 3c entry point (verify). Tools spawn real processes, so every
 * tool call is gated by `ctx.permission.assert` before anything runs; each run
 * is recorded in `verification_runs` by the service.
 */

export interface VerifyDeps {
  readonly storage: StorageInterface
  readonly config: ConfigInterface
  readonly codegraph: CodegraphPort
}

export const register = (ctx: Context, deps: VerifyDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const projectRoot = ctx.location.project.canonical || ctx.location.project.directory
    const verifier = make({ storage: deps.storage, config: deps.config, projectRoot })
    const tools = buildTools(ctx, verifier)

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
      .register(Definition, handlers(verifier, { projectRoot }))
      .pipe(Effect.orDie)
  })

export { Definition as VerifyRpcDefinition }
export { make as makeVerifier }
export { NAME_COMPILE, NAME_LINT, NAME_TEST, NAME_TYPECHECK }
export type { Interface as Verifier } from "./service.js"
