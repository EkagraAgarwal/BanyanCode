/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { createLive } from "../src/data/live"
import { context } from "./harness"

interface Recorded {
  readonly kind: "method" | "event"
  readonly target: string
}

/**
 * A plugin context whose RPC client records every call and whose location
 * collections record every `sync` (the host fetch that asks the server for a
 * location catalog). Nothing in this fixture is location-aware beyond that.
 */
function recordingContext() {
  const calls: Recorded[] = []
  const synced: string[] = []
  const base = context()
  const rpc = (definition: { readonly id: string }) =>
    new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "events") {
            return new Proxy(
              {},
              {
                get: (_events, event) => () => {
                  calls.push({ kind: "event", target: `${definition.id}.${String(event)}` })
                  return () => {}
                },
              },
            )
          }
          return async () => {
            calls.push({ kind: "method", target: `${definition.id}.${String(property)}` })
            return {}
          }
        },
      },
    )
  const value = {
    ...base,
    location: { directory: "D:/workspace" },
    client: { rpc } as unknown as Context["client"],
    data: {
      ...base.data,
      location: {
        ...base.data.location,
        sync: async (location?: { readonly directory: string }) => {
          synced.push(location?.directory ?? "default")
        },
        agent: {
          ...base.data.location.agent,
          sync: async (location?: { readonly directory: string }) => {
            synced.push(`agent:${location?.directory ?? "default"}`)
          },
        },
        model: {
          ...base.data.location.model,
          sync: async (location?: { readonly directory: string }) => {
            synced.push(`model:${location?.directory ?? "default"}`)
          },
        },
      },
    },
  } as Context
  return { context: value, calls, synced }
}

test("every plugin call names the current location, so the home folder is never activated", async () => {
  const seen: unknown[] = []
  const events = { on: () => () => {}, subscribe: () => [] }
  const rpc = () => new Proxy({}, {
    get: (_target, property) => property === "events" ? events : async (_input: unknown, options: unknown) => {
      seen.push(options)
      return {}
    },
  })
  const value = { ...context(), location: { directory: "D:/workspace" }, client: { rpc } } as unknown as Context
  const live = createLive(value)
  await live.codegraph.refresh()
  expect(seen).toEqual([{ location: { directory: "D:/workspace" } }])
  live.dispose()
})

test("createLive issues no RPC or location fetch at construction", () => {
  const recorded = recordingContext()
  const live = createLive(recorded.context)
  try {
    expect(recorded.calls.filter((call) => call.kind === "method")).toEqual([])
    expect(recorded.synced).toEqual([])
  } finally {
    live.dispose()
  }
})

test("provider usage uses the shipped providerList/providerRefresh RPC names", async () => {
  const recorded = recordingContext()
  const live = createLive(recorded.context)
  try {
    await live.usage.refreshProviders()
    expect(recorded.calls.some((call) => call.target === "banyancode.usage.providerList")).toBe(true)
    await live.usage.refreshProviders(true)
    expect(recorded.calls.some((call) => call.target === "banyancode.usage.providerRefresh")).toBe(true)
  } finally {
    live.dispose()
  }
})

test("mounting home surfaces does not fetch another location's catalog", async () => {
  const recorded = recordingContext()
  const live = createLive(recorded.context)
  const { StatusPills } = await import("../src/components/status/pills")
  const { HomeStrip } = await import("../src/components/home/home-strip")
  const { mount } = await import("./harness")
  const app = await mount(
    () => (
      <box flexDirection="column">
        <StatusPills
          context={recorded.context}
          codegraph={live.codegraph}
          mesh={live.mesh}
          system={live.system}
        />
        <HomeStrip context={recorded.context} codegraph={live.codegraph} />
      </box>
    ),
    { width: 100, height: 20 },
  )
  try {
    await Bun.sleep(30)
    // Only the status row's own two reads, for this location.
    expect(recorded.calls.filter((call) => call.kind === "method").map((call) => call.target).sort()).toEqual([
      "banyancode.codegraph.status",
      "banyancode.mesh.limits.get",
      "banyancode.system.lsp.status",
      "banyancode.system.yolo.get",
    ])
    expect(recorded.synced).toEqual([])
  } finally {
    app.renderer.destroy()
    live.dispose()
  }
})
