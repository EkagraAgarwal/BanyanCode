import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"

const id = "internal:tabs-tab-agents"

interface SessionItem {
  id: string
  parentID?: string
  title: string
  createdAt?: number
}

import { toHex } from "../../util/color"

function SessionTreeNode(props: { session: SessionItem; children: SessionItem[]; theme: () => TuiThemeCurrent }) {
  const [open, setOpen] = createSignal(true)

  return (
    <box flexDirection="column" paddingLeft={2}>
      <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
        <text fg={props.theme().textMuted}>{open() ? "▼" : "▶"}</text>
        <text fg={props.theme().primary} wrapMode="word">
          {props.session.title}
        </text>
        <text fg={props.theme().textMuted}> ({props.session.id.slice(0, 8)})</text>
      </box>
      <Show when={open()}>
        <For each={props.children}>
          {(child) => (
            <SessionTreeNode
              session={child}
              children={[]}
              theme={props.theme}
            />
          )}
        </For>
      </Show>
    </box>
  )
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [sessions, setSessions] = createSignal<SessionItem[]>([])
  const [loading, setLoading] = createSignal(true)

  onMount(async () => {
    try {
      const list = await props.api.client.session.list({})
      setSessions(list.data ?? [])
    } catch {
      // stub
    } finally {
      setLoading(false)
    }
  })

  const rootSessions = createMemo(() => sessions().filter((s) => !s.parentID))

  const getChildren = (parentID: string) => sessions().filter((s) => s.parentID === parentID)

  return (
    <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
      <box flexDirection="column" paddingTop={1}>
        <text fg={toHex(theme().text)}>
          <b>Agent Sessions</b>
        </text>
        {loading() ? (
          <text fg={toHex(theme().textMuted)}>Loading...</text>
        ) : rootSessions().length === 0 ? (
          <text fg={toHex(theme().textMuted)}>No sessions found.</text>
        ) : (
          <For each={rootSessions()}>
            {(session) => (
              <SessionTreeNode
                session={session}
                children={getChildren(session.id)}
                theme={theme}
              />
            )}
          </For>
        )}
      </box>
    </scrollbox>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 40,
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
