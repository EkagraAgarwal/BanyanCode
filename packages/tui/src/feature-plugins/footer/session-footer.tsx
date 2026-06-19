import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo } from "solid-js"
import { abbreviateHome } from "../../runtime"
import { useTuiPaths } from "../../context/runtime"
import { useData } from "../../context/data"
import { useRoute } from "../../context/route"

const id = "internal:session-footer"

function toHex(color: { r: number; g: number; b: number; a?: number } | string): string {
  if (typeof color === "string") return color
  const a = color.a !== undefined ? Math.round(color.a * 255).toString(16).padStart(2, "0") : ""
  return `#${color.r.toString(16).padStart(2, "0")}${color.g.toString(16).padStart(2, "0")}${color.b.toString(16).padStart(2, "0")}${a}`
}

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

  const dir = createMemo(() => abbreviateHome(directory(), paths.home))
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
      <text fg={toHex(theme().textMuted)}>
        BanyanCode {props.api.app.version}
        {branch() ? ` · ${branch()}` : ""}
      </text>
      <box flexGrow={1} />
      <text fg={toHex(theme().textMuted)}>
        {dir()}
      </text>
      <text fg={toHex(theme().textMuted)}>·</text>
      <text fg={toHex(theme().textMuted)}>enter send</text>
      <text fg={toHex(theme().textMuted)}>·</text>
      <text fg={toHex(theme().textMuted)}>shift+enter newline</text>
      <text fg={toHex(theme().textMuted)}>·</text>
      <text fg={toHex(theme().textMuted)}>/help</text>
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
