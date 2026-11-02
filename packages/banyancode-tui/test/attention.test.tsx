/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Context, SlotClaim } from "@opencode/plugin/tui/context"
import type { JSX } from "solid-js"
import { AttentionStrip } from "../src/components/status/attention"
import BanyanTui from "../src/tui"
import { context, mount, session } from "./harness"

const root = session({ id: "ses_root", title: "root" })

function pending(input: { readonly permissions?: number; readonly forms?: number } = {}) {
  const base = context({ sessions: [root] })
  return {
    ...base,
    data: {
      ...base.data,
      session: {
        ...base.data.session,
        permission: {
          ...base.data.session.permission,
          list: () => Array.from({ length: input.permissions ?? 0 }, (_, index) => ({ id: `perm_${index}` })),
        },
        form: {
          ...base.data.session.form,
          list: (sessionID: string) =>
            sessionID === "global"
              ? []
              : Array.from({ length: input.forms ?? 0 }, (_, index) => ({ id: `form_${index}` })),
        },
      },
    },
  } as unknown as Context
}

test("attention strip counts pending permissions and questions", async () => {
  const app = await mount(
    () => (
      <box width={100}>
        <AttentionStrip context={pending({ permissions: 2, forms: 1 })} sessionID="ses_root" />
      </box>
    ),
    { width: 100, height: 6 },
  )
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("▲ 3 need attention")
    expect(frame).toContain("2 permissions awaiting")
    expect(frame).toContain("1 question awaiting")
  } finally {
    app.renderer.destroy()
  }
})

test("attention strip stays silent without pending requests", async () => {
  const app = await mount(
    () => (
      <box width={100}>
        <AttentionStrip context={pending()} sessionID="ses_root" />
      </box>
    ),
    { width: 100, height: 6 },
  )
  try {
    expect(app.captureCharFrame().trim()).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("the composer-top slot carries attention while the prompt is replaced", async () => {
  const claims: Array<{
    readonly target: string
    readonly render: (input: { readonly sessionID: string }) => JSX.Element
  }> = []
  const base = pending({ permissions: 1 })
  const stub = {
    events: { on: () => () => {} },
    status: async () => {
      throw { type: "rpc.unavailable", message: "stub" }
    },
  }
  const proxy = new Proxy(stub, {
    get: (target, property) => {
      if (property in target) return (target as Record<string | symbol, unknown>)[property]
      if (typeof property !== "string") return undefined
      return async () => {
        throw { type: "rpc.unavailable", message: "stub" }
      }
    },
  })
  const recorded = {
    ...base,
    client: { rpc: () => proxy },
    ui: {
      ...base.ui,
      slot: (claim: SlotClaim) => {
        claims.push({
          target: claim.append ?? claim.prepend ?? claim.before ?? claim.after ?? claim.replace ?? "",
          render: claim.render as (input: { readonly sessionID: string }) => JSX.Element,
        })
        return () => {}
      },
      router: { ...base.ui.router, register: () => () => {} },
    },
    keymap: { ...base.keymap, layer: () => {} },
  } as unknown as Context

  const cleanup = BanyanTui.setup(recorded)
  if (typeof cleanup === "function") void cleanup()

  const composer = claims.filter((claim) => claim.target === "session.composer.top")
  expect(composer.length).toBeGreaterThan(0)

  const frames: string[] = []
  for (const claim of composer) {
    const app = await mount(() => claim.render({ sessionID: "ses_root" }), { width: 100, height: 6 })
    try {
      frames.push(app.captureCharFrame())
    } finally {
      app.renderer.destroy()
    }
  }
  expect(frames.some((frame) => frame.includes("▲ 1 need attention"))).toBe(true)
})
