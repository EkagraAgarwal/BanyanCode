/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import InspectorPendingActions, {
  PendingActionsView,
} from "../../../src/feature-plugins/inspector/pending-actions"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { SDKProvider } from "../../../src/context/sdk"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
import { ArgsProvider } from "../../../src/context/args"
import { ProjectProvider } from "../../../src/context/project"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ExitProvider } from "../../../src/context/exit"
import type { Session } from "@opencode-ai/sdk/v2"

const stubTheme = {
  text: { r: 200, g: 200, b: 200, a: 1 },
  textMuted: { r: 120, g: 120, b: 120, a: 1 },
  primary: { r: 100, g: 200, b: 100, a: 1 },
  secondary: { r: 100, g: 100, b: 200, a: 1 },
  success: { r: 100, g: 200, b: 100, a: 1 },
  error: { r: 200, g: 100, b: 100, a: 1 },
  warning: { r: 200, g: 200, b: 100, a: 1 },
}

function makeSession(id: string): Session {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    directory: "/tmp/test",
    title: `Session ${id}`,
    version: "0.0.0-test",
    time: { created: 0, updated: 0 },
  }
}

test("pending-actions session_inspector slot renders without throwing", async () => {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  let done: () => void
  const ready = new Promise<void>((r) => {
    done = r
  })

  function Inner() {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      slots: {
        register(plugin: any) {
          if (!plugin?.slots?.session_inspector) return () => {}
          void plugin.tui(api, undefined as any, { id: "test" } as any)
          plugin.slots.session_inspector({})
          return () => {}
        },
      },
    }
    onMount(done)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ExitProvider exit={console.error}>
        <ArgsProvider>
          <KVProvider>
            <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
              <ProjectProvider>
                <SyncProvider>
                  <TuiConfigProvider config={config}>
                    <ThemeProvider mode="dark">
                      <Inner />
                    </ThemeProvider>
                  </TuiConfigProvider>
                </SyncProvider>
              </ProjectProvider>
            </SDKProvider>
          </KVProvider>
        </ArgsProvider>
      </ExitProvider>
    </TestTuiContexts>
  ))

  await ready
  await new Promise((r) => setTimeout(r, 200))
  await app.renderOnce()
  try {
    expect(true).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("pending-actions renders a busy session badge without crashing", async () => {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  let ready: () => void = () => {}
  const readyPromise = new Promise<void>((r) => {
    ready = r
  })

  // The original bug threw asynchronously after the badge re-rendered, so a
  // naive await renderOnce() would let the test pass while the runtime
  // crashed in a microtask. Trap any later throw so it actually fails the
  // test rather than surfacing as "unhandled error between tests".
  const trap = installErrorTrap()

  // Renders the PendingActionsView and also captures the api + sync handle so
  // the test can mount a busy session and trigger the totalCount > 0 path.
  function Probe() {
    const sync = useSync()
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
    }
    onMount(() => {
      sync.set("session", [makeSession("ses_busy")])
      sync.set("session_status", "ses_busy", { type: "busy" })
      ready()
    })
    return <PendingActionsView api={api} />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ExitProvider exit={console.error}>
        <ArgsProvider>
          <KVProvider>
            <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
              <ProjectProvider>
                <SyncProvider>
                  <TuiConfigProvider config={config}>
                    <ThemeProvider mode="dark">
                      <Probe />
                    </ThemeProvider>
                  </TuiConfigProvider>
                </SyncProvider>
              </ProjectProvider>
            </SDKProvider>
          </KVProvider>
        </ArgsProvider>
      </ExitProvider>
    </TestTuiContexts>
  ))

  try {
    await readyPromise
    // The bug was: <text>{cond ? <text>...</text> : ""}</text> threw
    // "TextNodeRenderable only accepts strings, TextNodeRenderable instances,
    // or StyledText instances" the moment a busy session populated the badge.
    // After the fix this renderOnce must not throw.
    await app.renderOnce()
    // Flush the Solid scheduler so any reactive effect driven by the setStore
    // calls above gets a chance to run before we look at the trap.
    await new Promise((r) => setTimeout(r, 50))
    await app.renderOnce()
    trap.assertEmpty()
    expect(true).toBe(true)
  } finally {
    app.renderer.destroy()
    trap.dispose()
  }
})

function installErrorTrap() {
  const errors: unknown[] = []
  const onUncaught = (error: Error) => {
    errors.push(error)
  }
  const onRejection = (reason: unknown) => {
    errors.push(reason)
  }
  const onError = (event: ErrorEvent) => {
    errors.push(event.error ?? event.message)
  }
  process.on("uncaughtException", onUncaught)
  process.on("unhandledRejection", onRejection)
  globalThis.addEventListener?.("error", onError)
  return {
    errors,
    assertEmpty() {
      if (errors.length > 0) {
        throw new Error(
          `expected no errors during render, got ${errors.length}: ${errors
            .map((e) => (e instanceof Error ? `${e.message}\n${e.stack}` : String(e)))
            .join("\n\n")}`,
        )
      }
    },
    dispose() {
      process.off("uncaughtException", onUncaught)
      process.off("unhandledRejection", onRejection)
      globalThis.removeEventListener?.("error", onError)
    },
  }
}
