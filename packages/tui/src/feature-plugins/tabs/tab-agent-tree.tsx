/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, createResource, createMemo, onCleanup, onMount, For, Show } from "solid-js"
import { useRouteData } from "../../context/route"
import { useEvent } from "../../context/event"
import { useSync } from "../../context/sync"
import { toHex } from "../../util/color"

const id = "internal:tab-agent-tree"
export const AGENT_TREE_COLLAPSE_THRESHOLD = 5
const BAR_WIDTH = 10

type AgentStatus = "done" | "running" | "queued" | "error"

export interface SessionItem {
  id: string
  parentID?: string
  title: string
  agent?: string
  time?: { created: number; updated: number }
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

export interface AgentTreeNode {
  session: SessionItem
  children: AgentTreeNode[]
  totalCost: number
  totalTokens: number
  status: AgentStatus
  isPathToRunning: boolean
}

export interface AgentTreeNodeRow {
  kind: "node"
  node: AgentTreeNode
  depth: number
  isLast: boolean
  continuation: boolean[]
}

export interface AgentTreeGroupRow {
  kind: "group"
  key: string
  agentName: string
  nodes: AgentTreeNode[]
  depth: number
  isLast: boolean
  continuation: boolean[]
}

export type AgentTreeRow = AgentTreeNodeRow | AgentTreeGroupRow

type AgentTreeChildEntry =
  | { kind: "node"; node: AgentTreeNode }
  | { kind: "group"; key: string; agentName: string; nodes: AgentTreeNode[] }

const sparkChars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

export function agentName(session: SessionItem): string {
  return session.agent ?? "orchestrator"
}

export function agentTreeGroupKey(parentID: string, name: string, firstChildID: string): string {
  return `${parentID}:${name}:${firstChildID}`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function agentTreeSparkline(values: readonly number[]): string {
  if (values.length === 0) return ""
  const max = Math.max(...values, 1)
  return values
    .map((value) => sparkChars[Math.min(sparkChars.length - 1, Math.floor((value / max) * sparkChars.length))] ?? sparkChars[0])
    .join("")
}

export function flattenAgentTree(root: AgentTreeNode, expandedGroups: ReadonlySet<string> = new Set()): AgentTreeRow[] {
  const rows: AgentTreeRow[] = []

  const visit = (node: AgentTreeNode, depth: number, continuation: boolean[], isLast: boolean) => {
    rows.push({ kind: "node", node, depth, continuation, isLast })

    const entries = groupAgentTreeChildren(node.children).flatMap((entry) => {
      if (entry.kind === "group" && (expandedGroups.has(entry.key) || entry.nodes.some((child) => child.isPathToRunning))) {
        return entry.nodes.map((child) => ({ kind: "node" as const, node: child }))
      }
      return [entry]
    })

    entries.forEach((entry, index) => {
      const childIsLast = index === entries.length - 1
      const childContinuation = depth === 0 ? continuation : [...continuation, !isLast]
      if (entry.kind === "group") {
        rows.push({
          kind: "group",
          key: entry.key,
          agentName: entry.agentName,
          nodes: entry.nodes,
          depth: depth + 1,
          continuation: childContinuation,
          isLast: childIsLast,
        })
        return
      }
      visit(entry.node, depth + 1, childContinuation, childIsLast)
    })
  }

  visit(root, 0, [], true)
  return rows
}

export function groupAgentTreeChildren(children: readonly AgentTreeNode[]): AgentTreeChildEntry[] {
  const result: AgentTreeChildEntry[] = []
  let index = 0
  while (index < children.length) {
    const first = children[index]!
    const name = agentName(first.session)
    const nodes = [first]
    while (index + nodes.length < children.length && agentName(children[index + nodes.length]!.session) === name) {
      nodes.push(children[index + nodes.length]!)
    }
    if (nodes.length >= AGENT_TREE_COLLAPSE_THRESHOLD) {
      result.push({ kind: "group", key: agentTreeGroupKey(first.session.parentID ?? "", name, first.session.id), agentName: name, nodes })
    } else {
      result.push(...nodes.map((node) => ({ kind: "node" as const, node })))
    }
    index += nodes.length
  }
  return result
}

function getRootSessionId(currentId: string, sessions: SessionItem[]): string {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const seen = new Set<string>()
  let rootId = currentId
  while (!seen.has(rootId)) {
    seen.add(rootId)
    const parent = byId.get(rootId)?.parentID
    if (!parent || !byId.has(parent)) break
    rootId = parent
  }
  return rootId
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const event = useEvent()
  const sync = useSync()
  const route = useRouteData("session")
  const [refreshTrigger, setRefreshTrigger] = createSignal(0)
  const [expandedGroups, setExpandedGroups] = createSignal<ReadonlySet<string>>(new Set())

  const [sessions] = createResource(refreshTrigger, async () => {
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
      if (result?.data) setMeshStatus(result.data)
    } catch {}
  }

  onMount(() => {
    void fetchMesh()
    const unsubMesh = event.on("banyancode.mesh.status" as any, (ev: any) => {
      const rootId = getRootSessionId(route.sessionID, mergedSessions())
      if (ev.properties?.parentSessionID === rootId) setMeshStatus(ev.properties)
    })
    onCleanup(unsubMesh)
  })

  const mergedSessions = createMemo<SessionItem[]>(() => {
    const live = sync.data.session
    if (!live || live.length === 0) return sessions() ?? []
    const byID = new Map<string, SessionItem>()
    for (const session of live) byID.set(session.id, session as SessionItem)
    for (const session of sessions() ?? []) if (!byID.has(session.id)) byID.set(session.id, session)
    return Array.from(byID.values())
  })

  const statusOf = (sessionID: string, meshPeers: any[]): AgentStatus => {
    const meshStatus = meshPeers.find((peer) => peer.sessionID === sessionID)?.status
    if (meshStatus === "active") return "running"
    if (meshStatus === "queued" || meshStatus === "pending") return "queued"
    if (meshStatus === "error" || meshStatus === "failed" || meshStatus === "disconnected") return "error"

    const live = sync.data.session_status?.[sessionID] as { type?: string } | undefined
    if (live?.type === "busy" || live?.type === "retry" || live?.type === "working") return "running"
    if (live?.type === "queued" || live?.type === "pending") return "queued"
    if (live?.type === "error" || live?.type === "failed") return "error"

    const session = sync.session.get(sessionID)
    if (!session?.time || !("compacting" in session.time)) return "done"
    return sync.session.status(sessionID) === "working" ? "running" : "done"
  }

  const childMap = createMemo(() => {
    const map = new Map<string, SessionItem[]>()
    for (const session of mergedSessions()) {
      if (!session.parentID) continue
      const list = map.get(session.parentID) ?? []
      list.push(session)
      map.set(session.parentID, list)
    }
    return map
  })

  const buildNode = (session: SessionItem, meshPeers: any[], path: ReadonlySet<string>): AgentTreeNode => {
    const children = (childMap().get(session.id) ?? [])
      .filter((child) => !path.has(child.id))
      .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
    const nextPath = new Set(path)
    nextPath.add(session.id)
    const childrenNodes = children.map((child) => buildNode(child, meshPeers, nextPath))
    const status = statusOf(session.id, meshPeers)
    const selfCost = session.cost ?? 0
    const selfTokens =
      (session.tokens?.input ?? 0) +
      (session.tokens?.output ?? 0) +
      (session.tokens?.reasoning ?? 0) +
      (session.tokens?.cache?.read ?? 0) +
      (session.tokens?.cache?.write ?? 0)
    const totalCost = selfCost + childrenNodes.reduce((sum, child) => sum + child.totalCost, 0)
    const totalTokens = selfTokens + childrenNodes.reduce((sum, child) => sum + child.totalTokens, 0)
    const isPathToRunning = status === "running" || childrenNodes.some((child) => child.isPathToRunning)

    return { session, children: childrenNodes, totalCost, totalTokens, status, isPathToRunning }
  }

  const rootSessionId = createMemo(() => getRootSessionId(route.sessionID, mergedSessions()))

  const renderedRootNode = createMemo(() => {
    const list = mergedSessions()
    if (list.length === 0) return null
    const rootSession = list.find((session) => session.id === rootSessionId())
    if (!rootSession) return null
    return buildNode(rootSession, meshStatus()?.peers ?? [], new Set())
  })

  const rows = createMemo(() => {
    const root = renderedRootNode()
    return root ? flattenAgentTree(root, expandedGroups()) : []
  })

  const sessionCount = createMemo(() => {
    const root = renderedRootNode()
    if (!root) return 0
    const count = (node: AgentTreeNode): number => 1 + node.children.reduce((sum, child) => sum + count(child), 0)
    return count(root)
  })

  const toggleGroup = (key: string) => {
    const next = new Set(expandedGroups())
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setExpandedGroups(next)
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
        paddingBottom={1}
        border={["bottom"]}
        borderColor={toHex(theme().borderSubtle)}
      >
        <text fg={toHex(theme().text)}><b>Agent Tree</b></text>
        <text fg={toHex(theme().textMuted)}>{sessionCount()} sessions</text>
      </box>

      <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
        <box flexDirection="column" paddingTop={1} gap={0}>
          <Show
            when={rows().length > 0}
            fallback={<text fg={toHex(theme().textMuted)} paddingLeft={2} paddingTop={2}>No sessions yet.</text>}
          >
            <For each={rows()}>
              {(row) => {
                const connector = () => row.depth === 0
                  ? ""
                  : `${row.continuation.map((hasNext) => hasNext ? "│  " : "   ").join("")}${row.isLast ? "└─ " : "├─ "}`
                if (row.kind === "group") {
                  const color = agentType(row.agentName, theme()).color
                  return (
                    <box
                      flexDirection="row"
                      alignItems="center"
                      width="100%"
                      paddingLeft={1}
                      paddingRight={1}
                      onMouseUp={() => toggleGroup(row.key)}
                    >
                      <text fg={toHex(theme().textMuted)} flexShrink={0}>{connector()}</text>
                      <text fg={toHex(theme().textMuted)} flexShrink={0}><i>{row.nodes.length} {plural(row.agentName)} collapsed</i></text>
                      <text fg={color} flexShrink={0} paddingLeft={2}>{agentTreeSparkline(row.nodes.map((node) => node.totalTokens))}</text>
                      <box flexGrow={1} />
                      <text fg={toHex(theme().textMuted)} flexShrink={0}><u>expand ▶</u></text>
                    </box>
                  )
                }

                const node = row.node
                const style = agentType(agentName(node.session), theme())
                const status = statusGlyph(node.status, theme())
                const childSummary = node.children.length === 0 ? "" : `${node.children.length} ${node.children.length === 1 ? "sub" : "subs"}`
                return (
                  <box
                    flexDirection="row"
                    alignItems="center"
                    width="100%"
                    paddingLeft={1}
                    paddingRight={1}
                  >
                    <text fg={toHex(theme().textMuted)} flexShrink={0}>{connector()}</text>
                    <text fg={style.color} flexShrink={0} width={2}>{style.icon}</text>
                    <text fg={toHex(theme().text)} flexShrink={0}><b>{agentName(node.session)}</b></text>
                    <Show when={status.glyph}>
                      <text fg={status.color} paddingLeft={1} flexShrink={0}>{status.glyph}</text>
                    </Show>
                    <Show when={childSummary}>
                      <text fg={toHex(theme().textMuted)} flexShrink={0}> {childSummary}</text>
                    </Show>
                    <box flexGrow={1} />
                    <Show when={row.depth > 0}>
                      <MagnitudeBar value={node.totalTokens} max={renderedRootNode()?.totalTokens ?? 0} color={style.color} theme={theme()} />
                    </Show>
                    <box flexDirection="row" justifyContent="flex-end" width={12} flexShrink={0}>
                      <text fg={node.isPathToRunning ? toHex(theme().text) : toHex(theme().textMuted)}>{formatTokens(node.totalTokens)} tok</text>
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

function agentType(name: string, theme: any) {
  const normalized = name.toLowerCase()
  if (normalized === "build" || normalized === "orchestrator") return { icon: "▣", color: toHex(theme.primary) }
  if (normalized === "general") return { icon: "◆", color: toHex(theme.accent) }
  if (normalized === "explore") return { icon: "◇", color: toHex(theme.info) }
  if (normalized === "scout") return { icon: "•", color: toHex(theme.secondary) }
  return { icon: "•", color: toHex(theme.textMuted) }
}

function plural(name: string): string {
  if (name.endsWith("s")) return name
  if (name.endsWith("y")) return `${name.slice(0, -1)}ies`
  return `${name}s`
}

export function agentTreeStatusGlyph(status: AgentStatus): string {
  return status === "done" ? "" : "●"
}

function statusGlyph(status: AgentStatus, theme: any) {
  if (status === "running") return { glyph: agentTreeStatusGlyph(status), color: toHex(theme.success) }
  if (status === "queued") return { glyph: agentTreeStatusGlyph(status), color: toHex(theme.warning) }
  if (status === "error") return { glyph: agentTreeStatusGlyph(status), color: toHex(theme.error) }
  return { glyph: agentTreeStatusGlyph(status), color: toHex(theme.textMuted) }
}

function MagnitudeBar(props: { value: number; max: number; color: string; theme: any }) {
  const percent = () => props.max > 0 ? Math.max(0, Math.min(100, (props.value / props.max) * 100)) : 0
  return (
    <box flexDirection="row" width={BAR_WIDTH} height={1} flexShrink={0} marginRight={1}>
      <box backgroundColor={props.color} width={`${percent()}%`} height={1} />
      <box backgroundColor={toHex(props.theme.backgroundElement)} width={`${100 - percent()}%`} height={1} />
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
