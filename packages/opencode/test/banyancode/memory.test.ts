import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { MemoryTools } from "../../../core/src/tool/memory"
import { ToolRegistry } from "../../../core/src/tool/registry"
import { PermissionV2 } from "../../../core/src/permission"
import { Banyan } from "../../../core/src/banyancode"
import { EmbeddingProvider } from "../../../core/src/banyancode/embedding-provider"
import { testEffect } from "../lib/effect"

process.env.BANYANCODE_ENABLE = "1"

let capturedAssertInput: { agent: unknown; sessionID: unknown } | undefined
const mockPermissionLayer = Layer.succeed(PermissionV2.Service, PermissionV2.Service.of({
  ask: () => Effect.succeed({ id: { _id: "per_test" } as any, effect: "allow" as const }),
  assert: (input: any) => {
    capturedAssertInput = { agent: input.agent, sessionID: input.sessionID }
    return Effect.void
  },
  reply: () => Effect.void,
  get: () => Effect.succeed(undefined),
  forSession: () => Effect.succeed([]),
  list: () => Effect.succeed([]),
}))

const mockMemoryEntries: Banyan.MemoryEntry[] = []
const mockRepoLayer = Layer.succeed(Banyan.MemoryRepo, Banyan.MemoryRepo.of({
  put: (entry) => Effect.sync(() => mockMemoryEntries.push(entry as Banyan.MemoryEntry)),
  get: (id: string) => Effect.sync(() => mockMemoryEntries.find((e) => e.id === id)),
  list: (scope: "global" | "session", sessionID?: string) =>
    Effect.sync(() =>
      mockMemoryEntries.filter(
        (e) =>
          e.scope === scope && (scope === "global" || e.sessionID === sessionID),
      ),
    ),
  forget: (id: string) => Effect.sync(() => {
    const idx = mockMemoryEntries.findIndex((e) => e.id === id)
    if (idx >= 0) mockMemoryEntries.splice(idx, 1)
  }),
  search: (scope: "global" | "session", sessionID: string | undefined, key: string) =>
    Effect.sync(() =>
      mockMemoryEntries.filter(
        (e) =>
          e.scope === scope &&
          (scope === "global" || e.sessionID === sessionID) &&
          e.key === key,
      ),
    ),
  vacuum: () =>
    Effect.sync(() => {
      const now = Date.now()
      const before = mockMemoryEntries.length
      const filtered = mockMemoryEntries.filter((e) => !e.expiresAt || e.expiresAt > now)
      mockMemoryEntries.length = 0
      mockMemoryEntries.push(...filtered)
      return before - filtered.length
    }),
  touch: () => Effect.void,
  searchByEmbedding: () => Effect.succeed([]),
}))

const mockEmbeddingProviderLayer = Layer.succeed(
  Banyan.EmbeddingProviderService,
  Banyan.EmbeddingProviderService.of({
    embed: (input: string | string[]) =>
      Effect.fail(new EmbeddingProvider.EmbeddingError({ message: "no embedding model configured" })),
    model: () => undefined,
    setModel: () => Effect.void,
    inputHash: (text: string) => Buffer.from(text).toString("hex"),
    config: () => ({ baseUrl: "https://api.openai.com/v1", apiKey: undefined, dimensions: undefined, batchSize: 64 }),
  }),
)

const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(mockPermissionLayer))
const toolLayer = Layer.mergeAll(
  MemoryTools.locationLayer,
).pipe(
  Layer.provide(registry),
  Layer.provide(mockPermissionLayer),
  Layer.provide(mockRepoLayer),
  Layer.provide(mockEmbeddingProviderLayer),
)

const it = testEffect(Layer.mergeAll(
  mockPermissionLayer,
  registry,
  mockRepoLayer,
  mockEmbeddingProviderLayer,
  toolLayer,
))

