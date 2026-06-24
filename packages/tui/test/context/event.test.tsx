/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { onCleanup } from "solid-js"
import { ProjectProvider } from "../../src/context/project"
import { SDKProvider } from "../../src/context/sdk"
import { useEvent } from "../../src/context/event"
import { createEventSource, createFetch, directory } from "../fixture/tui-sdk"
import { TestTuiContexts } from "../fixture/tui-environment"

const projectID = "proj_test"

function evt(payload: GlobalEvent["payload"], input: { directory: string; project?: string; workspace?: string }): GlobalEvent {
  return {
    directory: input.directory,
    project: input.project,
    workspace: input.workspace,
    payload,
  } as GlobalEvent
}

async function withSdk(fn: (events: ReturnType<typeof createEventSource>) => Promise<void>) {
  const events = createEventSource()
  const calls = createFetch()

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <box />
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await fn(events)
  } finally {
    app.renderer.destroy()
  }
}

describe("useEvent", () => {
  test("subscribe returns an unlisten function that actually stops delivery", async () => {
    await withSdk(async (events) => {
      const spy = { count: 0 }
      let unlisten: (() => void) | undefined

      const probe = await testRender(() => (
        <TestTuiContexts>
          <SDKProvider url="http://test" directory={directory} events={events.source} fetch={createFetch().fetch}>
            <ProjectProvider>
              <box>
                {(() => {
                  const ev = useEvent()
                  unlisten = ev.subscribe((e: any) => {
                    if (e.type === "session.deleted") spy.count++
                  })
                  return null
                })()}
              </box>
            </ProjectProvider>
          </SDKProvider>
        </TestTuiContexts>
      ))

      events.emit(evt({ type: "session.deleted", properties: { info: { id: "1" } } } as any, { directory, project: projectID }))
      expect(spy.count).toBe(1)

      unlisten!()
      events.emit(evt({ type: "session.deleted", properties: { info: { id: "2" } } } as any, { directory, project: projectID }))
      expect(spy.count).toBe(1)

      probe.renderer.destroy()
    })
  })

  test("on returns an unlisten and unmounting stops delivery", async () => {
    await withSdk(async (events) => {
      const spy = { count: 0 }

      const probe = await testRender(() => (
        <TestTuiContexts>
          <SDKProvider url="http://test" directory={directory} events={events.source} fetch={createFetch().fetch}>
            <ProjectProvider>
              <box>
                {(() => {
                  const ev = useEvent()
                  onCleanup(ev.on("session.deleted", () => spy.count++))
                  return null
                })()}
              </box>
            </ProjectProvider>
          </SDKProvider>
        </TestTuiContexts>
      ))

      events.emit(evt({ type: "session.deleted", properties: { info: { id: "1" } } } as any, { directory, project: projectID }))
      expect(spy.count).toBe(1)

      probe.renderer.destroy()

      events.emit(evt({ type: "session.deleted", properties: { info: { id: "2" } } } as any, { directory, project: projectID }))
      expect(spy.count).toBe(1)
    })
  })

  test("regression: unmounting one subscriber does not affect another", async () => {
    await withSdk(async (events) => {
      const spy1 = { count: 0 }
      const spy2 = { count: 0 }

      const events1 = createEventSource()
      const events2 = createEventSource()

      const probe1 = await testRender(() => (
        <TestTuiContexts>
          <SDKProvider url="http://test" directory={directory} events={events1.source} fetch={createFetch().fetch}>
            <ProjectProvider>
              <box>
                {(() => {
                  const ev = useEvent()
                  onCleanup(ev.on("foo" as any, () => spy1.count++))
                  return null
                })()}
              </box>
            </ProjectProvider>
          </SDKProvider>
        </TestTuiContexts>
      ))

      probe1.renderer.destroy()

      const probe2 = await testRender(() => (
        <TestTuiContexts>
          <SDKProvider url="http://test" directory={directory} events={events2.source} fetch={createFetch().fetch}>
            <ProjectProvider>
              <box>
                {(() => {
                  const ev = useEvent()
                  onCleanup(ev.on("foo" as any, () => spy2.count++))
                  return null
                })()}
              </box>
            </ProjectProvider>
          </SDKProvider>
        </TestTuiContexts>
      ))

      events1.emit(evt({ type: "foo", properties: {} } as any, { directory, project: projectID }))
      events2.emit(evt({ type: "foo", properties: {} } as any, { directory, project: projectID }))
      expect(spy1.count).toBe(0)
      expect(spy2.count).toBe(1)

      probe2.renderer.destroy()
    })
  })
})
