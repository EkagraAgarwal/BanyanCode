/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal, onMount, onCleanup } from "solid-js"
import { useSync } from "../../context/sync"
import { toHex } from "../../util/color"

const id = "internal:sidebar-agent-tree"

type SessionInfo = {
  id: string
  parentID?: string
  title: string
  summary?: {
    additions: number
    deletions: number
    files: number
  }
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const sync = useSync()
  const [sessions, setSessions] = createSignal<SessionInfo[]>([])
  const [statusMap, setStatusMap] = createSignal<Record<string, { type: string }>>({})
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current

  const refreshSessionsAndStatuses = async () => {
    const list = await props.api.client.session.list({})
    setSessions(list.data ?? [])
    const statuses: Record<string, { type: string }> = {}
    for (const s of list.data ?? []) {
      if (s.parentID === props.session_id) {
        const st = await props.api.state.session.status(s.id)
        if (st) statuses[s.id] = st as { type: string }
      }
    }
    setStatusMap(statuses)
  }

  let unsubs: Array<() => void> = []
  onCleanup(() => unsubs.forEach((u) => u()))

  onMount(async () => {
    try {
      const { useEvent } = await import("../../context/event")
      const ev = useEvent()
      unsubs.push(ev.on("session.status" as any, (event: any) => {
        setStatusMap((prev) => ({ ...prev, [event.properties.sessionID]: event.properties.status }))
      }))
      unsubs.push(ev.on("session.updated" as any, async () => {
        await refreshSessionsAndStatuses()
      }))
    } catch {
      // SDK context not available (e.g., in test environment) - skip event subscription
    }

    await refreshSessionsAndStatuses()
  })

  const children = createMemo(() => sessions().filter((s) => s.parentID === props.session_id))

  const activeCount = createMemo(() => children().length)

  const statusText = (session: SessionInfo): string => {
    if (session.summary && session.summary.files > 0) return "finished"
    return ""
  }

  const toolsUsed = (sessionID: string) => {
    const messages = sync.data.message[sessionID] ?? []
    const toolNames = new Set<string>()
    for (const msg of messages) {
      const parts = sync.data.part[msg.id] ?? []
      for (const part of parts) {
        if (part.type === "tool" && part.tool) {
          toolNames.add(part.tool)
        }
      }
    }
    return Array.from(toolNames)
  }

  return (
    <Show when={children().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
          <text fg={toHex(theme().text)}>{open() ? "▼" : "▶"}</text>
          <text fg={toHex(theme().text)}>
            <b>AGENT TREE</b>
          </text>
          <text fg={toHex(theme().textMuted)}>
            {" " + activeCount() + " active"}
          </text>
        </box>
        <Show when={open()}>
          <box paddingLeft={1}>
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={toHex(theme().textMuted)}>─</text>
              <text flexShrink={0} fg={toHex(theme().primary)}>●</text>
              <text fg={toHex(theme().text)}>orchestrator <span style={{ fg: toHex(theme().textMuted) }}>(you)</span></text>
            </box>
            <For each={children()}>
              {(child, index) => {
                const isLast = () => index() === children().length - 1
                const st = statusMap()[child.id]
                const iconFg = !st || st.type === "idle" ? theme().textMuted : theme().primary
                const iconChar = !st || st.type === "idle" ? "○" : "●"
                const text = statusText(child)
                const connector = () => isLast() ? "└─" : "├─"
                const tools = () => toolsUsed(child.id)

                return (
                  <box gap={0}>
                    <box flexDirection="row" gap={0} paddingLeft={1}>
                      <text flexShrink={0} fg={toHex(theme().textMuted)}>{connector()}</text>
                      <text flexShrink={0} fg={toHex(iconFg)}>
                        {iconChar}
                      </text>
                      <text fg={toHex(theme().text)} wrapMode="word">{child.title}</text>
                      <Show when={text}>
                        <text fg={toHex(theme().textMuted)}> {text}</text>
                      </Show>
                    </box>
                    <Show when={tools().length > 0}>
                      <box flexDirection="row" gap={0} paddingLeft={1}>
                        <text flexShrink={0} fg={toHex(theme().textMuted)}>
                          {isLast() ? "   " : "│  "}
                        </text>
                        <text fg={toHex(theme().textMuted)}>
                          {`└─ tools: ${tools().join(", ")}`}
                        </text>
                      </box>
                    </Show>
                  </box>
                )
              }}
            </For>
          </box>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
