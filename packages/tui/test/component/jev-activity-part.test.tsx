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

const SESSION_ID = "ses-jev-render"
const USER_ID = "msg-jev-user"
const ASSISTANT_ID = "msg-jev-assistant"

const session = {
  id: SESSION_ID,
  title: "jev activity render",
  time: { created: 0, updated: 0 },
  version: "1.0.0",
  directory,
}

const userMessage = {
  id: USER_ID,
  sessionID: SESSION_ID,
  role: "user",
  agent: "build",
  model: { providerID: "test", modelID: "model" },
  time: { created: 1 },
}

const assistantMessage = {
  id: ASSISTANT_ID,
  sessionID: SESSION_ID,
  role: "assistant",
  time: { created: 2, completed: 3 },
  parentID: USER_ID,
  modelID: "model",
  providerID: "test",
  mode: "build",
  agent: "build",
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

type RenderedMessage = { info: Record<string, unknown>; parts: unknown[] }

// Mounts the real Session route (module-private context provider feeds `use()`)
// with a controlled user + assistant conversation so the assistant branch and
// PART_MAPPING render the injected jev parts.
function Harness(props: { children: any; state: string; messages: RenderedMessage[] }) {
  const config = createTuiResolvedConfig()
  const calls = createFetch(((url: URL) => {
    if (url.pathname === `/session/${SESSION_ID}`) return json(session)
    if (url.pathname === `/session/${SESSION_ID}/message`) return json(props.messages)
    if (url.pathname === `/session/${SESSION_ID}/todo`) return json([])
    if (url.pathname === `/session/${SESSION_ID}/diff`) return json([])
    return undefined
  }) satisfies FetchHandler)
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

// Renders a few extra frames after a positive anchor so absence assertions do
// not race the store hydration.
async function settledFrame(anchor: (frame: string) => boolean) {
  let frame = await waitForFrame(anchor)
  for (let i = 0; i < 3; i++) {
    await Bun.sleep(20)
    await testSetup!.renderOnce()
    frame = testSetup!.captureCharFrame()
  }
  return frame
}

async function renderMessages(messages: RenderedMessage[]) {
  const tmp = await tmpdir()
  tmpCleanup = tmp[Symbol.asyncDispose].bind(tmp)
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ right_sidebar_collapsed: true }))
  testSetup = await testRender(
    () => (
      <Harness state={tmp.path} messages={messages}>
        <Session />
      </Harness>
    ),
    { width: 72, height: 18 },
  )
  return testSetup!
}

function jevPart(overrides: Record<string, unknown>) {
  return {
    id: "prt_jev_render",
    sessionID: SESSION_ID,
    messageID: ASSISTANT_ID,
    type: "jev_activity",
    operationID: "op_jev_render_1",
    feature: "router",
    status: "completed",
    choice: "allow-choice",
    summary: "routed to the fast path",
    latency: { ms: 1500 },
    usage: { input: 12, output: 3 },
    ...overrides,
  }
}

function conversation(parts: { info: Record<string, unknown>; parts: unknown[] }[]) {
  return [
    { info: userMessage, parts: [{ id: "prt_user_text", sessionID: SESSION_ID, messageID: USER_ID, type: "text", text: "hello" }] },
    ...parts,
  ]
}

describe("JevActivityPart render (via real Session)", () => {
  test("a completed jev part renders feature, status, choice and summary under the assistant message", async () => {
    await renderMessages(
      conversation([
        {
          info: assistantMessage,
          parts: [
            { id: "prt_assistant_text", sessionID: SESSION_ID, messageID: ASSISTANT_ID, type: "text", text: "assistant reply" },
            jevPart({}),
          ],
        },
      ]),
    )
    const frame = await waitForFrame((f) => f.includes("Jev · router"))
    expect(frame).toContain("completed")
    expect(frame).toContain("allow-choice")
    expect(frame).toContain("routed to the fast path")
    expect(frame).toContain("assistant reply")
    // Usage line renders as informational token accounting.
    expect(frame).toContain("12↑ 3↓ tok")
    // The jev row sits under the assistant text, not under the user turn.
    const rows = frame.split("\n")
    const textRow = rows.findIndex((row) => row.includes("assistant reply"))
    const jevRow = rows.findIndex((row) => row.includes("Jev · router"))
    expect(textRow).toBeGreaterThanOrEqual(0)
    expect(jevRow).toBeGreaterThan(textRow)
  })

  test("a running jev part renders the spinner line", async () => {
    await renderMessages(
      conversation([
        {
          info: assistantMessage,
          parts: [
            { id: "prt_assistant_text", sessionID: SESSION_ID, messageID: ASSISTANT_ID, type: "text", text: "assistant reply" },
            jevPart({ status: "running", choice: undefined, summary: undefined, latency: undefined, usage: undefined }),
          ],
        },
      ]),
    )
    const frame = await waitForFrame((f) => f.includes("Jev · router"))
    expect(frame).toContain("running")
  })

  test("a jev part on a user message is never rendered", async () => {
    await renderMessages([
      {
        info: userMessage,
        parts: [
          { id: "prt_user_text", sessionID: SESSION_ID, messageID: USER_ID, type: "text", text: "hello" },
          jevPart({ messageID: USER_ID }),
        ],
      },
      {
        info: assistantMessage,
        parts: [{ id: "prt_assistant_text", sessionID: SESSION_ID, messageID: ASSISTANT_ID, type: "text", text: "assistant reply" }],
      },
    ])
    const frame = await settledFrame((f) => f.includes("hello"))
    expect(frame).not.toContain("Jev ·")
    expect(frame).not.toContain("allow-choice")
  })

  test("a malformed jev part fails the runtime guard and renders nothing", async () => {
    await renderMessages(
      conversation([
        {
          info: assistantMessage,
          parts: [
            { id: "prt_assistant_text", sessionID: SESSION_ID, messageID: ASSISTANT_ID, type: "text", text: "assistant reply" },
            jevPart({ operationID: undefined, status: "nonsense" }),
          ],
        },
      ]),
    )
    const frame = await settledFrame((f) => f.includes("assistant reply"))
    expect(frame).not.toContain("Jev ·")
  })
})
