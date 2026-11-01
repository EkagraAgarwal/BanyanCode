import type { Context } from "@opencode/plugin/tui/context"
import type { SessionInfo } from "@opencode/client"
import { createMemo, For, Show } from "solid-js"
import { formatMoney } from "../../data/format"
import { sessionAge } from "../../data/messages"
import { palette, type Palette } from "../../theme"

export function orderSessions(sessions: readonly SessionInfo[], pinned: readonly string[] = []): SessionInfo[] {
  const starred = new Set(pinned)
  const ordered = sessions
    .filter((session) => !session.parentID && session.time.archived === undefined)
    .sort((a, b) => b.time.updated - a.time.updated)
  return [
    ...ordered.filter((session) => starred.has(session.id)),
    ...ordered.filter((session) => !starred.has(session.id)),
  ]
}

function dotColor(context: Context, session: SessionInfo, theme: Palette) {
  const status = context.data.session.status(session.id)
  if (status === "running") return theme.success
  if (session.outcome === "failed") return theme.error
  return theme.muted
}

/**
 * Ported from v1 `tabs/tab-sessions.tsx`. v1 rendered this inside a
 * CHAT/SESSIONS/AGENTS tab bar; v2 uses native session tabs, so this is a
 * session-panel view instead.
 */
export function SessionsView(props: { readonly context: Context }) {
  const theme = () => palette(props.context.theme)
  const [pinned, setPinned] = props.context.storage.store("banyancode.sessions", {
    initial: { pinned: [] as string[] },
  })
  const sessions = createMemo(() => orderSessions(props.context.data.session.list(), pinned.pinned))
  const isPinned = (sessionID: string) => pinned.pinned.includes(sessionID)
  const togglePin = async (sessionID: string) => {
    await setPinned((draft) => {
      draft.pinned = draft.pinned.includes(sessionID)
        ? draft.pinned.filter((id) => id !== sessionID)
        : [...draft.pinned, sessionID]
    })
  }
  const children = (parentID: string) =>
    props.context.data.session.list().filter((session) => session.parentID === parentID)

  const create = async () => {
    const created = await props.context.client.session.create(
      props.context.location ? { location: { directory: props.context.location.directory } } : {},
    )
    props.context.ui.router.navigate({ type: "session", sessionID: created.id })
  }

  const rename = async (session: SessionInfo) => {
    const value = await props.context.ui.dialog.prompt({
      title: "Rename session",
      value: session.title ?? "",
    })
    if (value === undefined) return
    await props.context.client.session.update({ sessionID: session.id, title: value })
    props.context.ui.toast.show({ message: "Session renamed", variant: "success" })
  }

  const remove = async (session: SessionInfo) => {
    const kids = children(session.id).length
    const ok = await props.context.ui.dialog.confirm({
      title: "Delete session",
      message:
        kids > 0
          ? `Delete "${session.title ?? "(untitled)"}" and its ${kids} subagent session${kids === 1 ? "" : "s"}? This cannot be undone.`
          : `Delete "${session.title ?? "(untitled)"}"? This cannot be undone.`,
    })
    if (!ok) return
    await props.context.client.session.remove({ sessionID: session.id })
    props.context.ui.toast.show({ message: "Session deleted", variant: "success" })
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
        <text fg={theme().text}>
          <b>Sessions</b>
        </text>
        <text fg={theme().primary} onMouseUp={create}>
          [+ New session]
        </text>
      </box>
      <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
        <box flexDirection="column" paddingTop={1} gap={0}>
          <Show
            when={sessions().length > 0}
            fallback={
              <box flexDirection="column" paddingLeft={2} paddingTop={1} gap={0}>
                <box flexDirection="row" gap={1} alignItems="center">
                  <text fg={theme().muted}>∅</text>
                  <text fg={theme().text}>No sessions yet</text>
                </box>
                <text fg={theme().muted}>Click + New session above to start one.</text>
              </box>
            }
          >
            <For each={sessions()}>
              {(session) => (
                <box flexDirection="column" paddingLeft={2} paddingRight={2}>
                  <box flexDirection="row" gap={1} alignItems="center">
                    <text fg={dotColor(props.context, session, theme())}>●</text>
                    <text
                      fg={isPinned(session.id) ? theme().accent : theme().muted}
                      onMouseUp={() => void togglePin(session.id)}
                    >
                      {isPinned(session.id) ? "★" : "☆"}
                    </text>
                    <text
                      fg={theme().text}
                      flexGrow={1}
                      onMouseUp={() =>
                        props.context.ui.router.navigate({ type: "session", sessionID: session.id })
                      }
                    >
                      {session.title ?? "(untitled)"}
                    </text>
                    <text fg={theme().muted}>{sessionAge(session.time.updated)}</text>
                  </box>
                  <box flexDirection="row" gap={2} paddingLeft={1}>
                    <Show when={session.agent}>
                      <text fg={theme().muted}>{session.agent}</text>
                    </Show>
                    <Show when={session.cost > 0}>
                      <text fg={theme().muted}>{formatMoney(session.cost)}</text>
                    </Show>
                    <text
                      fg={theme().success}
                      onMouseUp={() =>
                        props.context.ui.router.navigate({ type: "session", sessionID: session.id })
                      }
                    >
                      continue
                    </text>
                    <text fg={theme().info} onMouseUp={() => void rename(session)}>
                      rename
                    </text>
                    <text fg={theme().error} onMouseUp={() => void remove(session)}>
                      delete
                    </text>
                  </box>
                </box>
              )}
            </For>
          </Show>
        </box>
      </scrollbox>
    </box>
  )
}
