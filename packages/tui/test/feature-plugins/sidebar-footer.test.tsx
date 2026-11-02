/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { createStore, produce } from "solid-js/store"
import { SidebarFooter, SidebarOnboarding, SidebarVersion } from "../../src/feature-plugins/sidebar/footer"

function context(options?: {
  dismissed?: boolean
  integrations?: Array<{ connections: unknown[] }>
  dispatched?: string[]
}) {
  const color = RGBA.fromInts(200, 200, 200)
  const [onboarding, setOnboarding] = createStore({ dismissed: options?.dismissed ?? false })
  const location = { directory: "/workspace" }
  return {
    location,
    app: { version: "26.11.0", channel: "test" },
    theme: {
      background: { raised: { high: color } },
      text: {
        base: color,
        muted: color,
        feedback: { success: { base: color }, error: { base: color }, warning: { base: color }, info: { base: color } },
      },
    },
    storage: {
      store: () => [
        onboarding,
        (mutation: (draft: { dismissed: boolean }) => void) => {
          setOnboarding(produce(mutation))
          return Promise.resolve()
        },
      ],
    },
    keymap: {
      dispatch: (id: string) => options?.dispatched?.push(id),
    },
    ui: {
      format: { path: (value: string) => value },
    },
    data: {
      session: {
        get: () => ({ location }),
      },
      location: {
        integration: { list: () => options?.integrations },
        vcs: { info: () => undefined },
      },
    },
  } as unknown as Context
}

async function render(input: Context, height = 22) {
  const app = await testRender(
    () => (
      <box width={38}>
        <SidebarOnboarding context={input} sessionID="session" />
      </box>
    ),
    { width: 38, height },
  )
  await app.renderOnce()
  return app
}

test("sidebar waits for integrations before showing onboarding", async () => {
  const app = await render(context())

  try {
    expect(app.captureCharFrame()).not.toContain("Getting started")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar preserves the compact layout when the onboarding card cannot fit", async () => {
  const app = await render(context({ integrations: [] }), 21)

  try {
    expect(app.captureCharFrame()).not.toContain("Getting started")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar shows onboarding without a connected integration", async () => {
  const app = await render(context({ integrations: [] }))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Getting started")
    expect(frame).toContain("BanyanCode includes free models")
    expect(frame).toContain("Connect provider")
    expect(frame).toContain("/connect")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar hides onboarding after an integration is connected or the card is dismissed", async () => {
  const connected = await render(context({ integrations: [{ connections: [{}] }] }))
  const dismissed = await render(context({ integrations: [], dismissed: true }))

  try {
    expect(connected.captureCharFrame()).not.toContain("Getting started")
    expect(dismissed.captureCharFrame()).not.toContain("Getting started")
  } finally {
    connected.renderer.destroy()
    dismissed.renderer.destroy()
  }
})

test("sidebar onboarding opens integrations and can be dismissed", async () => {
  const dispatched: string[] = []
  const app = await render(context({ integrations: [], dispatched }))

  try {
    const connect = app.renderer.root.findDescendantById("sidebar.footer.getting-started.connect")!
    await app.mockMouse.click(connect.x, connect.y)
    expect(dispatched).toEqual(["provider.connect"])

    const dismiss = app.renderer.root.findDescendantById("sidebar.footer.getting-started.dismiss")!
    await app.mockMouse.click(dismiss.x, dismiss.y)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Getting started")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar footer shows the version instead of a second workspace path", async () => {
  const input = context({ integrations: [], dismissed: true })
  const app = await testRender(
    () => (
      <box width={38}>
        <SidebarFooter context={input} sessionID="session" />
      </box>
    ),
    { width: 38, height: 8 },
  )
  await app.renderOnce()
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("BanyanCode")
    expect(frame).toContain("26.11.0")
    expect(frame).not.toContain("/workspace")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar version line names the running build", async () => {
  const input = context({ integrations: [] })
  const app = await testRender(
    () => (
      <box width={38}>
        <SidebarVersion context={input} />
      </box>
    ),
    { width: 38, height: 2 },
  )
  await app.renderOnce()
  try {
    expect(app.captureCharFrame()).toContain("• BanyanCode 26.11.0")
  } finally {
    app.renderer.destroy()
  }
})
