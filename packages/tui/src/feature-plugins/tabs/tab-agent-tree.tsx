/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, createResource, createMemo, createEffect, onCleanup, onMount, For, Show } from "solid-js"
import { useRouteData } from "../../context/route"
import { useEvent } from "../../context/event"
import { useSync } from "../../context/sync"
import { toHex } from "../../util/color"
import { activeTab } from "./state"
import { RoundedBorder } from "../../ui/border"

const id = "internal:tab-agent-tree"

interface SessionItem {
  id: string
  parentID?: string
  title: string
  agent?: string
  workspaceID?: string
  time?: { created: number; updated: number }
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

interface TreeNode {
  session: SessionItem
  children: TreeNode[]
  depth: number
  totalCost: number
  totalTokens: number
  isRunning: boolean
  isPathToRunning: boolean
  isExpanded: boolean
  connector: string
  isLasts: boolean[]
  isLast: boolean
  hasChildren: boolean
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function getRootSessionId(currentId: string, sessions: SessionItem[]): string {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  let rootId = currentId
  while (true) {
    const parent = byId.get(rootId)?.parentID
    if (parent && byId.has(parent)) {
      rootId = parent
    } else {
      break
    }
  }
  return rootId
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const event = useEvent()
  const sync = useSync()
  const route = useRouteData("session")

  const [refreshTrigger, setRefreshTrigger] = createSignal(0)
  const [focusSessionId, setFocusSessionId] = createSignal<string | null>(null)
  const [userExpanded, setUserExpanded] = createSignal<Record<string, boolean>>({})
  const [selectedId, setSelectedId] = createSignal<string | null>(null)

  // Load all sessions
  const [sessions, { refetch }] = createResource(refreshTrigger, async () => {
    try {
      const result = await props.api.client.session.list({})
      return (result.data ?? []) as SessionItem[]
    } catch {
      return []
    }
  })

  // Keep sessions list updated
  onCleanup(event.on("session.updated", () => setRefreshTrigger((n) => n + 1)))

  // Mesh status for active agents tracking
  const [meshStatus, setMeshStatus] = createSignal<any>(null)
  const fetchMesh = async () => {
    const rootId = getRootSessionId(route.sessionID, mergedSessions())
    try {
      const result = await props.api.client.session.mesh({ sessionID: rootId })
      if (result?.data) {
        setMeshStatus(result.data)
      }
    } catch {}
  }

  onMount(() => {
    void fetchMesh()
    const unsubMesh = event.on("banyancode.mesh.status" as any, (ev: any) => {
      const rootId = getRootSessionId(route.sessionID, mergedSessions())
      if (ev.properties?.parentSessionID === rootId) {
        setMeshStatus(ev.properties)
      }
    })
    onCleanup(unsubMesh)
  })

  // Combine synced and fetched sessions
  const mergedSessions = createMemo<SessionItem[]>(() => {
    const live = sync.data.session
    if (!live || live.length === 0) return sessions() ?? []
    const byID = new Map<string, SessionItem>()
    for (const s of live) byID.set(s.id, s as SessionItem)
    for (const s of sessions() ?? []) if (!byID.has(s.id)) byID.set(s.id, s)
    return Array.from(byID.values())
  })

  const isSessionRunning = (sessionID: string, meshPeers: any[]) => {
    const meshPeer = meshPeers.find((p) => p.sessionID === sessionID)
    if (meshPeer) return meshPeer.status === "active"

    const live = sync.data.session_status?.[sessionID]
    if (live) return live.type === "busy" || live.type === "retry"

    const session = sync.session.get(sessionID)
    if (!session || !session.time) return false

    const localStatus = sync.session.status(sessionID)
    return localStatus === "working"
  }

  // Build children mapping for fast recursive lookup
  const childMap = createMemo(() => {
    const map = new Map<string, SessionItem[]>()
    for (const s of mergedSessions()) {
      if (s.parentID) {
        const list = map.get(s.parentID) ?? []
        list.push(s)
        map.set(s.parentID, list)
      }
    }
    return map
  })

  // Build the tree nodes recursively
  const buildNode = (
    session: SessionItem,
    depth: number,
    isLasts: boolean[],
    isLast: boolean,
    meshPeers: any[],
    userExpandedMap: Record<string, boolean>
  ): TreeNode => {
    const kids = childMap().get(session.id) ?? []
    const childrenNodes: TreeNode[] = []

    const sortedKids = [...kids].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))

