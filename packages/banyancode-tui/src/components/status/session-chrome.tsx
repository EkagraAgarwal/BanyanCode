import type { Context } from "@opencode/plugin/tui/context"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, onMount, Show } from "solid-js"
import type { CodegraphLive, MeshLive, SystemLive } from "../../data/live"
import { palette } from "../../theme"
import { SessionTabs, viewKeyForPanel } from "../panels/nav"
import { activePeers, graphPill, severityColor } from "./pills"

const HEADER_PILLS_MIN_WIDTH = 72
const HEADER_HINTS_MIN_WIDTH = 110

const folderName = (directory: string | undefined) => directory?.split(/[\\/]/).filter(Boolean).at(-1) ?? "BanyanCode"

function Dot(props: { readonly color: ReturnType<typeof palette>["text"]; readonly muted: ReturnType<typeof palette>["text"]; readonly label: string }) {
  return (
    <box flexDirection="row" flexShrink={0} gap={1}>
      <text fg={props.color}>●</text>
      <text fg={props.muted}>{props.label}</text>
    </box>
  )
}

/** The v1 top bar and tab row: brand and project, live status, then CHAT / SESSIONS / AGENTS / CONFIG. */
export function SessionHeader(props: {
  readonly context: Context
  readonly sessionID: string
  readonly codegraph: CodegraphLive
  readonly mesh: MeshLive
  readonly system: SystemLive
}) {
  const theme = () => palette(props.context.theme)
  const dimensions = useTerminalDimensions()

  // YOLO and swarm can be on from config or the environment before anything toggles them.
  onMount(() => {
    void props.system.refreshYolo()
    void props.system.refreshLsp()
    void props.mesh.refreshLimits()
    void props.codegraph.refresh()
  })

  const active = createMemo(() => {
    const family = props.context.data.session.family(props.sessionID)
    const running = family.filter(
      (id) => id !== props.sessionID && props.context.data.session.status(id) === "running",
    ).length
    return Math.max(running, activePeers(props.mesh, props.context.data.session.root(props.sessionID)))
  })
  const lspColor = createMemo(() => {
    const status = props.system.lsp()
    if (!status?.enabled) return theme().error
    return status.servers.some((server) => server.status === "connected" && !server.disabled)
      ? theme().success
      : theme().warning
  })
  const graph = createMemo(() =>
    graphPill({
      availability: props.codegraph.availability(),
      readiness: props.codegraph.readiness(),
      build: props.codegraph.build(),
      autoUpdate: props.codegraph.autoUpdate(),
      meta: props.codegraph.meta(),
    }),
  )

  return (
    <box flexDirection="column" flexShrink={0} width="100%">
      <box flexDirection="row" flexShrink={0} justifyContent="space-between" gap={1} paddingLeft={1} paddingRight={1}>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text fg={theme().primary}>
            <b>BANYANCODE</b>
          </text>
          <Show when={dimensions().width >= 90}>
            <text fg={theme().muted}>{folderName(props.context.location?.directory)}</text>
          </Show>
        </box>
        <Show when={dimensions().width >= HEADER_PILLS_MIN_WIDTH}>
          <box flexDirection="row" gap={2} flexShrink={0}>
            <Dot
              color={active() > 0 ? theme().success : theme().muted}
              muted={theme().muted}
              label={`${active()} active`}
            />
            <Dot color={lspColor()} muted={theme().muted} label="LSP" />
            <Dot color={severityColor(theme(), graph().severity)} muted={theme().muted} label={graph().label} />
          </box>
        </Show>
        <Show when={dimensions().width >= HEADER_HINTS_MIN_WIDTH}>
          <text fg={theme().muted} flexShrink={0}>
            ctrl+p commands ctrl+] tabs
          </text>
        </Show>
      </box>
      <SessionTabs context={props.context} active={viewKeyForPanel(props.context.ui.panel.current()?.name)} />
    </box>
  )
}

/** The v1 status bar: project and branch on the left, modes and what needs attention on the right. */
export function SessionFooter(props: {
  readonly context: Context
  readonly sessionID: string
  readonly mesh: MeshLive
  readonly system: SystemLive
}) {
  const theme = () => palette(props.context.theme)
  const dimensions = useTerminalDimensions()
  const data = props.context.data
  const session = createMemo(() => data.session.get(props.sessionID))
  const location = () => session()?.location ?? props.context.location
  const branch = createMemo(() => {
    const current = location()
    return current ? data.location.vcs.info(current)?.branch.current : undefined
  })
  // Matches the host's own pending list: a root session owns its family's permissions and questions.
  const attention = createMemo(() => {
    const global = data.session.form.list("global", props.context.location) ?? []
    if (session()?.parentID) return global.length
    const family = data.session.family(props.sessionID)
    return (
      global.length +
      family.flatMap((id) => [...(data.session.permission.list(id) ?? []), ...(data.session.form.list(id) ?? [])]).length
    )
  })
  return (
    <box flexDirection="row" flexShrink={0} width="100%" gap={2} paddingLeft={2} paddingRight={2}>
      <text fg={theme().muted} flexShrink={1} wrapMode="none">
        {folderName(location()?.directory)}
        {branch() ? ` · Git: ${branch()}` : ""}
      </text>
      <box flexGrow={1} />
      <Show when={props.system.yolo() === true}>
        <text fg={theme().error} flexShrink={0}>
          [yolo]
        </text>
      </Show>
      <Show when={props.mesh.swarmMode() === true}>
        <text fg={theme().error} flexShrink={0}>
          [swarm]
        </text>
      </Show>
      <text fg={attention() > 0 ? theme().error : theme().success} flexShrink={0}>
        {`▲ ${attention()} need attention`}
      </text>
      <Show when={dimensions().width >= 100}>
        <text fg={theme().muted} flexShrink={0}>
          ^p cmd · / search
        </text>
      </Show>
    </box>
  )
}
