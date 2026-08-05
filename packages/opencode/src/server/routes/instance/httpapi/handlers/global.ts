import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Cause, Context, Duration, Effect, Layer, Option, Queue, Schema } from "effect"
import path from "path"
import * as Stream from "effect/Stream"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { BanyanAgentOverrideUpdateInput, BanyanAgentPromptUpdateInput, BanyanAgentSaveInput, BanyanConfigUpdateInput, BlastRadiusInput, CodeFindInput, CodegraphBuildInput, CodegraphRemoveInput, CodegraphRemoveResult, GlobalUpgradeInput, LintInput, PreflightInput, SafeRenameInput, TestRunInput, ToolUsageResult, TypecheckInput, WebSearchFreeInput } from "../groups/global"
import { Banyan } from "@opencode-ai/core/banyancode"
import { InvalidRequestError } from "../errors"
import { statusFromMeta } from "@opencode-ai/core/banyancode/codegraph-readiness"
import { GraphMeta } from "@opencode-ai/core/banyancode/types"
import { PermissionV2 } from "@opencode-ai/core/permission"
import * as WebSearchFreeTool from "@opencode-ai/core/tool/websearch-free"
import { parse as parseWebSearchFree } from "@opencode-ai/core/tool/websearch-free/parse"
import * as CodeFindTool from "@opencode-ai/core/tool/code-find"
import * as PreflightTool from "@opencode-ai/core/tool/preflight"
import * as BlastRadiusTool from "@opencode-ai/core/tool/blast-radius"
import * as SafeRenameTool from "@opencode-ai/core/tool/safe-rename"
import type { Interface as CodegraphRepoInterface } from "@opencode-ai/core/banyancode/codegraph-repo"
import type { Interface as CodegraphAnalyzerInterface } from "@opencode-ai/core/banyancode/codegraph-analyzer"
import type { Interface as RepositoryIntelligenceInterface } from "@opencode-ai/core/banyancode/repository-intelligence/service"
import type { Interface as EditPlannerInterface } from "@opencode-ai/core/banyancode/edit-planner"
import type { Interface as PermissionV2Interface } from "@opencode-ai/core/permission"
import { Tool as ToolNS } from "@opencode-ai/core/tool/tool"
import { ToolCall } from "@opencode-ai/llm"
import { randomUUID } from "node:crypto"

const websearchFreeDisabled = () => process.env.BANYANCODE_DISABLE_WEBSEARCH === "1"

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

