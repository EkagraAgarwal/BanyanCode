/**
 * Scope-inheritance + deterministic-id regression tests for the memory /
 * shared-memory / subagent-message tools.
 *
 * Regression (commit 079d46b4e, GLOBAL_WRITE_ALLOWLIST): subagent writes to
 * shared_memory / memory tools landed under the subagent's OWN session id;
 * the parent (build/orchestrator) reads under ITS session id â†’ parent sees
 * nothing. Fix: the tools resolve the ROOT parent session by walking the
 * `session.parent_id` chain and use it as the default sessionID for subagent
 * callers.
 *
 * Also covers the deterministic (hash-based) ids for memory_store /
 * memory_candidate_emit / subagent_message so LLM retries upsert the SAME
 * row instead of duplicating.
 */

import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "path"
import { Effect, Layer } from "effect"
import { ToolCall } from "@opencode-ai/llm"
import { Database } from "@opencode-ai/core/database/database"
import { Banyan } from "@opencode-ai/core/banyancode"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { unwrapMemoryValue } from "@opencode-ai/core/banyancode/memory-payload"
import { Tool } from "../../src/tool/tool"
import { SharedMemoryTool } from "../../src/tool/shared-memory"
import { MemoryTools } from "../../src/tool/memory"
import { MemoryCandidateTool } from "../../src/tool/memory-candidate"
import { SubagentMessageTool } from "../../src/tool/subagent-message"
import { ToolCatalog } from "../../src/tool/tool-catalog"
import { ApplicationTools } from "../../src/tool/application-tools"
import { ToolOutputStore } from "../../src/tool-output-store"
import { PermissionV2 } from "../../src/permission"
import type { Interface as PermissionV2Interface } from "../../src/permission"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

const ROOT = "ses_scope_root"
const CHILD = "ses_scope_child"
const GRANDCHILD = "ses_scope_grandchild"

const mockPermission: PermissionV2Interface = {
  assert: () => Effect.void,
  ask: () => Effect.void,
  reply: () => Effect.void,
  configured: () => Effect.void,
  list: () => Effect.succeed([]),
  get: () => Effect.void,
  forSession: () => Effect.void,
} as unknown as PermissionV2Interface

const makeContext = (sessionID: string, agent = "coder"): Tool.Context => ({
  sessionID: sessionID as Tool.Context["sessionID"],
  agent: agent as Tool.Context["agent"],
  assistantMessageID: `msg_${randomUUID()}` as Tool.Context["assistantMessageID"],
  toolCallID: randomUUID(),
})

const makeCall = (name: string, input: unknown): ToolCall => ({
  type: "tool-call",
  id: randomUUID(),
  name,
  input,
})

const catalogLayer = ToolCatalog.layer.pipe(
  Layer.provide(ApplicationTools.layer),
  Layer.provide(
    Layer.mock(ToolOutputStore.Service, {
      bound: (input) => Effect.sync(() => ({ output: input.output, outputPaths: [] as const })),
    }),
  ),
)

const permissionLayer = Layer.succeed(PermissionV2.Service, mockPermission as never)

const seedSessionChain = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/test"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  for (const [id, parent] of [
    [ROOT, undefined],
    [CHILD, ROOT],
    [GRANDCHILD, CHILD],
  ] as const) {
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make(id),
        project_id: Project.ID.global,
        slug: id,
        directory: "/test",
        title: id,
        version: "test",
        parent_id: parent ? SessionV2.ID.make(parent) : undefined,
      })
      .run()
      .pipe(Effect.orDie)
  }
})

describe("MemoryRepo scope inheritance primitives", () => {
  test("resolveRootSessionID walks the parent chain to the root", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "walk.sqlite"))
    const memoryLayer = Banyan.memoryRepoLayer.pipe(Layer.provide(dbLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedSessionChain
        const repo = yield* Banyan.MemoryRepo

        expect(yield* repo.resolveRootSessionID(GRANDCHILD)).toBe(ROOT)
        expect(yield* repo.resolveRootSessionID(CHILD)).toBe(ROOT)
        expect(yield* repo.resolveRootSessionID(ROOT)).toBe(ROOT)
        // Unknown session: no row â†’ unchanged (never rewritten).
        expect(yield* repo.resolveRootSessionID("ses_unknown")).toBe("ses_unknown")
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("getLatestSessionScoped finds an orphaned child-session row by key", async () => {
    await using tmp = await tmpdir()
    const dbLayer = Database.layerFromPath(path.join(tmp.path, "orphan.sqlite"))
    const memoryLayer = Banyan.memoryRepoLayer.pipe(Layer.provide(dbLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Banyan.MemoryRepo
        // Pre-fix shape: row written under the CHILD session id, id != key.
        yield* repo.put({
          id: "orphan-row-1",
          key: "legacy-note",
          value: { text: "old" },
          tags: [],
          scope: "session",
          sessionID: CHILD,
          createdAt: Date.now(),
        })
        yield* repo.put({
          id: "orphan-row-2",
          key: "legacy-note",
          value: { text: "newer" },
          tags: [],
          scope: "session",
          sessionID: "ses_other_child",
          createdAt: Date.now() + 1000,
        })

        const entry = yield* repo.getLatestSessionScoped("legacy-note")
        expect(entry?.sessionID).toBe("ses_other_child")
        expect(unwrapMemoryValue(entry!.value, "legacy-note").body).toBe(JSON.stringify({ text: "newer" }))
        expect(yield* repo.getLatestSessionScoped("missing-key")).toBeUndefined()
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

describe("shared_memory scope inheritance", () => {
  const buildLayers = (dbPath: string) => {
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer.pipe(Layer.provide(dbLayer))
    const toolLayer = SharedMemoryTool.layer.pipe(
      Layer.provideMerge(catalogLayer),
      Layer.provideMerge(permissionLayer),
      Layer.provideMerge(memoryLayer),
    )
    return { dbLayer, toolLayer }
  }

  test("subagent write lands on the root session and the parent reads/lists it", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "shared.sqlite")
    const { dbLayer, toolLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedSessionChain
        const catalog = yield* ToolCatalog.Service
        const tool = (yield* catalog.list()).get(SharedMemoryTool.name)!

        // Child writes without an explicit sessionID.
        const write = yield* Tool.settle(
          tool,
          makeCall("shared_memory", { op: "write", key: "notes", value: { text: "from child" } }),
          makeContext(CHILD),
        )
        expect((write.structured as { ok: boolean }).ok).toBe(true)

        const repo = yield* Banyan.MemoryRepo
        const underRoot = yield* repo.list("session", ROOT)
        expect(underRoot.length).toBe(1)
        expect(underRoot[0].sessionID).toBe(ROOT)
        expect(underRoot[0].key).toBe("notes")

        // Parent reads by key â†’ finds the row.
        const read = yield* Tool.settle(
          tool,
          makeCall("shared_memory", { op: "read", key: "notes" }),
          makeContext(ROOT, "build"),
        )
        const readStructured = read.structured as { ok: boolean; entries: Array<{ value: unknown }> }
        expect(readStructured.ok).toBe(true)
        expect(unwrapMemoryValue(readStructured.entries[0].value, "notes").body).toBe(
          JSON.stringify({ text: "from child" }),
        )

        // Parent lists under its own session â†’ sees the child's write.
        const list = yield* Tool.settle(
          tool,
          makeCall("shared_memory", { op: "list" }),
          makeContext(ROOT, "build"),
        )
        const listStructured = list.structured as { ok: boolean; entries: Array<{ key: string }> }
        expect(listStructured.ok).toBe(true)
        expect(listStructured.entries.map((e) => e.key)).toContain("notes")
      }).pipe(Effect.provide(toolLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("explicit input.sessionID still wins over the root-session resolution", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "explicit.sqlite")
    const { dbLayer, toolLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedSessionChain
        const catalog = yield* ToolCatalog.Service
        const tool = (yield* catalog.list()).get(SharedMemoryTool.name)!

        yield* Tool.settle(
          tool,
          makeCall("shared_memory", {
            op: "write",
            key: "private",
            value: "child-local",
            sessionID: CHILD,
          }),
          makeContext(CHILD),
        )

        const repo = yield* Banyan.MemoryRepo
        const underChild = yield* repo.list("session", CHILD)
        const underRoot = yield* repo.list("session", ROOT)
        expect(underChild.length).toBe(1)
        expect(underChild[0].key).toBe("private")
        expect(underRoot.length).toBe(0)
      }).pipe(Effect.provide(toolLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("read-by-key falls back to an orphaned child-session row", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "fallback.sqlite")
    const { dbLayer, toolLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedSessionChain
        const repo = yield* Banyan.MemoryRepo
        // Pre-fix orphan: child-scoped row whose id differs from its key.
        yield* repo.put({
          id: "old-row-id",
          key: "legacy-note",
          value: { text: "orphaned" },
          tags: [],
          scope: "session",
          sessionID: CHILD,
          createdAt: Date.now(),
        })

        const catalog = yield* ToolCatalog.Service
        const tool = (yield* catalog.list()).get(SharedMemoryTool.name)!

        const read = yield* Tool.settle(
          tool,
          makeCall("shared_memory", { op: "read", key: "legacy-note" }),
          makeContext(ROOT, "build"),
        )
        const structured = read.structured as { ok: boolean; entries: Array<{ value: unknown }> }
        expect(structured.ok).toBe(true)
        expect(unwrapMemoryValue(structured.entries[0].value, "legacy-note").body).toBe(
          JSON.stringify({ text: "orphaned" }),
        )
      }).pipe(Effect.provide(toolLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

describe("memory_store idempotent retries", () => {
  const buildLayers = (dbPath: string) => {
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer.pipe(Layer.provide(dbLayer))
    const toolLayer = MemoryTools.locationLayer.pipe(
      Layer.provideMerge(catalogLayer),
      Layer.provideMerge(permissionLayer),
      Layer.provideMerge(memoryLayer),
    )
    return { dbLayer, toolLayer }
  }

  test("same payload twice â†’ one row; recall returns it", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "store.sqlite")
    const { dbLayer, toolLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedSessionChain
        const catalog = yield* ToolCatalog.Service
        const store = (yield* catalog.list()).get(MemoryTools.name_store)!
        const recall = (yield* catalog.list()).get(MemoryTools.name_recall)!

        const first = yield* Tool.settle(
          store,
          makeCall("memory_store", { key: "pref", value: { lang: "bun" } }),
          makeContext(CHILD),
        )
        const second = yield* Tool.settle(
          store,
          makeCall("memory_store", { key: "pref", value: { lang: "bun" } }),
          makeContext(CHILD),
        )
        const firstId = (first.structured as { id: string }).id
        const secondId = (second.structured as { id: string }).id
        expect(firstId).toMatch(/^mem:/)
        expect(secondId).toBe(firstId)

        const repo = yield* Banyan.MemoryRepo
        const rows = yield* repo.search("session", ROOT, "pref")
        expect(rows.length).toBe(1)
        expect(rows[0].sessionID).toBe(ROOT)

        const recalled = yield* Tool.settle(
          recall,
          makeCall("memory_recall", { key: "pref", scope: "session" }),
          makeContext(ROOT, "build"),
        )
        expect(
          unwrapMemoryValue((recalled.structured as { entry: unknown }).entry, "pref").body,
        ).toBe(JSON.stringify({ lang: "bun" }))
      }).pipe(Effect.provide(toolLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("same key with different content â†’ new row; recall picks the latest", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "store-diff.sqlite")
    const { dbLayer, toolLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedSessionChain
        const catalog = yield* ToolCatalog.Service
        const store = (yield* catalog.list()).get(MemoryTools.name_store)!
        const recall = (yield* catalog.list()).get(MemoryTools.name_recall)!

        yield* Tool.settle(
          store,
          makeCall("memory_store", { key: "pref", value: { lang: "bun" } }),
          makeContext(CHILD),
        )
        yield* Effect.sleep(5)
        yield* Tool.settle(
          store,
          makeCall("memory_store", { key: "pref", value: { lang: "node" } }),
          makeContext(CHILD),
        )

        const repo = yield* Banyan.MemoryRepo
        expect((yield* repo.search("session", ROOT, "pref")).length).toBe(2)

        const recalled = yield* Tool.settle(
          recall,
          makeCall("memory_recall", { key: "pref", scope: "session" }),
          makeContext(ROOT, "build"),
        )
        expect(
          unwrapMemoryValue((recalled.structured as { entry: unknown }).entry, "pref").body,
        ).toBe(JSON.stringify({ lang: "node" }))
      }).pipe(Effect.provide(toolLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

describe("memory_candidate_emit dedupe", () => {
  const buildLayers = (dbPath: string) => {
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer.pipe(Layer.provide(dbLayer))
    const serviceLayer = Banyan.memoryServiceLayer.pipe(
      Layer.provide(memoryLayer),
      Layer.provide(dbLayer),
    )
    const toolLayer = MemoryCandidateTool.layer.pipe(
      Layer.provideMerge(catalogLayer),
      Layer.provideMerge(permissionLayer),
      Layer.provideMerge(serviceLayer),
      Layer.provideMerge(memoryLayer),
    )
    return { dbLayer, toolLayer }
  }

  test("same candidate twice â†’ one row, emitted under the root session", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "candidate.sqlite")
    const { dbLayer, toolLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedSessionChain
        const catalog = yield* ToolCatalog.Service
        const tool = (yield* catalog.list()).get(MemoryCandidateTool.name)!

        const payload = { kind: "preference", title: "Use Bun", body: "Project runs on Bun." }
        const first = yield* Tool.settle(
          tool,
          makeCall("memory_candidate_emit", { key: "fact:bun", value: payload }),
          makeContext(CHILD),
        )
        const second = yield* Tool.settle(
          tool,
          makeCall("memory_candidate_emit", { key: "fact:bun", value: payload }),
          makeContext(CHILD),
        )
        const firstId = (first.structured as { id: string }).id
        const secondId = (second.structured as { id: string }).id
        expect(firstId).toMatch(/^candidate:/)
        expect(secondId).toBe(firstId)

        const repo = yield* Banyan.MemoryRepo
        const rows = yield* repo.search("session", ROOT, "fact:bun")
        expect(rows.length).toBe(1)
        expect(rows[0].status).toBe("pending")
        expect(rows[0].sessionID).toBe(ROOT)
      }).pipe(Effect.provide(toolLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

describe("subagent_message stable fallback idempotency", () => {
  const buildLayers = (dbPath: string) => {
    const dbLayer = Database.layerFromPath(dbPath)
    const messagesLayer = Banyan.subagentMessagesRepoLayer.pipe(Layer.provide(dbLayer))
    const busLayer = Banyan.subagentBusLayer.pipe(
      Layer.provide(messagesLayer),
      Layer.provide(dbLayer),
    )
    const toolLayer = SubagentMessageTool.layer.pipe(
      Layer.provideMerge(catalogLayer),
      Layer.provideMerge(permissionLayer),
      Layer.provideMerge(busLayer),
      Layer.provideMerge(messagesLayer),
    )
    return { dbLayer, toolLayer }
  }

  test("same logical message twice (no explicit key) â†’ one row", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "mesh.sqlite")
    const { dbLayer, toolLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const catalog = yield* ToolCatalog.Service
        const tool = (yield* catalog.list()).get(SubagentMessageTool.name)!

        const first = yield* Tool.settle(
          tool,
          makeCall("subagent_message", {
            kind: "inform",
            to: "orchestrator",
            payload: { summary: "phase done" },
          }),
          makeContext(ROOT),
        )
        const second = yield* Tool.settle(
          tool,
          makeCall("subagent_message", {
            kind: "inform",
            to: "orchestrator",
            payload: { summary: "phase done" },
          }),
          makeContext(ROOT),
        )
        expect((first.structured as { idempotencyKey: string }).idempotencyKey).toBe(
          (second.structured as { idempotencyKey: string }).idempotencyKey,
        )

        const repo = yield* Banyan.SubagentMessagesRepo
        expect((yield* repo.listPending(ROOT)).length).toBe(1)

        // Same kind/to with a DIFFERENT payload is a different message.
        yield* Tool.settle(
          tool,
          makeCall("subagent_message", {
            kind: "inform",
            to: "orchestrator",
            payload: { summary: "phase two" },
          }),
          makeContext(ROOT),
        )
        expect((yield* repo.listPending(ROOT)).length).toBe(2)
      }).pipe(Effect.provide(toolLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
