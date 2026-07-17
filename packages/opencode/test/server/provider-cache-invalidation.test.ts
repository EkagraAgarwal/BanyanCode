import { afterEach, describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Auth } from "../../src/auth"
import { Provider } from "../../src/provider/provider"
import { Config } from "@/config/config"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstancesEffect } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Auth.defaultLayer, Provider.defaultLayer, Config.defaultLayer, node))

afterEach(async () => {
  await InstanceRuntime.disposeAllInstances()
  await resetDatabase()
  const authFile = path.join(Global.Path.data, "auth.json")
  await Bun.write(authFile, "{}").catch(() => {})
})

describe("provider cache invalidation on auth change", () => {
  it.instance(
    "Auth.set alone does not refresh the Provider cache (reproduces the bug)",
    () =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const provider = yield* Provider.Service

        const before = yield* provider.list()
        expect(Object.keys(before)).not.toContain("openai")

        yield* auth.set("openai", { type: "api", key: "sk-regression-key" })

        const after = yield* provider.list()
        expect(Object.keys(after)).not.toContain("openai")
      }),
    { git: false },
    30000,
  )

  it.instance(
    "disposing the instance causes the next Provider.list to read fresh auth (proves the fix path)",
    () =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const provider = yield* Provider.Service

        const baseline = yield* provider.list()
        expect(Object.keys(baseline)).not.toContain("openai")

        yield* auth.set("openai", { type: "api", key: "sk-regression-key" })

        const stale = yield* provider.list()
        expect(Object.keys(stale)).not.toContain("openai")

        yield* disposeAllInstancesEffect

        const fresh = yield* provider.list()
        expect(Object.keys(fresh)).toContain("openai")
      }),
    { git: false },
    30000,
  )
})