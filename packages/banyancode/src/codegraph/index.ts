/**
 * Codegraph workstream registration.
 *
 * `register(ctx, deps)` is the single entry point the plugin's `server.ts`
 * calls. It owns every registration the workstream needs:
 *
 *   - tools   → `ctx.tool.transform` (exact v1 IDs: codegraph_build, code_find,
 *               codegraph_staleness, codegraph_search, codegraph_query,
 *               codegraph_impact, codegraph_dependents, codegraph_callers,
 *               codegraph_remove, codegraph_find_*)
 *   - RPC     → `ctx.rpc.register(Definition)` with id `banyancode.codegraph`
 *               (methods + `rpc.banyancode.codegraph.*` events)
 *   - commands→ `ctx.command.transform` (`/codegraph-build`, `-cancel`,
 *               `-force-kill`, `-remove`)
 *   - policy  → `ctx.session.hook("context")`, appending the v1 policy text +
 *               per-session tool guide to `event.system`
 *   - watcher → `ctx.event.subscribe({ types: ["filesystem.changed"] })`
 *   - backgrounds → `Effect.forkScoped` (plugin scope)
 *
 * Per AGENTS.md every service event queue has exactly ONE consumer, and it is
 * the RPC bridge here — no service drains its own queue.
 */
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool as ToolSchema } from "@opencode/schema/tool"
import { Effect, Queue, Scope, Stream } from "effect"
import { existsSync } from "node:fs"
import path from "node:path"
import type { BanyanConfig } from "../config/index.js"
import type { Storage } from "../storage/index.js"
import { make as makeAnalyzer } from "./codegraph-analyzer.js"
import { make as makeAutoUpdate } from "./codegraph-auto-update.js"
import { make as makeBootstrap } from "./codegraph-bootstrap.js"
import { make as makeBuildService } from "./codegraph-build-service.js"
import { make as makeIndexer } from "./codegraph-indexer.js"
import { make as makeReadiness } from "./codegraph-readiness.js"
import { make as makeRepo } from "./codegraph-repo.js"
import { Definition } from "./rpc.js"
import { makeService } from "./search/search.js"
import { make as makeStructural } from "./structural-queries/structural-queries.js"
import { renderPolicy, type ToolGuideInput } from "./system-policy.js"
import { name as codeFindName, tool as codeFindTool } from "./tools/code-find.js"
import {
  name_build,
  name_callers,
  name_dependents,
  name_impact,
  name_query,
  name_remove,
  tools as codegraphTools,
} from "./tools/codegraph.js"
import { name as stalenessName, tool as stalenessTool } from "./tools/codegraph-staleness.js"
import { name as searchName, tool as searchTool } from "./tools/codegraph-search-tool.js"
import {
  name_find_async,
  name_find_http_routes,
  name_find_implementations,
  name_find_overrides,
  name_find_recursive,
  tools as structuralTools,
} from "./tools/structural-queries-tool.js"

export * as CodegraphRpc from "./rpc.js"
export { Definition as CodegraphRpcDefinition } from "./rpc.js"
export type { Interface as CodegraphRepo } from "./codegraph-repo.js"
export { CODEGRAPH_SCHEMA_VERSION } from "./codegraph-repo.js"
export { POLICY_TEXT } from "./system-policy.js"

export interface RegisterDeps {
  readonly storage: Storage.Interface
  readonly config: BanyanConfig.Interface
}

/** Every tool id this workstream registers, in registration order. */
export const TOOL_IDS = [
  name_build,
  name_query,
  name_impact,
  name_dependents,
  name_callers,
  name_remove,
  codeFindName,
  stalenessName,
  searchName,
  name_find_implementations,
  name_find_overrides,
  name_find_recursive,
  name_find_async,
  name_find_http_routes,
] as const

