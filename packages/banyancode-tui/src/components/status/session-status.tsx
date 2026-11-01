import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, Show } from "solid-js"
import { formatMoney, formatTokens } from "../../data/format"
import { totalTokens } from "../../data/messages"
import { palette } from "../../theme"

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

/**
 * Ported from v1 `footer/session-footer.tsx`. YOLO and swarm indicators are
 * omitted here: workstreams 3e/3f own those switches, and v2 exposes them
 * through their own config/limits surfaces.
 */
export function SessionStatus(props: { readonly context: Context; readonly sessionID: string }) {
  const theme = () => palette(props.context.theme)

  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const location = createMemo(() => session()?.location ?? props.context.location)

  const label = createMemo(() => {
    const directory = location()?.directory
    if (!directory) return undefined
    const branch = props.context.data.location.vcs.info(location())?.branch.current
    return branch ? `${basename(directory)}:${branch}` : basename(directory)
  })

  const attention = createMemo(() => {
    const sessionID = props.sessionID
    const permissions = props.context.data.session.permission.list(sessionID)?.length ?? 0
    const forms = props.context.data.session.form.list(sessionID)?.length ?? 0
    return permissions + forms
  })

  const cost = createMemo(() => props.context.data.session.cost(props.sessionID))
  const tokens = createMemo(() => totalTokens(session()?.tokens))

  return (
    <box flexDirection="row" gap={2} alignItems="center" flexShrink={0}>
      <Show when={label()}>{(value) => <text fg={theme().muted}>{value()}</text>}</Show>
      <Show when={cost() > 0}>
        <text fg={theme().muted}>{formatMoney(cost())}</text>
      </Show>
      <Show when={tokens() > 0}>
        <text fg={theme().muted}>{formatTokens(tokens())} tok</text>
      </Show>
      <text fg={attention() > 0 ? theme().error : theme().success}>{`▲ ${attention()} need attention`}</text>
    </box>
  )
}
