/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { JevView, summarizeJevParts } from "../../../src/feature-plugins/sidebar/jev"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider } from "../../../src/context/sync"
import { ProjectProvider } from "../../../src/context/project"
import { ExitProvider } from "../../../src/context/exit"
import { ArgsProvider } from "../../../src/context/args"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"

const SESSION_ID = "ses_jev_panel"

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

// Persisted jev_activity part shape, mirroring the fixtures in
// test/component/jev-activity-part.test.tsx (choice/summary are pre-redacted
// bounded strings, never raw prompts).
function jevPart(overrides: Record<string, unknown>) {
  return {
    id: "prt_jev_panel",
    sessionID: SESSION_ID,
    messageID: "msg_jev_assistant",
    type: "jev_activity",
    operationID: "op_jev_panel_1",
    feature: "router",
    status: "completed",
    choice: "allow-choice",
    summary: "routed to the fast path",
    latency: { ms: 240 },
    usage: { input: 12, output: 3, cost: 0.0001 },
    ...overrides,
  }
}

async function renderPanel(parts: ReadonlyArray<unknown>, expectVisible = true): Promise<string> {
  const events = createEventSource()
  const calls = createFetch()
  const config = createTuiResolvedConfig()
  const api = {
    ...createTuiPluginApi({}),
    theme: { current: stubTheme },
  }

  const testSetup = await testRender(
    () => (
      <ExitProvider exit={console.error}>
        <TestTuiContexts>
          <ArgsProvider>
            <KVProvider>
              <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                <ProjectProvider>
                  <SyncProvider>
                    <TuiConfigProvider config={config}>
                      <ThemeProvider mode="dark">
                        <JevView api={api as never} session_id={SESSION_ID} parts={parts} />
                      </ThemeProvider>
                    </TuiConfigProvider>
                  </SyncProvider>
                </ProjectProvider>
              </SDKProvider>
            </KVProvider>
          </ArgsProvider>
        </TestTuiContexts>
      </ExitProvider>
    ),
    { width: 48, height: 30 },
  )
  const capture = () =>
    testSetup
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd()
  await testSetup.renderOnce()
  // Poll until the panel paints (cold first-mount needs extra frames on a
  // loaded host). Absence assertions settle with fixed frames instead of
  // burning the deadline waiting for content that must never appear.
  const deadline = Date.now() + 3000
  let frame = capture()
  if (expectVisible) {
    while (!frame.includes("JEV") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      await testSetup.renderOnce()
      frame = capture()
    }
  } else {
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 20))
      await testSetup.renderOnce()
    }
    frame = capture()
  }
  await testSetup.renderOnce()
  frame = capture()
  testSetup.renderer.destroy()
  return frame
}

test("jev panel renders observed decision counts per feature from persisted parts", async () => {
  const frame = await renderPanel([
    jevPart({ id: "prt_1", operationID: "op_1" }),
    jevPart({ id: "prt_2", operationID: "op_2", status: "failed" }),
    jevPart({ id: "prt_3", operationID: "op_3", feature: "judge", status: "skipped" }),
  ])
  expect(frame).toContain("JEV")
  expect(frame).toContain("3 observed decisions")
  expect(frame).toContain("router")
  expect(frame).toContain("2 observed")
  expect(frame).toContain("1 failed")
  expect(frame).toContain("judge")
  expect(frame).toContain("1 skipped")
})

test("jev panel reports honest cost with known-count coverage, never savings", async () => {
  const frame = await renderPanel([
    jevPart({ id: "prt_1", operationID: "op_1" }),
    jevPart({ id: "prt_2", operationID: "op_2", usage: { input: 5, output: 1 } }),
  ])
  expect(frame).toContain("cost $")
  expect(frame).toContain("1 of 2 known")
  expect(frame).not.toMatch(/sav/i)
})

test("jev panel reports cost n/a when no part carries usage cost", async () => {
  const frame = await renderPanel([jevPart({ id: "prt_1", operationID: "op_1", usage: undefined })])
  expect(frame).toContain("JEV")
  expect(frame).toContain("cost n/a")
})

test("jev panel renders nothing when no persisted parts exist", async () => {
  const frame = await renderPanel([], false)
  expect(frame).not.toContain("JEV")
  expect(frame).not.toContain("observed decisions")
})

test("jev panel ignores parts from other sessions", async () => {
  const frame = await renderPanel([jevPart({ id: "prt_1", operationID: "op_1", sessionID: "ses_other" })], false)
  expect(frame).not.toContain("JEV")
})

test("summarizeJevParts bounds the aggregation window and never surfaces prompt text", () => {
  const parts: Array<unknown> = []
  for (let i = 0; i < 250; i += 1) {
    parts.push(
      jevPart({
        id: `prt_${i}`,
        operationID: `op_${i}`,
        choice: `secret-choice-${i}`,
        summary: `raw prompt leak ${i}`,
      }),
    )
  }
  const summary = summarizeJevParts(parts, SESSION_ID)
  expect(summary.observed).toBe(200)
  const rendered = JSON.stringify(summary)
  expect(rendered).not.toContain("secret-choice-")
  expect(rendered).not.toContain("raw prompt leak")
})

test("jev panel source keeps compact spacing and honest labelling", async () => {
  const source = await Bun.file(new URL("../../../src/feature-plugins/sidebar/jev.tsx", import.meta.url)).text()
  expect(source).toContain("marginTop={0}")
  expect(source).not.toMatch(/marginTop=\{1\}/)
  expect(source).toContain("observed decisions")
  expect(source).not.toMatch(/savings?/i)
})