function eventResponse() {
  return Effect.gen(function* () {
    yield* Effect.logInfo("global event connected")
    const events = Stream.callback<GlobalBusEvent>((queue) => {
      const handler = (event: GlobalBusEvent) => Queue.offerUnsafe(queue, event)
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", handler)),
        () => Effect.sync(() => GlobalBus.off("event", handler)),
      )
    })
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("global event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return {
          status: 400,
          body: { success: false as const, error: "Unknown installation method" },
        }
      }
      const target = ctx.payload.target || (yield* installation.latest(method))
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ status: 200, body: { success: true as const, version: target } }),
        Effect.catch((err) =>
          Effect.succeed({
            status: 500,
            body: {
              success: false as const,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      )
      if (!result.body.success) return result
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return result
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const result = yield* upgrade({ payload: payload.payload })
      return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
    })

    const startupHandler = Effect.fn("GlobalHttpApi.startup")(function* () {
      // The SystemMonitor bridge is forked once at process start by
      // AppRuntime (see packages/opencode/src/effect/app-runtime.ts). Calling
      // it again on every TUI reconnect would spawn additional drain fibers
      // against the same Queue.bounded(60), leaking consumers across
      // reconnects. The bridge is therefore not invoked here.
      return true
    })

    const getBanyanConfigHandler = Effect.fn("GlobalHttpApi.getBanyanConfig")(function* () {
      const svc = yield* Banyan.BanyanConfigService
      return yield* svc.get()
    })

    const updateBanyanConfigHandler = Effect.fn("GlobalHttpApi.updateBanyanConfig")(function* ({
      payload,
    }: {
      payload: typeof BanyanConfigUpdateInput.Type
    }) {
      const svc = yield* Banyan.BanyanConfigService
      const updated = yield* svc.update(payload.config)
      const events = yield* EventV2Bridge.Service
      yield* events.publish(Banyan.BanyanConfig.Event.Updated, { scope: "global" }).pipe(Effect.orDie)
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: "banyancode.config.updated" as any,
          properties: { scope: "global" },
        },
      })
      return updated
    })

    const banyanAgentOverrideUpdateHandler = Effect.fn("GlobalHttpApi.banyanAgentOverrideUpdate")(function* ({
      payload,
    }: {
      payload: typeof BanyanAgentOverrideUpdateInput.Type
    }) {
      const svc = yield* Banyan.BanyanConfigService
      const modelPatch =
        payload.model === null
          ? { model: undefined as { providerID: string; modelID: string } | undefined }
          : payload.model === undefined
            ? {}
            : { model: payload.model }
      const updated = yield* svc.updateAgentOverride(payload.name, {
        ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
        ...modelPatch,
      })

      const agentSvc = yield* Agent.Service
      yield* agentSvc.invalidate()

      const events = yield* EventV2Bridge.Service
      yield* events.publish(Banyan.BanyanConfig.Event.Updated, { scope: "global" }).pipe(Effect.orDie)
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: "banyancode.config.updated" as any,
          properties: { scope: "global" },
        },
      })

      return updated
    })

    const banyanAgentPromptUpdateHandler = Effect.fn("GlobalHttpApi.banyanAgentPromptUpdate")(function* ({
      payload,
    }: {
      payload: typeof BanyanAgentPromptUpdateInput.Type
    }) {
      const svc = yield* Banyan.BanyanConfigService
      const updated = yield* svc.updateAgentPrompt(payload.name, payload.prompt)

      const agentSvc = yield* Agent.Service
      yield* agentSvc.invalidate()

      const events = yield* EventV2Bridge.Service
      yield* events.publish(Banyan.BanyanConfig.Event.Updated, { scope: "global" }).pipe(Effect.orDie)
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: "banyancode.config.updated" as any,
          properties: { scope: "global" },
        },
      })

      return updated
    })

    const codegraphCancelHandler = Effect.fn("GlobalHttpApi.codegraphCancel")(function* () {
      const buildService = yield* Effect.serviceOption(Banyan.CodegraphBuildService)
      if (Option.isSome(buildService)) {
        yield* buildService.value.cancel()
      }
      return true
    })

    const codegraphForceKillHandler = Effect.fn("GlobalHttpApi.codegraphForceKill")(function* () {
      const buildService = yield* Effect.serviceOption(Banyan.CodegraphBuildService)
      if (Option.isNone(buildService)) {
        return { ok: false, message: "CodegraphBuildService not available" }
      }
      return yield* buildService.value.forceKill()
    })

    const codegraphRemoveHandler = Effect.fn("GlobalHttpApi.codegraphRemove")(function* (ctx: {
      payload: typeof CodegraphRemoveInput.Type
    }) {
      const repoOpt = yield* Effect.serviceOption(Banyan.CodegraphRepo)
      if (Option.isNone(repoOpt)) {
        yield* Effect.logInfo("BanyanCode is disabled; /global/codegraph-remove returning 503.")
        return yield* Effect.fail(new HttpApiError.ServiceUnavailable())
      }
      const result = yield* repoOpt.value.clearAll(ctx.payload.dropFile ? { dropFile: true } : undefined)
      const response: typeof CodegraphRemoveResult.Type = {
        sizeBefore: result.sizeBefore,
        sizeAfter: result.sizeAfter,
        // `droppedFile` reflects the actual outcome (POSIX unlink succeeds,
        // Windows EBUSY is reported as false), not the caller-requested flag.
        droppedFile: result.droppedFile,
      }
      return response
    })

