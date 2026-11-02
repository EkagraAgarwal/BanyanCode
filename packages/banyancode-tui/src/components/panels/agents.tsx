import type { Context } from "@opencode/plugin/tui/context"
import type { SessionInfo } from "@opencode/client"
import type { RGBA } from "@opentui/core"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { formatTokens } from "../../data/format"
import type { MeshLive } from "../../data/live"
import { totalTokens } from "../../data/messages"
import { meshStateFor } from "../../data/mesh"
import { palette, type Palette } from "../../theme"
import { usePanelFocus, useRowKeys, type PanelRow } from "./keys"

export const AGENT_TREE_COLLAPSE_THRESHOLD = 5
const BAR_WIDTH = 10
const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

export type AgentStatus = "done" | "running" | "queued" | "error"

export interface AgentNode {
  readonly session: SessionInfo
  readonly children: readonly AgentNode[]
  readonly totalCost: number
  readonly totalTokens: number
  readonly status: AgentStatus
  readonly killed: boolean
  readonly isPathToRunning: boolean
}

export interface AgentNodeRow {
  readonly kind: "node"
  readonly node: AgentNode
  readonly depth: number
  readonly isLast: boolean
  readonly continuation: readonly boolean[]
}

export interface AgentGroupRow {
  readonly kind: "group"
  readonly key: string
  readonly agentName: string
  readonly nodes: readonly AgentNode[]
  readonly depth: number
  readonly isLast: boolean
  readonly continuation: readonly boolean[]
}

export type AgentTreeRow = AgentNodeRow | AgentGroupRow

export function agentName(session: SessionInfo): string {
  return session.agent ?? "orchestrator"
}

export function agentTreeSparkline(values: readonly number[]): string {
  if (values.length === 0) return ""
  const max = Math.max(...values, 1)
  return values
    .map((value) => SPARK_CHARS[Math.min(SPARK_CHARS.length - 1, Math.floor((value / max) * SPARK_CHARS.length))] ?? SPARK_CHARS[0])
    .join("")
}

export function groupAgentTreeChildren(children: readonly AgentNode[]): ReadonlyArray<
  | { readonly kind: "node"; readonly node: AgentNode }
  | { readonly kind: "group"; readonly key: string; readonly agentName: string; readonly nodes: readonly AgentNode[] }
> {
  const result: Array<
    | { readonly kind: "node"; readonly node: AgentNode }
    | { readonly kind: "group"; readonly key: string; readonly agentName: string; readonly nodes: readonly AgentNode[] }
  > = []
  let index = 0
  while (index < children.length) {
    const first = children[index]!
    const name = agentName(first.session)
    const nodes = [first]
    while (index + nodes.length < children.length && agentName(children[index + nodes.length]!.session) === name) {
      nodes.push(children[index + nodes.length]!)
    }
    if (nodes.length >= AGENT_TREE_COLLAPSE_THRESHOLD) {
      result.push({
        kind: "group",
        key: `${first.session.parentID ?? ""}:${name}:${first.session.id}`,
        agentName: name,
        nodes,
      })
    } else {
      result.push(...nodes.map((node) => ({ kind: "node" as const, node })))
    }
    index += nodes.length
  }
  return result
}

