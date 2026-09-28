/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { testRender, useRenderer } from "@opentui/solid"
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

const SESSION_ID = "ses-jev-run"
const USER_ID = "msg-jev-run-user"
const ASSISTANT_ID = "msg-jev-run-assistant"

const session = {
  id: SESSION_ID,
  title: "jev run ledger render",
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
// PART_MAPPING render the injected jev_run parts.
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

async function renderMessages(messages: RenderedMessage[], height = 18) {
  const tmp = await tmpdir()
  tmpCleanup = tmp[Symbol.asyncDispose].bind(tmp)
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ right_sidebar_collapsed: true }))
  testSetup = await testRender(
    () => (
      <Harness state={tmp.path} messages={messages}>
        <Session />
      </Harness>
    ),
    { width: 72, height },
  )
  return testSetup!
}

function runPart(overrides: Record<string, unknown>) {
  return {
    id: "prt_jev_run",
    sessionID: SESSION_ID,
    messageID: ASSISTANT_ID,
    type: "jev_run",
    runID: "run_1",
    status: "running",
    nodes: [
      { nodeID: "n1", actionID: "repository_query", target: "explorer topic", status: "done" },
      { nodeID: "n2", parentID: "n1", actionID: "read", target: "src/a.ts", status: "done" },
    ],
    ...overrides,
  }
}

function conversation(parts: RenderedMessage[]) {
  return [
    {
      info: userMessage,
      parts: [{ id: "prt_user_text", sessionID: SESSION_ID, messageID: USER_ID, type: "text", text: "hello" }],
    },
    ...parts,
  ]
}

function assistant(parts: unknown[]): RenderedMessage {
  return {
    info: assistantMessage,
    parts: [
      { id: "prt_assistant_text", sessionID: SESSION_ID, messageID: ASSISTANT_ID, type: "text", text: "assistant reply" },
      ...parts,
    ],
  }
}

describe("JevRunTree render (via real Session)", () => {
  test("a running run ledger renders the header with node count and its tree under the assistant message", async () => {
    await renderMessages(conversation([assistant([runPart({})])]))
    const frame = await waitForFrame((f) => f.includes("Jev · explore-tree"))
    expect(frame).toContain("running")
    expect(frame).toContain("2 nodes")
    expect(frame).toContain("repository_query")
    expect(frame).toContain("explorer topic")
    const rows = frame.split("\n")
    const textRow = rows.findIndex((row) => row.includes("assistant reply"))
    const headerRow = rows.findIndex((row) => row.includes("Jev · explore-tree"))
    expect(textRow).toBeGreaterThanOrEqual(0)
    expect(headerRow).toBeGreaterThan(textRow)
  })

  test("a completed ledger renders child indentation, evidence, confidence, latency, usage and stopReason", async () => {
    await renderMessages(
      conversation([
        assistant([
          runPart({
            id: "prt_jev_run_done",
            status: "completed",
            nodes: [
              {
                nodeID: "n1",
                actionID: "repository_query",
                target: "explorer topic",
                status: "done",
                confidence: 0.87,
                latencyMs: 300,
                evidence: [{ path: "src/a.ts", lines: "10-12", excerpt: "export const JevRunTree" }],
              },
              { nodeID: "n2", parentID: "n1", actionID: "read", target: "src/b.ts", status: "failed" },
            ],
            stopReason: "budget exhausted",
            usage: { input: 120, output: 40, cost: 0.0012 },
          }),
        ]),
      ]),
    )
    const frame = await waitForFrame((f) => f.includes("Jev · explore-tree"))
    expect(frame).toContain("completed")
    expect(frame).toContain("2 nodes")
    expect(frame).toContain("repository_query")
    expect(frame).toContain("src/a.ts:10-12")
    expect(frame).toContain("87%")
    expect(frame).toContain("300ms")
    expect(frame).toContain("120↑ 40↓ tok")
    expect(frame).toContain("$0.0012")
    expect(frame).toContain("budget exhausted")
    const rows = frame.split("\n")
    const parentRow = rows.find((row) => row.includes("repository_query"))!
    const childRow = rows.find((row) => row.includes("src/b.ts"))!
    const indent = (row: string) => row.length - row.trimStart().length
    expect(indent(childRow)).toBeGreaterThan(indent(parentRow))
  })

  test("a handoff run shows the continued-by-model note", async () => {
    await renderMessages(
      conversation([
        assistant([
          runPart({
            id: "prt_jev_run_handoff",
            status: "handoff",
            stopReason: "tool budget reached",
          }),
        ]),
      ]),
    )
    const frame = await waitForFrame((f) => f.includes("Jev · explore-tree"))
    expect(frame).toContain("handoff")
    expect(frame).toContain("continued by model")
    expect(frame).toContain("tool budget reached")
  })

  test("a ledger taller than the collapse budget renders the first 8 rows plus a +N more line", async () => {
    const nodes = Array.from({ length: 9 }, (_, index) => ({
      nodeID: `n${index + 1}`,
      actionID: "read",
      target: `tgt${index + 1}`,
      status: "done",
    }))
    await renderMessages(conversation([assistant([runPart({ id: "prt_jev_run_big", nodes })])]), 30)
    const frame = await waitForFrame((f) => f.includes("Jev · explore-tree"))
    expect(frame).toContain("9 nodes")
    expect(frame).toContain("+1 more")
    expect(frame).not.toContain("tgt9")
  })

  test("a jev_run part on a user message is never rendered", async () => {
    await renderMessages([
      {
        info: userMessage,
        parts: [
          { id: "prt_user_text", sessionID: SESSION_ID, messageID: USER_ID, type: "text", text: "hello" },
          runPart({ id: "prt_jev_run_user", messageID: USER_ID }),
        ],
      },
      assistant([]),
    ])
    const frame = await settledFrame((f) => f.includes("hello"))
    expect(frame).not.toContain("Jev ·")
    expect(frame).not.toContain("explore-tree")
  })

  test("malformed jev_run parts fail the runtime guard and render nothing", async () => {
    await renderMessages(
      conversation([
        assistant([
          runPart({ id: "prt_jev_run_bad_status", status: "nonsense" }),
          runPart({ id: "prt_jev_run_bad_nodes", nodes: "nope" }),
          runPart({
            id: "prt_jev_run_bad_node",
            nodes: [{ nodeID: "", actionID: "read", target: "src/a.ts", status: "done" }],
          }),
        ]),
      ]),
    )
    const frame = await settledFrame((f) => f.includes("assistant reply"))
    expect(frame).not.toContain("Jev ·")
    expect(frame).not.toContain("explore-tree")
    expect(frame).not.toContain("repository_query")
  })
})
