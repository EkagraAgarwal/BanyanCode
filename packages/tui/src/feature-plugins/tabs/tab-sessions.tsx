/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, createResource, createMemo, For, Show } from "solid-js"
import { useToast } from "../../ui/toast"
import { toHex } from "../../util/color"

const id = "internal:tab-sessions"

interface SessionItem {
  id: string
  parentID?: string
  title: string
  agent?: string
  time?: { created: number; updated: number }
  version?: string
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const toast = useToast()
  const [refreshTrigger, setRefreshTrigger] = createSignal(0)

  const [sessions] = createResource<SessionItem[]>(async () => {
    try {
      const result = await props.api.client.session.list({})
      return (result.data ?? []) as SessionItem[]
    } catch {
      return []
    }
  })

  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [editingTitle, setEditingTitle] = createSignal("")

  const rootSessions = createMemo(() =>
    (sessions() ?? []).filter((s) => !s.parentID).sort((a, b) =>
      (b.time?.updated ?? 0) - (a.time?.updated ?? 0)
    )
  )

  const children = (parentID: string) =>
    (sessions() ?? []).filter((s) => s.parentID === parentID)

  const timeAgo = (ts?: number) => {
    if (!ts) return "—"
    const diff = Date.now() - ts
    const s = Math.floor(diff / 1000)
    if (s < 60) return `${s}s ago`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  }

  const startEdit = (s: SessionItem) => {
    setEditingId(s.id)
    setEditingTitle(s.title)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditingTitle("")
  }

  const saveEdit = async (s: SessionItem) => {
    const newTitle = editingTitle().trim()
    if (!newTitle || newTitle === s.title) {
      cancelEdit()
      return
    }
    try {
      await props.api.client.session.update({
        sessionID: s.id as any,
        title: newTitle,
      })
      toast.show({ message: `Renamed to "${newTitle}"`, variant: "success" })
      setRefreshTrigger((n) => n + 1)
    } catch (e) {
      toast.show({ message: `Rename failed: ${String(e)}`, variant: "error" })
    }
    cancelEdit()
  }

  return (
    <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
      <box flexDirection="column" paddingTop={1} gap={1}>
        <text fg={toHex(theme().text)}><b>Sessions</b></text>
        <Show when={sessions() !== undefined} fallback={<text fg={toHex(theme().textMuted)}>Loading...</text>}>
          <Show
            when={rootSessions().length > 0}
            fallback={<text fg={toHex(theme().textMuted)}>No sessions yet. Start one from the chat tab.</text>}
          >
            <For each={rootSessions()}>
              {(session) => <SessionRow
                session={session}
                children={children(session.id)}
                theme={theme()}
                isEditing={editingId() === session.id}
                editTitle={editingTitle()}
                onEditTitle={setEditingTitle}
                onStartEdit={() => startEdit(session)}
                onCancelEdit={cancelEdit}
                onSaveEdit={() => saveEdit(session)}
                timeAgo={timeAgo}
              />}
            </For>
          </Show>
        </Show>
      </box>
    </scrollbox>
  )
}

function SessionRow(props: {
  session: SessionItem
  children: SessionItem[]
  theme: any
  isEditing: boolean
  editTitle: string
  onEditTitle: (v: string) => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onSaveEdit: () => void
  timeAgo: (ts?: number) => string
}) {
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={toHex(props.theme.success)}>●</text>
        <Show
          when={props.isEditing}
          fallback={
            <box flexDirection="row" gap={1} flexGrow={1}>
              <text fg={toHex(props.theme.text)} flexGrow={1}>
                {props.session.title || "(untitled)"}
              </text>
              <text fg={toHex(props.theme.textMuted)}>{props.timeAgo(props.session.time?.updated)}</text>
              <text fg={toHex(props.theme.primary)}>[e rename]</text>
            </box>
          }
        >
          <input
            value={props.editTitle}
            onInput={(v: string) => props.onEditTitle(v)}
            onSubmit={() => props.onSaveEdit()}
            flexGrow={1}
          />
          <text fg={toHex(props.theme.success)}>[⏎ save]</text>
          <text fg={toHex(props.theme.textMuted)}>[esc cancel]</text>
        </Show>
      </box>
      <Show when={props.children.length > 0}>
        <box flexDirection="column" paddingLeft={3} marginTop={1}>
          <For each={props.children}>
            {(child) => (
              <box flexDirection="row" gap={1}>
                <text fg={toHex(props.theme.textMuted)}>└─</text>
                <text fg={toHex(props.theme.text)}>↳</text>
                <text fg={toHex(props.theme.textMuted)}>{child.agent ?? "subagent"}</text>
                <text fg={toHex(props.theme.textMuted)}>·</text>
                <text fg={toHex(props.theme.text)}>{child.title || "(no title)"}</text>
                <text fg={toHex(props.theme.textMuted)}>{props.timeAgo(child.time?.updated)}</text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 50,
    slots: {
      session_tab_sessions() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }
export default plugin
