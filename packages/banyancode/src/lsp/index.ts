import { Effect, type Scope } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Interface as ConfigInterface } from "../config/service.js"
import type { Interface as StorageInterface } from "../storage/service.js"
import { resolveConfig, resolveFlags, readHostLsp } from "./config.js"
import { registerDiagnosticsHook } from "./hooks.js"
import { create } from "./manager.js"
import { bind } from "./state.js"
import { makeLspTool } from "./tools.js"

/**
 * Workstream 3e (parity G1): the LSP runtime.
 *
 * `server.ts` owns composition; the lead adds
 * `isolated("lsp", registerLsp(ctx, deps))`. Everything the runtime starts —
 * language server processes, the idle sweep timer, the status registry binding
 * — is released when the plugin scope closes.
 */

export interface LspDeps {
  readonly storage: StorageInterface
  readonly config: ConfigInterface
}

export const register = (ctx: Context, deps: LspDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const directory = ctx.location.directory
    const worktree = ctx.location.project.canonical || ctx.location.project.directory || directory
    const instance = { directory, worktree }

    const resolve = async () => {
      const loaded = await Effect.runPromise(deps.config.get())
      const host = await readHostLsp({ directory, projectRoot: worktree })
      return resolveConfig({
        host,
        banyan: loaded.config.banyancode_lsp,
        banyanIdleTimeoutMs: loaded.config.banyancode_lsp_idle_timeout_ms,
      })
    }

    const manager = create({ instance, resolve })
    const unbind = bind(() => manager.status())

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        unbind()
        await manager.dispose()
      }),
    )

    // Resolve eagerly so `banyancode.system.lsp.status` is truthful before the
    // first edit: configured servers appear (inert) and the enabled flag
    // reflects `lsp` / `banyancode_lsp`.
    yield* Effect.promise(() => manager.reload()).pipe(Effect.catchCause(() => Effect.void))

    yield* registerDiagnosticsHook(ctx, manager)

    if (resolveFlags().experimentalLspTool) {
      yield* ctx.tool
        .transform((editor) => {
          editor.namespace({
            name: "banyan",
            description: "BanyanCode repository intelligence, verification and orchestration tools.",
          })
          editor.add(makeLspTool({ ctx, manager }))
        })
        .pipe(Effect.orDie)
    }
  })

export { NAME_LSP } from "./tools.js"
export type { Manager } from "./manager.js"
export { DEFAULT_LSP_IDLE_TIMEOUT_MS, resolveIdleTimeoutMs } from "./config.js"
export type { EntryConfig, Resolved, Setting } from "./config.js"
