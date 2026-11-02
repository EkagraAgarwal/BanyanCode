import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, Match, Show, Switch } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { usePlugin } from "../../plugin/context"
import { Slot } from "../../plugin/render"
import { useUpdateNotification } from "../../context/update-notification"
import { useExit } from "../../context/exit"
import { useTheme } from "../../context/theme"
import { InteractivityProvider } from "../../context/interactivity"
import { FadeInText } from "../../component/fade-in-text"
import { PromptFooter } from "../prompt/footer"

/**
 * The prompt hints are the first thing the footer row drops: with a typical
 * directory, the pills and the version they need this much width to coexist.
 * Below it the compact palette hint and the directory get the room.
 */
const HINTS_MIN_WIDTH = 120

export function homeFooterVisibility(width: number) {
  return {
    mcpCommand: width >= 64,
    pluginCommand: width >= 80,
    // The palette hint never disappears: below the full hints it compacts to `^p cmds`.
    compactHint: width >= 64 && width < HINTS_MIN_WIDTH,
    // The version is the first thing the row gives up, so the hint keeps its columns.
    version: width >= HINTS_MIN_WIDTH,
  }
}

/**
 * The palette hint below the full hints' width: the session footer's compact
 * shape, but read from the keymap so a rebind cannot leave it stale.
 */
function CompactHint(props: { context: Plugin.Context }) {
  const label = createMemo(() => {
    const binding = props.context.keymap.shortcuts("command.palette.show")[0]
    if (!binding) return undefined
    // The default binding reads as `^p`, the way the session footer writes it.
    const ctrl = /^ctrl\+([a-z0-9])$/i.exec(binding)
    return `${ctrl ? `^${ctrl[1]!.toLowerCase()}` : binding} cmds`
  })
  return (
    <Show when={label()}>
      {(text) => (
        <text fg={props.context.theme.text.muted} flexShrink={0}>
          {text()}
        </text>
      )}
    </Show>
  )
}

function Mcp(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const visibility = createMemo(() => homeFooterVisibility(dimensions().width))
  const list = createMemo(() => props.context.data.location.mcp.server.list(props.context.location) ?? [])
  const failed = createMemo(() => list().filter((item) => item.status.status === "failed").length)
  const count = createMemo(() => list().filter((item) => item.status.status === "connected").length)

  return (
    <Show when={list().length}>
      <box gap={1} flexDirection="row" flexShrink={0} onMouseUp={() => props.context.keymap.dispatch("mcp.list")}>
        <text fg={props.context.theme.text.base}>
          <Switch>
            <Match when={failed()}>
              <span style={{ fg: props.context.theme.text.feedback.error.base }}>⊙ </span>
              {failed()} MCP failed
            </Match>
            <Match when={true}>
              <span
                style={{
                  fg:
                    count() > 0 ? props.context.theme.text.feedback.success.base : props.context.theme.text.muted,
                }}
              >
                ⊙{" "}
              </span>
              {count()} MCP
            </Match>
          </Switch>
        </text>
        <Show when={visibility().mcpCommand}>
          <text fg={props.context.theme.text.muted}>/mcps</text>
        </Show>
      </box>
    </Show>
  )
}

function Plugins(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const visibility = createMemo(() => homeFooterVisibility(dimensions().width))
  const plugins = usePlugin()
  const failed = createMemo(
    () =>
      plugins.list().filter((item) => item.status === "failed").length +
      plugins.server().filter((item) => item.state.status === "failed").length,
  )

  return (
    <Show when={failed()}>
      <box gap={1} flexDirection="row" flexShrink={0} onMouseUp={() => props.context.keymap.dispatch("plugins.list")}>
        <text fg={props.context.theme.text.base}>
          <span style={{ fg: props.context.theme.text.feedback.error.base }}>⊙ </span>
          {failed()} plugin{failed() === 1 ? "" : "s"} failed
        </text>
        <Show when={visibility().pluginCommand}>
          <text fg={props.context.theme.text.muted}>/plugins</text>
        </Show>
      </box>
    </Show>
  )
}

// The update notice rides in the footer row, right of the spacer: the mockup's
// "/update ... <installed version>" cluster. It keeps its own click behavior.
function UpdateNotice() {
  const update = useUpdateNotification()
  const exit = useExit()
  const theme = useTheme()
  const [hovered, setHovered] = createSignal(false)
  const backdrop = () => (hovered() ? theme.background.action.primary.hovered : theme.background.base)
  createEffect(() => {
    update.notification()
    setHovered(false)
  })

  return (
    <Show when={update.notification()} keyed>
      {(state) => {
        const remote = state.source === "server" && state.remote
        return (
          <Show when={!remote || state.type === "available"}>
            <box
              flexShrink={1}
              minWidth={0}
              flexDirection="row"
              gap={1}
              backgroundColor={hovered() ? theme.background.action.primary.hovered : undefined}
              onMouseOver={() => setHovered(true)}
              onMouseOut={() => setHovered(false)}
              onMouseUp={() => {
                if (remote) return update.dismiss()
                if (state.type === "installed") return exit()
                update.open?.("notification")
              }}
            >
              <FadeInText fg={theme.text.muted} backdrop={backdrop()} wrapMode="none" truncate>
                <Show when={!remote}>
                  <span style={{ fg: theme.text.action.primary.selected }}>
                    {state.type === "installed" ? "/exit" : "/update"}
                  </span>
                </Show>
                {remote
                  ? "remote server update available"
                  : state.type === "installed"
                    ? ` restart to use v${state.version}`
                    : ` to install v${state.version}`}
              </FadeInText>
            </box>
          </Show>
        )
      }}
    </Show>
  )
}

function View(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const visibility = createMemo(() => homeFooterVisibility(dimensions().width))

  return (
    <Show when={dimensions().height >= 14 && dimensions().width >= 44}>
      <box
        width="100%"
        height={1}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="row"
        alignItems="center"
        flexShrink={0}
        gap={2}
        overflow="hidden"
      >
        {/* Host status content lives inside the slot: a plugin prepend (the
            directory and branch) then lands left of the MCP and plugin counts,
            and an append (status pills) stays right of them. */}
        <Slot path="home.footer.status">
          <Mcp context={props.context} />
          <Plugins context={props.context} />
        </Slot>
        {/* Home's prompt carries no footer row of its own, so its hints live
            here: the full set when the row has room, the compact palette hint
            when it does not. */}
        <Show when={dimensions().width >= HINTS_MIN_WIDTH}>
          <InteractivityProvider enabled={true}>
            <PromptFooter context={props.context} mode="normal" showDetails />
          </InteractivityProvider>
        </Show>
        <Show when={visibility().compactHint}>
          <CompactHint context={props.context} />
        </Show>
        <box flexGrow={1} minWidth={0} />
        <UpdateNotice />
        <Show when={visibility().version}>
          <text fg={props.context.theme.text.muted} flexShrink={0}>
            {props.context.app.version}
          </text>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.home.footer",
  setup(context) {
    // Root takeover: an external plugin replacing home.footer wins (last-
    // enabled) and this builtin shows as suppressed, not silently gone.
    // Append keeps the path open to additive plugin claims; an external
    // replace still takes the boundary over.
    context.ui.slot({ append: "home.footer", render: () => <View context={context} /> })
  },
})
