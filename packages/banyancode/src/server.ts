import { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { BanyanConfig, summarize } from "./config/index.js"
import { Definition, Status } from "./rpc.js"
import { Storage } from "./storage/index.js"
import { PLUGIN_ID, VERSION } from "./version.js"

/**
 * BanyanCode server plugin skeleton.
 *
 * Phase 2 owns storage, config and the RPC/tool surface. The feature
 * workstreams plug in here without moving this file:
 *
 *   TODO(3a codegraph): `src/codegraph/` — indexer, readiness, watcher bridge,
 *        `/codegraph-*` commands, system-prompt policy.
 *   TODO(3b memory): dropped in v2; no server module will be added.
 *   TODO(3c intel/verify): `src/intel/`, `src/verify/` — preflight,
 *        blast_radius, safe_rename, edit_plan, test/typecheck/lint.
 *   TODO(3d agents): `src/agents/` — orchestrator/coder/scout/researcher/
 *        reviewer transforms and DuckDuckGo websearch.
 *   TODO(3e gateway): `src/gateway/` — route_grep/read/glob, tool telemetry,
 *        prompt-cache tuning, yolo mode, LSP caps.
 *   TODO(3f mesh): `src/mesh/` — subagent messages/plans/reviews on the tables
 *        already created by the storage migrations, plus `/goal` and `/swarm`.
 *   TODO(3g TUI): `packages/banyancode-tui` consumes the `banyancode.*` RPC
 *        methods and `rpc.banyancode.*` events; no server module here.
 *   TODO(3h parity): Telegram and trace keys are already accepted by
 *        `BanyanConfig`; wire their consumers when the workstream lands.
 */
export default Plugin.define({
  id: PLUGIN_ID,
  effect: Effect.fn(function* (ctx) {
    const projectRoot = ctx.location.project.canonical || ctx.location.project.directory
    const storage = yield* Storage.open({ projectRoot }).pipe(Effect.orDie)
    const config = BanyanConfig.make({ directory: ctx.location.directory, projectRoot })

    const status: Effect.Effect<Status> = Effect.gen(function* () {
      const loaded = yield* config.get()
      return {
        plugin: PLUGIN_ID,
        version: VERSION,
        host: { name: ctx.app.name, version: ctx.app.version, channel: ctx.app.channel },
        database: {
          path: storage.path,
          driver: storage.driver,
          schemaVersion: storage.schemaVersion,
          migrations: [...storage.appliedMigrations],
          ftsTokenizer: storage.ftsTokenizer,
        },
        config: {
          sources: loaded.sources.map((source) => source.file),
          unknownKeys: loaded.unknownKeys.flatMap((entry) => entry.keys),
          errors: loaded.errors.map((entry) => `${entry.file}: ${entry.message}`),
          summary: summarize(loaded),
        },
      } satisfies Status
    })

    yield* ctx.rpc
      .register(Definition, {
        status: () => status,
        "config.get": () =>
          config.get().pipe(
            Effect.map((loaded) => ({
              config: loaded.config,
              sources: loaded.sources.map((source) => source.file),
              unknownKeys: loaded.unknownKeys.map((entry) => ({ file: entry.file, keys: [...entry.keys] })),
              errors: loaded.errors.map((entry) => ({ file: entry.file, message: entry.message })),
            })),
          ),
      })
      // ctx.rpc.register has an `unknown` error channel (spike finding).
      .pipe(Effect.orDie)

    const execute = (): Effect.Effect<Tool.Result<typeof Status>, Tool.Error> =>
      status.pipe(
        Effect.map((output) => ({
          output,
          content: JSON.stringify(output, null, 2),
        })),
      )

    yield* ctx.tool
      .transform((editor) => {
        editor.namespace({
          name: "banyan",
          description: "BanyanCode repository intelligence, verification and orchestration tools.",
        })
        editor.add({
          name: "banyan_status",
          description:
            "Report BanyanCode plugin status: version, project database path and schema version, and the effective banyancode.json sources.",
          input: Schema.Struct({}),
          output: Status,
          options: { permission: "banyan_status" },
          execute,
        })
      })
      .pipe(Effect.orDie)
  }),
})
