import type { Context } from "@opencode/plugin/tui/context"
import { For, Show } from "solid-js"
import type { IntelLive } from "../../data/live"
import { palette } from "../../theme"

/**
 * Ported from v1 `sidebar/codegraph-intel-panel.tsx`. v1 fed this from prompt
 * intercepts that called endpoints which never shipped; here the buffer is fed
 * by whatever command workstream 3h wires up. Empty state keeps the hint.
 */
export function CodegraphIntelPanel(props: { readonly context: Context; readonly intel: IntelLive }) {
  const theme = () => palette(props.context.theme)
  return (
    <box flexDirection="column" gap={0}>
      <text fg={theme().primary}>
        <b>CODEGRAPH INTEL</b>
      </text>
      <Show
        when={props.intel.entries().length > 0}
        fallback={
          <text fg={theme().muted}>Use /codegraph-search, /repo-find-subsystem, or /codegraph-find-routes.</text>
        }
      >
        <For each={props.intel.entries()}>
          {(entry) => (
            <box flexDirection="column" gap={0}>
              <text fg={theme().muted}>
                {entry.kind}: {entry.query}
              </text>
              <text fg={theme().text}>{entry.summary}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}
