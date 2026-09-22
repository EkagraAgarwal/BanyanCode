/** @jsxImportSource @opentui/solid */
/**
 * Regression tests for the bounded sync store (f58aceda43, post-v26.09.6):
 *  1. The retained (viewed) session must never be evicted while subagent
 *     sessions churn events — otherwise the central chat blanks on switch.
 *  2. Eviction must clear fullSyncedSessions so the next session.sync()
 *     re-hydrates instead of early-returning over an empty store forever.
 *  3. An errored messages fetch must not mark the session fully synced.
 *  4. message.removed / message.part.removed for evicted data must not throw
 *     out of the event flush (that aborted the batch and the SSE loop).
 *  5. A throwing subscriber must not kill delivery to other subscribers.
 */
import { describe, expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

const messageFor = (sessionID: string, id: string) => ({
  id,
  sessionID,
  role: "assistant" as const,
  agent: "build",
  modelID: "model",
  providerID: "test",
  mode: "build",
  parentID: `parent_${id}`,
  path: { cwd: "/tmp/opencode", root: "/tmp/opencode" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, completed: 2 },
})

const emitMessage = (emit: (event: GlobalEvent) => void, sessionID: string, messageID: string) =>
  emit(
    global({
      id: `evt_${messageID}`,
      type: "message.updated",
      properties: { sessionID, info: messageFor(sessionID, messageID) },
    }),
  )

describe("tui sync active-session retention", () => {
  test("retained session survives eviction even when coldest by event recency", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      sync.session.retain("ses_active")
      emitMessage(emit, "ses_active", "msg_active")
      await wait(() => sync.data.message.ses_active?.length === 1)

      // Five other sessions stream — the retained one is now the oldest entry.
      for (let i = 2; i <= 6; i++) emitMessage(emit, `ses_${i}`, `msg_${i}`)
      await wait(() => Object.keys(sync.data.message).length === 5)

      expect(sync.data.message.ses_active).toHaveLength(1)
      // 4 non-retained (cap) + 1 retained; coldest non-retained evicted.
      expect(sync.data.message.ses_2).toBeUndefined()
      expect(sync.data.message.ses_6).toHaveLength(1)
      expect(Object.keys(sync.data.message)).toHaveLength(5)
    } finally {
      app.renderer.destroy()
    }
  })

  test("retained session is re-synced after it is evicted on a later visit", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    let version = 1
    const sessionPayload = {
      id: "ses_resync",
      title: "resync",
      time: { created: 0, updated: 0 },
      version: "1.14.42",
      directory,
      project_id: "proj_test",
    }
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === `/session/ses_resync`) return json(sessionPayload)
      if (url.pathname === `/session/ses_resync/message`)
        return json([
          { info: messageFor("ses_resync", `msg_v${version}`), parts: [] },
        ])
      if (url.pathname === `/session/ses_resync/todo`) return json([])
      if (url.pathname === `/session/ses_resync/diff`) return json([])
      if (url.pathname === "/session") return json([sessionPayload])
      return undefined
    }, tmp.path)

    try {
      await sync.session.sync("ses_resync")
      expect(sync.data.message.ses_resync?.[0]?.id).toBe("msg_v1")

      // Not retained: five newer sessions push it out of the 4-slot window.
      for (let i = 2; i <= 6; i++) emitMessage(emit, `ses_${i}`, `msg_${i}`)
      await wait(() => sync.data.message.ses_resync === undefined)
      expect(sync.data.message.ses_resync).toBeUndefined()

      // Re-visiting must re-fetch (pre-fix: fullSyncedSessions blocked this).
      version = 2
      await sync.session.sync("ses_resync")
      expect(sync.data.message.ses_resync?.[0]?.id).toBe("msg_v2")
    } finally {
      app.renderer.destroy()
    }
  })

  test("errored messages fetch does not mark the session fully synced", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    let fail = true
    const sessionPayload = {
      id: "ses_flaky",
      title: "flaky",
      time: { created: 0, updated: 0 },
      version: "1.14.42",
      directory,
      project_id: "proj_test",
    }
    const { app, sync } = await mount((url) => {
      if (url.pathname === `/session/ses_flaky`) return json(sessionPayload)
      if (url.pathname === `/session/ses_flaky/message`)
        return fail
          ? json({}, { status: 500 })
          : json([{ info: messageFor("ses_flaky", "msg_ok"), parts: [] }])
      if (url.pathname === `/session/ses_flaky/todo`) return json([])
      if (url.pathname === `/session/ses_flaky/diff`) return json([])
      return undefined
    }, tmp.path)

    try {
      await sync.session.sync("ses_flaky")
      expect(sync.data.message.ses_flaky ?? []).toHaveLength(0)

      fail = false
      await sync.session.sync("ses_flaky")
      expect(sync.data.message.ses_flaky?.[0]?.id).toBe("msg_ok")
    } finally {
      app.renderer.destroy()
    }
  })

  test("message.removed for an unknown session does not throw or drop later events", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      // Force the elapsed>=16ms path so flush() runs synchronously inside
      // emit — a handler throw would surface as an emit() throw here.
      await Bun.sleep(30)
      expect(() =>
        emit(
          global({
            id: "evt_removed_ghost",
            type: "message.removed",
            properties: { sessionID: "ses_ghost", messageID: "msg_ghost" },
          } as never),
        ),
      ).not.toThrow()

      emitMessage(emit, "ses_after", "msg_after")
      await wait(() => sync.data.message.ses_after?.length === 1)
      expect(sync.data.message.ses_after).toHaveLength(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("message.part.removed for an unknown message does not throw", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      await Bun.sleep(30)
      expect(() =>
        emit(
          global({
            id: "evt_part_ghost",
            type: "message.part.removed",
            properties: {
              sessionID: "ses_ghost",
              messageID: "msg_ghost",
              partID: "prt_ghost",
            },
          } as never),
        ),
      ).not.toThrow()

      emitMessage(emit, "ses_alive", "msg_alive")
      await wait(() => sync.data.message.ses_alive?.length === 1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("a throwing subscriber does not kill delivery to other subscribers", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync, sdk } = await mount(undefined, tmp.path)

    try {
      sdk.event.on("event", () => {
        throw new Error("boom")
      })
      await Bun.sleep(30)

      expect(() => emitMessage(emit, "ses_survive", "msg_survive")).not.toThrow()
      await wait(() => sync.data.message.ses_survive?.length === 1)
      expect(sync.data.message.ses_survive).toHaveLength(1)

      // The stream is still alive for subsequent events.
      expect(() => emitMessage(emit, "ses_next", "msg_next")).not.toThrow()
      await wait(() => sync.data.message.ses_next?.length === 1)
    } finally {
      app.renderer.destroy()
    }
  })
})
