import type { Context } from "@opencode/plugin/effect/plugin"
import { Path as GlobalPath } from "@opencode/util/global"
import { Effect, type Scope } from "effect"
import { MAX_SUBAGENTS_LIMIT, DEFAULT_MAX_SUBAGENTS } from "../config/index.js"
import type { Interface as ConfigInterface } from "../config/service.js"
import type { WriteTarget } from "../config/writer.js"
import type { Interface as StorageInterface } from "../storage/service.js"
import { registerCommands } from "./commands.js"
import { createSystemMonitor } from "./monitor.js"
import { heartbeat, pingOnFirstRun } from "./install-telemetry.js"
import { Definition, handlers, publishStatus } from "./rpc.js"
import { buildSystemTools, NAME_SYSTEMINFO, NAME_SYSTEM_STATUS, NAME_TOOL_SEARCH } from "./tools.js"

/**
 * Workstream 3e entry point: host health tools, LSP config state, the YOLO
 * switch and the agent config writers, plus install telemetry.
 *
 * `server.ts` owns composition; this module owns every registration below.
 * The lead wires `register(ctx, { storage, config })` into the plugin after
 * `mesh` so the persisted `/max-subagents` command wins over the mesh
 * in-memory variant (otherwise the value is not written to `banyancode.json`).
 */

export interface SystemDeps {
  readonly storage: StorageInterface
  readonly config: ConfigInterface
}

export const TOOL_IDS = [NAME_SYSTEM_STATUS, NAME_SYSTEMINFO, NAME_TOOL_SEARCH] as const

const STATUS_INTERVAL = "15 seconds"

export const writeTarget = (ctx: Context): WriteTarget => ({
  directory: ctx.location.directory,
  projectRoot: ctx.location.project.canonical || ctx.location.project.directory,
})

const registerTelemetry = (ctx: Context, config: ConfigInterface): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const loaded = yield* config.get()
    const stateDir = GlobalPath.state
    const options = {
      stateDir,
      ...(loaded.config.banyancode_telemetry === undefined
        ? {}
        : { setting: loaded.config.banyancode_telemetry }),
      version: ctx.app.version,
      channel: ctx.app.channel,
    }
    // Detached: a slow/failed ping must never delay plugin activation, and no
    // key means `pingOnFirstRun` returns "noop" before touching the network.
    yield* Effect.forkDetach(
      Effect.gen(function* () {
        yield* Effect.promise(() => pingOnFirstRun(options))
        yield* Effect.promise(() => heartbeat(options))
      }).pipe(Effect.catchCause(() => Effect.void)),
    )
  })

export const register = (ctx: Context, deps: SystemDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const target = writeTarget(ctx)
    const monitor = createSystemMonitor()

    yield* ctx.tool
      .transform((editor) => {
        editor.namespace({
          name: "banyan",
          description: "BanyanCode repository intelligence, verification and orchestration tools.",
        })
        for (const tool of buildSystemTools({ ctx, monitor, storage: deps.storage })) editor.add(tool)
      })
      .pipe(Effect.orDie)

    const rpc = yield* ctx.rpc
      .register(
        Definition,
        handlers({
          config: deps.config,
          monitor,
          target,
          reloadAgents: () => ctx.agent.reload(),
        }),
      )
      .pipe(Effect.orDie)

    yield* registerCommands(ctx, {
      config: deps.config,
      target,
      session: ctx.session,
      maxSubagentsLimit: MAX_SUBAGENTS_LIMIT,
      maxSubagentsDefault: DEFAULT_MAX_SUBAGENTS,
    })

    yield* registerTelemetry(ctx, deps.config)

    // v1 `banyancode.system.updated` was a sampled stream. The TUI polls
    // `status` too, so a slow interval is enough and keeps idle CPU at zero.
    yield* Effect.forever(
      Effect.sleep(STATUS_INTERVAL).pipe(
        Effect.andThen(Effect.promise(() => monitor.status())),
        Effect.andThen((status) => publishStatus(rpc, status)),
      ),
    ).pipe(Effect.forkScoped({ startImmediately: true }))
  })

export { Definition as SystemRpcDefinition, handlers as systemRpcHandlers } from "./rpc.js"
export { createSystemMonitor, readSystemStatus, detectPlatform } from "./monitor.js"
export type { SystemStatus, SystemMonitor } from "./monitor.js"
export { lspStatus, resolveIdleTimeoutMs, DEFAULT_LSP_IDLE_TIMEOUT_MS } from "./lsp.js"
export type { LspStatus, LspServerStatus } from "./lsp.js"
export {
  buildPayload,
  heartbeat,
  pingOnFirstRun,
  ping,
  telemetryEnabled,
  transportAvailable,
  POSTHOG_ENDPOINT,
} from "./install-telemetry.js"
export type { InstallIdentity, PingOutcome, PingPayload } from "./install-telemetry.js"
export {
  NAME_SYSTEM_STATUS,
  NAME_SYSTEMINFO,
  NAME_TOOL_SEARCH,
  buildSystemTools,
  makeSystemInfoTool,
  makeSystemStatusTool,
  makeToolSearchTool,
} from "./tools.js"
export { LSP_COMMAND, MAX_SUBAGENTS_COMMAND, WEBSEARCH_FREE_COMMAND, YOLO_COMMAND, registerCommands } from "./commands.js"
