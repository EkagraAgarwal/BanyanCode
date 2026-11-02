import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, For, Show } from "solid-js"
import { palette } from "../../theme"

const ROUNDED = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
  topT: "",
  bottomT: "",
  leftT: "",
  rightT: "",
  cross: "",
}

interface AttentionItem {
  readonly key: string
  readonly label: string
  readonly color: "info" | "warning"
}

/**
 * Ported from v1 `component/attention-strip.tsx`, narrowed to the data v2
 * exposes: pending permission requests and question forms. v1 also listed
 * blocked mesh peers, but the v2 mesh status carries no `blockedReason`.
 */
export function AttentionStrip(props: { readonly context: Context; readonly sessionID: string }) {
  const theme = () => palette(props.context.theme)
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  // Matches the host's own pending list: a root session owns its family's
  // permissions and questions; a subagent only ever sees global questions.
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return props.context.data.session
      .family(props.sessionID)
      .flatMap((id) => props.context.data.session.permission.list(id) ?? [])
  })
  const forms = createMemo(() => {
    const global = props.context.data.session.form.list("global", props.context.location) ?? []
    if (session()?.parentID) return global
    return props.context.data.session
      .family(props.sessionID)
      .flatMap((id) => props.context.data.session.form.list(id) ?? [])
      .concat(global)
  })
  const count = createMemo(() => permissions().length + forms().length)
  const items = createMemo<AttentionItem[]>(() => {
    const result: AttentionItem[] = []
    if (permissions().length > 0) {
      const size = permissions().length
      result.push({
        key: "permission",
        label: `${size} permission${size === 1 ? "" : "s"} awaiting`,
        color: "warning",
      })
    }
    if (forms().length > 0) {
      const size = forms().length
      result.push({
        key: "question",
        label: `${size} question${size === 1 ? "" : "s"} awaiting`,
        color: "info",
      })
    }
    return result
  })

  return (
    <Show when={items().length > 0}>
      <box flexDirection="row" alignItems="center" gap={2} paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text fg={theme().error}>{`▲ ${count()} need attention`}</text>
        <For each={items()}>
          {(item) => (
            <box
              customBorderChars={ROUNDED}
              border={["left", "right", "top", "bottom"]}
              borderColor={item.color === "warning" ? theme().warning : theme().info}
              flexShrink={0}
            >
              <box paddingLeft={1} paddingRight={1}>
                <text fg={theme().text}>{item.label}</text>
              </box>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}
