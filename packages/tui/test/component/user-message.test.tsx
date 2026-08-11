/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { testRender, useRenderer, type JSX } from "@opentui/solid"
import { Session } from "../../src/routes/session"
import { TestTuiContexts } from "../fixture/tui-environment"
import { ThemeProvider } from "../../src/context/theme"
import { KVProvider } from "../../src/context/kv"
import { TuiConfigProvider } from "../../src/config"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider } from "../../src/context/sync"
import { DataProvider } from "../../src/context/data"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider } from "../../src/context/route"
import { LocalProvider } from "../../src/context/local"
import { ToastProvider } from "../../src/ui/toast"
import { ArgsProvider } from "../../src/context/args"
import { ExitProvider } from "../../src/context/exit"
import { EpilogueProvider } from "../../src/context/epilogue"
import { ClipboardProvider } from "../../src/context/clipboard"
import { PromptStashProvider } from "../../src/component/prompt/stash"
import { DialogProvider } from "../../src/ui/dialog"
import { AutocompleteProvider } from "../../src/context/autocomplete"
import { FrecencyProvider } from "../../src/component/prompt/frecency"
import { PromptHistoryProvider } from "../../src/component/prompt/history"
import { PromptRefProvider } from "../../src/context/prompt"
import { EditorContextProvider } from "../../src/context/editor"
import { CodegraphBuildProvider } from "../../src/component/codegraph-progress"
import { PluginRuntimeProvider, createPluginRuntime } from "../../src/plugin/runtime"
import { createEventSource, createFetch, directory, json, type FetchHandler } from "../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { tmpdir } from "../fixture/fixture"

const SESSION_ID = "ses-user-msg"
const MESSAGE_ID = "msg-user-1"

const session = {
  id: SESSION_ID,
  title: "user message",
  time: { created: 0, updated: 0 },
  version: "1.0.0",
  directory,
}

const userMessage = {
  id: MESSAGE_ID,
  sessionID: SESSION_ID,
  role: "user",
  agent: "build",
  model: { providerID: "test", modelID: "model" },
  time: { created: 1 },
}

// UserMessage (packages/tui/src/routes/session/index.tsx:1451) is only mounted
// inside the Session route, whose context provider (module-private) is what
// feeds `use()`. These tests mount the real exported Session with a controlled
// single-user-message session so the real UserMessage renders, then assert on
// its layout inside the captured char frame.
function Harness(props: { children: any; state: string; parts: any[] }) {
  const config = createTuiResolvedConfig()
  const calls = createFetch((url) => {
    if (url.pathname === `/session/${SESSION_ID}`) return json(session)
    if (url.pathname === `/session/${SESSION_ID}/message`)
      return json([{ info: userMessage, parts: props.parts }])
    if (url.pathname === `/session/${SESSION_ID}/todo`) return json([])
    if (url.pathname === `/session/${SESSION_ID}/diff`) return json([])
    return undefined
  })
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const pluginRuntime = createPluginRuntime()
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))
  return (
    <ExitProvider exit={console.error}>
      <EpilogueProvider set={() => {}}>
        <TestTuiContexts paths={{ state: props.state }}>
          <ClipboardProvider>
            <OpencodeKeymapProvider keymap={keymap}>
              <ArgsProvider>
                <KVProvider>
                  <ToastProvider>
                    <CodegraphBuildProvider>
                      <RouteProvider initialRoute={{ type: "session", sessionID: SESSION_ID }}>
                        <TuiConfigProvider config={config}>
                          <PluginRuntimeProvider value={pluginRuntime}>
                            <SDKProvider
                              url="http://test"
                              directory={directory}
                              events={createEventSource().source}
                              fetch={calls.fetch}
                            >
                              <ProjectProvider>
                                <SyncProvider>
                                  <DataProvider>
                                    <ThemeProvider mode="dark">
                                      <LocalProvider>
                                        <PromptStashProvider>
                                          <DialogProvider>
                                            <AutocompleteProvider>
                                              <FrecencyProvider>
                                                <PromptHistoryProvider>
                                                  <PromptRefProvider>
                                                    <EditorContextProvider>
                                                      {props.children}
                                                    </EditorContextProvider>
                                                  </PromptRefProvider>
                                                </PromptHistoryProvider>
                                              </FrecencyProvider>
                                            </AutocompleteProvider>
                                          </DialogProvider>
                                        </PromptStashProvider>
                                      </LocalProvider>
                                    </ThemeProvider>
                                  </DataProvider>
                                </SyncProvider>
                              </ProjectProvider>
                            </SDKProvider>
                          </PluginRuntimeProvider>
                        </TuiConfigProvider>
                      </RouteProvider>
                    </CodegraphBuildProvider>
                  </ToastProvider>
                </KVProvider>
              </ArgsProvider>
            </OpencodeKeymapProvider>
          </ClipboardProvider>
        </TestTuiContexts>
      </EpilogueProvider>
    </ExitProvider>
  )
}

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined
let tmpCleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  testSetup?.renderer.destroy()
  testSetup = undefined
  await tmpCleanup?.()
  tmpCleanup = undefined
})