export function flattenAgentTree(root: AgentNode, expanded: ReadonlySet<string> = new Set()): AgentTreeRow[] {
  const rows: AgentTreeRow[] = []
  const visit = (node: AgentNode, depth: number, continuation: readonly boolean[], isLast: boolean) => {
    rows.push({ kind: "node", node, depth, continuation, isLast })
    const entries = groupAgentTreeChildren(node.children).flatMap((entry) =>
      entry.kind === "group" && (expanded.has(entry.key) || entry.nodes.some((child) => child.isPathToRunning))
        ? entry.nodes.map((child) => ({ kind: "node" as const, node: child }))
        : [entry],
    )
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

export function buildAgentTree(input: {
  readonly sessions: readonly SessionInfo[]
  readonly rootID: string
  readonly stateOf: (sessionID: string) => AgentStatus
  readonly killed?: ReadonlySet<string>
}): AgentNode | undefined {
  const byParent = new Map<string, SessionInfo[]>()
  for (const session of input.sessions) {
    if (!session.parentID) continue
    const list = byParent.get(session.parentID) ?? []
    list.push(session)
    byParent.set(session.parentID, list)
  }
  const root = input.sessions.find((session) => session.id === input.rootID)
  if (!root) return undefined
  const visit = (session: SessionInfo, path: ReadonlySet<string>): AgentNode => {
    const nextPath = new Set(path)
    nextPath.add(session.id)
    const children = (byParent.get(session.id) ?? [])
      .filter((child) => !nextPath.has(child.id))
      .sort((a, b) => a.time.created - b.time.created)
      .map((child) => visit(child, nextPath))
    const killed = input.killed?.has(session.id) ?? false
    const status = killed ? "done" : input.stateOf(session.id)
    const selfTokens = totalTokens(session.tokens)
    return {
      session,
      children,
      totalCost: (session.cost ?? 0) + children.reduce((sum, child) => sum + child.totalCost, 0),
      totalTokens: selfTokens + children.reduce((sum, child) => sum + child.totalTokens, 0),
      status,
      killed,
      isPathToRunning: status === "running" || children.some((child) => child.isPathToRunning),
    }
  }
  return visit(root, new Set())
}

function agentType(name: string, theme: Palette) {
  const normalized = name.toLowerCase()
  if (normalized === "build" || normalized === "orchestrator") return { icon: "▣", color: theme.primary }
  if (normalized === "general") return { icon: "◆", color: theme.accent }
  if (normalized === "explore") return { icon: "◇", color: theme.info }
  if (normalized === "scout") return { icon: "•", color: theme.muted }
  return { icon: "•", color: theme.muted }
}

function statusGlyph(status: AgentStatus, theme: Palette) {
  if (status === "running") return { glyph: "●", color: theme.success }
  if (status === "queued") return { glyph: "●", color: theme.warning }
  if (status === "error") return { glyph: "●", color: theme.error }
  return { glyph: "", color: theme.muted }
}

function MagnitudeBar(props: { readonly value: number; readonly max: number; readonly color: RGBA; readonly theme: Palette }) {
  const percent = () => (props.max > 0 ? Math.max(0, Math.min(100, (props.value / props.max) * 100)) : 0)
  return (
    <box flexDirection="row" width={BAR_WIDTH} height={1} flexShrink={0} marginRight={1}>
      <box backgroundColor={props.color} width={`${percent()}%`} height={1} />
      <box backgroundColor={props.theme.surfaceHigh} width={`${100 - percent()}%`} height={1} />
    </box>
  )
}

/**
 * Ported from v1 `tabs/tab-agent-tree.tsx`. v1's tab bar is replaced by v2's
 * native session tabs; this renders as a session-panel view.
 */
export function AgentTreeView(props: {
  readonly context: Context
  readonly sessionID: string
  readonly mesh: MeshLive
}) {
  const theme = () => palette(props.context.theme)
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())

  onMount(() => {
    void props.mesh.ensure(props.context.data.session.root(props.sessionID))
  })

  const stateOf = (sessionID: string): AgentStatus => {
    const session = props.context.data.session.get(sessionID)
    const root = session === undefined ? undefined : props.context.data.session.root(sessionID)
    const meshState = root === undefined ? undefined : meshStateFor(props.mesh.root(root), sessionID)
    if (meshState === "running" || meshState === "retry") return "running"
    if (meshState === "failed" || meshState === "interrupted") return "error"
    if (meshState === "unknown") return "queued"
    if (props.context.data.session.status(sessionID) === "running") return "running"
    return "done"
  }

  const root = createMemo(() =>
    buildAgentTree({
      sessions: props.context.data.session.list(),
      rootID: props.context.data.session.root(props.sessionID),
      stateOf,
      killed: props.mesh.killed(),
    }),
  )

  const rows = createMemo(() => (root() ? flattenAgentTree(root()!, expanded()) : []))
  const focus = usePanelFocus()

  const treeRows = createMemo<PanelRow[]>(() =>
    rows().map((row) =>
      row.kind === "group"
        ? { id: row.key, actions: [{ title: "Toggle group", run: () => toggle(row.key) }] }
        : { id: row.node.session.id, actions: [] },
    ),
  )
  const keys = useRowKeys({ context: props.context, rows: treeRows })
  const cursor = (index: number) => focus?.zone() === "content" && keys.row() === index
  const sessionCount = createMemo(() => {
    const count = (node: AgentNode): number => 1 + node.children.reduce((sum, child) => sum + count(child), 0)
    return root() ? count(root()!) : 0
  })

  const toggle = (key: string) => {
    const next = new Set(expanded())
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setExpanded(next)
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
        borderColor={theme().border}
      >
        <text fg={theme().text}>
          <b>Agent Tree</b>
        </text>
        <text fg={theme().muted}>{sessionCount()} sessions</text>
      </box>
      <scrollbox id="banyancode.agents.list" flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
        <box flexDirection="column" paddingTop={1} gap={0}>
          <Show
            when={rows().length > 0}
            fallback={
              <text fg={theme().muted} paddingLeft={2} paddingTop={1}>
                No sessions yet.
              </text>
            }
          >
            <For each={rows()}>
              {(row, index) => {
                const connector = () =>
                  row.depth === 0
                    ? ""
                    : `${row.continuation.map((hasNext) => (hasNext ? "│  " : "   ")).join("")}${row.isLast ? "└─ " : "├─ "}`
                if (row.kind === "group") {
                  const style = agentType(row.agentName, theme())
                  return (
                    <box
                      flexDirection="row"
                      alignItems="center"
                      width="100%"
                      paddingLeft={1}
                      paddingRight={1}
                      onMouseUp={() => toggle(row.key)}
                    >
                      <text fg={theme().muted} flexShrink={0}>
                        {connector()}
                      </text>
                      <text fg={cursor(index()) ? theme().primary : theme().muted} flexShrink={0}>
                        {`${row.nodes.length} ${row.agentName} collapsed`}
                      </text>
                      <text fg={style.color} flexShrink={0} paddingLeft={2}>
                        {agentTreeSparkline(row.nodes.map((node) => node.totalTokens))}
                      </text>
                      <box flexGrow={1} />
                      <text
                        fg={cursor(index()) && keys.action() === 0 ? theme().primary : theme().muted}
                        flexShrink={0}
                      >
                        expand ▶
                      </text>
                    </box>
                  )
                }
                const node = row.node
                const style = agentType(agentName(node.session), theme())
                const status = statusGlyph(node.status, theme())
                const childSummary =
                  node.children.length === 0
                    ? ""
                    : `${node.children.length} ${node.children.length === 1 ? "sub" : "subs"}`
                return (
                  <box flexDirection="row" alignItems="center" width="100%" paddingLeft={1} paddingRight={1}>
                    <text fg={theme().muted} flexShrink={0}>
                      {connector()}
                    </text>
                    <text fg={style.color} flexShrink={0} width={2}>
                      {style.icon}
                    </text>
                    <text fg={cursor(index()) ? theme().primary : theme().text} flexShrink={0}>
                      <b>{agentName(node.session)}</b>
                    </text>
                    <Show when={status.glyph}>
                      <text fg={status.color} paddingLeft={1} flexShrink={0}>
                        {status.glyph}
                      </text>
                    </Show>
                    <Show when={node.killed}>
                      <text fg={theme().muted} flexShrink={0}>
                        {" "}
                        killed
                      </text>
                    </Show>
                    <Show when={childSummary}>
                      <text fg={theme().muted} flexShrink={0}>
                        {" "}
                        {childSummary}
                      </text>
                    </Show>
                    <box flexGrow={1} />
                    <Show when={row.depth > 0}>
                      <MagnitudeBar
                        value={node.totalTokens}
                        max={root()?.totalTokens ?? 0}
                        color={style.color}
                        theme={theme()}
                      />
                    </Show>
                    <box flexDirection="row" justifyContent="flex-end" width={12} flexShrink={0}>
                      <text fg={node.isPathToRunning ? theme().text : theme().muted}>
                        {formatTokens(node.totalTokens)} tok
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
