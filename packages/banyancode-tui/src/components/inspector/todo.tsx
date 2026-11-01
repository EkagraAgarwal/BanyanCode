import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, For, Show } from "solid-js"
import { sessionTodos } from "../../data/messages"
import { palette } from "../../theme"

function marker(status: string): string {
  if (status === "completed") return "[✓]"
  if (status === "in_progress") return "[•]"
  if (status === "cancelled") return "[-]"
  return "[ ]"
}

/** Ported from v1 `inspector/todo.tsx` (uses v2's sessionTodos extraction). */
export function TodoPanel(props: { readonly context: Context; readonly sessionID: string }) {
  const theme = () => palette(props.context.theme)
  const list = createMemo(() =>
    sessionTodos(
      props.context.data.session.message.list(props.sessionID),
      props.context.data.session.get(props.sessionID)?.revert?.messageID,
    ),
  )
  const completed = createMemo(() => list().filter((item) => item.status === "completed").length)

  return (
    <box>
      <text fg={theme().primary} marginBottom={1}>
        TODO {completed()}/{list().length}
      </text>
      <Show when={list().length > 0} fallback={<text fg={theme().muted}>No tasks</text>}>
        <box flexDirection="column" gap={0}>
          <For each={list()}>
            {(item) => (
              <text
                fg={
                  item.status === "completed"
                    ? theme().muted
                    : item.status === "cancelled"
                      ? theme().faint
                      : theme().text
                }
              >
                {marker(item.status)} {item.content}
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
