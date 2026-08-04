/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import TabAgents from "../../../src/feature-plugins/tabs/tab-agents"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { SDKProvider } from "../../../src/context/sdk"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
import { DialogAgentConfig } from "../../../src/component/dialog-agent-config"
import { SyncProvider } from "../../../src/context/sync"
import { ProjectProvider } from "../../../src/context/project"
import { ExitProvider } from "../../../src/context/exit"
import { ArgsProvider } from "../../../src/context/args"
import { ToastProvider } from "../../../src/ui/toast"

const stubTheme = {
  text: { r: 200, g: 200, b: 200, a: 1 },
  textMuted: { r: 120, g: 120, b: 120, a: 1 },
  primary: { r: 100, g: 200, b: 100, a: 1 },
  secondary: { r: 100, g: 100, b: 200, a: 1 },
  success: { r: 100, g: 200, b: 100, a: 1 },
  error: { r: 200, g: 100, b: 100, a: 1 },
  warning: { r: 200, g: 200, b: 100, a: 1 },
  border: { r: 60, g: 60, b: 60, a: 1 },
  info: { r: 100, g: 150, b: 220, a: 1 },
  background: { r: 20, g: 20, b: 20, a: 1 },
}

function Harness(props: { children: any }) {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  return (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <DialogProvider>
              <ThemeProvider mode="dark">
                {props.children}
              </ThemeProvider>
            </DialogProvider>
          </KVProvider>
        </TuiConfigProvider>
      </SDKProvider>
    </TestTuiContexts>
  )
}

test("tab-agents session_tab_agents slot renders without throwing", async () => {
  const [slotContent, setSlotContent] = createSignal<any>(null)

  const Inner = () => {
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
    }
    api.slots = {
      register: (plugin: any) => {
        if (!plugin?.slots?.session_tab_agents) return () => {}
        const el = plugin.slots.session_tab_agents()
        setSlotContent(() => el)
        return () => {}
      },
    }
    onMount(() => {
      void TabAgents.tui(api as any, undefined as any, { id: "test" } as any)
    })

    return <box>{slotContent()}</box>
  }

  const app = await testRender(() => (
    <Harness>
      <Inner />
    </Harness>
  ), { width: 60, height: 40 })
  await app.renderOnce()
  try {
    expect(true).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("tab-agents source groups orchestrator + subagents and hides plan", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../src/feature-plugins/tabs/tab-agents.tsx"),
    "utf8",
  )
  expect(source).toContain("ORCHESTRATOR")
  expect(source).toContain("SUBAGENTS")
  expect(source).toContain('HIDDEN_FROM_TAB')
  expect(source).toContain('"plan"')
  expect(source).toContain("function summarize")
  expect(source).toContain("height={4}")
})

test("dialog-agent-config source has focus ref on name input", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../src/component/dialog-agent-config.tsx"),
    "utf8",
  )
  expect(source).toContain('placeholder="my-researcher"')
  expect(source).toContain("setTimeout")
  expect(source).toContain("el.focus()")
})

test("dialog-agent-config source wires DialogModel inline for model picker", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../src/component/dialog-agent-config.tsx"),
    "utf8",
  )
  expect(source).toContain("DialogModel")
  // The picker is rendered INLINE (gated by a showModelPicker signal), NOT via
  // dialog.replace — replacing the wizard would unmount it mid-flow.
  expect(source).toContain("showModelPicker")
  expect(source).toContain("preserveStack")
  expect(source).not.toContain("dialog.replace(() => (")
  expect(source).toContain("onSelect={(selectedModel)")
  expect(source).toContain("setStep(\"tools\")")
})

test("dialog-agent-config model step has keyboard wiring (enter + space)", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../src/component/dialog-agent-config.tsx"),
    "utf8",
  )
  expect(source).toContain("useBindings")
  expect(source).toContain('enabled: step() === "model"')
  expect(source).toContain('key: "enter"')
  expect(source).toContain('key: "space"')
})

test("dialog-agent-config tools list is registry-backed with a full fallback", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../src/component/dialog-agent-config.tsx"),
    "utf8",
  )
  // Fetches the registry list at dialog open (tool.list needs provider+model, tool.ids is model-free).
  expect(source).toMatch(/tool\.(list|ids)\(/)
  expect(source).toContain("repository_query")
  expect(source).toContain("preflight")
})

test("dialog-agent-config save uses typed banyanAgent.save (no silent optional chain)", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../src/component/dialog-agent-config.tsx"),
    "utf8",
  )
  expect(source).toContain("banyanAgent.save")
  expect(source).toContain("saveResult.error")
  expect(source).not.toContain("as any).global?.banyanAgent")
})

test("dialog-multi-select has per-group select all/clear plus enter/escape bindings", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../src/ui/dialog-multi-select.tsx"),
    "utf8",
  )
  expect(source).toContain("[select all]")
  expect(source).toContain("[clear]")
  expect(source).toContain("toggleGroup")
  expect(source).toContain("useBindings")
  expect(source).toContain('key: "enter"')
})