export const register = (
  ctx: Context,
  deps: RegisterDeps,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    // v1 contract: `BANYANCODE_ENABLE=0` disables the whole workstream
    // (tools, RPC, watcher, bootstrap). The plugin still loads.
    if (process.env.BANYANCODE_ENABLE === "0") return

    const projectRoot = ctx.location.project.canonical || ctx.location.project.directory

    // ── services ────────────────────────────────────────────────────────────
    const repo = makeRepo(deps.storage)
    const indexer = yield* makeIndexer(repo, deps.storage)
    const buildService = yield* makeBuildService({ indexer, repo, dbPath: () => deps.storage.path })
    const autoUpdate = yield* makeAutoUpdate({
      indexer,
      repo,
      buildService,
      projectDirectory: ctx.location.project.directory,
      dbPath: deps.storage.path,
      config: {
        getWatchOptions: () =>
          deps.config.get().pipe(
            Effect.map((loaded) => ({
              enabled: loaded.config.banyancode_codegraph_watch_enabled ?? true,
              debounceMs: loaded.config.banyancode_codegraph_watch_debounce_ms ?? 500,
              excludePatterns: loaded.config.banyancode_codegraph_exclude_patterns ?? [],
            })),
            Effect.orElseSucceed(() => ({
              enabled: true,
              debounceMs: 500,
              excludePatterns: [] as readonly string[],
            })),
          ),
      },
    })
    const readiness = yield* makeReadiness({ buildService, repo })
    const bootstrap = yield* makeBootstrap({
      readiness,
      watchEnabled: () =>
        deps.config.get().pipe(
          Effect.map((loaded) => loaded.config.banyancode_codegraph_watch_enabled ?? true),
          Effect.orElseSucceed(() => true),
        ),
    })
    const analyzer = makeAnalyzer(repo)
    const search = makeService(repo)
    const structural = makeStructural(repo)

    const excludePatterns = () =>
      deps.config.get().pipe(
        Effect.map((loaded) => loaded.config.banyancode_codegraph_exclude_patterns ?? []),
        Effect.orElseSucceed(() => [] as readonly string[]),
      )

    // ── RPC ─────────────────────────────────────────────────────────────────
    const rpc = yield* ctx.rpc
      .register(Definition, {
        build: (input) =>
          Effect.gen(function* () {
            const root = input.root ?? projectRoot
            yield* buildService.start({
              root,
              force: input.force ?? false,
              ...(input.excludePatterns ? { excludePatterns: input.excludePatterns } : {}),
            })
            return yield* buildService.status()
          }),
        cancel: () => buildService.cancel().pipe(Effect.andThen(buildService.status())),
        forceKill: () => buildService.forceKill(),
        remove: (input) =>
          Effect.gen(function* () {
            const [filesBefore, nodesBefore, edgesBefore] = yield* Effect.all([
              repo.countFiles(),
              repo.countNodes(),
              repo.countEdges(),
            ])
            const empty = filesBefore === 0 && nodesBefore === 0 && edgesBefore === 0
            const { sizeBefore, sizeAfter } = yield* repo.clearAll({ dropFile: input.dropFile ?? false })
            return {
              status: (empty ? "empty" : "removed") as "empty" | "removed",
              sizeBefore,
              sizeAfter,
              freedBytes: Math.max(0, sizeBefore - sizeAfter),
            }
          }),
        status: () =>
          Effect.gen(function* () {
            const [build, ready, auto, meta] = yield* Effect.all([
              buildService.status(),
              readiness.status(),
              autoUpdate.state(),
              repo.getMeta(),
            ])
            return {
              build,
              readiness: ready,
              autoUpdate: auto,
              ...(meta ? { meta } : {}),
              databasePath: deps.storage.path,
              schemaVersion: deps.storage.schemaVersion,
            }
          }),
        nodes: (input) => repo.listNodesPage({ ...input }),
        edges: (input) => repo.listEdgesPage({ ...input }),
        files: (input) => repo.listFilesPage({ ...input }),
        staleness: (input) =>
          Effect.gen(function* () {
            const root = input.root ?? projectRoot
            const totalFiles = yield* repo.countFiles()
            if (totalFiles === 0) {
              return { staleFiles: 0, missingFiles: 0, totalFiles: 0, topStale: [], topMissing: [] }
            }
            const staleFiles = yield* repo.countStaleFiles()
            const topStale = yield* repo.listStaleFiles(10)
            const all = yield* repo.listAllFiles()
            const missing = all
              .filter((file) => {
                const candidate = path.isAbsolute(file.path) ? file.path : path.join(root, file.path)
                return !existsSync(candidate)
              })
              .map((file) => ({ path: file.path, indexedAt: file.indexedAt }))
            return {
              staleFiles,
              missingFiles: missing.length,
              totalFiles,
              topStale: [...topStale],
              topMissing: missing.slice(0, 10),
            }
          }),
        "autoUpdate.status": () => autoUpdate.state(),
        "autoUpdate.flush": (input) => autoUpdate.flush({ ...input }),
        "autoUpdate.reconcile": (input) => autoUpdate.reconcile({ ...input }),
      })
      // ctx.rpc.register has an `unknown` error channel (spike finding).
      .pipe(Effect.orDie)

    // Single-consumer bridges. One fiber per queue; no service drains these.
    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(buildService.events()).pipe(
          Effect.flatMap((state) => rpc.events.emit("build", state)),
          Effect.ignore,
        ),
      ),
    )
    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(autoUpdate.events()).pipe(
          Effect.flatMap((state) => rpc.events.emit("autoUpdate", state)),
          Effect.ignore,
        ),
      ),
    )
    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(autoUpdate.progressEvents()).pipe(
          Effect.flatMap((state) => rpc.events.emit("autoUpdateProgress", state)),
          Effect.ignore,
        ),
      ),
    )

    // ── filesystem watcher → incremental index ─────────────────────────────
    yield* ctx.event
      .subscribe({ types: ["filesystem.changed"] })
      .pipe(
        Stream.runForEach((event) =>
          event.type === "filesystem.changed"
            ? autoUpdate.onChange({
                file: event.data.file,
                event: event.data.event,
                ...(event.location?.directory ? { directory: event.location.directory } : {}),
              })
            : Effect.void,
        ),
        Effect.catchCause(() => Effect.void),
        Effect.forkScoped,
      )

    // ── tools ──────────────────────────────────────────────────────────────
    const toolDeps = { repo, analyzer, buildService }
    const registered = [
      ...codegraphTools(toolDeps),
      codeFindTool({ repo, analyzer, readiness, projectRoot: () => projectRoot }),
      stalenessTool({ repo, projectRoot: () => projectRoot }),
      searchTool({ repo, search, structural }),
      ...structuralTools({ structural }),
    ] as ReadonlyArray<ToolSchema.Info>

    yield* ctx.tool
      .transform((editor) => {
        for (const tool of registered) editor.add(tool)
      })
      .pipe(Effect.orDie)

    const toolGuide: ReadonlyArray<ToolGuideInput> = registered.map((tool) => ({
      id: tool.name,
      description: tool.description,
    }))
    // ── system-prompt policy (v1 `codegraph-system-source.ts`) ─────────────
    yield* ctx.session
      .hook("context", (event) =>
        Effect.gen(function* () {
          const ready = yield* readiness.status()
          const graph =
            ready.reason === "ready" || ready.reason === "stale"
              ? ({ state: "ready", ...(ready.totalFiles !== undefined ? { symbols: ready.totalFiles } : {}) } as const)
              : ready.reason === "building"
                ? ({ state: "building" } as const)
                : ({ state: "missing" } as const)
          const text = renderPolicy({ tools: toolGuide, graph })
          event.system.push({ type: "text", text })
        }).pipe(Effect.catchCause(() => Effect.void)),
      )
      .pipe(Effect.orDie)

    // ── slash commands ─────────────────────────────────────────────────────
    const parseForce = (text: string) => /(^|\s)--force(\s|$)/.test(text)
    const parseDropFile = (text: string) => /(^|\s)--drop-file(\s|$)/.test(text)
    yield* ctx.command
      .transform((editor) => {
        editor.add({
          name: "codegraph-build",
          description: "build or rebuild the code graph [--force]",
          execute: (input) =>
            Effect.gen(function* () {
              yield* buildService.start({
                root: projectRoot,
                force: parseForce(input.prompt.text),
                excludePatterns: yield* excludePatterns(),
              })
            }).pipe(Effect.orDie),
        })
        editor.add({
          name: "codegraph-cancel",
          description: "cancel the running code graph build",
          execute: () => buildService.cancel().pipe(Effect.orDie),
        })
        editor.add({
          name: "codegraph-force-kill",
          description: "force-kill a wedged code graph build",
          execute: () => buildService.forceKill().pipe(Effect.asVoid, Effect.orDie),
        })
        editor.add({
          name: "codegraph-remove",
          description: "remove the code graph index [--drop-file]",
          execute: (input) =>
            Effect.gen(function* () {
              yield* repo.clearAll({ dropFile: parseDropFile(input.prompt.text) })
            }).pipe(Effect.orDie),
        })
      })
      .pipe(Effect.orDie)

    // ── background bootstrap (non-blocking first build) ────────────────────
    yield* Effect.forkScoped(bootstrap.ensureGraph({ root: projectRoot }).pipe(Effect.ignore))

    // Periodic reconciliation covers edits the host watcher missed.
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep("10 minutes").pipe(
          Effect.andThen(autoUpdate.reconcile({ root: projectRoot })),
          Effect.ignore,
        ),
      ),
    )
  })