const codegraphBuildHandler = Effect.fn("GlobalHttpApi.codegraphBuild")(function* (ctx: {
      payload: typeof CodegraphBuildInput.Type
    }) {
      // /global/* routes run without the session-scoped InstanceContextMiddleware,
      // so InstanceRef defaults to undefined here. Read it gracefully so the
      // endpoint works with an explicit `root` body even when no instance is
      // active. Do NOT use InstanceState.context — it Effect.dies on a missing
      // InstanceRef ("InstanceRef not provided"), which escalates to an opaque
      // 500 and the TUI shows "no response from server".
      const inst = yield* InstanceRef
      const root = ctx.payload.root ?? inst?.worktree
      if (!root) {
        return {
          started: false,
          reason: "root is required. Pass it as the `root` field of the request body.",
        }
      }
      // Phase 7 follow-up: per plan, drop arbitrary client-supplied `dbPath`
      // from the build contract. The canonical DB path is derived from the
      // resolved root via WorkspaceIdentity.identityForRoot. If the caller
      // sent a stale `dbPath` we keep it as a diagnostic echo field so
      // existing clients don't break, but the actual storage location is
      // always the canonical one. identityForRoot throws on a missing root
      // path — surface that as an explicit reason, not an opaque 500.
      let identity: Banyan.WorkspaceIdentityInterface
      try {
        identity = Banyan.WorkspaceIdentity.identityForRoot(root)
      } catch (error) {
        return {
          started: false,
          reason: error instanceof Error ? error.message : `invalid root: ${root}`,
        }
      }
      const dbPath = identity.dbPath
      const force = ctx.payload.force ?? false

      // The build kicks off inside an `AppRuntime.runFork` so the work fiber
      // outlives this HTTP request. The returned fiber always resolves (it
      // catches its own errors), so we surface `started: true` once the
      // kickoff has been scheduled — not after the build itself completes
      // (which would block the request for minutes).
      yield* Effect.logInfo("codegraph-build: kickoff received", { root, force })
      AppRuntime.runFork(
        Effect.gen(function* () {
          const buildServiceOpt = yield* Effect.serviceOption(Banyan.CodegraphBuildService)
          if (Option.isNone(buildServiceOpt)) {
            yield* Effect.logWarning(
              "codegraph-build: CodegraphBuildService not in app runtime; check BANYANCODE_ENABLE",
            )
            return
          }
          yield* buildServiceOpt.value.start({ root, force, dbPath }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("codegraph-build: start() failed", { cause: Cause.pretty(cause) }),
            ),
          )
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("codegraph-build: runFork body crashed", { cause: Cause.pretty(cause) }),
          ),
        ),
      )
      return { started: true, root, dbPath, banyanDir: identity.banyanDir }
    })

    const toolUsageHandler = Effect.fn("GlobalHttpApi.toolUsage")(function* () {
      const repoOpt = yield* Effect.serviceOption(Banyan.CodegraphRepo)
      if (Option.isNone(repoOpt)) {
        // BanyanCode is disabled (no CodegraphRepo in the app runtime): the
        // usage table is a BanyanCode concept, so surface an empty list
        // rather than failing the request.
        return { tools: [] } satisfies typeof ToolUsageResult.Type
      }
      const rows = yield* repoOpt.value.listToolUsage()
      return { tools: rows } satisfies typeof ToolUsageResult.Type
    })

    const codegraphStatusHandler = Effect.fn("GlobalHttpApi.codegraphStatus")(function* (ctx: {
      query: { root?: string }
    }) {
      // /global/* routes run without the session-scoped InstanceContextMiddleware,
      // so InstanceRef may be undefined here. Fall back to the current
      // worktree gracefully, mirroring codegraphBuildHandler.
      const inst = yield* InstanceRef
      const root = ctx.query.root ?? inst?.worktree
      if (!root) {
        return yield* Effect.fail(
          new InvalidRequestError({ message: "root is required. Pass it as the `root` query parameter." }),
        )
      }
      // Keep path validation at the HTTP boundary: identityForRoot realpaths
      // the root and throws on empty / non-existent roots. Surface that as a
      // typed 400 with the message instead of an opaque 500.
      let identity: Banyan.WorkspaceIdentityInterface
      try {
        identity = Banyan.WorkspaceIdentity.identityForRoot(root)
      } catch (error) {
        return yield* Effect.fail(
          new InvalidRequestError({ message: error instanceof Error ? error.message : `invalid root: ${root}` }),
        )
      }
      // The persisted graph DB is derived from the EXPLICIT root (realpath
      // hash + installation-channel suffix via WorkspaceIdentity.identityForRoot),
      // NOT from server-start process.cwd() — Database.path() and the identity
      // helper now share one derivation. The status read must bind to that
      // same canonical file, which is only known per request (query param or
      // instance worktree), so the root-bound layer is built SCOPED here rather
      // than provided at the server.ts assembly boundary. The HttpApi AGENTS.md
      // warning against Effect.provide in handlers targets STABLE services
      // that belong at the application/layer boundary; this is a deliberately
      // request-scoped, read-only SQLite open that cannot be hoisted because
      // the root arrives per request.
      //
      // The fresh memo map is REQUIRED: the server runtime threads one global
      // MemoMap (server.ts toWebHandler), and the module-level `layer` /
      // `codegraphRepoLayer` references are shared with the process-wide
      // Database. With the shared map, the first construction (the process DB)
      // gets memoized and this scoped root-bound read would silently reuse it,
      // reporting the cwd-keyed DB's status instead of the requested root's.
      // Layer.buildWithMemoMap with a per-request map forces fresh construction
      // of the root-bound repo; Effect.scoped closes the connection afterwards.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope
          const memoMap = Layer.makeMemoMapUnsafe()
          const context = yield* Layer.buildWithMemoMap(
            Banyan.codegraphRepoLayer.pipe(Layer.provide(Database.layerFromRoot(identity.root))),
            memoMap,
            scope,
          )
          const repo = Context.get(context, Banyan.CodegraphRepo)
          const meta = yield* repo.getMeta()
          const result = statusFromMeta(meta)
          return {
            reason: result.reason,
            autoBuilt: result.autoBuilt,
            ...(result.graphBuiltAt !== undefined ? { graphBuiltAt: result.graphBuiltAt } : {}),
            ...(result.graphVersion !== undefined ? { graphVersion: result.graphVersion } : {}),
            ...(result.graphCoverage !== undefined ? { graphCoverage: result.graphCoverage } : {}),
            ...(result.totalFiles !== undefined ? { totalFiles: result.totalFiles } : {}),
            ...(result.warning !== undefined ? { warning: result.warning } : {}),
            ...(result.error !== undefined ? { error: result.error } : {}),
          }
        }),
      )
    })

    const codegraphNodesHandler = Effect.fn("GlobalHttpApi.codegraphNodes")(function* () {
      const repo = yield* Banyan.CodegraphRepo
      const [nodes, meta] = yield* Effect.all([repo.listAllNodes(), repo.getMeta()])
      const graphMeta = meta
        ? {
            graphBuiltAt: meta.graphBuiltAt,
            graphVersion: meta.graphVersion,
            graphCoverage: meta.graphCoverage,
            totalFiles: meta.totalFiles,
            totalNodes: meta.totalNodes,
            totalEdges: meta.totalEdges,
          }
        : undefined
      return {
        nodes,
        meta: graphMeta,
        total: nodes.length,
      }
    })

    const codegraphEdgesHandler = Effect.fn("GlobalHttpApi.codegraphEdges")(function* (ctx: { query: { nodeID?: string } }) {
      const repo = yield* Banyan.CodegraphRepo
      const nodeID = ctx.query?.nodeID
      if (!nodeID) {
        const allEdges = yield* repo.listAllEdges()
        return { edges: allEdges, total: allEdges.length }
      }
      const [outgoing, incoming] = yield* Effect.all([repo.edgesFrom(nodeID), repo.edgesTo(nodeID)])
      const allEdges = [...outgoing, ...incoming]
      return { edges: allEdges, total: allEdges.length }
    })

    const banyanAgentSaveHandler = Effect.fn("GlobalHttpApi.banyanAgentSave")(function* (ctx: {
      payload: typeof BanyanAgentSaveInput.Type
    }) {
      const fs = yield* FSUtil.Service

      const dir = path.join(Global.Path.banyan.config, "agent")
      yield* fs.ensureDir(dir).pipe(
        Effect.mapError((e) => new InvalidRequestError({ message: String(e) })),
      )

      const safeName = ctx.payload.name.replace(/[^a-zA-Z0-9._-]/g, "")
      if (safeName !== ctx.payload.name || safeName.length === 0) {
        return yield* Effect.fail(
          new InvalidRequestError({
            message: "Invalid agent name. Allowed: letters, digits, '.', '_', '-'.",
          }),
        )
      }
      const filePath = path.join(dir, `${safeName}.md`)
      const resolvedFile = path.resolve(filePath)
      const resolvedDir = path.resolve(dir)
      if (!resolvedFile.startsWith(resolvedDir + path.sep) && resolvedFile !== resolvedDir) {
        return yield* Effect.fail(
          new InvalidRequestError({ message: "Resolved path escapes the agent directory." }),
        )
      }

      const escapeYamlScalar = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`

      // ConfigAgentV1.Info.model is a STRING "providerID/modelID", not an object.
      // Consumers (Provider.parseModel / ModelV2.parse) split on "/" taking the
      // first segment as providerID, so multi-slash modelIDs round-trip.
      const model = ctx.payload.model
      const modelLine = model
        ? `model: ${escapeYamlScalar(model.providerID ? `${model.providerID}/${model.modelID}` : model.modelID)}`
        : null

      // ConfigAgentV1.Info.tools is a Record<tool, boolean>, not an array.
      // ConfigAgentV1.normalize converts { "read": true } into permission allow rules.
      const toolsLine =
        ctx.payload.tools && ctx.payload.tools.length > 0
          ? `tools: { ${ctx.payload.tools.map((tool) => `${escapeYamlScalar(tool)}: true`).join(", ")} }`
          : null

      // ConfigPermissionV1.Info is Union([Action, InputObject]) — a single action
      // string OR a record of key -> rule. A YAML list of strings does NOT decode,
      // so map each requested permission key to an explicit allow rule.
      const permissionLine =
        ctx.payload.permission && ctx.payload.permission.length > 0
          ? `permission: { ${ctx.payload.permission.map((key) => `${escapeYamlScalar(key)}: "allow"`).join(", ")} }`
          : null

      const frontmatter: (string | null)[] = [
        "---",
        `name: ${escapeYamlScalar(safeName)}`,
        `description: ${escapeYamlScalar(ctx.payload.description ?? "")}`,
        `mode: ${escapeYamlScalar(ctx.payload.mode ?? "subagent")}`,
        ctx.payload.hidden !== undefined ? `hidden: ${ctx.payload.hidden}` : null,
        modelLine,
        permissionLine,
        toolsLine,
        "---",
        "",
      ]
      const body: string[] = ctx.payload.prompt
        ? [ctx.payload.prompt]
        : [`# ${safeName}`, "", ctx.payload.description ?? ""]

      const content = [...frontmatter, ...body].filter(Boolean).join("\n")

      yield* fs.writeFileString(filePath, content).pipe(
        Effect.mapError((e) => new InvalidRequestError({ message: String(e) })),
      )

      const configSvc = yield* Config.Service
      yield* configSvc.invalidate()

      const agentSvc = yield* Agent.Service
      yield* agentSvc.invalidate()

      // Emit a config.updated event so the TUI refreshes the agents list immediately.
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: "banyancode.config.updated" as any,
          properties: { scope: "global" },
        },
      })

      return { ok: true as const, filePath }
    })

    const websearchFreeHandler = Effect.fn("GlobalHttpApi.websearchFree")(function* (ctx: {
      payload: typeof WebSearchFreeInput.Type
    }) {
      if (websearchFreeDisabled()) {
        return yield* Effect.fail(
          new InvalidRequestError({ message: "websearch_free is disabled (BANYANCODE_DISABLE_WEBSEARCH=1)" }),
        )
      }

      const http = yield* HttpClient.HttpClient
      const permission = yield* PermissionV2.Service

      const query = ctx.payload.query
      const numResults = ctx.payload.numResults ?? 8
      const region = ctx.payload.region
      const time = ctx.payload.time

      yield* permission.assert({
        action: "websearch_free",
        resources: [query],
        save: ["*"],
        metadata: ctx.payload as unknown as Record<string, unknown>,
        sessionID: "global" as unknown as typeof ctx.payload.query as never,
        agent: undefined,
        source: undefined,
      }).pipe(
        Effect.mapError((error) => new InvalidRequestError({ message: error.message })),
      )

      const url = new URL(WebSearchFreeTool.DDG_URL)
      url.searchParams.set("q", query)
      if (region !== undefined) url.searchParams.set("kl", region)
      else url.searchParams.set("kl", "wt-wt")
      if (time !== undefined) url.searchParams.set("df", time)

      const request = HttpClientRequest.get(url.toString()).pipe(
        HttpClientRequest.setHeader("User-Agent", WebSearchFreeTool.USER_AGENT),
        HttpClientRequest.accept("text/html"),
        HttpClientRequest.setHeader("Accept-Language", "en-US,en;q=0.9"),
      )

      const body = yield* HttpClient.filterStatusOk(http)
        .execute(request)
        .pipe(
          Effect.flatMap((res) => res.text),
          Effect.tapError((error) => Effect.logError("websearch_free http error", { error })),
          Effect.mapError((error) =>
            error instanceof InvalidRequestError
              ? error
              : new InvalidRequestError({ message: error.message }),
          ),
        )
        .pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(25),
            orElse: () => Effect.fail(new InvalidRequestError({ message: "websearch_free request timed out" })),
          }),
        )

      if (Buffer.byteLength(body, "utf8") > WebSearchFreeTool.MAX_RESPONSE_BYTES) {
        return yield* Effect.fail(
          new InvalidRequestError({
            message: `websearch_free response exceeded ${WebSearchFreeTool.MAX_RESPONSE_BYTES} bytes`,
          }),
        )
      }

      const parsed = parseWebSearchFree(body)
      const limited = parsed.slice(0, Math.min(numResults, WebSearchFreeTool.MAX_NUM_RESULTS))

      if (limited.length === 0) {
        return {
          provider: "duckduckgo" as const,
          text: "No search results found. Please try a different query.",
          results: [],
        } satisfies typeof WebSearchFreeTool.Output.Type
      }

      const text = limited.map((r) => `${r.title}\n${r.url}\n${r.snippet}`).join("\n\n")
      return {
        provider: "duckduckgo" as const,
        text,
        results: limited.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
      } satisfies typeof WebSearchFreeTool.Output.Type
    })

    const settleCodeFindHandler = (
      payload: typeof CodeFindInput.Type,
      services: {
        permission: PermissionV2Interface
        repo: CodegraphRepoInterface
        analyzer: CodegraphAnalyzerInterface
        readiness: Banyan.CodegraphReadinessInterface
      },
    ): Effect.Effect<typeof CodeFindTool.Output.Type, InvalidRequestError, never> =>
      Effect.gen(function* () {
        const tool = CodeFindTool.makeCodeFindTool(services)
        const call: ToolCall = {
          type: "tool-call",
          id: randomUUID(),
          name: CodeFindTool.name,
          input: payload as unknown as Record<string, unknown>,
        }
        const ctxTool: ToolNS.Context = {
          sessionID: "global" as ToolNS.Context["sessionID"],
          agent: "global" as ToolNS.Context["agent"],
          assistantMessageID: "global" as ToolNS.Context["assistantMessageID"],
          toolCallID: call.id,
        }
        const settleResult = yield* ToolNS.settle(tool, call, ctxTool).pipe(
          Effect.mapError((err) => new InvalidRequestError({ message: err.message })),
        )
        return (settleResult as { structured: typeof CodeFindTool.Output.Type }).structured
      })

    const settlePreflightHandler = (
      payload: typeof PreflightInput.Type,
      services: {
        permission: PermissionV2Interface
        repo: CodegraphRepoInterface
        analyzer: CodegraphAnalyzerInterface
        intel: RepositoryIntelligenceInterface
        readiness: Banyan.CodegraphReadinessInterface
      },
    ): Effect.Effect<typeof PreflightTool.Output.Type, InvalidRequestError, never> =>
      Effect.gen(function* () {
        const tool = PreflightTool.makePreflightTool(services)
        const call: ToolCall = {
          type: "tool-call",
          id: randomUUID(),
          name: PreflightTool.name,
          input: payload as unknown as Record<string, unknown>,
        }
        const ctxTool: ToolNS.Context = {
          sessionID: "global" as ToolNS.Context["sessionID"],
          agent: "global" as ToolNS.Context["agent"],
          assistantMessageID: "global" as ToolNS.Context["assistantMessageID"],
          toolCallID: call.id,
        }
        const settleResult = yield* ToolNS.settle(tool, call, ctxTool).pipe(
          Effect.mapError((err) => new InvalidRequestError({ message: err.message })),
        )
        return (settleResult as { structured: typeof PreflightTool.Output.Type }).structured
      })

    const settleBlastRadiusHandler = (
      payload: typeof BlastRadiusInput.Type,
      services: {
        permission: PermissionV2Interface
        repo: CodegraphRepoInterface
        analyzer: CodegraphAnalyzerInterface
        intel: RepositoryIntelligenceInterface
        readiness: Banyan.CodegraphReadinessInterface
      },
    ): Effect.Effect<typeof BlastRadiusTool.Output.Type, InvalidRequestError, never> =>
      Effect.gen(function* () {
        const tool = BlastRadiusTool.makeBlastRadiusTool(services)
        const call: ToolCall = {
          type: "tool-call",
          id: randomUUID(),
          name: BlastRadiusTool.name,
          input: payload as unknown as Record<string, unknown>,
        }
        const ctxTool: ToolNS.Context = {
          sessionID: "global" as ToolNS.Context["sessionID"],
          agent: "global" as ToolNS.Context["agent"],
          assistantMessageID: "global" as ToolNS.Context["assistantMessageID"],
          toolCallID: call.id,
        }
        const settleResult = yield* ToolNS.settle(tool, call, ctxTool).pipe(
          Effect.mapError((err) => new InvalidRequestError({ message: err.message })),
        )
        return (settleResult as { structured: typeof BlastRadiusTool.Output.Type }).structured
      })

    const settleSafeRenameHandler = (
      payload: typeof SafeRenameInput.Type,
      services: {
        permission: PermissionV2Interface
        repo: CodegraphRepoInterface
        analyzer: CodegraphAnalyzerInterface
        intel: RepositoryIntelligenceInterface
        planner: EditPlannerInterface
      },
    ): Effect.Effect<typeof SafeRenameTool.Output.Type, InvalidRequestError, never> =>
      Effect.gen(function* () {
        const tool = SafeRenameTool.makeSafeRenameTool(services)
        const call: ToolCall = {
          type: "tool-call",
          id: randomUUID(),
          name: SafeRenameTool.name,
          input: payload as unknown as Record<string, unknown>,
        }
        const ctxTool: ToolNS.Context = {
          sessionID: "global" as ToolNS.Context["sessionID"],
          agent: "global" as ToolNS.Context["agent"],
          assistantMessageID: "global" as ToolNS.Context["assistantMessageID"],
          toolCallID: call.id,
        }
        const settleResult = yield* ToolNS.settle(tool, call, ctxTool).pipe(
          Effect.mapError((err) => new InvalidRequestError({ message: err.message })),
        )
        return (settleResult as { structured: typeof SafeRenameTool.Output.Type }).structured
      })

    const codeFindHandler = Effect.fn("GlobalHttpApi.codeFind")(function* (ctx: {
      payload: typeof CodeFindInput.Type
    }) {
      const repo = yield* Banyan.CodegraphRepo
      const analyzer = yield* Banyan.CodegraphAnalyzer
      const readiness = yield* Banyan.CodegraphReadiness
      const permission = yield* PermissionV2.Service
      return yield* settleCodeFindHandler(ctx.payload, {
        permission: permission as PermissionV2Interface,
        repo: repo as CodegraphRepoInterface,
        analyzer: analyzer as CodegraphAnalyzerInterface,
        readiness,
      })
    })

    const preflightHandler = Effect.fn("GlobalHttpApi.preflight")(function* (ctx: {
      payload: typeof PreflightInput.Type
    }) {
      const repo = yield* Banyan.CodegraphRepo
      const analyzer = yield* Banyan.CodegraphAnalyzer
      const intel = yield* Banyan.RepositoryIntelligence
      const readiness = yield* Banyan.CodegraphReadiness
      const permission = yield* PermissionV2.Service
      return yield* settlePreflightHandler(ctx.payload, {
        permission: permission as PermissionV2Interface,
        repo: repo as CodegraphRepoInterface,
        analyzer: analyzer as CodegraphAnalyzerInterface,
        intel: intel as RepositoryIntelligenceInterface,
        readiness,
      })
    })

    const blastRadiusHandler = Effect.fn("GlobalHttpApi.blastRadius")(function* (ctx: {
      payload: typeof BlastRadiusInput.Type
    }) {
      const repo = yield* Banyan.CodegraphRepo
      const analyzer = yield* Banyan.CodegraphAnalyzer
      const intel = yield* Banyan.RepositoryIntelligence
      const readiness = yield* Banyan.CodegraphReadiness
      const permission = yield* PermissionV2.Service
      return yield* settleBlastRadiusHandler(ctx.payload, {
        permission: permission as PermissionV2Interface,
        repo: repo as CodegraphRepoInterface,
        analyzer: analyzer as CodegraphAnalyzerInterface,
        intel: intel as RepositoryIntelligenceInterface,
        readiness,
      })
    })

    const safeRenameHandler = Effect.fn("GlobalHttpApi.safeRename")(function* (ctx: {
      payload: typeof SafeRenameInput.Type
    }) {
      const repo = yield* Banyan.CodegraphRepo
      const analyzer = yield* Banyan.CodegraphAnalyzer
      const intel = yield* Banyan.RepositoryIntelligence
      const planner = yield* Banyan.EditPlanner
      const permission = yield* PermissionV2.Service
      return yield* settleSafeRenameHandler(ctx.payload, {
        permission: permission as PermissionV2Interface,
        repo: repo as CodegraphRepoInterface,
        analyzer: analyzer as CodegraphAnalyzerInterface,
        intel: intel as RepositoryIntelligenceInterface,
        planner: planner as EditPlannerInterface,
      })
    })

    const meshStatusHandler = Effect.fn("GlobalHttpApi.meshStatus")(function* (ctx: {
      query: { parentSessionID: string }
    }) {
      const opt = yield* Effect.serviceOption(Banyan.MeshCoordinator)
      if (Option.isNone(opt)) {
        return {
          parentSessionID: ctx.query.parentSessionID,
          peers: [],
          pendingMessages: 0,
          recentActivity: [],
        }
      }
      return yield* opt.value.status(ctx.query.parentSessionID as never)
    })

    const typecheckHandler = Effect.fn("GlobalHttpApi.typecheck")(function* (ctx: {
      payload: typeof TypecheckInput.Type
    }) {
      const verifier = yield* Banyan.VerifierService
      const projectRoot = ctx.payload.projectRoot ?? process.cwd()
      const result = yield* verifier.typecheck({
        ...(ctx.payload.path !== undefined ? { path: ctx.payload.path } : {}),
        projectRoot,
        ...(ctx.payload.timeoutMs !== undefined ? { timeoutMs: ctx.payload.timeoutMs } : {}),
      })
      return {
        status: result.status,
        summary: result.summary as Record<string, unknown>,
        durationMs: result.durationMs,
        cacheHit: result.cacheHit,
        ...(result.rawOutput !== undefined ? { rawOutput: result.rawOutput } : {}),
      }
    })

    const testRunHandler = Effect.fn("GlobalHttpApi.testRun")(function* (ctx: {
      payload: typeof TestRunInput.Type
    }) {
      const verifier = yield* Banyan.VerifierService
      const projectRoot = ctx.payload.projectRoot ?? process.cwd()
      const result = yield* verifier.test({
        path: ctx.payload.path,
        projectRoot,
        ...(ctx.payload.framework !== undefined ? { framework: ctx.payload.framework } : {}),
        ...(ctx.payload.timeoutMs !== undefined ? { timeoutMs: ctx.payload.timeoutMs } : {}),
      })
      return {
        status: result.status,
        summary: result.summary as Record<string, unknown>,
        durationMs: result.durationMs,
        cacheHit: result.cacheHit,
        ...(result.rawOutput !== undefined ? { rawOutput: result.rawOutput } : {}),
      }
    })

    const lintHandler = Effect.fn("GlobalHttpApi.lint")(function* (ctx: {
      payload: typeof LintInput.Type
    }) {
      const verifier = yield* Banyan.VerifierService
      const projectRoot = ctx.payload.projectRoot ?? process.cwd()
      const result = yield* verifier.lint({
        ...(ctx.payload.path !== undefined ? { path: ctx.payload.path } : {}),
        projectRoot,
        ...(ctx.payload.timeoutMs !== undefined ? { timeoutMs: ctx.payload.timeoutMs } : {}),
      })
      return {
        status: result.status,
        summary: result.summary as Record<string, unknown>,
        durationMs: result.durationMs,
        cacheHit: result.cacheHit,
        ...(result.rawOutput !== undefined ? { rawOutput: result.rawOutput } : {}),
        command: `bun run lint (target=${result.target})`,
      }
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw)
      .handle("startup", startupHandler)
      .handle("getBanyanConfig", getBanyanConfigHandler)
      .handle("updateBanyanConfig", updateBanyanConfigHandler)
      .handle("updateBanyanAgentOverride", banyanAgentOverrideUpdateHandler)
      .handle("updateBanyanAgentPrompt", banyanAgentPromptUpdateHandler)
      .handle("codegraphCancel", codegraphCancelHandler)
      .handle("codegraphForceKill", codegraphForceKillHandler)
      .handle("codegraphRemove", codegraphRemoveHandler)
      .handle("codegraphBuild", codegraphBuildHandler)
      .handle("codegraphStatus", codegraphStatusHandler)
      .handle("toolUsage", toolUsageHandler)
      .handle("codegraphNodes", codegraphNodesHandler)
      .handle("codegraphEdges", codegraphEdgesHandler)
      .handle("banyanAgentSave", banyanAgentSaveHandler)
      .handle("websearchFree", websearchFreeHandler)
      .handle("codeFind", codeFindHandler)
      .handle("preflight", preflightHandler)
      .handle("blastRadius", blastRadiusHandler)
      .handle("safeRename", safeRenameHandler)
      .handle("meshStatus", meshStatusHandler)
      .handle("typecheck", typecheckHandler)
      .handle("testRun", testRunHandler)
      .handle("lint", lintHandler)
  }),
)
