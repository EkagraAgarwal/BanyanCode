import { Plugin } from "@opencode/plugin/tui"
import { createMemo, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { hasConnectedProvider } from "../../util/connected-provider"
import { displayName } from "../../brand"

export function SidebarOnboarding(props: { context: Plugin.Context; sessionID: string }) {
  const dimensions = useTerminalDimensions()
  const [onboarding, updateOnboarding] = props.context.storage.store("getting-started", {
    initial: { dismissed: false },
  })
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const integrations = createMemo(() =>
    props.context.data.location.integration.list(session()?.location ?? props.context.location),
  )
  const showOnboarding = createMemo(() => {
    if (dimensions().height < 22) return false
    const list = integrations()
    if (!list) return false
    return !onboarding.dismissed && !hasConnectedProvider(list)
  })

  return (
    <Show when={showOnboarding()}>
      <box
        id="sidebar.footer.getting-started"
        backgroundColor={props.context.theme.background.raised.high}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="row"
        gap={1}
      >
        <text flexShrink={0} fg={props.context.theme.text.base}>
          ⬖
        </text>
        <box flexGrow={1} gap={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={props.context.theme.text.base}>
              <b>Getting started</b>
            </text>
            <text
              id="sidebar.footer.getting-started.dismiss"
              fg={props.context.theme.text.muted}
              onMouseUp={() => {
                void updateOnboarding((draft) => {
                  draft.dismissed = true
                }).catch((error) => console.error("Failed to dismiss sidebar onboarding", error))
              }}
            >
              ✕
            </text>
          </box>
          <text fg={props.context.theme.text.muted}>{displayName} includes free models so you can start immediately.</text>
          <text fg={props.context.theme.text.muted}>
            Connect from 75+ providers to use other models, including Claude, GPT, Gemini etc
          </text>
          <box
            id="sidebar.footer.getting-started.connect"
            flexDirection="row"
            gap={1}
            justifyContent="space-between"
            onMouseUp={() => props.context.keymap.dispatch("provider.connect")}
          >
            <text fg={props.context.theme.text.base}>Connect provider</text>
            <text fg={props.context.theme.text.muted}>/connect</text>
          </box>
        </box>
      </box>
    </Show>
  )
}

/** v1 `feature-plugins/sidebar/footer.tsx`: brand line with the app version. */
export function SidebarVersion(props: { context: Plugin.Context }) {
  const theme = props.context.theme
  return (
    <text id="sidebar.footer.version" fg={theme.text.muted}>
      <span style={{ fg: theme.text.feedback.success.base }}>•</span>{" "}
      <span style={{ fg: theme.text.base }}>
        <b>BanyanCode</b>
      </span>{" "}
      {props.context.app.version}
    </text>
  )
}

function SidebarLocation(props: { context: Plugin.Context; sessionID: string }) {
  const location = () => props.context.data.session.get(props.sessionID)?.location ?? props.context.location
  const label = () => {
    const current = location()
    if (!current) return ""
    const branch = props.context.data.location.vcs.info(current)?.branch.current
    return branch ? `${current.directory}:${branch}` : current.directory
  }
  return <text fg={props.context.theme.text.muted}>{label()}</text>
}

export function SidebarFooter(props: { context: Plugin.Context; sessionID: string }) {
  return (
    <box gap={1}>
      <SidebarOnboarding context={props.context} sessionID={props.sessionID} />
      <box>
        <SidebarLocation context={props.context} sessionID={props.sessionID} />
        <SidebarVersion context={props.context} />
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.footer",
  setup(context) {
    // Append keeps the footer open to additive plugin claims; an external
    // replace still takes the boundary over.
    context.ui.slot({
      append: "sidebar.footer",
      render: (props) => <SidebarFooter context={context} sessionID={props.sessionID} />,
    })
  },
})