    sortedKids.forEach((child, index) => {
      const isLastChild = index === sortedKids.length - 1
      childrenNodes.push(
        buildNode(
          child,
          depth + 1,
          [...isLasts, isLastChild],
          isLastChild,
          meshPeers,
          userExpandedMap
        )
      )
    })

    const nodeIsRunning = isSessionRunning(session.id, meshPeers)
    const childIsPathToRunning = childrenNodes.some((c) => c.isRunning || c.isPathToRunning)
    const isPathToRunning = nodeIsRunning || childIsPathToRunning

    const selfCost = session.cost ?? 0
    const selfTokens = session.tokens
      ? session.tokens.input +
        session.tokens.output +
        session.tokens.reasoning +
        session.tokens.cache.read +
        session.tokens.cache.write
      : 0

    const totalCost = selfCost + childrenNodes.reduce((sum, c) => sum + c.totalCost, 0)
    const totalTokens = selfTokens + childrenNodes.reduce((sum, c) => sum + c.totalTokens, 0)

    let isExpanded = isPathToRunning
    if (userExpandedMap[session.id] !== undefined) {
      isExpanded = userExpandedMap[session.id]
    }

    return {
      session,
      children: childrenNodes,
      depth,
      totalCost,
      totalTokens,
      isRunning: nodeIsRunning,
      isPathToRunning,
      isExpanded,
      connector: isLast ? "└─" : "├─",
      isLasts,
      isLast,
      hasChildren: childrenNodes.length > 0,
    }
  }

  const rootSessionId = createMemo(() => getRootSessionId(route.sessionID, mergedSessions()))

  const renderedRootNode = createMemo(() => {
    const sessionsList = mergedSessions()
    if (sessionsList.length === 0) return null

    const rootId = focusSessionId() ?? rootSessionId()
    const rootSession = sessionsList.find((s) => s.id === rootId)
    if (!rootSession) return null

    const peers = meshStatus()?.peers ?? []
    return buildNode(rootSession, 0, [], true, peers, userExpanded())
  })

  // Flatten tree for list rendering
  const flattenTree = (node: TreeNode, list: TreeNode[] = []): TreeNode[] => {
    list.push(node)
    if (node.isExpanded) {
      node.children.forEach((c) => flattenTree(c, list))
    }
    return list
  }

  const flatNodes = createMemo(() => {
    const root = renderedRootNode()
    if (!root) return []
    return flattenTree(root)
  })

  // Manage selection lifecycle
  createEffect(() => {
    const list = flatNodes()
    if (list.length === 0) {
      setSelectedId(null)
      return
    }
    const current = selectedId()
    if (!current || !list.some((n) => n.session.id === current)) {
      setSelectedId(list[0].session.id)
    }
  })

  // Focus navigation & keyboard bindings helper
  const moveSelection = (dir: 1 | -1) => {
    const list = flatNodes()
    if (list.length === 0) return
    const current = selectedId()
    const idx = list.findIndex((n) => n.session.id === current)
    let nextIdx = idx + dir
    if (nextIdx < 0) nextIdx = 0
    if (nextIdx >= list.length) nextIdx = list.length - 1
    setSelectedId(list[nextIdx].session.id)
  }