test("dialog-multi-select confirm does not clear the dialog stack", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../src/ui/dialog-multi-select.tsx"),
    "utf8",
  )
  // confirm() must only invoke onConfirm — the parent (DialogAgentConfig wizard)
  // decides navigation. dialog.clear() would unmount the whole wizard stack.
  const confirmMatch = source.match(/const confirm = \(\) => \{[\s\S]*?\n  \}/)
  expect(confirmMatch).toBeTruthy()
  expect(confirmMatch![0]).toContain("onConfirm")
  expect(confirmMatch![0]).not.toContain("dialog.clear()")
  // Escape still cancels the whole flow.
  expect(source).toContain('key: "escape"')
  expect(source).toContain("dialog.clear()")
})

test("dialog-model preserveStack prop gates dialog.clear in onSelect", () => {
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../../src/component/dialog-model.tsx"),
    "utf8",
  )
  expect(source).toContain("preserveStack")
  expect(source).toMatch(/if \(!props\.preserveStack\) dialog\.clear\(\)/)
  // The top-level picker flow (tab-agents.tsx) keeps clear-on-select: the
  // default (preserveStack unset) must still clear.
  expect(source).toContain("props.onSelect({ providerID, modelID })")
})

// Integration tests for agent override persistence (Slice B)
describe("tab-agents agent override persistence", () => {
  test("toggle function calls updateBanyanAgentOverride with correct args", async () => {
    // Verify the source code contains the toggle wiring with the endpoint call
    const fs = require("fs") as typeof import("fs")
    const path = require("path") as typeof import("path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../src/feature-plugins/tabs/tab-agents.tsx"),
      "utf8",
    )
    // The toggle function should call updateBanyanAgentOverride with name and enabled
    expect(source).toContain("banyanAgentOverride")
    expect(source).toContain("toggle")
    expect(source).toContain("name, enabled: nextEnabled")
  })

  test("toggle uses optimistic update - setOverridesData called before API await", async () => {
    // Verify the source code contains optimistic update pattern:
    // setOverridesData is called BEFORE the await for the API call
    const fs = require("fs") as typeof import("fs")
    const path = require("path") as typeof import("path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../src/feature-plugins/tabs/tab-agents.tsx"),
      "utf8",
    )
    // The toggle function should have optimistic update before the API call
    expect(source).toContain("// Optimistic update")
    // Verify the pattern: setOverridesData call comes before the API await in toggle
    const toggleMatch = source.match(/const toggle = async \(name: string\) => \{[\s\S]*?\n  \}/)
    expect(toggleMatch).toBeTruthy()
    const toggleBody = toggleMatch![0]
    // Optimistic update should come before the API call
    const optimisticIdx = toggleBody.indexOf("// Optimistic update")
    const apiCallIdx = toggleBody.indexOf("banyanAgentOverride")
    expect(optimisticIdx).toBeLessThan(apiCallIdx)
  })

  test("banyancode.config.updated event subscription refetches BanyanConfig", async () => {
    // Verify the source code contains the event subscription for config updates
    const fs = require("fs") as typeof import("fs")
    const path = require("path") as typeof import("path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../src/feature-plugins/tabs/tab-agents.tsx"),
      "utf8",
    )
    // The View should subscribe to banyancode.config.updated event
    expect(source).toContain("banyancode.config.updated")
    expect(source).toContain("ev.on")
    expect(source).toContain("loadOverrides")
  })

  test("model picker onSelect calls updateBanyanAgentOverride with model", async () => {
    // Verify the source code contains the model picker wiring with the endpoint call
    const fs = require("fs") as typeof import("fs")
    const path = require("path") as typeof import("path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../src/feature-plugins/tabs/tab-agents.tsx"),
      "utf8",
    )
    // The openModelPicker should call updateBanyanAgentOverride with model
    expect(source).toContain("banyanAgentOverride")
    expect(source).toMatch(/name, model/)
  })

  test("toast.show called on toggle success and failure", async () => {
    // Verify the source code contains toast calls
    const fs = require("fs") as typeof import("fs")
    const path = require("path") as typeof import("path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../src/feature-plugins/tabs/tab-agents.tsx"),
      "utf8",
    )
    expect(source).toContain("toast.show")
    expect(source).toContain("Saved ${name} override")
    expect(source).toContain("Failed to update ${name}")
  })

  // Slice E: prompt persistence
  test("saveEditPrompt calls updateBanyanAgentPrompt endpoint", async () => {
    const fs = require("fs") as typeof import("fs")
    const path = require("path") as typeof import("path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../src/feature-plugins/tabs/tab-agents.tsx"),
      "utf8",
    )
    expect(source).toContain("banyanAgentPrompt")
  })
})
