/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, createResource, createMemo, onCleanup, For, Show } from "solid-js"
import { useDialog } from "../../ui/dialog"
import { useRoute } from "../../context/route"
import { useEvent } from "../../context/event"
import { useSync } from "../../context/sync"
import { useProject } from "../../context/project"
import { toHex } from "../../util/color"
import { setActiveTab } from "./state"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { DialogSessionDeleteFailed } from "../../component/dialog-session-delete-failed"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { errorMessage } from "../../util/error"
import { RoundedBorder } from "../../ui/border.ts"

const id = "internal:tab-sessions"

interface SessionItem {
  id: string
  parentID?: string
  title: string
  agent?: string
  workspaceID?: string
  time?: { created: number; updated: number }
  version?: string
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const event = useEvent()
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const project = useProject()
  const [refreshTrigger, setRefreshTrigger] = createSignal(0)

  const notify = (message: string) => {
    void props.api.attention.notify({
      message,
      notification: false,
      sound: false,
    })
  }

  const [sessions] = createResource<SessionItem[], number>(refreshTrigger, async () => {
    try {
      const result = await props.api.client.session.list({})
      return (result.data ?? []) as SessionItem[]
    } catch {
      return []
    }
  })

  onCleanup(event.on("session.updated", () => setRefreshTrigger((n) => n + 1)))

  const merged = createMemo<SessionItem[]>(() => {
    const live = sync.data.session
    if (!live || live.length === 0) return sessions() ?? []
    const byID = new Map<string, SessionItem>()
    for (const s of live) byID.set(s.id, s as SessionItem)
    for (const s of sessions() ?? []) if (!byID.has(s.id)) byID.set(s.id, s)
    return Array.from(byID.values())
  })

  const rootSessions = createMemo(() =>
    merged()
      .filter((s) => !s.parentID)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)),
  )

  const children = (parentID: string) => merged().filter((s) => s.parentID === parentID)

  const statusOf = (sessionID: string) => sync.data.session_status?.[sessionID]

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

  const dotColor = (sessionID: string) => {
    const status = statusOf(sessionID)?.type
    if (status === "busy" || status === "retry") return toHex(theme().success)
    return toHex(theme().textMuted)
  }

  const createNew = async () => {
    try {
      const res = await props.api.client.session.create({})
      const created = (res as any)?.data
      const newID = created?.id ?? (res as any)?.id
      if (newID) {
        route.navigate({ type: "session", sessionID: newID })
        setActiveTab("chat")
        notify("Session created")
        setRefreshTrigger((n) => n + 1)
      } else {
        notify("Could not create session")
      }
    } catch (e) {
      notify(`Create failed: ${String(e)}`)
    }
  }

  const continueSession = (s: SessionItem) => {
    route.navigate({ type: "session", sessionID: s.id })
    setActiveTab("chat")
  }

  const renameSession = (s: SessionItem) => {
    dialog.replace(() => <DialogSessionRename session={s.id} />)
  }

  const deleteSession = async (s: SessionItem) => {
    const kids = children(s.id)
    const ok = await DialogConfirm.show(
      dialog,
      "Delete session",
      kids.length > 0
        ? `Delete "${s.title || "(untitled)"}" and its ${kids.length} subagent session${kids.length === 1 ? "" : "s"}? This cannot be undone.`
        : `Delete "${s.title || "(untitled)"}"? This cannot be undone.`,
    )
    if (!ok) return

    const workspaceID = s.workspaceID
    const title = s.title || "(untitled)"

    const runDelete = async (): Promise<boolean> => {
      try {
        const result = await props.api.client.session.delete({ sessionID: s.id })
        if ((result as any)?.error) {
          if (workspaceID) {
            const workspace = project.workspace.get(workspaceID)
            dialog.replace(() => (
              <DialogSessionDeleteFailed
                session={title}
                workspace={workspace?.name ?? workspaceID}
                onDone={() => {
                  dialog.clear()
                  setRefreshTrigger((n) => n + 1)
                }}
                onDelete={async () => {
                  try {
                    const r = await props.api.client.session.delete({ sessionID: s.id })
                    if ((r as any)?.error) {
                      notify(`Delete failed: ${errorMessage((r as any).error)}`)
                      return false
                    }
                    notify("Session deleted")
                    return true
                  } catch (err) {
                    notify(`Delete failed: ${errorMessage(err)}`)
                    return false
                  }
                }}
              />
            ))
            return false
          }
          notify(`Delete failed: ${errorMessage((result as any).error)}`)
          return false
        }
        notify("Session deleted")
        return true
      } catch (err) {
        if (workspaceID) {
          const workspace = project.workspace.get(workspaceID)
          dialog.replace(() => (
            <DialogSessionDeleteFailed
              session={title}
              workspace={workspace?.name ?? workspaceID}
              onDone={() => {
                dialog.clear()
                setRefreshTrigger((n) => n + 1)
              }}
            />
          ))
          return false
        }
        notify(`Delete failed: ${errorMessage(err)}`)
        return false
      }
    }

    const ok2 = await runDelete()
    if (ok2) setRefreshTrigger((n) => n + 1)
  }

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box flexDirection="row" justifyContent="space-between" alignItems="center" paddingLeft={2} paddingRight={2} paddingTop={1}>
        <text fg={toHex(theme().text)}>
          <b>Sessions</b>
        </text>
        <text fg={toHex(theme().primary)} onMouseUp={createNew}>
          [+ New session]
        </text>
      </box>
      <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
        <box flexDirection="column" paddingTop={1} gap={1}>
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
                    <text fg={toHex(theme().textMuted)}>Click <b>+ New session</b> above to start one.</text>
                  </box>
                </box>
              }
            >
              <For each={rootSessions()}>
                {(session) => (
                  <box paddingLeft={2} paddingRight={2}>
                    <SessionCard
                      session={session}
                      children={children(session.id)}
                      theme={theme()}
                      dotColor={dotColor(session.id)}
                      onContinue={() => continueSession(session)}
                      onRename={() => renameSession(session)}
                      onDelete={() => deleteSession(session)}
                      timeAgo={timeAgo}
                    />
                  </box>
                )}
              </For>
            </Show>
          </Show>
        </box>
      </scrollbox>
    </box>
  )
}

