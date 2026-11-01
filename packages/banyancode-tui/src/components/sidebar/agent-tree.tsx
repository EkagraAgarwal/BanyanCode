import type { Context } from "@opencode/plugin/tui/context"
import type { SessionInfo } from "@opencode/client"
import { createMemo, createSignal, For, Show } from "solid-js"
import { toolNames } from "../../data/messages"
import type { MeshLive } from "../../data/live"
import { meshStateFor } from "../../data/mesh"
import { palette } from "../../theme"

function statusType(
  context: Context,
  mesh: MeshLive,
  session: SessionInfo,
): "idle" | "running" | "error" | "queued" {
  const meshState = meshStateFor(mesh.root(context.data.session.root(session.id)), session.id)
  if (meshState === "running" || meshState === "retry") return "running"
  if (meshState === "failed" || meshState === "interrupted") return "error"
  if (meshState === "unknown") return "queued"
  return context.data.session.status(session.id) === "running" ? "running" : "idle"
}

function toolsUsed(context: Context, sessionID: string): string[] {
  return toolNames(context.data.session.message.list(sessionID))
}

/**
 * Ported from v1 `sidebar/agent-tree.tsx` (module-only in v1; parity 7b).
 * Lists this session's direct subagent children with connector glyphs.
 */
export function AgentTreePanel(props: { readonly context: Context; readonly sessionID: string; readonly mesh: MeshLive }) {
  const theme = () => palette(props.context.theme)
  const [open, setOpen] = createSignal(true)

  const children = createMemo(() =>
    props.context.data.session.list().filter((session) => session.parentID === props.sessionID),
  )

  const glyph = (session: SessionInfo) => {
    const status = statusType(props.context, props.mesh, session)
    if (status === "idle") return { color: theme().muted, char: "○" }
    if (status === "running") return { color: theme().success, char: "●" }
    if (status === "error") return { color: theme().error, char: "×" }
    return { color: theme().warning, char: "◐" }
  }

  return (
    <Show when={children().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => setOpen((value) => !value)}>
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          <text fg={theme().text}>
            <b>AGENT TREE</b>
          </text>
          <text fg={theme().muted}>{` ${children().length} active`}</text>
        </box>
        <Show when={open()}>
          <box paddingLeft={1}>
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={theme().muted}>
                ─
              </text>
              <text flexShrink={0} fg={theme().primary}>
                ●
              </text>
              <text fg={theme().text}>
                orchestrator <span style={{ fg: theme().muted }}>(you)</span>
              </text>
            </box>
            <For each={children()}>
              {(child, index) => {
                const last = () => index() === children().length - 1
                const status = () => glyph(child)
                const tools = () => toolsUsed(props.context, child.id)
                return (
                  <box gap={0}>
                    <box flexDirection="row" gap={0} paddingLeft={1}>
                      <text flexShrink={0} fg={theme().muted}>
                        {last() ? "└─" : "├─"}
                      </text>
                      <text flexShrink={0} fg={status().color}>
                        {status().char}
                      </text>
                      <text fg={theme().text} wrapMode="word">
                        {child.title ?? child.id}
                      </text>
                      <Show when={child.outcome !== undefined}>
                        <text fg={theme().muted}> {child.outcome}</text>
                      </Show>
                    </box>
                    <Show when={tools().length > 0}>
                      <box flexDirection="row" gap={0} paddingLeft={1}>
                        <text flexShrink={0} fg={theme().muted}>
                          {last() ? "   " : "│  "}
                        </text>
                        <text fg={theme().muted}>{`└─ tools: ${tools().join(", ")}`}</text>
                      </box>
                    </Show>
                  </box>
                )
              }}
            </For>
          </box>
        </Show>
      </box>
    </Show>
  )
}
