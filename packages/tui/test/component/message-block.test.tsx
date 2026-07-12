/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { MessageBlock } from "../../src/component/message-block"
import { TestTuiContexts } from "../fixture/tui-environment"
import { ThemeProvider } from "../../src/context/theme"
import { KVProvider } from "../../src/context/kv"
import { TuiConfigProvider } from "../../src/config"
import { SDKProvider } from "../../src/context/sdk"
import { createEventSource, createFetch, directory } from "../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { KeymapProvider } from "@opentui/keymap/solid"

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
  borderSubtle: { r: 80, g: 80, b: 80, a: 1 },
}

const mockKeymap = {
  dispatchCommand: () => {},
} as any

function Harness(props: { children: any }) {
  const config = createTuiResolvedConfig()
  const events = createEventSource()
  const calls = createFetch()
  return (
    <TestTuiContexts>
      <KVProvider>
        <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
          <TuiConfigProvider config={config}>
            <ThemeProvider mode="dark">
              <KeymapProvider keymap={mockKeymap}>
                {props.children}
              </KeymapProvider>
            </ThemeProvider>
          </TuiConfigProvider>
        </SDKProvider>
      </KVProvider>
    </TestTuiContexts>
  )
}

describe("MessageBlock", () => {
  afterEach(() => {})

  test("mode=plan renders plan label", async () => {
    const testSetup = await testRender(() => (
      <Harness>
        <MessageBlock mode="plan" label="Planning next step">
          <text>Plan details here</text>
        </MessageBlock>
      </Harness>
    ), { width: 80, height: 10 })
    await new Promise((r) => setTimeout(r, 100))
    await testSetup.renderOnce()
    const snapshot = testSetup
      .captureCharFrame()
    try {
      expect(snapshot).toMatchSnapshot()
    } finally {
      testSetup.renderer.destroy()
    }
  })

  test("mode=diff with permission link renders approve/reject actions", async () => {
    const testSetup = await testRender(() => (
      <Harness>
        <MessageBlock mode="diff" label="Changes" hasPermissionLink permissionRequestID="req-1">
          <text>Diff content</text>
        </MessageBlock>
      </Harness>
    ), { width: 80, height: 10 })
    await new Promise((r) => setTimeout(r, 100))
    await testSetup.renderOnce()
    const snapshot = testSetup.captureCharFrame()
    try {
      expect(snapshot).toMatchSnapshot()
    } finally {
      testSetup.renderer.destroy()
    }
  })

  test("mode=diff without permission link renders view diff action", async () => {
    const testSetup = await testRender(() => (
      <Harness>
        <MessageBlock mode="diff" label="Changes">
          <text>Diff content</text>
        </MessageBlock>
      </Harness>
    ), { width: 80, height: 10 })
    await new Promise((r) => setTimeout(r, 100))
    await testSetup.renderOnce()
    const snapshot = testSetup.captureCharFrame()
    try {
      expect(snapshot).toMatchSnapshot()
    } finally {
      testSetup.renderer.destroy()
    }
  })

  test("mode=tool renders tool label", async () => {
    const testSetup = await testRender(() => (
      <Harness>
        <MessageBlock mode="tool" label="Tool: bash">
          <text>Tool output</text>
        </MessageBlock>
      </Harness>
    ), { width: 80, height: 10 })
    await new Promise((r) => setTimeout(r, 100))
    await testSetup.renderOnce()
    const snapshot = testSetup.captureCharFrame()
    try {
      expect(snapshot).toMatchSnapshot()
    } finally {
      testSetup.renderer.destroy()
    }
  })

  test("mode=tool compact renders a tight single-line label and content", async () => {
    const testSetup = await testRender(() => (
      <Harness>
        <box flexDirection="column">
          <MessageBlock mode="tool" label="TOOL · Shell · ls" compact>
            <text>$ ls</text>
            <text>file.ts</text>
          </MessageBlock>
        </box>
      </Harness>
    ), { width: 80, height: 8 })
    await new Promise((r) => setTimeout(r, 100))
    await testSetup.renderOnce()
    const snapshot = testSetup.captureCharFrame()
    try {
      expect(snapshot).toMatchSnapshot()
    } finally {
      testSetup.renderer.destroy()
    }
  })
})
