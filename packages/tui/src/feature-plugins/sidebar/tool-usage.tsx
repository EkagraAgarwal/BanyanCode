/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createResource, For, Show } from "solid-js"
import { toHex } from "../../util/color"
import { useSDK } from "../../context/sdk"

const id = "internal:sidebar-tool-usage"

// Keep the widget compact per the sidebar-compact-spacing rule: at most 8
// single-line rows. The sidebar wrapper owns the inter-plugin gap.
const MAX_ROWS = 8

interface UsageRow {
  toolId: string
  useCount: number
  lastUsedAt: number
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const sdk = useSDK()

  // Fetch on mount. The endpoint returns an empty list when BanyanCode is
  // disabled and throws on older servers — both must render nothing (fail
  // silent), so any failure resolves the resource to `undefined`.
  const [usage] = createResource(async () => {
    try {
      const res = await sdk.client.global.toolUsage()
      return res.data?.tools ?? []
    } catch {
      return undefined
    }
  })

  const rows = () => usage()?.slice(0, MAX_ROWS) ?? []

  return (
    <Show when={usage() !== undefined && usage()!.length > 0}>
      <box flexDirection="column" gap={0}>
        <text fg={toHex(theme().primary)}>
          <b>TOOL USAGE</b>
        </text>
        <For each={rows()}>
          {(row) => (
            <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
              <text fg={toHex(theme().textMuted)} wrapMode="none">
                {row.toolId}
              </text>
              <text fg={toHex(theme().text)}>{row.useCount}</text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 158,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
