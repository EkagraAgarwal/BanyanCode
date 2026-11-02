import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, Show } from "solid-js"
import { palette } from "../../theme"

/**
 * The home footer's leading item: the working directory, then the branch.
 * Claimed as `prepend: "home.footer.status"` so the host's footer row owns the
 * layout and this only contributes content outside BanyanCode.
 *
 * The directory is the only field that can be arbitrarily long, so it is the
 * one that yields: it truncates instead of wrapping or pushing the version off.
 */
export function HomeStatus(props: { readonly context: Context }) {
  const theme = () => palette(props.context.theme)
  // `context.location` is the routed location; fall back to the default before
  // the router has one so the footer never reads a half-built location.
  const location = () => props.context.location ?? props.context.data.location.default()
  const directory = createMemo(() => props.context.ui.format.path(location().directory))
  const branch = createMemo(() => {
    const current = location()
    return current ? props.context.data.location.vcs.info(current)?.branch.current : undefined
  })

  return (
    <box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0}>
      <text fg={theme().faint} wrapMode="none" truncate flexShrink={1} minWidth={0}>
        {directory()}
      </text>
      <Show when={branch()}>
        <text fg={theme().muted} wrapMode="none" truncate flexShrink={0}>
          {branch()}
        </text>
      </Show>
    </box>
  )
}
