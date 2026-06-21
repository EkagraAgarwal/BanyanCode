/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo } from "solid-js"
import { useSync } from "../../context/sync"

const id = "internal:inspector-pending-actions"

import { toHex } from "../../util/color"

function View(props: { api: TuiPluginApi }) {
  const sync = useSync()
  const theme = () => props.api.theme.current
  const primary = () => toHex(theme().primary)
  const textMuted = () => toHex(theme().textMuted)
  const text = () => toHex(theme().text)

  // Sessions in "working" or "busy" state are considered in-flight.
  const pendingSessions = createMemo(() => {
    return sync.data.session.filter((s) => {
      const status = sync.data.session_status[s.id]
      if (!status) return false
      return status.type === "busy" || status.type === "retry"
    })
  })

  // Pending permission requests.
  const pendingPermissions = createMemo(() => {
    const list: any[] = []
    for (const sessionID of Object.keys(sync.data.permission)) {
      const reqs = sync.data.permission[sessionID] ?? []
      for (const req of reqs) {
        list.push({ sessionID, req })
      }
    }
    return list
  })

  // Pending questions.
  const pendingQuestions = createMemo(() => {
    const list: any[] = []
    for (const sessionID of Object.keys(sync.data.question)) {
      const reqs = sync.data.question[sessionID] ?? []
      for (const req of reqs) {
        list.push({ sessionID, req })
      }
    }
    return list
  })

  const totalCount = createMemo(() => {
    return pendingSessions().length + pendingPermissions().length + pendingQuestions().length
  })

  return (
    <box>
      <text fg={text()}>
        <b>PENDING ACTIONS{totalCount() > 0 ? ` ${totalCount()}` : ""}</b>
      </text>
      {totalCount() === 0 ? (
        <text fg={textMuted()}>No pending actions</text>
      ) : (
        <box gap={1}>
          {/* Active agent sessions */}
          {pendingSessions().map((s) => (
            <box flexDirection="column" gap={0}>
              <box flexDirection="row" gap={1}>
                <text fg={textMuted()}>•</text>
                <text fg={text()}>{s.agent ?? "agent"}</text>
                {s.title && (
                  <text fg={textMuted()}> ({s.title})</text>
                )}
              </box>
              <box flexDirection="row" gap={1} paddingLeft={3}>
                <text fg={primary()}>[a]</text>
                <text fg={textMuted()}> abort  </text>
                <text fg={primary()}>[v]</text>
                <text fg={textMuted()}> view  </text>
                <text fg={primary()}>[t]</text>
                <text fg={textMuted()}> timeline</text>
              </box>
            </box>
          ))}

          {/* Pending permission requests */}
          {pendingPermissions().map(({ sessionID, req }) => (
            <box flexDirection="column" gap={0}>
              <box flexDirection="row" gap={1}>
                <text fg={toHex(theme().warning)}>•</text>
                <text fg={text()}>Permission: {req.tool?.name ?? "unknown tool"}</text>
              </box>
              <box flexDirection="row" gap={1} paddingLeft={3}>
                <text fg={primary()}>[y]</text>
                <text fg={textMuted()}> approve  </text>
                <text fg={primary()}>[n]</text>
                <text fg={textMuted()}> deny  </text>
                <text fg={primary()}>[v]</text>
                <text fg={textMuted()}> view diff</text>
              </box>
            </box>
          ))}

          {/* Pending questions */}
          {pendingQuestions().map(({ sessionID, req }) => (
            <box flexDirection="column" gap={0}>
              <box flexDirection="row" gap={1}>
                <text fg={toHex(theme().info)}>•</text>
                <text fg={text()}>Question: {req.text ? (req.text.length > 30 ? req.text.substring(0, 27) + "..." : req.text) : "agent query"}</text>
              </box>
              <box flexDirection="row" gap={1} paddingLeft={3}>
                <text fg={primary()}>[enter]</text>
                <text fg={textMuted()}> answer  </text>
                <text fg={primary()}>[s]</text>
                <text fg={textMuted()}> skip</text>
              </box>
            </box>
          ))}
        </box>
      )}
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 300,
    slots: {
      session_inspector() {
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