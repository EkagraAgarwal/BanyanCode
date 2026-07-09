/** @jsxImportSource @opentui/solid */
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show } from "solid-js"
import { toHex } from "../../util/color"

const id = "internal:sidebar-context"

interface Segment {
  key: string
  label: string
  tokens: number
  color: "accent" | "info" | "success" | "warning"
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current

  const lastAssistant = createMemo(() => {
    const messages = props.api.state.session.messages(props.session_id)
    return messages.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
  })

  const breakdown = createMemo(() => {
    const a = lastAssistant()
    if (!a) return null
    const reasoning = a.tokens.reasoning
    const input = a.tokens.input
    const output = a.tokens.output
    const cache = a.tokens.cache.read + a.tokens.cache.write
    return { reasoning, input, output, cache, total: reasoning + input + output + cache }
  })

  const modelContextLimit = createMemo(() => {
    const last = lastAssistant()
    if (!last) return null
    const provider = props.api.state.provider.find((p) => p.id === last.providerID)
    return provider?.models[last.modelID]?.limit?.context ?? null
  })

  const contextPercent = createMemo(() => {
    const tb = breakdown()
    const limit = modelContextLimit()
    if (!tb || !limit || limit === 0) return null
    return Math.round((tb.total / limit) * 100)
  })

  const segments = createMemo<Segment[]>(() => {
    const tb = breakdown()
    if (!tb) return []
    return [
      { key: "thinking", label: "Thinking", tokens: tb.reasoning, color: "accent" },
      { key: "prompt", label: "Prompt", tokens: tb.input, color: "info" },
      { key: "output", label: "Output", tokens: tb.output, color: "success" },
      { key: "cache", label: "Cache", tokens: tb.cache, color: "warning" },
    ]
  })

  const segColor = (color: Segment["color"]): string => {
    const t = theme()
    if (color === "accent") return toHex(t.accent)
    if (color === "info") return toHex(t.info)
    if (color === "success") return toHex(t.success)
    if (color === "warning") return toHex(t.warning)
    return toHex(t.text)
  }

  const BAR_WIDTH = 18

  return (
    <box>
      <text fg={toHex(theme().primary)}>
        <b>CONTEXT</b>
      </text>
      <Show
        when={breakdown()}
        fallback={
          <text fg={toHex(theme().textMuted)} marginTop={1}>
            no data
          </text>
        }
      >
        {(tb) => (
          <>
            <text fg={toHex(theme().textMuted)} marginTop={1}>
              {tb().total.toLocaleString()} used
              {contextPercent() !== null ? ` · ${contextPercent()}% of context` : ""}
            </text>
            <Show when={tb().total > 0}>
              <box flexDirection="row" marginTop={1} gap={0}>
                <For each={segments().filter((s) => s.tokens > 0)}>
                  {(seg) => {
                    const cells = Math.max(1, Math.round((seg.tokens / tb().total) * BAR_WIDTH))
                    return <text fg={segColor(seg.color)}>{"█".repeat(cells)}</text>
                  }}
                </For>
                <text fg={toHex(theme().textMuted)}>
                  {"░".repeat(
                    Math.max(
                      0,
                      BAR_WIDTH - segments().filter((s) => s.tokens > 0).reduce(
                        (sum, seg) => sum + Math.max(1, Math.round((seg.tokens / tb().total) * BAR_WIDTH)),
                        0,
                      ),
                    ),
                  )}
                </text>
              </box>
            </Show>
            <box flexDirection="column" marginTop={1} gap={0}>
              <For each={segments().filter((s) => s.tokens > 0)}>
                {(seg) => (
                  <box flexDirection="row" gap={1}>
                    <text fg={segColor(seg.color)}>■</text>
                    <text fg={toHex(theme().textMuted)}>
                      {seg.label}: {seg.tokens.toLocaleString()}
                    </text>
                  </box>
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
