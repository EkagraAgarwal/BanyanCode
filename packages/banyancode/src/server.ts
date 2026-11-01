import { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Cause, Effect, Schema, type Scope } from "effect"
import { register as registerAgents } from "./agents/index.js"
import { register as registerCache } from "./cache/index.js"
import { makeServices as makeCodegraphServices, register as registerCodegraph } from "./codegraph/index.js"
import { BanyanConfig, setConfigUpdatedListener, summarize, updateConfig, type Loaded } from "./config/index.js"
import { register as registerGateway } from "./gateway/index.js"
import { empty as emptyCodegraphPort, make as makeCodegraphPort } from "./integration/codegraph-port.js"
import { make as makeCodegraphQuery } from "./integration/codegraph-query.js"
import { register as registerIntel } from "./intel/index.js"
import { register as registerLsp } from "./lsp/index.js"
import { register as registerMesh } from "./mesh/index.js"
import { Definition, Status } from "./rpc.js"
import { Storage } from "./storage/index.js"
import { register as registerSystem } from "./system/index.js"
import { register as registerTelemetry } from "./telemetry/index.js"
import { register as registerVerify } from "./verify/index.js"
import { PLUGIN_ID, VERSION } from "./version.js"
import { register as registerWebsearch } from "./websearch/index.js"
import { register as registerYolo } from "./yolo/index.js"

/**
 * BanyanCode server plugin.
 *
 * Every feature workstream owns its registrations behind a `register(ctx,
 * deps)` entry point; this file only builds the shared storage/config/codegraph
 * dependencies and composes them. A workstream that throws during registration
 * is logged and skipped: optional features (websearch, telemetry, cache, yolo,
 * mesh, verify, system) must never prevent the host from booting. Codegraph is built
 * once and shared: a failure there degrades intel/gateway to an empty graph
 * instead of aborting the plugin.
 */

/**
 * Body of `banyancode.config.update` (v1 `PATCH /global/banyan-config`).
 * Exported so the RPC body can be tested without booting every workstream.
 */
export const handleConfigUpdate = (
  config: BanyanConfig.Interface,
  target: { readonly directory: string; readonly projectRoot: string },
  input: { readonly config: Readonly<Record<string, unknown>>; readonly scope?: "global" | "project" },
): Effect.Effect<Loaded> =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      updateConfig(
        { scope: input.scope ?? "global", directory: target.directory, projectRoot: target.projectRoot },
        input.config,
      ),
    )
    return yield* config.get()
  })

/** Logs a workstream failure and keeps booting; interrupts still propagate. */
const isolated = (name: string, effect: Effect.Effect<void, never, Scope.Scope>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning(`banyancode: ${name} registration failed; feature skipped`, {
            cause: Cause.pretty(cause),
          }),
    ),
  )

export default Plugin.define({
  id: PLUGIN_ID,
  effect: Effect.fn(function* (ctx) {
    const projectRoot = ctx.location.project.canonical || ctx.location.project.directory
    // v1 parity: `BANYANCODE_ENABLE=0` disables every BanyanCode tool, policy
    // and feature. Only the status surface stays: it is what a user checks to
    // confirm the plugin loaded and why everything else is off.
    const enabled = process.env.BANYANCODE_ENABLE !== "0"
    const storage = yield* Storage.open({ projectRoot, channel: ctx.app.channel }).pipe(Effect.orDie)
    const config = BanyanConfig.make({ directory: ctx.location.directory, projectRoot })
    const deps = { storage, config }

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

    const describeConfig = (loaded: Loaded) => ({
      config: loaded.config,
      sources: loaded.sources.map((source) => source.file),
      unknownKeys: loaded.unknownKeys.map((entry) => ({ file: entry.file, keys: [...entry.keys] })),
      errors: loaded.errors.map((entry) => ({ file: entry.file, message: entry.message })),
    })

    const rpc = yield* ctx.rpc
      .register(Definition, {
        status: () => status,
        "config.get": () => config.get().pipe(Effect.map(describeConfig)),
        "config.update": (input) =>
          handleConfigUpdate(config, { directory: ctx.location.directory, projectRoot }, input).pipe(
            Effect.map(describeConfig),
          ),
      })
      // ctx.rpc.register has an `unknown` error channel (spike finding).
      .pipe(Effect.orDie)

    // Bridge the writer's process-local `config.updated` notification to the
    // plugin RPC event (host emits it as `rpc.banyancode.config.updated`).
    {
      const context = yield* Effect.context<never>()
      setConfigUpdatedListener((event) => {
        Effect.runForkWith(context)(rpc.events.emit("config.updated", event))
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => setConfigUpdatedListener(undefined)))
    }

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

    // `BANYANCODE_ENABLE=0`: status RPC + `banyan_status` tool only. No graph,
    // no policy, no mesh, no verifier, no telemetry, no commands.
    if (!enabled) return

    // 3a — build the graph repository once; intel/gateway reuse the same instance.
    const codegraph = yield* makeCodegraphServices(ctx, deps).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("banyancode: codegraph services failed; intel/gateway use an empty graph", {
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(undefined)),
      ),
    )
    const port = codegraph === undefined ? emptyCodegraphPort : makeCodegraphPort(codegraph.repo)

    yield* isolated(
      "codegraph",
      registerCodegraph(ctx, { ...deps, ...(codegraph === undefined ? {} : { services: codegraph }) }),
    )
    yield* isolated("intel", registerIntel(ctx, { ...deps, codegraph: port }))
    yield* isolated("verify", registerVerify(ctx, { ...deps, codegraph: port }))
    yield* isolated("agents", registerAgents(ctx, { config }))
    yield* isolated("websearch", registerWebsearch(ctx, { config }))

    // 3e — the gateway may only rewrite onto tools that are actually registered.
    const availableTools = yield* ctx.tool.list().pipe(
      Effect.map((tools) => new Set(tools.map((tool) => tool.id))),
      Effect.catchCause((cause) =>
        Effect.logWarning("banyancode: tool catalog unavailable; gateway rewrites disabled", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(new Set<string>())),
      ),
    )
    const query = codegraph === undefined ? {} : makeCodegraphQuery(codegraph.repo, { availableTools })
    yield* isolated("gateway", registerGateway(ctx, { ...deps, codegraph: query }))

    yield* isolated("telemetry", registerTelemetry(ctx, deps))
    yield* isolated("yolo", registerYolo(ctx, { config }))
    yield* isolated("cache", registerCache(ctx, deps))
    yield* isolated("mesh", registerMesh(ctx, deps))
    // After mesh: the persisted /max-subagents command replaces the in-memory one.
    yield* isolated("system", registerSystem(ctx, deps))
    yield* isolated("lsp", registerLsp(ctx, deps))
  }),
})
