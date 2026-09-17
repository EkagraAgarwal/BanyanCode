/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { mount, wait } from "./sync-fixture"

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

const partFor = (sessionID: string, messageID: string, id: string) => ({
  id,
  sessionID,
  messageID,
  type: "text" as const,
  text: id,
})

describe("tui sync memory bounds", () => {
  test("message store keeps only the 4 most recent sessions", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      for (let i = 1; i <= 5; i++) {
        const sessionID = `ses_evict_${i}`
        emit(global({ id: `evt_msg_${i}`, type: "message.updated", properties: { sessionID, info: messageFor(sessionID, `msg_evict_${i}`) } }))
      }
      await wait(() => Object.keys(sync.data.message).length === 4)

      expect(Object.keys(sync.data.message)).toHaveLength(4)
      expect(sync.data.message.ses_evict_1).toBeUndefined()
      expect(sync.data.message.ses_evict_5).toHaveLength(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("part store caps parts per message at 50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      const sessionID = "ses_part_cap"
      const messageID = "msg_part_cap"
      emit(global({ id: "evt_cap_msg", type: "message.updated", properties: { sessionID, info: messageFor(sessionID, messageID) } }))
      await wait(() => sync.data.message[sessionID]?.length === 1)
      for (let i = 0; i < 60; i++) {
        const id = `prt_cap_${String(i).padStart(2, "0")}`
        emit(
          global({
            id: `evt_cap_part_${i}`,
            type: "message.part.updated",
            properties: { sessionID, time: i, part: partFor(sessionID, messageID, id) },
          }),
        )
      }
      await wait(() => (sync.data.part[messageID]?.length ?? 0) === 50)

      const parts = sync.data.part[messageID]
      expect(parts).toHaveLength(50)
      expect(parts[0]?.id).toBe("prt_cap_10")
    } finally {
      app.renderer.destroy()
    }
  })

  test("session.deleted drops messages and parts", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      const sessionID = "ses_deleted"
      const messageID = "msg_deleted"
      emit(global({ id: "evt_del_msg", type: "message.updated", properties: { sessionID, info: messageFor(sessionID, messageID) } }))
      emit(
        global({
          id: "evt_del_part",
          type: "message.part.updated",
          properties: { sessionID, time: 1, part: partFor(sessionID, messageID, "prt_deleted") },
        }),
      )
      await wait(() => sync.data.part[messageID]?.length === 1)

      emit(global({ id: "evt_del_session", type: "session.deleted", properties: { info: { id: sessionID } } } as any))
      await wait(() => sync.data.message[sessionID] === undefined)

      expect(sync.data.message[sessionID]).toBeUndefined()
      expect(sync.data.part[messageID]).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })
})
