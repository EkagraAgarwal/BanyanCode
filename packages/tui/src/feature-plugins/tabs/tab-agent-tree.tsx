/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, createResource, createMemo, onCleanup, onMount, For, Show } from "solid-js"
import { useRouteData } from "../../context/route"
import { useEvent } from "../../context/event"
import { useSync } from "../../context/sync"
import { toHex } from "../../util/color"
import { activeTab } from "./state"

const id = "internal:tab-agent-tree"

interface SessionItem {
  id: string
  parentID?: string
  title: string
  agent?: string
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

  const [sessions, { refetch }] = createResource(refreshTrigger, async () => {
    try {
      const result = await props.api.client.session.list({})
      return (result.data ?? []) as SessionItem[]
    } catch {
      return []
    }
  })

  onCleanup(event.on("session.updated", () => setRefreshTrigger((n) => n + 1)))

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
    return sync.session.status(sessionID) === "working"
  }

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

  const buildNode = (
    session: SessionItem,
    depth: number,
    meshPeers: any[],
  ): TreeNode => {
    const kids = childMap().get(session.id) ?? []
    const sortedKids = [...kids].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
    const childrenNodes = sortedKids.map((child) => buildNode(child, depth + 1, meshPeers))

    const nodeIsRunning = isSessionRunning(session.id, meshPeers)
    const childIsPathToRunning = childrenNodes.some((c) => c.isRunning || c.isPathToRunning)
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

    return {
      session,
      children: childrenNodes,
      depth,
      totalCost,
      totalTokens,
      isRunning: nodeIsRunning,
      isPathToRunning: nodeIsRunning || childIsPathToRunning,
    }
  }

  const rootSessionId = createMemo(() => getRootSessionId(route.sessionID, mergedSessions()))

  const renderedRootNode = createMemo(() => {
    const sessionsList = mergedSessions()
    if (sessionsList.length === 0) return null
    const rootSession = sessionsList.find((s) => s.id === rootSessionId())
    if (!rootSession) return null
    const peers = meshStatus()?.peers ?? []
    return buildNode(rootSession, 0, peers)
  })

  // Always fully expanded. Flatten by depth-first traversal so the user can
  // see every parent-child relationship at a glance without toggle buttons.
  const flatNodes = createMemo(() => {
    const root = renderedRootNode()
    if (!root) return []
    const list: TreeNode[] = []
    const walk = (node: TreeNode) => {
      list.push(node)
      node.children.forEach(walk)
    }
    walk(root)
    return list
  })

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        border={["bottom"]}
        borderColor={toHex(theme().borderSubtle)}
      >
        <text fg={toHex(theme().text)}>
          <b>Agent Tree</b>
        </text>
        <text fg={toHex(theme().textMuted)}>{flatNodes().length} sessions</text>
      </box>

      <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
        <box flexDirection="column" paddingTop={1} gap={0}>
          <Show
            when={flatNodes().length > 0}
            fallback={
              <text fg={toHex(theme().textMuted)} paddingLeft={2} paddingTop={2}>
                No sessions yet.
              </text>
            }
          >
            <For each={flatNodes()}>
              {(item) => {
                const indent = "  ".repeat(item.depth)
                const agentName = () => item.session.agent ?? "orchestrator"
                const statusDot = () =>
                  item.isRunning ? toHex(theme().success) : toHex(theme().textMuted)
                const statusChar = () => (item.isRunning ? "●" : "✓")
                const childSummary = () =>
                  item.children.length === 0
                    ? ""
                    : `  ${item.children.length} ${item.children.length === 1 ? "sub" : "subs"}`

                return (
                  <box
                    flexDirection="row"
                    gap={1}
                    alignItems="center"
                    width="100%"
                    paddingLeft={1}
                    paddingRight={1}
                  >
                    <text fg={toHex(theme().textMuted)} flexShrink={0}>
                      {indent}
                    </text>
                    <text fg={statusDot()} flexShrink={0}>
                      {statusChar()}
                    </text>
                    <text fg={item.depth === 0 ? toHex(theme().primary) : toHex(theme().text)} flexShrink={0}>
                      <b>{agentName()}</b>
                    </text>
                    <Show when={item.children.length > 0}>
                      <text fg={toHex(theme().info)} flexShrink={0}>
                        {childSummary()}
                      </text>
                    </Show>
                    <text fg={toHex(theme().textMuted)} flexShrink={0}>
                      ·
                    </text>
                    <text fg={toHex(theme().textMuted)} flexShrink={0}>
                      {money.format(item.totalCost)} · {formatTokens(item.totalTokens)} tok
                    </text>
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