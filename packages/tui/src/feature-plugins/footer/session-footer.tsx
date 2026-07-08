/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, onCleanup } from "solid-js"
import { useTuiPaths } from "../../context/runtime"
import { useData } from "../../context/data"
import { useRoute } from "../../context/route"
import { useSync } from "../../context/sync"
import { useEvent } from "../../context/event"

const id = "internal:session-footer"

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const data = useData()
  const paths = useTuiPaths()
  const route = useRoute()
  const sync = useSync()
  const ev = useEvent()

  const directory = createMemo(() => {
    if (route.data.type === "session") {
      const session = data.session.get(route.data.sessionID)
      if (session?.location?.directory) return session.location.directory
    }
    return props.api.state.path.directory || paths.cwd
  })

  const branch = createMemo(() => {
    if (directory() === (props.api.state.path.directory || paths.cwd)) {
      return props.api.state.vcs?.branch
    }
    return undefined
  })

  const [blockedPeerCount, setBlockedPeerCount] = createSignal(0)

  const unsubMesh = ev.on("banyancode.mesh.status" as any, (event: any) => {
    const peers = event.properties.peers ?? []
    setBlockedPeerCount(peers.filter((p: any) => p.status === "disconnected" && p.blockedReason).length)
  })
  onCleanup(unsubMesh)

  const attentionCount = createMemo(() => {
    if (route.data.type !== "session") return 0
    const sessionID = route.data.sessionID
    const permCount = sync.data.permission[sessionID]?.length ?? 0
    const questCount = sync.data.question[sessionID]?.length ?? 0
    return permCount + questCount + blockedPeerCount()
  })

  const attentionLabel = createMemo(() => {
    const count = attentionCount()
    if (count === 0) return "▲ all clear"
    return `▲ ${count} need attention`
  })

  return (
    <box
      width="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      flexShrink={0}
      gap={2}
    >
      <text fg={theme().textMuted}>
        BanyanCode {props.api.app.version}
        {branch() ? ` · Git: ${branch()}` : ""}
      </text>
      <box flexGrow={1} />
      <text fg={attentionCount() > 0 ? theme().error : theme().success}>
        {attentionLabel()}
      </text>
      <text fg={theme().textMuted}> · drag the separators to resize</text>
      <box flexGrow={1} />
      <text fg={theme().textMuted}>
        ^p cmd palette · ^g build graph · ^m memory search · / search · ^t new tab · ^s save session · ^q quit
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      session_footer() {
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
