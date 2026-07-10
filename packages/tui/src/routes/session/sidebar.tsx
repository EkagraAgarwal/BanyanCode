/** @jsxImportSource @opentui/solid */
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { usePluginRuntime } from "../../plugin/runtime"

import { getScrollAcceleration } from "../../util/scroll"
import { WorkspaceLabel } from "../../component/workspace-label"
import { RoundedBorder } from "../../ui/border"

export function Sidebar(props: { sessionID: string; overlay?: boolean; onClose?: () => void; width?: number | "auto" | `${number}%` }) {
  const pluginRuntime = usePluginRuntime()
  const project = useProject()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const workspace = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return
    return project.workspace.get(workspaceID)
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  return (
    <Show when={session()}>
      <box
        width={props.width ?? "30%"}
        minWidth={32}
        height="100%"
        marginTop={1}
        marginBottom={1}
        position={props.overlay ? "absolute" : "relative"}
        customBorderChars={RoundedBorder.customBorderChars}
        border={["left", "right", "top", "bottom"]}
        borderColor={theme.borderSubtle}
      >
        <box
          backgroundColor={theme.backgroundPanel}
          width="100%"
          height="100%"
          paddingLeft={1}
          paddingRight={1}
          flexDirection="column"
        >
          <Show when={props.onClose}>
            <box flexDirection="row" justifyContent="flex-end" width="100%" marginBottom={1}>
              <text fg={theme.textMuted} onMouseDown={props.onClose}>
                ✕
              </text>
            </box>
          </Show>
          <scrollbox
            flexGrow={1}
            scrollAcceleration={scrollAcceleration()}
            verticalScrollbarOptions={{
              trackOptions: {
                backgroundColor: theme.background,
                foregroundColor: theme.borderActive,
              },
            }}
          >
            <box flexDirection="column" flexShrink={0} gap={1} paddingRight={1}>
              <pluginRuntime.Slot
                name="sidebar_title"
                mode="single_winner"
                session_id={props.sessionID}
                title={session()!.title}
                share_url={session()!.share?.url}
              >
                <box paddingRight={1}>
                  <text fg={theme.text}>
                    <b>{session()!.title}</b>
                  </text>
                  <Show when={session()!.workspaceID}>
                    <text fg={theme.textMuted}>
                      <Show
                        when={workspace()}
                        fallback={<WorkspaceLabel type="unknown" name={session()!.workspaceID!} status="error" icon />}
                      >
                        {(item) => (
                          <WorkspaceLabel
                            type={item().type}
                            name={item().name}
                            status={project.workspace.status(item().id) ?? "error"}
                            icon
                          />
                        )}
                      </Show>
                    </text>
                  </Show>
                  <Show when={session()!.share?.url}>
                    <text fg={theme.textMuted}>{session()!.share!.url}</text>
                  </Show>
                </box>
              </pluginRuntime.Slot>
              <pluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
            </box>
          </scrollbox>

          <box flexShrink={0} gap={1} paddingTop={1}>
            <pluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
              <text fg={theme.textMuted}>
                <span style={{ fg: theme.success }}>•</span> <b>Open</b>
                <span style={{ fg: theme.text }}>
                  <b>Code</b>
                </span>{" "}
                <span>{InstallationVersion}</span>
              </text>
            </pluginRuntime.Slot>
          </box>
        </box>
      </box>
    </Show>
  )
}
