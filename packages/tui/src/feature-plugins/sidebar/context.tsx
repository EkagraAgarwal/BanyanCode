/** @jsxImportSource @opentui/solid */
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show } from "solid-js"
import { toHex } from "../../util/color"

const id = "internal:sidebar-context"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))

  const lastAssistant = createMemo(() =>
    msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0),
  )

  const tokenBreakdown = createMemo(() => {
    const a = lastAssistant()
    if (!a) return null
    const input = a.tokens.input
    const output = a.tokens.output
    const reasoning = a.tokens.reasoning
    const cacheRead = a.tokens.cache.read
    const cacheWrite = a.tokens.cache.write
    const total = input + output + reasoning + cacheRead + cacheWrite
    return { input, output, reasoning, cacheRead, cacheWrite, total }
  })

  const contextPercent = createMemo(() => {
    const tb = tokenBreakdown()
    if (!tb) return null
    const last = lastAssistant()
    if (!last) return null
    const model = props.api.state.provider.find((p) => p.id === last.providerID)?.models[last.modelID]
    if (!model?.limit?.context) return null
    return Math.round((tb.total / model.limit.context) * 100)
  })

  const segColor = (segment: string, theme: any): string => {
    if (segment === "thinking") return toHex(theme.accent)
    if (segment === "prompt") return toHex(theme.info)
    if (segment === "output") return toHex(theme.success)
    if (segment === "cache") return toHex(theme.warning)
    return toHex(theme.textMuted)
  }

  return (
    <box>
      <text fg={toHex(theme().primary)}>
        <b>CONTEXT</b>
      </text>
      <Show
        when={tokenBreakdown()}
        fallback={
          <text fg={toHex(theme().textMuted)} marginTop={1}>
            0 tokens used
          </text>
        }
      >
        {(tb) => (
          <>
            <text fg={toHex(theme().textMuted)} marginTop={1}>
              {tb().total.toLocaleString()} used
              {contextPercent() !== null ? ` / ${contextPercent()}%` : ""}
            </text>
            <Show when={tb().total > 0}>
              <box flexDirection="row" marginTop={1} gap={0}>
                <text wrapMode="none">
                  <Show when={tb().reasoning > 0}>
                    <text fg={toHex(theme().accent)}>
                      {"█".repeat(Math.round((tb().reasoning / tb().total) * 12))}
                    </text>
                  </Show>
                  <Show when={tb().input > 0}>
                    <text fg={toHex(theme().info)}>
                      {"█".repeat(Math.round((tb().input / tb().total) * 12))}
                    </text>
                  </Show>
                  <Show when={tb().output > 0}>
                    <text fg={toHex(theme().success)}>
                      {"█".repeat(Math.round((tb().output / tb().total) * 12))}
                    </text>
                  </Show>
                  <Show when={tb().cacheRead + tb().cacheWrite > 0}>
                    <text fg={toHex(theme().warning)}>
                      {"█".repeat(Math.round(((tb().cacheRead + tb().cacheWrite) / tb().total) * 12))}
                    </text>
                  </Show>
                </text>
              </box>
            </Show>
            <box flexDirection="column" marginTop={1} gap={0}>
              <For each={[
                { label: "Thinking", value: tb().reasoning, pct: tb().total > 0 ? Math.round((tb().reasoning / tb().total) * 100) : 0, color: "thinking" },
                { label: "Prompt", value: tb().input, pct: tb().total > 0 ? Math.round((tb().input / tb().total) * 100) : 0, color: "prompt" },
                { label: "Output", value: tb().output, pct: tb().total > 0 ? Math.round((tb().output / tb().total) * 100) : 0, color: "output" },
                { label: "Cache", value: tb().cacheRead + tb().cacheWrite, pct: tb().total > 0 ? Math.round(((tb().cacheRead + tb().cacheWrite) / tb().total) * 100) : 0, color: "cache" },
              ]}>
                {(row) => (
                  <Show when={row.value > 0}>
                    <box flexDirection="row" gap={1}>
                      <text
                        fg={segColor(row.color, theme())}
                      >
                        ■
                      </text>
                      <text fg={toHex(theme().textMuted)}>
                        {row.label}: {row.value.toLocaleString()} ({row.pct}%)
                      </text>
                    </box>
                  </Show>
                )}
              </For>
            </box>
          </>
        )}
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
