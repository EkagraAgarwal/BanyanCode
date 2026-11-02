import type { Context } from "@opencode/plugin/tui/context"
import type { FileDiffInfo } from "@opencode/client"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { palette } from "../../theme"

const COLLAPSE_THRESHOLD = 2
const PATH_BUDGET = 36

export function changeCountWidth(item: { readonly additions: number; readonly deletions: number }): number {
  return [item.additions ? `+${item.additions}` : "", item.deletions ? `-${item.deletions}` : ""]
    .filter(Boolean)
    .join(" ").length
}

export function truncateLeft(text: string, max: number): string {
  if (max <= 0) return ""
  if (text.length <= max) return text
  if (max === 1) return "…"
  return `…${text.slice(text.length - (max - 1))}`
}

/**
 * Ported from v1 `feature-plugins/sidebar/files.tsx`. v1 read the session diff
 * from the sync store; v2 exposes it as `client.session.diff`, refreshed after
 * each completed step and after a revert changes the working tree.
 */
export function ModifiedFilesPanel(props: { readonly context: Context; readonly sessionID: string }) {
  const theme = () => palette(props.context.theme)
  const [open, setOpen] = createSignal(true)
  const [files, setFiles] = createSignal<readonly FileDiffInfo[]>([])

  const load = () => {
    void props.context.client.session
      .diff({ sessionID: props.sessionID, context: 3 })
      .then((result) => setFiles(result ?? []))
      .catch(() => {})
  }

  onMount(load)
  const offStep = props.context.data.on("session.step.ended", (event) => {
    if (event.data.sessionID !== props.sessionID) return
    load()
  })
  const offRevert = props.context.data.on("session.revert.cleared", (event) => {
    if (event.data.sessionID !== props.sessionID) return
    load()
  })
  const offCommitted = props.context.data.on("session.revert.committed", (event) => {
    if (event.data.sessionID !== props.sessionID) return
    load()
  })
  onCleanup(() => {
    offStep()
    offRevert()
    offCommitted()
  })

  return (
    <Show when={files().length > 0}>
      <box>
        <box
          id="banyancode.files.header"
          flexDirection="row"
          gap={1}
          onMouseDown={() => {
            if (files().length > COLLAPSE_THRESHOLD) setOpen((value) => !value)
          }}
        >
          <Show when={files().length > COLLAPSE_THRESHOLD}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Modified Files</b>
          </text>
        </box>
        <Show when={files().length <= COLLAPSE_THRESHOLD || open()}>
          <For each={files()}>
            {(item) => (
              <box flexDirection="row" gap={1} justifyContent="space-between">
                <text fg={theme().muted} wrapMode="none">
                  {truncateLeft(item.file, Math.max(2, PATH_BUDGET - changeCountWidth(item)))}
                </text>
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <Show when={item.additions > 0}>
                    <text fg={theme().diffAdded}>+{item.additions}</text>
                  </Show>
                  <Show when={item.deletions > 0}>
                    <text fg={theme().diffRemoved}>-{item.deletions}</text>
                  </Show>
                </box>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}
