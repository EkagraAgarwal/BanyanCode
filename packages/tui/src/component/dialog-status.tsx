import { useTheme } from "../context/theme"
import { DialogHeader, DialogLayout } from "../ui/dialog"
import { useData } from "../context/data"
import { For, Match, Switch, Show, createMemo } from "solid-js"

export function DialogStatus() {
  const data = useData()
  const theme = useTheme().surface("dialog")

  const mcp = createMemo(() => data.location.mcp.server.list() ?? [])
  const providers = createMemo(() => data.location.provider.list() ?? [])
  const models = createMemo(() => data.location.model.list() ?? [])
  const sessions = createMemo(() => data.session.list().filter((session) => !session.parentID))
  const running = createMemo(
    () => data.session.list().filter((session) => data.session.status(session.id) === "running").length,
  )
  const modelCount = (providerID: string) => models().filter((model) => model.providerID === providerID).length
  const color = (status: string) => {
    if (status === "connected") return theme.text.feedback.success.base
    if (status === "failed") return theme.text.feedback.error.base
    if (status === "needs_auth") return theme.text.feedback.warning.base
    return theme.text.muted
  }
  return (
    <DialogLayout header={<DialogHeader title="Status" />}>
      <Show when={providers().length > 0} fallback={<text fg={theme.text.base}>No providers connected</text>}>
        <box>
          <text fg={theme.text.base}>
            {providers().length} provider{providers().length === 1 ? "" : "s"}
          </text>
          <For each={providers()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} style={{ fg: theme.text.feedback.success.base }}>
                  •
                </text>
                <text fg={theme.text.base} wrapMode="word">
                  <b>{item.name}</b>{" "}
                  <span style={{ fg: theme.text.muted }}>
                    {modelCount(item.id)} model{modelCount(item.id) === 1 ? "" : "s"}
                  </span>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <box>
        <text fg={theme.text.base}>
          {sessions().length} session{sessions().length === 1 ? "" : "s"}
          {running() > 0 ? ` · ${running()} running` : ""}
        </text>
      </box>
      <Show when={mcp().length > 0} fallback={<text fg={theme.text.base}>No MCP servers</text>}>
        <box>
          <text fg={theme.text.base}>
            {mcp().length} MCP server{mcp().length === 1 ? "" : "s"}
          </text>
          <For each={mcp()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} style={{ fg: color(item.status.status) }}>
                  •
                </text>
                <text fg={theme.text.base} wrapMode="word">
                  <b>{item.name}</b>{" "}
                  <span style={{ fg: theme.text.muted }}>
                    <Switch fallback={item.status.status}>
                      <Match when={item.status.status === "connected"}>Connected</Match>
                      <Match when={item.status.status === "failed" && item.status}>{(val) => val().error}</Match>
                      <Match when={item.status.status === "disabled"}>Disabled in configuration</Match>
                      <Match when={item.status.status === "needs_auth" && item.status}>
                        {(val) => `Needs authentication: ${val().error}`}
                      </Match>
                    </Switch>
                  </span>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </DialogLayout>
  )
}
