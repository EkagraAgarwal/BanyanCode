/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { RGBA } from "@opentui/core"
import TabAgentTree, {
  AGENT_TREE_COLLAPSE_THRESHOLD,
  agentTreeGroupKey,
  agentTreeStatusGlyph,
  flattenAgentTree,
  groupAgentTreeChildren,
  type AgentTreeNode,
} from "../../../src/feature-plugins/tabs/tab-agent-tree"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { SDKProvider } from "../../../src/context/sdk"
import { ExitProvider } from "../../../src/context/exit"
import { ArgsProvider } from "../../../src/context/args"
import { ProjectProvider } from "../../../src/context/project"
import { SyncProvider } from "../../../src/context/sync"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { RouteProvider } from "../../../src/context/route"

function makeColor(r: number, g: number, b: number, a = 255) {
  return RGBA.fromInts(r, g, b, a)
}

const stubTheme = {
  text: makeColor(200, 200, 200),
  textMuted: makeColor(120, 120, 120),
  primary: makeColor(100, 200, 100),
  secondary: makeColor(100, 100, 200),
  success: makeColor(100, 200, 100),
  error: makeColor(200, 100, 100),
  warning: makeColor(200, 200, 100),
  backgroundElement: makeColor(50, 50, 50),
}

const stubSessions = [
  { id: "current-session", parentID: undefined, title: "orchestrator" },
  { id: "child-1", parentID: "current-session", title: "researcher", summary: undefined },
  { id: "child-2", parentID: "current-session", title: "scout", summary: { additions: 5, deletions: 2, files: 3 } },
]

function node(id: string, agent: string, parentID = "root", totalTokens = 1, children: AgentTreeNode[] = []): AgentTreeNode {
  return {
    session: { id, parentID, title: agent, agent },
    children,
    totalCost: 0,
    totalTokens,
    status: "done",
    isPathToRunning: false,
  }
}

test("agent tree collapses contiguous repeated siblings at the threshold", () => {
  const children = [
    ...Array.from({ length: AGENT_TREE_COLLAPSE_THRESHOLD }, (_, index) => node(`scout-${index}`, "scout")),
    node("general-0", "general"),
    ...Array.from({ length: 6 }, (_, index) => node(`explore-${index}`, "explore")),
  ]

  const grouped = groupAgentTreeChildren(children)

  expect(grouped.map((entry) => entry.kind)).toEqual(["group", "node", "group"])
  expect(grouped[0]).toMatchObject({ agentName: "scout", nodes: children.slice(0, AGENT_TREE_COLLAPSE_THRESHOLD) })
  expect(grouped[2]).toMatchObject({ agentName: "explore", nodes: children.slice(6) })
})

test("agent tree preserves connectors for expanded nested siblings", () => {
  const scouts = [node("scout-1", "scout", "explore"), node("scout-2", "scout", "explore")]
  const explore = node("explore", "explore", "root", 4, scouts)
  const root = node("root", "build", undefined, 8, [explore, node("general", "general")])

  const rows = flattenAgentTree(root)

  expect(rows.map((row) => [row.depth, row.isLast, row.continuation])).toEqual([
    [0, true, []],
    [1, false, []],
    [2, false, [true]],
    [2, true, [true]],
    [1, true, []],
  ])
})

test("agent tree expands a collapsed group back into raw rows", () => {
  const scouts = Array.from({ length: 6 }, (_, index) => node(`scout-${index}`, "scout"))
  const root = node("root", "build", undefined, 12, scouts)
  const key = agentTreeGroupKey("root", "scout", "scout-0")

  const collapsed = flattenAgentTree(root)
  expect(collapsed).toHaveLength(2)
  expect(collapsed[1]).toMatchObject({ kind: "group", key, nodes: scouts })

  const expanded = flattenAgentTree(root, new Set([key]))
  expect(expanded).toHaveLength(7)
  expect(expanded.slice(1).every((row) => row.kind === "node")).toBe(true)
})

test("agent tree omits status glyphs for completed rows", () => {
  expect(agentTreeStatusGlyph("done")).toBe("")
  expect(agentTreeStatusGlyph("running")).toBe("●")
  expect(agentTreeStatusGlyph("queued")).toBe("●")
  expect(agentTreeStatusGlyph("error")).toBe("●")
})

test("tab agent-tree session_tab_agents slot renders without throwing", async () => {
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json(stubSessions)
    if (url.pathname === "/session/mesh") return json({ peers: [] })
    if (url.pathname === "/session/status") return json({})
    return undefined
  })
  const config = createTuiResolvedConfig()
  const [rendered, setRendered] = createSignal(false)

  const Harness = () => {
    let slotFn: any = null
    const api: any = {
      ...createTuiPluginApi({}),
      theme: { current: stubTheme },
      client: {
        session: {
          list: async () => ({ data: stubSessions }),
          mesh: async () => ({ data: { peers: [] } }),
        },
      },
      state: {
        session: {
          get: () => undefined,
          status: () => "idle",
          diff: () => [],
          todo: () => [],
          messages: () => Promise.resolve([]),
          permission: () => [],
          question: () => [],
        },
      },
    }
    api.slots = {
      register: (plugin: any) => {
        if (plugin?.slots?.session_tab_agents) slotFn = plugin.slots.session_tab_agents
        return () => {}
      },
    }
    void TabAgentTree.tui(api as any, undefined as any, { id: "test" } as any)
    setRendered(true)
    return (
      <TestTuiContexts>
        <ExitProvider exit={console.error}>
          <ArgsProvider>
            <KVProvider>
              <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
                <ProjectProvider>
                  <SyncProvider>
                    <TuiConfigProvider config={config}>
                      <ThemeProvider mode="dark">
                        <RouteProvider initialRoute={{ type: "session", sessionID: "current-session" }}>
                          <box flexDirection="column">
                            {slotFn ? slotFn(undefined as any, { session_id: "current-session" }) : null}
                          </box>
                        </RouteProvider>
                      </ThemeProvider>
                    </TuiConfigProvider>
                  </SyncProvider>
                </ProjectProvider>
              </SDKProvider>
            </KVProvider>
          </ArgsProvider>
        </ExitProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />)
  await new Promise((resolve) => setTimeout(resolve, 200))
  await app.renderOnce()
  try {
    expect(rendered()).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})
