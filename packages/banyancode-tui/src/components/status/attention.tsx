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
 * Pending permissions and questions for a session, counted the way the host
 * presents them: a root session owns its family's permissions and questions
 * (plus global questions); a subagent only ever sees global questions.
 */
export function attentionBreakdown(context: Context, sessionID: string) {
  const session = context.data.session.get(sessionID)
  const family = context.data.session.family(sessionID)
  const permissions =
    session?.parentID === undefined
      ? family.flatMap((id) => context.data.session.permission.list(id) ?? []).length
      : 0
  const global = context.data.session.form.list("global", context.location) ?? []
  const forms =
    session?.parentID === undefined
      ? family.flatMap((id) => context.data.session.form.list(id) ?? []).length + global.length
      : global.length
  return { permissions, forms, count: permissions + forms }
}

/**
 * Ported from v1 `component/attention-strip.tsx`, narrowed to the data v2
 * exposes: pending permission requests and question forms. v1 also listed
 * blocked mesh peers, but the v2 mesh status carries no `blockedReason`.
 */
export function AttentionStrip(props: { readonly context: Context; readonly sessionID: string }) {
  const theme = () => palette(props.context.theme)
  const summary = createMemo(() => attentionBreakdown(props.context, props.sessionID))
  const count = createMemo(() => summary().count)
  const items = createMemo<AttentionItem[]>(() => {
    const result: AttentionItem[] = []
    const permissions = summary().permissions
    if (permissions > 0) {
      result.push({
        key: "permission",
        label: `${permissions} permission${permissions === 1 ? "" : "s"} awaiting`,
        color: "warning",
      })
    }
    const forms = summary().forms
    if (forms > 0) {
      result.push({
        key: "question",
        label: `${forms} question${forms === 1 ? "" : "s"} awaiting`,
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
