import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { SubagentConsumer, layer } from "../../src/banyancode/subagent-consumer"
import { SubagentBus } from "../../src/banyancode/subagent-bus"
import { MemoryRepo } from "../../src/banyancode/memory-repo"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import type { SubagentMessage } from "../../src/banyancode/types"

process.env.BANYANCODE_ENABLE = "1"

describe("SubagentConsumer", () => {
  test("start returns void", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const mockBus = Layer.succeed(
      SubagentBus.Service,
      SubagentBus.Service.of({
        publish: () => Effect.void,
        subscribe: () => Queue.unbounded<SubagentMessage>(),
        peers: () => Effect.succeed([]),
      }),
    )

    const mockMemory = Layer.succeed(
      MemoryRepo.Service,
      MemoryRepo.Service.of({
        put: () => Effect.void,
        get: () => Effect.succeed(undefined),
        list: () => Effect.succeed([]),
        forget: () => Effect.void,
        search: () => Effect.succeed([]),
        vacuum: () => Effect.succeed(0),
      }),
    )

    const serviceLayer = layer.pipe(
      Layer.provide(mockBus),
      Layer.provide(mockMemory),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const consumer = yield* SubagentConsumer.Service
        const result = yield* consumer.start({
          sessionID: "ses_child" as any,
          agent: "coder",
        })
        expect(result).toBeUndefined()
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer)),
    )
  })
})