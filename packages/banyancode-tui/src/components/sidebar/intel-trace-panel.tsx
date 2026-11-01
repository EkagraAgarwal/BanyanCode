import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, For, Show } from "solid-js"
import type { IntelLive } from "../../data/live"
import { palette } from "../../theme"

/**
 * Ported from v1 `sidebar/intel-trace-panel.tsx`.
 *
 * v1 listened to the `banyancode.intel.trace` endpoint, which never shipped,
 * so the panel was permanently empty. In v2 `banyancode.intel` has real
 * repository methods (query/explain/codeFind/...), but none of them is a
 * per-session tool trace — so the panel reads the shared intel buffer and
 * keeps a clean empty state instead of calling a method that does not exist.
 */
export function IntelTracePanel(props: {
  readonly context: Context
  readonly sessionID: string
  readonly intel: IntelLive
}) {
  const theme = () => palette(props.context.theme)
  const entries = createMemo(() => props.intel.entries().filter((entry) => entry.kind === "trace"))

  return (
    <box flexDirection="column" gap={0}>
      <text fg={theme().primary}>
        <b>TRACE</b>
      </text>
      <Show
        when={entries().length > 0}
        fallback={
          <text fg={theme().muted}>
            No trace recorded yet. v1's trace endpoint never shipped; repository-intel results appear in the
            CODEGRAPH INTEL panel.
          </text>
        }
      >
        <For each={entries()}>
          {(entry) => (
            <box flexDirection="column" gap={0}>
              <text fg={theme().muted}>{entry.query}</text>
              <text fg={theme().text}>{entry.summary}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}
