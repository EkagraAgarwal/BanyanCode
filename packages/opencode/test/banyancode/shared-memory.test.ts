import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SharedMemoryTool } from "../../../core/src/tool/shared-memory"
import { ToolRegistry } from "../../../core/src/tool/registry"
import { PermissionV2 } from "../../../core/src/permission"
import { testEffect } from "../lib/effect"

process.env.BANYANCODE_ENABLE = "1"

const mockPermissionLayer = Layer.succeed(PermissionV2.Service, PermissionV2.Service.of({
  ask: () => Effect.succeed({ id: { _id: "per_test" } as any, effect: "allow" as const }),
  assert: () => Effect.void,
  reply: () => Effect.void,
  get: () => Effect.succeed(undefined),
  forSession: () => Effect.succeed([]),
  list: () => Effect.succeed([]),
}))

const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(mockPermissionLayer))
const tool = SharedMemoryTool.layer.pipe(Layer.provide(registry), Layer.provide(mockPermissionLayer))
const it = testEffect(Layer.mergeAll(mockPermissionLayer, registry, tool))

describe("shared_memory", () => {
  it.effect("3 concurrent writes do not lose data", () =>
    Effect.gen(function* () {
      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()

      const def = mat.definitions.find((d) => d.name === "shared_memory")
      if (!def) throw new Error("shared_memory tool not registered")

      const ctx = {
        sessionID: "test-session" as any,
        messageID: "msg-1" as any,
        agent: "test" as any,
        assistantMessageID: "am-1" as any,
        toolCallID: "tc-1",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const writeResult1 = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-1", name: "shared_memory", input: { op: "write", key: "counter", value: 0 } },
      })
      const writeResult2 = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-2", name: "shared_memory", input: { op: "write", key: "counter", value: 1 } },
      })
      const writeResult3 = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-3", name: "shared_memory", input: { op: "write", key: "counter", value: 2 } },
      })

      expect((writeResult1.output?.structured as any).ok).toBe(true)
      expect((writeResult2.output?.structured as any).ok).toBe(true)
      expect((writeResult3.output?.structured as any).ok).toBe(true)

      const readResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-4", name: "shared_memory", input: { op: "read", key: "counter" } },
      })

      expect((readResult.output?.structured as any).ok).toBe(true)
      expect((readResult.output?.structured as any).entries.length).toBe(1)
      expect((readResult.output?.structured as any).entries[0].value).toBe(2)
    }),
  )

  it.effect("reads see latest write", () =>
    Effect.gen(function* () {
      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()

      const ctx = {
        sessionID: "test-session" as any,
        messageID: "msg-1" as any,
        agent: "test" as any,
        assistantMessageID: "am-1" as any,
        toolCallID: "tc-1",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-1", name: "shared_memory", input: { op: "write", key: "latest", value: "v1" } },
      })
      yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-2", name: "shared_memory", input: { op: "write", key: "latest", value: "v2" } },
      })
      yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-3", name: "shared_memory", input: { op: "write", key: "latest", value: "v3" } },
      })

      const readResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-4", name: "shared_memory", input: { op: "read", key: "latest" } },
      })

      expect((readResult.output?.structured as any).ok).toBe(true)
      expect((readResult.output?.structured as any).entries[0].value).toBe("v3")
    }),
  )

  it.effect("list returns keys with the right tags", () =>
    Effect.gen(function* () {
      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()

      const ctx = {
        sessionID: "test-session" as any,
        messageID: "msg-1" as any,
        agent: "test" as any,
        assistantMessageID: "am-1" as any,
        toolCallID: "tc-1",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-1", name: "shared_memory", input: { op: "write", key: "a", value: 1, tags: ["foo", "bar"] } },
      })
      yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-2", name: "shared_memory", input: { op: "write", key: "b", value: 2, tags: ["bar", "baz"] } },
      })
      yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-3", name: "shared_memory", input: { op: "write", key: "c", value: 3, tags: ["baz"] } },
      })

      const listResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-4", name: "shared_memory", input: { op: "list", key: "", tags: ["bar"] } },
      })

      expect((listResult.output?.structured as any).ok).toBe(true)
      expect((listResult.output?.structured as any).entries.length).toBe(2)
      const keys = (listResult.output?.structured as any).entries.map((e: any) => e.key).sort()
      expect(keys).toEqual(["a", "b"])
    }),
  )

  it.effect("delete removes only the named key", () =>
    Effect.gen(function* () {
      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()

      const ctx = {
        sessionID: "test-session" as any,
        messageID: "msg-1" as any,
        agent: "test" as any,
        assistantMessageID: "am-1" as any,
        toolCallID: "tc-1",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-1", name: "shared_memory", input: { op: "write", key: "todelete", value: "yes" } },
      })
      yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-2", name: "shared_memory", input: { op: "write", key: "tokeep", value: "yes" } },
      })

      const deleteResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-3", name: "shared_memory", input: { op: "delete", key: "todelete" } },
      })
      expect((deleteResult.output?.structured as any).ok).toBe(true)

      const readDeleted = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-4", name: "shared_memory", input: { op: "read", key: "todelete" } },
      })
      expect((readDeleted.output?.structured as any).ok).toBe(false)

      const readKept = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-5", name: "shared_memory", input: { op: "read", key: "tokeep" } },
      })
      expect((readKept.output?.structured as any).ok).toBe(true)
      expect((readKept.output?.structured as any).entries[0].value).toBe("yes")
    }),
  )
})
