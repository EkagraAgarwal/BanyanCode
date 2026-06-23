/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, createResource, createMemo, onCleanup, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useToast } from "../../ui/toast"
import { useEvent } from "../../context/event"
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
  const event = useEvent()
  const [refreshTrigger, setRefreshTrigger] = createSignal(0)

  const [sessions] = createResource<SessionItem[], number>(refreshTrigger, async () => {
    try {
      const result = await props.api.client.session.list({})
      return (result.data ?? []) as SessionItem[]
    } catch {
      return []
    }
  })

  // Renames (and any other session mutation) emit session.updated; refetch so the new title shows immediately.
  onCleanup(event.on("session.updated", () => setRefreshTrigger((n) => n + 1)))

  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [editingTitle, setEditingTitle] = createSignal("")
  const [selectedId, setSelectedId] = createSignal<string | null>(null)

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

  useKeyboard((evt) => {
    if (editingId() !== null) {
      if (evt.name === "escape") cancelEdit()
      return
    }
    if (evt.name !== "e") return
    const target = selectedId() ?? rootSessions()[0]?.id
    const match = (sessions() ?? []).find((s) => s.id === target)
    if (match) startEdit(match)
  })

  return (
    <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
      <box flexDirection="column" paddingTop={1} gap={1}>
        <text fg={toHex(theme().text)}><b>Sessions</b></text>
        <Show when={sessions() !== undefined} fallback={
          <text fg={toHex(theme().textMuted)} paddingLeft={2} paddingTop={2}>Loading…</text>
        }>
          <Show
            when={rootSessions().length > 0}
            fallback={
              <box flexDirection="column" paddingLeft={2} paddingTop={2} gap={1}>
                <box flexDirection="row" gap={2} alignItems="center">
                  <text fg={toHex(theme().textMuted)}>∅</text>
                  <text fg={toHex(theme().text)}>No sessions yet</text>
                </box>
                <box paddingLeft={4}>
                  <text fg={toHex(theme().textMuted)}>Start a session from the chat tab with <b>/new</b>.</text>
                </box>
              </box>
            }
          >
            <For each={rootSessions()}>
              {(session) => <SessionRow
                session={session}
                children={children(session.id)}
                theme={theme()}
                editingId={editingId()}
                editTitle={editingTitle()}
                selectedId={selectedId()}
                onSelect={setSelectedId}
                onEditTitle={setEditingTitle}
                onStartEdit={startEdit}
                onCancelEdit={cancelEdit}
                onSaveEdit={saveEdit}
                timeAgo={timeAgo}
              />}
            </For>
          </Show>
        </Show>
      </box>
    </scrollbox>
  )
}

interface RowControllerProps {
  theme: any
  editingId: string | null
  editTitle: string
  selectedId: string | null
  onSelect: (id: string) => void
  onEditTitle: (v: string) => void
  onStartEdit: (s: SessionItem) => void
  onCancelEdit: () => void
  onSaveEdit: (s: SessionItem) => void
  timeAgo: (ts?: number) => string
}

function SessionRow(props: RowControllerProps & { session: SessionItem; children: SessionItem[] }) {
  return (
    <box flexDirection="column">
      <box
        flexDirection="row"
        gap={1}
        alignItems="center"
        onMouseDown={() => props.onSelect(props.session.id)}
      >
        <text fg={toHex(props.theme.success)}>●</text>
        <EditableTitle controller={props} session={props.session} />
      </box>
      <Show when={props.children.length > 0}>
        <box flexDirection="column" paddingLeft={3} marginTop={1}>
          <For each={props.children}>
            {(child) => (
              <box
                flexDirection="row"
                gap={1}
                alignItems="center"
                onMouseDown={() => props.onSelect(child.id)}
              >
                <text fg={toHex(props.theme.textMuted)}>└─</text>
                <text fg={toHex(props.theme.text)}>↳</text>
                <text fg={toHex(props.theme.textMuted)}>{child.agent ?? "subagent"}</text>
                <text fg={toHex(props.theme.textMuted)}>·</text>
                <EditableTitle controller={props} session={child} />
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

function EditableTitle(props: { controller: RowControllerProps; session: SessionItem }) {
  const c = () => props.controller
  const isEditing = () => c().editingId === props.session.id
  const isSelected = () => c().selectedId === props.session.id
  return (
    <Show
      when={isEditing()}
      fallback={
        <box
          flexDirection="row"
          gap={1}
          flexGrow={1}
          onMouseDown={() => c().onStartEdit(props.session)}
        >
          <text fg={toHex(c().theme.text)} flexGrow={1}>
            {props.session.title || "(untitled)"}
          </text>
          <text fg={toHex(c().theme.textMuted)}>{c().timeAgo(props.session.time?.updated)}</text>
          <text fg={toHex(isSelected() ? c().theme.primary : c().theme.textMuted)}>[e rename]</text>
        </box>
      }
    >
      <input
        value={c().editTitle}
        onInput={(v: string) => c().onEditTitle(v)}
        onSubmit={() => c().onSaveEdit(props.session)}
        flexGrow={1}
        ref={(r: { focus(): void } | undefined) => {
          // Only auto-focus the first time the input mounts. Subsequent
          // re-renders must not steal focus — the user may have tabbed
          // elsewhere to abort the rename.
          if (r) setTimeout(() => r.focus(), 1)
        }}
      />
      <text fg={toHex(c().theme.success)}>[⏎ save]</text>
      <text fg={toHex(c().theme.textMuted)} onMouseDown={() => c().onCancelEdit()}>[esc cancel]</text>
    </Show>
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
