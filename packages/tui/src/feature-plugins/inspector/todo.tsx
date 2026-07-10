/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show } from "solid-js"
import { TodoItem } from "../../component/todo-item"
import { toHex } from "../../util/color"

const id = "internal:inspector-todo"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.todo(props.session_id))

  const completedCount = createMemo(() => list().filter((item) => item.status === "completed").length)
  const totalCount = createMemo(() => list().length)

  return (
    <box>
      <text fg={toHex(theme().primary)} marginBottom={1}>
        TODO {completedCount()}/{totalCount()}
      </text>
      <Show
        when={list().length > 0}
        fallback={
          <text fg={toHex(theme().textMuted)}>No tasks</text>
        }
      >
        <box flexDirection="column" gap={0}>
          <For each={list()}>{(item) => <TodoItem status={item.status} content={item.content} />}</For>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
    slots: {
      session_inspector(_ctx, props) {
        const session_id = (props as { session_id?: string }).session_id ?? ""
        return <View api={api} session_id={session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
