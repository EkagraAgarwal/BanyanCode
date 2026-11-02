import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { BanyanConfig } from "../../src/config/index.js"
import { parseJsonc } from "../../src/config/jsonc.js"
import { update } from "../../src/config/writer.js"
import { handlers } from "../../src/mesh/rpc.js"
import { makeMesh } from "../../src/mesh/service.js"
import type { SessionPort } from "../../src/mesh/session-port.js"
import { Storage } from "../../src/storage/index.js"

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

const sessions: SessionPort = {
  list: () => Effect.succeed([]),
  get: () => Effect.succeed(undefined),
  create: (input) => Effect.succeed({ id: `${input.parentID}-${input.agent}` }),
  prompt: () => Effect.void,
  wait: () => Effect.void,
  synthetic: () => Effect.void,
  interrupt: () => Effect.succeed(true),
  context: () => Effect.succeed([]),
}

describe("mesh limits persistence", () => {
  test("limits.set writes banyancode.json and a restart reads it back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "banyancode-mesh-limits-"))
    roots.push(directory)
    const config = BanyanConfig.make({
      directory,
      projectRoot: directory,
      globalDir: directory,
      home: directory,
      env: {},
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* Storage.open({
            projectRoot: directory,
            env: { BANYANCODE_PROJECT_DB_DIR: join(directory, "db") },
          })
          const mesh = yield* makeMesh({ storage, config, sessions })
          const rpc = handlers({
            mesh,
            background: () => Effect.void,
            persist: (patch) => Effect.promise(() => update({ globalDir: directory }, patch)).pipe(Effect.asVoid),
          })
          const rpcContext = { error: () => { throw new Error("unexpected rpc error") } } as never

          const result = yield* rpc["limits.set"]({ maxSubagents: 3, swarmMode: true }, rpcContext)
          expect(result.ok).toBe(true)
          expect(result.limits.maxSubagents).toBe(3)
          expect(result.limits.swarmMode).toBe(true)

          const written = parseJsonc(
            yield* Effect.promise(() => readFile(join(directory, "banyancode.json"), "utf8")),
          )
          expect(written).toEqual({ banyancode_max_subagents: 3, banyancode_swarm_mode: true })

          // A fresh mesh has no in-memory override, so it must read the file.
          const restarted = yield* makeMesh({ storage, config, sessions })
          const limits = yield* restarted.limits()
          expect(limits.maxSubagents).toBe(3)
          expect(limits.swarmMode).toBe(true)
        }),
      ),
    )
  })

  test("an invalid limit is rejected without touching the config file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "banyancode-mesh-limits-"))
    roots.push(directory)
    const config = BanyanConfig.make({
      directory,
      projectRoot: directory,
      globalDir: directory,
      home: directory,
      env: {},
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* Storage.open({
            projectRoot: directory,
            env: { BANYANCODE_PROJECT_DB_DIR: join(directory, "db") },
          })
          const mesh = yield* makeMesh({ storage, config, sessions })
          let writes = 0
          const rpc = handlers({
            mesh,
            background: () => Effect.void,
            persist: () =>
              Effect.sync(() => {
                writes += 1
              }),
          })
          const rpcContext = { error: () => { throw new Error("unexpected rpc error") } } as never
          const result = yield* rpc["limits.set"]({ maxSubagents: 99 }, rpcContext)
          expect(result.ok).toBe(false)
          expect(writes).toBe(0)
        }),
      ),
    )
  })
})
