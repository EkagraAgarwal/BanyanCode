/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { RGBA } from "@opentui/core"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo } from "solid-js"
import { useSync } from "../../context/sync"

const id = "internal:inspector-graph-explorer"

function toHex(color: { r: number; g: number; b: number; a?: number } | string): string {
  if (typeof color === "string") return color
  const a = color.a !== undefined ? Math.round(color.a * 255).toString(16).padStart(2, "0") : ""
  return `#${color.r.toString(16).padStart(2, "0")}${color.g.toString(16).padStart(2, "0")}${color.b.toString(16).padStart(2, "0")}${a}`
}

interface GraphNode {
  id: string
  label: string
  focused: boolean
}

// Static layout for v1: 1 focused node + up to 3 one-hop neighbors in a tree shape.
// The focused node is derived from the first user message's tool call name (placeholder:
// "auth.login" if no symbol is found). Neighbors are also placeholders for now.
function buildGraph(sessionID: string, messages: any[], parts: Record<string, any[]>): GraphNode[] {
  // Try to find the first tool in a user message to use as the focused symbol.
  let focusedLabel = "auth.login"
  for (const msg of messages) {
    if (msg.role !== "user") continue
    const msgParts = parts[msg.id] ?? []
    for (const part of msgParts) {
      if (part.type === "tool" && (part as any).tool) {
        focusedLabel = (part as any).tool
        break
      }
    }
    break
  }

  const focused: GraphNode = { id: "focused", label: focusedLabel, focused: true }
  const neighbors: GraphNode[] = [
    { id: "n1", label: "auth.logout", focused: false },
    { id: "n2", label: "user.session", focused: false },
  ]

  return [focused, ...neighbors]
}

type ThemeColors = {
  primary: RGBA
  textMuted: RGBA
  success: RGBA
  text: RGBA
}

// Renders a minimal node-link diagram using ASCII art characters.
// OpenTUI does not expose <line> or <shape> primitives in its component catalogue;
// all available rendering primitives are box, text, input, select, textarea,
// ascii_font, tab_select, scrollbox, code, diff, line_number, markdown, and text
// span modifiers. Falling back to Unicode/ASCII art for the graph visualization.
function AsciiGraph(props: { nodes: GraphNode[]; theme: ThemeColors }) {
  const { nodes, theme } = props
  const focused = nodes[0]
  const neighbors = nodes.slice(1)

  const fg = (c: RGBA) => toHex(c)
  const primary = fg(theme.primary)
  const textMuted = fg(theme.textMuted)
  const success = fg(theme.success)
  const text = fg(theme.text)

  return (
    <box>
      <text fg={textMuted}>GRAPH EXPLORER</text>
      {/* Focused node */}
      <box flexDirection="row" gap={0}>
        <text fg={success}>●</text>
        <text fg={textMuted}>──</text>
        <text fg={primary}>
          <b>{focused.label}</b>
        </text>
        <text fg={textMuted}> (focused)</text>
      </box>
      {/* Vertical trunk */}
      <box flexDirection="row" gap={0}>
        <text fg={textMuted}>│</text>
      </box>
      {/* Neighbors */}
      {neighbors.map((node, i) => (
        <box flexDirection="row" gap={0}>
          <text fg={textMuted}>├</text>
          <text fg={textMuted}>──</text>
          <text fg={text}>●</text>
          <text fg={textMuted}>──</text>
          <text fg={text}>{node.label}</text>
        </box>
      ))}
      {/* Navigation hint */}
      <text fg={textMuted}>↑/↓ navigate  enter focus  b back</text>
    </box>
  )
}

function View(props: { api: TuiPluginApi; sessionID: string }) {
  const sync = useSync()
  const theme = () => props.api.theme.current

  const graphNodes = createMemo(() => {
    const messages = sync.data.message[props.sessionID] ?? []
    return buildGraph(props.sessionID, messages, sync.data.part)
  })

  return (
    <box>
      <AsciiGraph nodes={graphNodes()} theme={theme()} />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 200,
    slots: {
      session_inspector(_ctx, slotProps) {
        const sessionID = (slotProps as { session_id?: string }).session_id
        if (!sessionID) return () => <box />
        return <View api={api} sessionID={sessionID} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin