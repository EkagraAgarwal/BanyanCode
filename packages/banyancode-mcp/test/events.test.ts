import { describe, expect, test } from "bun:test"
import { mapEvent } from "../src/events"

describe("mapEvent", () => {
  test("session.status and session.idle", () => {
    expect(mapEvent({ type: "session.status", data: { sessionID: "ses_1", status: { type: "busy" } } })).toEqual({
      type: "session.status",
      sessionID: "ses_1",
      status: "busy",
    })
    expect(mapEvent({ type: "session.status", data: { sessionID: "ses_1", status: { type: "weird" } } })).toBeUndefined()
    expect(mapEvent({ type: "session.idle", data: { sessionID: "ses_1" } })).toEqual({
      type: "session.idle",
      sessionID: "ses_1",
    })
  })

  test("permission.asked carries a readable title", () => {
    const mapped = mapEvent({
      type: "permission.asked",
      data: { id: "per_1", sessionID: "ses_1", action: "edit", resources: ["src/a.ts"] },
    })
    expect(mapped).toEqual({
      type: "permission.asked",
      sessionID: "ses_1",
      ask: { id: "per_1", action: "edit", resources: ["src/a.ts"], title: "edit src/a.ts" },
    })
  })

  test("permission.asked without an id is ignored", () => {
    expect(
      mapEvent({ type: "permission.asked", data: { sessionID: "ses_1", action: "edit", resources: [] } }),
    ).toBeUndefined()
  })

  test("form.created prefers the first field title and carries metadata.kind", () => {
    const mapped = mapEvent({
      type: "form.created",
      data: {
        form: {
          id: "form_1",
          sessionID: "ses_1",
          title: "Questions",
          metadata: { kind: "question" },
          fields: [{ key: "q0", title: "Which database?", type: "string" }],
        },
      },
    })
    expect(mapped).toEqual({
      type: "form.created",
      sessionID: "ses_1",
      form: { id: "form_1", title: "Which database?", kind: "question" },
    })
  })

  test("form.replied and form.cancelled close the ask", () => {
    expect(mapEvent({ type: "form.replied", data: { id: "form_1", sessionID: "ses_1", answer: {} } })).toEqual({
      type: "form.closed",
      sessionID: "ses_1",
      formID: "form_1",
    })
    expect(mapEvent({ type: "form.cancelled", data: { id: "form_2", sessionID: "ses_1" } })).toEqual({
      type: "form.closed",
      sessionID: "ses_1",
      formID: "form_2",
    })
  })

  test("unknown and malformed events map to nothing", () => {
    expect(mapEvent({ type: "session.updated", data: {} })).toBeUndefined()
    expect(mapEvent({ type: "session.status", data: null })).toBeUndefined()
    expect(mapEvent({ type: "form.created", data: { form: {} } })).toBeUndefined()
  })
})
