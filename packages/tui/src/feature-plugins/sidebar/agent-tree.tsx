import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal, onMount } from "solid-js"

const id = "internal:sidebar-agent-tree"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const [sessions, setSessions] = createSignal<{ id: string; parentID?: string; title: string }[]>([])
  const theme = () => props.api.theme.current

  onMount(async () => {
    const list = await props.api.client.session.list({})
    setSessions(list.data ?? [])
  })

  const children = createMemo(() => sessions().filter((s) => s.parentID === props.session_id))

  const statusDot = (agent: string) => {
    const child = children().find((c) => c.title.toLowerCase().includes(agent.toLowerCase()))
    if (!child) return theme().textMuted
    return theme().success
  }

  return (
    <Show when={children().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          <text fg={theme().text}>
            <b>Agents</b>
          </text>
        </box>
        <Show when={open()}>
          <box paddingLeft={2}>
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={theme().primary}>●</text>
              <text fg={theme().text}>orchestrator <span style={{ fg: theme().textMuted }}>(you)</span></text>
            </box>
            <For each={children()}>
              {(child) => (
                <box flexDirection="row" gap={1}>
                  <text flexShrink={0} fg={statusDot(child.title)}>├</text>
                  <text fg={theme().text} wrapMode="word">
                    {child.title}
                  </text>
                </box>
              )}
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