  const toggleExpand = (sessionID: string) => {
    setUserExpanded((prev) => {
      const list = flatNodes()
      const node = list.find((n) => n.session.id === sessionID)
      const currentVal = node ? node.isExpanded : false
      return { ...prev, [sessionID]: !currentVal }
    })
  }

  const handleEnter = () => {
    const current = selectedId()
    if (!current) return
    setFocusSessionId(current)
  }

  // Bind keys
  onMount(() => {
    if (!props.api.keymap) return
    const cleanup = props.api.keymap.registerLayer({
      priority: 110,
      commands: [
        {
          name: "agenttree.up",
          title: "Select up",
          desc: "Select the previous node in the agent tree",
          category: "Agent Tree",
          run() {
            if (activeTab() === "agents") moveSelection(-1)
          },
        },
        {
          name: "agenttree.down",
          title: "Select down",
          desc: "Select the next node in the agent tree",
          category: "Agent Tree",
          run() {
            if (activeTab() === "agents") moveSelection(1)
          },
        },
        {
          name: "agenttree.focus",
          title: "Focus selected",
          desc: "Focus (drill down) the selected agent node",
          category: "Agent Tree",
          run() {
            if (activeTab() === "agents") handleEnter()
          },
        },
        {
          name: "agenttree.toggle",
          title: "Toggle expand",
          desc: "Toggle expand/collapse of the selected agent node",
          category: "Agent Tree",
          run() {
            if (activeTab() === "agents" && selectedId()) toggleExpand(selectedId()!)
          },
        },
        {
          name: "agenttree.escape",
          title: "Reset focus",
          desc: "Reset focus to the root node",
          category: "Agent Tree",
          run() {
            if (activeTab() === "agents" && focusSessionId() !== null) {
              setFocusSessionId(null)
            }
          },
        },
      ],
      bindings: [
        { key: "up", command: "agenttree.up" },
        { key: "down", command: "agenttree.down" },
        { key: "k", command: "agenttree.up" },
        { key: "j", command: "agenttree.down" },
        { key: "enter", command: "agenttree.focus" },
        { key: "space", command: "agenttree.toggle" },
        { key: "escape", command: "agenttree.escape" },
      ],
    })
    onCleanup(cleanup)
  })

  // Breadcrumbs calculation
  const breadcrumbs = createMemo(() => {
    const activeFocus = focusSessionId()
    if (!activeFocus) return []
    const all = mergedSessions()
    const byId = new Map(all.map((s) => [s.id, s]))
    const path: SessionItem[] = []
    let current: SessionItem | undefined = byId.get(activeFocus)
    while (current) {
      path.push(current)
      const parent = current.parentID
      current = parent ? byId.get(parent) : undefined
    }
    return path.reverse()
  })

  const getGuidesAndConnector = (item: TreeNode) => {
    const DEPTH_CAP = 3
    if (item.depth <= DEPTH_CAP) {
      const guides: string[] = []
      for (let i = 0; i < item.depth - 1; i++) {
        if (item.isLasts[i]) {
          guides.push("   ")
        } else {
          guides.push("│  ")
        }
      }
      return {
        isCapped: false,
        guides,
        connector: item.connector,
      }
    } else {
      return {
        isCapped: true,
        guides: [],
        connector: item.connector,
      }
    }
  }

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
      >
        <text fg={toHex(theme().text)}>
          <b>Agent Tree</b>
        </text>
        <Show when={focusSessionId() !== null}>
          <text fg={toHex(theme().primary)} onMouseUp={() => setFocusSessionId(null)}>
            [reset focus]
          </text>
        </Show>
      </box>