async function waitForFrame(predicate: (frame: string) => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let frame = testSetup!.captureCharFrame()
  while (!predicate(frame)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for frame condition\nlast frame:\n${frame}`)
    await Bun.sleep(20)
    await testSetup!.renderOnce()
    frame = testSetup!.captureCharFrame()
  }
  return frame
}

async function renderSession(parts: any[]) {
  const tmp = await tmpdir()
  // KVProvider reads kv.json asynchronously after mount; keep the tmpdir alive
  // (dispose in afterEach) so the async read lands. Collapse the right
  // inspector rail so the chat column is wide and free of side chrome.
  tmpCleanup = tmp[Symbol.asyncDispose].bind(tmp)
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ right_sidebar_collapsed: true }))
  testSetup = await testRender(
    () => (
      <Harness state={tmp.path} parts={parts}>
        <Session />
      </Harness>
    ),
    { width: 72, height: 18 },
  )
  return testSetup!
}

function textPart(text: string, id = "part-user-1") {
  return { id, sessionID: SESSION_ID, messageID: MESSAGE_ID, type: "text", text }
}

describe("UserMessage layout (via real Session)", () => {
  test("single-line text sits one row below the message top, leaving a blank padding row above it", async () => {
    await renderSession([textPart("Hello")])
    const frame = await waitForFrame((f) => f.includes("Hello"))
    const rows = frame.split("\n")
    const textRow = rows.findIndex((row) => row.includes("Hello"))
    const col = rows[textRow].indexOf("Hello")
    expect(textRow).toBeGreaterThan(0)
    // The row directly above the text is the inner box's paddingTop row: it
    // carries the left border char but no content. The pre-fix layout rendered
    // the text flush at the top of the box, so the row above the text was the
    // scroll spacer outside the box (no border char) — this assertion fails
    // against that layout.
    const above = rows[textRow - 1]
    expect(above).toContain("┃")
    expect(above[col]).toBe(" ")
  })

  test("multiline text wraps and keeps every line below the blank padding row", async () => {
    const wrapped = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ")
    await renderSession([textPart(wrapped)])
    const frame = await waitForFrame((f) => f.includes("word0"))
    const rows = frame.split("\n")
    const firstRow = rows.findIndex((row) => row.includes("word0"))
    const col = rows[firstRow].indexOf("word0")
    expect(firstRow).toBeGreaterThan(0)
    const above = rows[firstRow - 1]
    expect(above).toContain("┃")
    expect(above[col]).toBe(" ")
    // wrapped continuation lines follow and are not blank
    const textRows = rows.filter((row) => row.includes("word"))
    expect(textRows.length).toBeGreaterThan(1)
  })

  test("a file part renders its file-chip row below the text", async () => {
    await renderSession([
      textPart("Check this file"),
      {
        id: "part-user-file",
        sessionID: SESSION_ID,
        messageID: MESSAGE_ID,
        type: "file",
        mime: "text/plain",
        filename: "a.ts",
        url: "file:///a.ts",
      },
    ])
    const frame = await waitForFrame((f) => {
      const rows = f.split("\n")
      const textRow = rows.findIndex((row) => row.includes("Check this file"))
      const chipRow = rows.findIndex((row) => row.includes("a.ts"))
      return textRow >= 0 && chipRow > textRow
    })
    const rows = frame.split("\n")
    const textRow = rows.findIndex((row) => row.includes("Check this file"))
    const chipRow = rows.findIndex((row) => row.includes("a.ts"))
    expect(textRow).toBeGreaterThan(0)
    expect(chipRow).toBeGreaterThan(textRow)
  })
})
