/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal } from "solid-js"
import { toHex } from "../../util/color"

const id = "internal:sidebar-lsp"

type LspEntry = {
  id: string
  name: string
  root: string
  status: "configured" | "connected" | "error"
  autoDownload: boolean
  languages: string[]
  inert: boolean
  disabled: boolean
  disabledReason?: string
}

function View(props: { api: TuiPluginApi }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.lsp() as LspEntry[])
  // BanyanCode owns LSP config (banyancode_lsp in banyancode.json). When the
  // BanyanConfig service is unavailable or the field is unset, treat LSP as
  // off — matches the previous opencode default of `cfg.lsp === undefined`.
  const off = createMemo(() => {
    const v = props.api.state.banyanConfig?.banyancode_lsp
    return !(v === true || (typeof v === "object" && v !== null))
  })
  const config = createMemo<LspEntry[]>(() => list().filter((entry) => !entry.disabled))
  const disabled = createMemo<LspEntry[]>(() => list().filter((entry) => entry.disabled))
  const connected = createMemo(() => config().filter((entry) => entry.status === "connected"))
  const inert = createMemo(() => config().filter((entry) => entry.inert))
  const primaryLangs = createMemo<string[]>(() => {
    const out: string[] = []
    for (const entry of connected()) {
      for (const lang of entry.languages) {
        if (!out.includes(lang)) out.push(lang)
      }
      if (out.length >= 3) break
    }
    if (out.length === 0) {
      for (const entry of inert()) {
        for (const lang of entry.languages) {
          if (!out.includes(lang)) out.push(lang)
        }
        if (out.length >= 3) break
      }
    }
    return out
  })
  const languageLabel = () => {
    if (off()) return "LSP: off"
    const langs = primaryLangs()
    if (langs.length === 0) return `LSP: 0/${config().length}`
    return `LSP: ${langs.join(" · ")} · ${connected().length}/${config().length}`
  }
  const headerColor = () => {
    if (off()) return toHex(theme().error)
    if (connected().length > 0) return toHex(theme().success)
    return toHex(theme().warning)
  }

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
        <Show when={list().length > 2}>
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
        </Show>
        <text fg={theme().text}>
          <b>LSP</b>
        </text>
        <text fg={headerColor()}>
          {off() ? " off" : connected().length > 0 ? " active" : " inactive"}
        </text>
        <text fg={toHex(theme().textMuted)}>{languageLabel()}</text>
      </box>
      <Show when={list().length <= 2 || open()}>
        <Show
          when={list().length > 0}
          fallback={
            <text fg={toHex(theme().textMuted)}>
              {off() ? "LSPs are disabled" : "LSPs will activate as files are read"}
            </text>
          }
        >
          <For each={config()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: item.status === "connected" ? theme().success : theme().warning,
                  }}
                >
                  {item.status === "connected" ? "●" : item.inert ? "◌" : "✗"}
                </text>
                <text fg={toHex(theme().text)}>{item.id}</text>
                <Show when={item.languages.length > 0}>
                  <text fg={toHex(theme().textMuted)}>
                    {`(${item.languages.slice(0, 3).join(", ")})`}
                  </text>
                </Show>
                <text fg={toHex(theme().textMuted)}>
                  {item.root ? ` ${item.root}` : item.inert ? " (waiting for a file)" : ""}
                </text>
              </box>
            )}
          </For>
          <Show when={disabled().length > 0}>
            <For each={disabled()}>
              {(item) => (
                <box flexDirection="row" gap={1}>
                  <text flexShrink={0} style={{ fg: theme().textMuted }}>
                    ◌
                  </text>
                  <text fg={toHex(theme().textMuted)}>{item.id}</text>
                  <text fg={toHex(theme().textMuted)}>
                    {item.disabledReason ?? "disabled"}
                  </text>
                </box>
              )}
            </For>
          </Show>
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 300,
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
