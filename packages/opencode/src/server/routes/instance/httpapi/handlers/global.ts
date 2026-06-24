import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Option, Queue, Schema } from "effect"
import path from "path"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { BanyanAgentSaveInput, BanyanConfigUpdateInput, GlobalUpgradeInput } from "../groups/global"
import { applyEmbeddingModel } from "@/effect/banyancode-bootstrap"
import { applySystemMonitorBridge } from "@/effect/banyancode-system-bridge"
import { Banyan } from "@opencode-ai/core/banyancode"
import { InvalidRequestError } from "../errors"
import { GraphMeta } from "@opencode-ai/core/banyancode/types"

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
      yield* applySystemMonitorBridge
      return true
    })

    const applyEmbeddingModelHandler = Effect.fn("GlobalHttpApi.applyEmbeddingModel")(function* () {
      yield* applySystemMonitorBridge
      yield* applyEmbeddingModel.pipe(
        Effect.mapError((e: unknown) => {
          const err = e as { _tag: string; message: string }
          return new InvalidRequestError({ message: err.message })
        }),
      )
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
      return yield* svc.update(payload.config)
    })

    const codegraphCancelHandler = Effect.fn("GlobalHttpApi.codegraphCancel")(function* () {
      const buildService = yield* Effect.serviceOption(Banyan.CodegraphBuildService)
      if (Option.isSome(buildService)) {
        yield* buildService.value.cancel()
      }
      return true
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
      const frontmatter: (string | null)[] = [
        "---",
        `name: ${escapeYamlScalar(safeName)}`,
        `description: ${escapeYamlScalar(ctx.payload.description ?? "")}`,
        `mode: ${escapeYamlScalar(ctx.payload.mode ?? "subagent")}`,
        ctx.payload.hidden !== undefined ? `hidden: ${ctx.payload.hidden}` : null,
        ctx.payload.model ? `model: ${JSON.stringify(ctx.payload.model)}` : null,
        `permission: [${(ctx.payload.permission ?? []).map(escapeYamlScalar).join(", ")}]`,
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

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw)
      .handle("startup", startupHandler)
      .handle("applyEmbeddingModel", applyEmbeddingModelHandler)
      .handle("getBanyanConfig", getBanyanConfigHandler)
      .handle("updateBanyanConfig", updateBanyanConfigHandler)
      .handle("codegraphCancel", codegraphCancelHandler)
      .handle("codegraphNodes", codegraphNodesHandler)
      .handle("codegraphEdges", codegraphEdgesHandler)
      .handle("banyanAgentSave", banyanAgentSaveHandler)
  }),
)
