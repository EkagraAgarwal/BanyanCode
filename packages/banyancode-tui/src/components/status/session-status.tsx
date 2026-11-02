import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { formatMoney, formatTokens } from "../../data/format"
import { totalTokens } from "../../data/messages"
import { palette } from "../../theme"


/**
 * Ported from v1 `footer/session-footer.tsx`, narrowed to what the v2 host
 * footer does not already render: the host owns the location label, context
 * usage and cost, so duplicating them only crowds the row. Only a non-zero
 * attention count is added, and never at narrow widths.
 */
export function SessionStatus(props: { readonly context: Context; readonly sessionID: string }) {
  const theme = () => palette(props.context.theme)
  const dimensions = useTerminalDimensions()

  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const attention = createMemo(() => {
    const sessionID = props.sessionID
    const permissions = props.context.data.session.permission.list(sessionID)?.length ?? 0
    const forms = props.context.data.session.form.list(sessionID)?.length ?? 0
    return permissions + forms
  })

  const cost = createMemo(() => props.context.data.session.cost(props.sessionID))
  const tokens = createMemo(() => totalTokens(session()?.tokens))

  // A zero count is never rendered. At narrow widths only attention survives;
  // cost and tokens are already shown by the host footer.
  const showDetails = createMemo(() => dimensions().width >= 88)
  const showAttention = createMemo(() => dimensions().width >= 60 && attention() > 0)

  return (
    <Show when={showAttention() || (showDetails() && (cost() > 0 || tokens() > 0))}>
      <box flexDirection="row" gap={2} alignItems="center" flexShrink={0}>
        <Show when={showDetails() && cost() > 0}>
          <text fg={theme().muted}>{formatMoney(cost())}</text>
        </Show>
        <Show when={showDetails() && tokens() > 0}>
          <text fg={theme().muted}>{formatTokens(tokens())} tok</text>
        </Show>
        <Show when={showAttention()}>
          <text fg={theme().error}>{`▲ ${attention()} need attention`}</text>
        </Show>
      </box>
    </Show>
  )
}
