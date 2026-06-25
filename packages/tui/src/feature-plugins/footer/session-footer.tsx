/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo } from "solid-js"
import { useTuiPaths } from "../../context/runtime"
import { useData } from "../../context/data"
import { useRoute } from "../../context/route"

const id = "internal:session-footer"


function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const data = useData()
  const paths = useTuiPaths()
  const route = useRoute()

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
      <text fg={theme().textMuted}>enter send</text>
      <text fg={theme().textMuted}>·</text>
      <text fg={theme().textMuted}>shift+enter newline</text>
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