const makeCtx = (sessionID = "test-session") => ({
  sessionID: sessionID as any,
  messageID: "msg-1" as any,
  agent: "test" as any,
  assistantMessageID: "am-1" as any,
  toolCallID: "tc-1",
  abort: new AbortController().signal,
  messages: [] as any[],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe("memory tools", () => {
  it.effect("memory_store and memory_recall round-trip", () =>
    Effect.gen(function* () {
      mockMemoryEntries.length = 0
      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const storeResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-1",
          name: "memory_store",
          input: { key: "test-key", value: { hello: "world" }, scope: "global" },
        },
      })
      expect((storeResult.output?.structured as any).id).toBeDefined()
      expect((storeResult.output?.structured as any).createdAt).toBeDefined()

      const recallResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-2",
          name: "memory_recall",
          input: { key: "test-key", scope: "global" },
        },
      })
      expect((recallResult.output?.structured as any).entry).toEqual({ hello: "world" })
    }),
  )

  it.effect("memory_store and memory_recall with session scope", () =>
    Effect.gen(function* () {
      mockMemoryEntries.length = 0
      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const sessionID = "session-123"
      const ctx = makeCtx(sessionID)

      yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-1",
          name: "memory_store",
          input: { key: "session-key", value: "session-value", scope: "session", sessionID },
        },
      })

      const recallResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-2",
          name: "memory_recall",
          input: { key: "session-key", scope: "session", sessionID },
        },
      })
      expect((recallResult.output?.structured as any).entry).toBe("session-value")
    }),
  )

  it.effect("memory_list returns all entries with correct filters", () =>
    Effect.gen(function* () {
      mockMemoryEntries.length = 0
      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      for (let i = 0; i < 5; i++) {
        yield* mat.settle({
          sessionID: ctx.sessionID,
          agent: ctx.agent,
          assistantMessageID: ctx.assistantMessageID,
          call: {
            type: "tool-call",
            id: `call-store-${i}`,
            name: "memory_store",
            input: { key: `key-${i}`, value: i, scope: "global", tags: i % 2 === 0 ? ["even"] : ["odd"] },
          },
        })
      }

      const listResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-list",
          name: "memory_list",
          input: { scope: "global" },
        },
      })
      expect((listResult.output?.structured as any).entries.length).toBe(5)

      const filteredResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-list-even",
          name: "memory_list",
          input: { scope: "global", tags: ["even"] },
        },
      })
      expect((filteredResult.output?.structured as any).entries.length).toBe(3)
    }),
  )

  it.effect("memory_forget deletes entry", () =>
    Effect.gen(function* () {
      mockMemoryEntries.length = 0
      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-store",
          name: "memory_store",
          input: { key: "to-delete", value: "data", scope: "global" },
        },
      })

      const forgetResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-forget",
          name: "memory_forget",
          input: { key: "to-delete", scope: "global" },
        },
      })
      expect((forgetResult.output?.structured as any).ok).toBe(true)

      const recallResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-recall",
          name: "memory_recall",
          input: { key: "to-delete", scope: "global" },
        },
      })
      expect((recallResult.output?.structured as any).entry).toBeNull()
    }),
  )

  it.effect("memory_search with no embedding model returns degraded=true and keyword matches", () =>
    Effect.gen(function* () {
      mockMemoryEntries.length = 0
      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-store",
          name: "memory_store",
          input: { key: "apple banana", value: "fruit facts", context: "food storage", scope: "global" },
        },
      })

      const searchResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-search",
          name: "memory_search",
          input: { query: "banana", scope: "global" },
        },
      })
      expect((searchResult.output?.structured as any).degraded).toBe(true)
      expect((searchResult.output?.structured as any).entries.length).toBe(1)
      expect((searchResult.output?.structured as any).entries[0].key).toBe("apple banana")
    }),
  )

  it.effect("memory_store quota enforcement rejects value > 64KB", () =>
    Effect.gen(function* () {
      mockMemoryEntries.length = 0
      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const largeValue = { data: "x".repeat(70 * 1024) }

      const storeResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-store-large",
          name: "memory_store",
          input: { key: "large", value: largeValue, scope: "global" },
        },
      })

      expect(storeResult.result.type).toBe("error")
      expect(String((storeResult.result as any).value)).toContain("exceeds limit")
    }),
  )

  it.effect("memory_store and vacuum for TTL expiry", () =>
    Effect.gen(function* () {
      mockMemoryEntries.length = 0
      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()
      const now = Date.now()

      mockMemoryEntries.push({
        id: "expired-entry",
        key: "old-key",
        value: "should be deleted",
        tags: [],
        scope: "global",
        createdAt: now - 2000,
        expiresAt: now - 1000,
      })

      mockMemoryEntries.push({
        id: "valid-entry",
        key: "new-key",
        value: "should remain",
        tags: [],
        scope: "global",
        createdAt: now,
        expiresAt: now + 10000,
      })

      const repo = yield* Banyan.MemoryRepo
      const vacuumed = yield* repo.vacuum()
      expect(vacuumed).toBe(1)

      const remaining = mockMemoryEntries.filter((e) => e.key === "new-key")
      expect(remaining.length).toBe(1)
    }),
  )

  it.effect("100 entries round-trip with global and session scopes", () =>
    Effect.gen(function* () {
      mockMemoryEntries.length = 0
      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      for (let i = 0; i < 50; i++) {
        yield* mat.settle({
          sessionID: ctx.sessionID,
          agent: ctx.agent,
          assistantMessageID: ctx.assistantMessageID,
          call: {
            type: "tool-call",
            id: `call-global-${i}`,
            name: "memory_store",
            input: { key: `global-${i}`, value: { index: i }, scope: "global" },
          },
        })
      }

      const sessionID = "session-100"
      for (let i = 0; i < 50; i++) {
        yield* mat.settle({
          sessionID: ctx.sessionID,
          agent: ctx.agent,
          assistantMessageID: ctx.assistantMessageID,
          call: {
            type: "tool-call",
            id: `call-session-${i}`,
            name: "memory_store",
            input: { key: `session-${i}`, value: { index: i }, scope: "session", sessionID },
          },
        })
      }

      const listGlobal = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-list-global",
          name: "memory_list",
          input: { scope: "global" },
        },
      })
      expect((listGlobal.output?.structured as any).entries.length).toBe(50)

      const listSession = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-list-session",
          name: "memory_list",
          input: { scope: "session", sessionID },
        },
      })
      expect((listSession.output?.structured as any).entries.length).toBe(50)
    }),
  )

  it.effect("memory_store passes agent and sessionID to permission.assert", () =>
    Effect.gen(function* () {
      mockMemoryEntries.length = 0
      capturedAssertInput = undefined
      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx("session-123")

      yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-propagate",
          name: "memory_store",
          input: { key: "propagate-test", value: "data", scope: "global" },
        },
      })

      expect(capturedAssertInput).toBeDefined()
      expect(capturedAssertInput!.agent).toBe(ctx.agent)
      expect(capturedAssertInput!.sessionID).toBe(ctx.sessionID)
    }),
  )
})