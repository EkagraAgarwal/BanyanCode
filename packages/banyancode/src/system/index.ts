import type { Context } from "@opencode/plugin/effect/plugin"
import { Path as GlobalPath } from "@opencode/util/global"
import { Cause, Effect, type Duration, Fiber, Scope } from "effect"
import { MAX_SUBAGENTS_LIMIT, DEFAULT_MAX_SUBAGENTS } from "../config/index.js"
import type { Interface as ConfigInterface } from "../config/service.js"
import type { WriteTarget } from "../config/writer.js"
import type { Interface as StorageInterface } from "../storage/service.js"
import { registerCommands } from "./commands.js"
import { createSystemMonitor, type SystemMonitor } from "./monitor.js"
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
  /** Test seam: the host sampler. Defaults to a real monitor on the host machine. */
  readonly monitor?: SystemMonitor
  /** Test seam: push cadence. Defaults to `STATUS_INTERVAL`. */
  readonly statusInterval?: Duration.Input
}

export const TOOL_IDS = [NAME_SYSTEM_STATUS, NAME_SYSTEMINFO, NAME_TOOL_SEARCH] as const

/**
 * Sampled push cadence. The TUI also polls `status` while its panel is mounted,
 * so this is only the live channel; 5s is fast enough that a change lands in the
 * same glance as the poll and slow enough that idle CPU stays at zero (each tick
 * spawns no timer of its own beyond the loop's sleep).
 */
export const STATUS_INTERVAL = "5 seconds"

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
    const monitor = deps.monitor ?? createSystemMonitor()
    // Prime the CPU delta plus the disk/GPU caches once. CPU is a delta between
    // two snapshots, so without this the first `status` call (the TUI's mount
    // read, and the first publish) has no percentage at all and the row is
    // hidden until a second sample lands. Best effort: a failed probe must not
    // fail activation.
    yield* Effect.promise(() => monitor.status()).pipe(Effect.ignore)

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

    // Sampled push, owned explicitly: the fiber is detached from the fiber that
    // happens to be running registration (a scoped fork needs a live Scope in
    // context and dies with it) and torn down by a finalizer on the plugin's
    // activation scope, so a reload never leaves a second publisher behind.
    // Each iteration is guarded: one rejected probe must not end the stream for
    // the rest of the process.
    const scope = yield* Scope.Scope
    const interval = deps.statusInterval ?? STATUS_INTERVAL
    const publisher = yield* Effect.forkDetach(
      Effect.gen(function* () {
        yield* Effect.sleep(interval)
        yield* Effect.forever(
          Effect.gen(function* () {
            const status = yield* Effect.promise(() => monitor.status())
            yield* publishStatus(rpc, status)
            // The pause belongs inside the loop: hoisting it above `forever`
            // makes every iteration after the first one run back to back, which
            // samples the host and pushes `updated` thousands of times a second.
            yield* Effect.sleep(interval)
          }).pipe(
            // One rejected probe must not end the stream, and its retry has to
            // wait a full tick too or a failing probe becomes the same hot loop.
            Effect.catchCause((cause) =>
              Effect.logWarning("banyancode: system status sample failed; retrying on the next tick", {
                cause: Cause.pretty(cause),
              }).pipe(Effect.andThen(Effect.sleep(interval))),
            ),
          ),
        )
      }),
    )
    yield* Scope.addFinalizer(scope, Fiber.interrupt(publisher).pipe(Effect.asVoid))
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
