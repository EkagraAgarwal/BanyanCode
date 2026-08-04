import { afterEach, beforeAll, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Auth } from "@opencode-ai/core/auth"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Auth as AuthV1 } from "../../src/auth"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

function accountTestLayer(dir: string) {
  return Auth.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provideMerge(EventV2.defaultLayer),
    Layer.provide(
      Global.layerWith({
        data: dir,
        cache: path.join(dir, "cache"),
        config: path.join(dir, "config"),
        state: path.join(dir, "state"),
        tmp: path.join(dir, "tmp"),
        bin: path.join(dir, "bin"),
        log: path.join(dir, "log"),
        repos: path.join(dir, "repos"),
      }),
    ),
  )
}

const it = testEffect(Layer.mergeAll(AuthV1.defaultLayer))

// The V1 auth.json store and the V2 account store (account.json) are
// separate. The V2 catalog decides provider/model availability from the
// account store and only re-evaluates on V2 account events — a V1-only
// credential write left the model picker stale after removal. This test
// proves V1 set/remove mirror into the V2 account store.
describe("Auth V1 credential → V2 account sync", () => {
  const authFile = () => path.join(Global.Path.data, "auth.json")
  let authBackup: string | null = null

  beforeAll(async () => {
    authBackup = (await Bun.file(authFile()).exists()) ? await Bun.file(authFile()).text() : null
  })

  afterEach(async () => {
    if (authBackup === null) await Bun.write(authFile(), "{}").catch(() => {})
    else await Bun.write(authFile(), authBackup)
  })

  it.live(
    "auth.set mirrors into the account store and auth.remove mirrors the removal",
    Effect.acquireRelease(Effect.promise(() => tmpdir()), (tmp) =>
      Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const accounts = yield* Auth.Service
          const auth = yield* AuthV1.Service
          const serviceID = Auth.ServiceID.make("test-provider")

          yield* auth.set("test-provider", { type: "api", key: "sk-test" })
          yield* Effect.yieldNow
          const afterSet = yield* accounts.forService(serviceID).pipe(Effect.orDie)
          expect(afterSet.length).toBe(1)
          expect(afterSet[0].credential).toEqual({ type: "api", key: "sk-test" })

          yield* auth.remove("test-provider")
          yield* Effect.yieldNow
          const afterRemove = yield* accounts.forService(serviceID).pipe(Effect.orDie)
          expect(afterRemove.length).toBe(0)
        }).pipe(
          Effect.scoped,
          Effect.provide(Layer.mergeAll(accountTestLayer(tmp.path))),
        ),
      ),
    ),
  )
})
