import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, For, Show } from "solid-js"
import { palette } from "../../theme"

/**
 * Ported from v1 `inspector/pending-actions.tsx`. v2 surfaces permissions and
 * forms (questions) per session, and running state per session; there are no
 * per-peer abort/view/timeline keybinds in a plugin, so rows link to the
 * session instead of advertising keys that do nothing.
 */
export function PendingActions(props: { readonly context: Context; readonly sessionID: string }) {
  const theme = () => palette(props.context.theme)

  const running = createMemo(() => {
    const family = props.context.data.session.family(props.sessionID)
    return family.filter((id) => props.context.data.session.status(id) === "running")
  })

  const permissions = createMemo(() => props.context.data.session.permission.list(props.sessionID) ?? [])
  const forms = createMemo(() => props.context.data.session.form.list(props.sessionID) ?? [])
  const total = createMemo(() => running().length + permissions().length + forms().length)

  return (
    <box>
      <text fg={theme().text}>
        PENDING ACTIONS
        <Show when={total() > 0}>
          <span style={{ fg: theme().primary }}> {total()}</span>
        </Show>
      </text>
      <Show
        when={total() > 0}
        fallback={
          <box flexDirection="column" paddingLeft={2} gap={0}>
            <box flexDirection="row" gap={1} alignItems="center">
              <text fg={theme().muted}>∅</text>
              <text fg={theme().text}>All caught up</text>
            </box>
            <text fg={theme().muted}>Pending questions and permission requests will appear here.</text>
          </box>
        }
      >
        <box gap={0}>
          <For each={running()}>
            {(id) => (
              <box flexDirection="row" gap={1} onMouseDown={() => props.context.ui.router.navigate({ type: "session", sessionID: id })}>
                <text fg={theme().muted}>•</text>
                <text fg={theme().text}>{props.context.data.session.get(id)?.agent ?? "agent"}</text>
                <text fg={theme().muted}>{props.context.data.session.get(id)?.title ?? id}</text>
              </box>
            )}
          </For>
          <For each={permissions()}>
            {(request) => (
              <box flexDirection="column" gap={0}>
                <box flexDirection="row" gap={1}>
                  <text fg={theme().warning}>•</text>
                  <text fg={theme().text}>Permission: {request.action}</text>
                </box>
                <text fg={theme().muted}> respond from the prompt</text>
              </box>
            )}
          </For>
          <For each={forms()}>
            {(form) => (
              <box flexDirection="column" gap={0}>
                <box flexDirection="row" gap={1}>
                  <text fg={theme().info}>•</text>
                  <text fg={theme().text}>Question: {form.title || "agent query"}</text>
                </box>
                <text fg={theme().muted}> respond from the prompt</text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