function SessionCard(props: {
  session: SessionItem
  children: SessionItem[]
  theme: any
  dotColor: string
  onContinue: () => void
  onRename: () => void
  onDelete: () => void
  timeAgo: (ts?: number) => string
}) {
  return (
    <box
      flexDirection="column"
      border={["left", "right", "top", "bottom"]}
      borderColor={props.theme.border}
      customBorderChars={RoundedBorder.customBorderChars}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
    >
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={props.dotColor}>●</text>
        <text fg={toHex(props.theme.text)} flexGrow={1}>
          {props.session.title || "(untitled)"}
        </text>
        <text fg={toHex(props.theme.textMuted)}>{props.timeAgo(props.session.time?.updated)}</text>
      </box>
      <Show when={props.children.length > 0}>
        <box flexDirection="column" paddingLeft={3} marginTop={0}>
          <For each={props.children}>
            {(child) => (
              <box flexDirection="row" gap={1} alignItems="center">
                <text fg={toHex(props.theme.textMuted)}>└─</text>
                <text fg={toHex(props.theme.textMuted)}>{child.agent ?? "subagent"}</text>
                <text fg={toHex(props.theme.textMuted)}>·</text>
                <text fg={toHex(props.theme.text)} flexGrow={1}>{child.title || "(untitled)"}</text>
                <text fg={toHex(props.theme.textMuted)}>{props.timeAgo(child.time?.updated)}</text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <box flexDirection="row" gap={2} paddingTop={0}>
        <text fg={toHex(props.theme.success)} onMouseUp={props.onContinue}>continue</text>
        <text fg={toHex(props.theme.info)} onMouseUp={props.onRename}>rename</text>
        <text fg={toHex(props.theme.error)} onMouseUp={props.onDelete}>delete</text>
      </box>
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