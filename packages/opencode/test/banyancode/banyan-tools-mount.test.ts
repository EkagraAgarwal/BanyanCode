import path from "path"
import { describe, expect, it as bunIt } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { AppProcess } from "@opencode-ai/core/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ToolCatalog } from "@opencode-ai/core/tool/tool-catalog"
import { Banyan } from "@opencode-ai/core/banyancode"
import { BanyanToolsManifest } from "@opencode-ai/core/banyancode/banyan-tools-manifest"
import { Permission } from "@/permission"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { BanyanToolsMount } from "@/effect/banyan-tools-mount"
import { PermissionBridge } from "@/effect/permission-bridge"
import { testEffect } from "../lib/effect"
import { readFileSync } from "fs"

const makeMountTestLayer = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)
  const permissionLayer = Permission.defaultLayer.pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Banyan.banyanConfigServiceDefaultLayer.pipe(Layer.provide(FSUtil.defaultLayer))),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(dbLayer),
  )
  const catalogLayer = Banyan.toolCatalogDefaultLayer.pipe(
    Layer.provide(permissionLayer),
    Layer.provide(dbLayer),
    Layer.provide(FSUtil.defaultLayer),
  )
  const baseInfra = Layer.mergeAll(
    dbLayer,
    FSUtil.defaultLayer,
    Global.defaultLayer,
    EventV2.defaultLayer,
    AppProcess.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    permissionLayer,
  )
  return baseInfra.pipe(
    Layer.provideMerge(BanyanToolsMount.attachToCatalog(catalogLayer)),
    Layer.provideMerge(PermissionBridge.layer.pipe(Layer.provide(permissionLayer))),
  ) as unknown as Layer.Layer<never, never, never>
}

describe("BanyanToolsMount", () => {
  const prev = process.env.BANYANCODE_ENABLE
  process.env.BANYANCODE_ENABLE = "1"

  const dbPath = path.join(
    Global.Path.tmp,
    `banyan-tools-mount-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  )
  const it = testEffect(makeMountTestLayer(dbPath))

  it.effect("registers every BANYAN_PUBLIC_TOOL_IDS entry in the canonical ToolCatalog", () =>
    Effect.gen(function* () {
      const catalog = yield* ToolCatalog.Service
      const listed = yield* catalog.list()
      const materialized = (yield* catalog.materialize()).definitions.map((d) => d.name)
      for (const id of BanyanToolsManifest.BANYAN_PUBLIC_TOOL_IDS) {
        expect(listed.has(id)).toBe(true)
        expect(materialized).toContain(id)
      }
    }) as unknown as Effect.Effect<void, never, Scope.Scope>,
  )

  it.effect("exposes PermissionV2 through the mount's PermissionBridge", () =>
    Effect.gen(function* () {
      const permission = yield* PermissionV2.Service
      const result = yield* permission.ask({
        sessionID: "ses_mount_test" as never,
        action: "codegraph_build",
        resources: ["."],
        save: [],
      })
      expect(result.effect).toBe("allow")
    }) as unknown as Effect.Effect<void, never, Scope.Scope>,
  )

  describe("when Tools.Service is absent", () => {
    const itBare = testEffect(
      Layer.effectDiscard(BanyanToolsMount.registerBanyanTools) as unknown as Layer.Layer<never, never, never>,
    )

    itBare.effect("registerBanyanTools is a no-op without Tools.Service", () =>
      Effect.gen(function* () {
        const catalogOption = yield* Effect.serviceOption(ToolCatalog.Service)
        expect(catalogOption._tag).toBe("None")
      }),
    )
  })

  process.env.BANYANCODE_ENABLE = prev
})

describe("startup assertion", () => {
  const prev = process.env.BANYANCODE_ENABLE
  process.env.BANYANCODE_ENABLE = "1"

  const dbPath = path.join(
    Global.Path.tmp,
    `banyan-tools-mount-negative-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  )

  const makeCatalogOnlyLayer = () => {
    const dbLayer = Database.layerFromPath(dbPath)
    const permissionLayer = Permission.defaultLayer.pipe(
      Layer.provide(EventV2Bridge.defaultLayer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(Banyan.banyanConfigServiceDefaultLayer.pipe(Layer.provide(FSUtil.defaultLayer))),
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(dbLayer),
    )
    const catalogLayer = Banyan.toolCatalogDefaultLayer.pipe(
      Layer.provide(permissionLayer),
      Layer.provide(dbLayer),
      Layer.provide(FSUtil.defaultLayer),
    )
    return Layer.mergeAll(dbLayer, FSUtil.defaultLayer, Global.defaultLayer, permissionLayer).pipe(
      Layer.provideMerge(catalogLayer),
    ) as unknown as Layer.Layer<never, never, never>
  }

  const it = testEffect(makeCatalogOnlyLayer())

  it.effect("dies naming missing tools when registration did not run", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(BanyanToolsMount.registerBanyanTools)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = Cause.prettyErrors(exit.cause)
          .map((error) => error.message)
          .join("\n")
        expect(message).toContain("failed to register")
      }
    }),
  )

  process.env.BANYANCODE_ENABLE = prev
})

describe("createRoutes reachability", () => {
  const prev = process.env.BANYANCODE_ENABLE
  process.env.BANYANCODE_ENABLE = "1"

  const dbPath = path.join(
    Global.Path.tmp,
    `banyan-tools-mount-routes-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  )

  const makeRoutesToolLayer = () => {
    const dbLayer = Database.layerFromPath(dbPath)
    const permissionLayer = Permission.defaultLayer.pipe(
      Layer.provide(EventV2Bridge.defaultLayer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(Banyan.banyanConfigServiceDefaultLayer.pipe(Layer.provide(FSUtil.defaultLayer))),
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(dbLayer),
    )
    const routesCatalog = BanyanToolsMount.attachToCatalog(
      Banyan.toolCatalogDefaultLayer.pipe(
        Layer.provide(Permission.defaultLayer),
        Layer.provide(dbLayer),
        Layer.provide(FSUtil.defaultLayer),
      ),
    ).pipe(
      Layer.provideMerge(PermissionBridge.layer.pipe(Layer.provide(permissionLayer))),
    )
    return Layer.mergeAll(dbLayer, FSUtil.defaultLayer, Global.defaultLayer, permissionLayer).pipe(
      Layer.provideMerge(routesCatalog),
    ) as unknown as Layer.Layer<never, never, never>
  }

  const it = testEffect(makeRoutesToolLayer())

  it.effect("exposes PermissionV2 and every public Banyan tool through the createRoutes catalog stack", () =>
    Effect.gen(function* () {
      yield* PermissionV2.Service
      const catalog = yield* ToolCatalog.Service
      const listed = yield* catalog.list()
      for (const id of BanyanToolsManifest.BANYAN_PUBLIC_TOOL_IDS) {
        expect(listed.has(id)).toBe(true)
      }
    }) as unknown as Effect.Effect<void, never, Scope.Scope>,
  )

  process.env.BANYANCODE_ENABLE = prev
})

describe("runtime composition drift guard", () => {
  bunIt("AppLayer and createRoutes both attach BanyanToolsMount to the tool catalog", () => {
    const appRuntime = readFileSync(path.join(import.meta.dir, "../../src/effect/app-runtime.ts"), "utf8")
    const server = readFileSync(
      path.join(import.meta.dir, "../../src/server/routes/instance/httpapi/server.ts"),
      "utf8",
    )
    expect(appRuntime).toContain("BanyanToolsMount.attachToCatalog")
    expect(server).toContain("BanyanToolsMount.attachToCatalog")
    expect(server).toContain("PermissionBridge.layer")
  })
})
