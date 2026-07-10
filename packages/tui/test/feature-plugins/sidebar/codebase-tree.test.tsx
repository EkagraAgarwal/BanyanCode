/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import SidebarCodebaseTree from "../../../src/feature-plugins/sidebar/codebase-tree"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { SDKProvider } from "../../../src/context/sdk"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
import { SyncProvider } from "../../../src/context/sync"
import { ProjectProvider } from "../../../src/context/project"
import { ExitProvider } from "../../../src/context/exit"
import { ArgsProvider } from "../../../src/context/args"

const stubTheme = {
  text: { r: 200, g: 200, b: 200, a: 1 },
  textMuted: { r: 120, g: 120, b: 120, a: 1 },
  primary: { r: 100, g: 200, b: 100, a: 1 },
  secondary: { r: 100, g: 100, b: 200, a: 1 },
  success: { r: 100, g: 200, b: 100, a: 1 },
  error: { r: 200, g: 100, b: 100, a: 1 },
  warning: { r: 200, g: 200, b: 100, a: 1 },
  accent: { r: 150, g: 150, b: 150, a: 1 },
  info: { r: 100, g: 100, b: 100, a: 1 },
}

const fixtureTree = {
  path: "/test/workspace",
  name: "workspace",
  kind: "directory" as const,
  children: [
    { path: "/test/workspace/src", name: "src", kind: "directory" as const, children: [
      { path: "/test/workspace/src/index.ts", name: "index.ts", kind: "file" as const },
      { path: "/test/workspace/src/utils.ts", name: "utils.ts", kind: "file" as const },
    ]},
    { path: "/test/workspace/package.json", name: "package.json", kind: "file" as const },
  ],
}

test("sidebar codebase-tree sidebar_content slot renders with tree data", async () => {
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/file/tree") {
      return new Response(JSON.stringify({ data: fixtureTree }), {
        headers: { "content-type": "application/json" },
      })
    }
    return undefined
  })
  const config = createTuiResolvedConfig()
  const [slotContent, setSlotContent] = createSignal<any>(null)

  function Inner() {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      client: {
        file: { tree: async (args: any) => ({ data: fixtureTree }) },
      },
      state: {
        session: { get: () => undefined },
        path: { directory: "/test/workspace" },
        mcp: () => [],
        lsp: () => [],
      },
    }
    api.slots = {
      register: (plugin: any) => {
        if (!plugin?.slots?.sidebar_content) return () => {}
        const el = plugin.slots.sidebar_content({})
        setSlotContent(() => el)
        return () => {}
      },
    }
    onMount(() => {
      SidebarCodebaseTree.tui(api as any, undefined as any, { id: "test" } as any).catch(() => {})
    })
    return <box>{slotContent()}</box>
  }

  const testSetup = await testRender(() => (
    <ExitProvider exit={console.error}>
      <TestTuiContexts>
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
      </TestTuiContexts>
    </ExitProvider>
  ), { width: 40, height: 50 })
  await testSetup.renderOnce()
  await new Promise((r) => setTimeout(r, 0))
  await testSetup.renderOnce()
  const snapshot = testSetup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
  try {
    expect(snapshot).toMatchSnapshot()
  } finally {
    testSetup.renderer.destroy()
  }
})

test("codebase-tree module no longer exports Coming soon fallback", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../src/feature-plugins/sidebar/codebase-tree.tsx"),
    "utf8",
  )
  expect(source).not.toContain("Coming soon")
})