      {/* Breadcrumbs for focused drill-down view */}
      <Show when={breadcrumbs().length > 0}>
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          border={["bottom"]}
          borderColor={toHex(theme().borderSubtle)}
        >
          <text fg={toHex(theme().textMuted)}>Path:</text>
          <For each={breadcrumbs()}>
            {(bc, index) => (
              <box flexDirection="row" gap={1}>
                <Show when={index() > 0}>
                  <text fg={toHex(theme().textMuted)}>›</text>
                </Show>
                <text
                  fg={toHex(bc.id === focusSessionId() ? theme().primary : theme().text)}
                  onMouseUp={() => setFocusSessionId(bc.id === rootSessionId() ? null : bc.id)}
                >
                  {bc.agent ?? "orchestrator"}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>

      {/* Main tree list */}
      <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
        <box flexDirection="column" paddingTop={1} gap={0}>
          <Show
            when={flatNodes().length > 0}
            fallback={
              <text fg={toHex(theme().textMuted)} paddingLeft={2} paddingTop={2}>
                Loading agent tree…
              </text>
            }
          >
            <For each={flatNodes()}>
              {(item) => {
                const gc = getGuidesAndConnector(item)
                const isSelected = () => selectedId() === item.session.id

                const iconFg = () => (item.isRunning ? theme().success : theme().textMuted)
                const iconChar = () => (item.isRunning ? "●" : "✓")

                const nodeStatusLabel = () => {
                  if (item.isRunning) return "running"
                  return "done"
                }

                const summaryText = () => {
                  if (!item.isExpanded && item.hasChildren) {
                    return ` · ${nodeStatusLabel()} · ${item.children.length} subagent${item.children.length === 1 ? "" : "s"}`
                  }
                  return ""
                }

                return (
                  <box
                    flexDirection="row"
                    gap={1}
                    alignItems="center"
                    backgroundColor={isSelected() ? toHex(theme().backgroundElement) : undefined}
                    width="100%"
                    paddingLeft={1}
                    paddingRight={1}
                    onMouseDown={() => setSelectedId(item.session.id)}
                  >
                    {/* Render guides/capping */}
                    <Show
                      when={gc.isCapped}
                      fallback={
                        <For each={gc.guides}>
                          {(guide) => <text flexShrink={0} fg={toHex(theme().textMuted)}>{guide}</text>}
                        </For>
                      }
                    >
                      <text flexShrink={0} fg={toHex(theme().textMuted)}>
                        {`    [L${item.depth + 1}] `}
                      </text>
                    </Show>

                    {/* Connector & Status */}
                    <Show when={item.depth > 0}>
                      <text flexShrink={0} fg={toHex(theme().textMuted)}>
                        {gc.connector}
                      </text>
                    </Show>
                    <text flexShrink={0} fg={toHex(iconFg())}>
                      {iconChar()}
                    </text>

                    {/* Agent Name & Title */}
                    <text fg={toHex(theme().primary)}>
                      <b>{item.session.agent ?? "orchestrator"}</b>
                    </text>
                    <text fg={toHex(theme().text)} flexGrow={1} wrapMode="none" truncate>
                      {item.session.title || "(untitled)"}
                      <span style={{ fg: toHex(theme().textMuted) }}>{summaryText()}</span>
                    </text>

                    {/* Cost & Tokens Rollup */}
                    <text fg={toHex(theme().textMuted)}>
                      {money.format(item.totalCost)} · {formatTokens(item.totalTokens)} tok
                    </text>

                    {/* Quick actions */}
                    <box flexDirection="row" gap={1} flexShrink={0}>
                      <Show when={item.hasChildren}>
                        <text
                          fg={toHex(theme().info)}
                          onMouseUp={(e: any) => {
                            e.stopPropagation()
                            toggleExpand(item.session.id)
                          }}
                        >
                          [{item.isExpanded ? "collapse" : "expand"}]
                        </text>
                      </Show>
                      <text
                        fg={toHex(theme().primary)}
                        onMouseUp={(e: any) => {
                          e.stopPropagation()
                          setFocusSessionId(item.session.id)
                        }}
                      >
                        [focus]
                      </text>
                    </box>
                  </box>
                )
              }}
            </For>
          </Show>
        </box>
      </scrollbox>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 70,
    slots: {
      session_tab_agents() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
