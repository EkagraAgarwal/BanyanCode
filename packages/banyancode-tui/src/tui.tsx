import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { Show } from "solid-js"
import { PANEL, PANEL_NAMES, PLUGIN_ID, RAIL, type PanelName } from "./constants"
import { createLive, type Live } from "./data/live"
import { CodegraphProgress } from "./components/status/codegraph-progress"
import { StatusPills } from "./components/status/pills"
import { SessionStatus } from "./components/status/session-status"
import { AgentsPanel } from "./components/sidebar/agents"
import { AgentTreePanel } from "./components/sidebar/agent-tree"
import { CodebaseTreePanel } from "./components/sidebar/codebase-tree"
import { CodegraphIntelPanel } from "./components/sidebar/codegraph-intel-panel"
import { CodegraphPanel } from "./components/sidebar/codegraph-panel"
import { IntelTracePanel } from "./components/sidebar/intel-trace-panel"
import { PerformancePanel } from "./components/sidebar/performance"
import { ProviderUsagePanel } from "./components/sidebar/provider-usage"
import { SystemPanel } from "./components/sidebar/system-status"
import { ToolUsagePanel } from "./components/sidebar/tool-usage"
import { InspectorPage, InspectorPanel } from "./components/panels/inspector"

/** Panel presentation requested by a view command. */
type Presentation = "panel" | "fullscreen"

function openView(context: Context, name: PanelName, options?: { readonly presentation?: Presentation }) {
  const route = context.ui.router.current()
  const sessionID = route.type === "session" ? route.sessionID : undefined
  if (sessionID !== undefined && context.ui.panel.open(name, options)) return
  context.ui.router.navigate({
    type: "plugin",
    name,
    data: { view: name, sessionID },
  })
}

/**
 * BanyanCode TUI plugin.
 *
 * v1 mounted every surface through `feature-plugins/builtins.ts`; v2 mounts
 * plugins through `Plugin.define` and the slot tree. This is the single entry
 * point: slot claims, router pages, and palette commands all live here so a
 * host registration is one import in `packages/tui/src/plugin/builtins.ts`.
 */
export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    const live = createLive(context)

    // --- sidebar (v1 registration order) ----------------------------------
    context.ui.slot({
      append: "sidebar.content",
      render: (input) => <AgentsPanel context={context} sessionID={input.sessionID} mesh={live.mesh} />,
    })
    context.ui.slot({
      append: "sidebar.content",
      render: () => <CodebaseTreePanel context={context} codegraph={live.codegraph} />,
    })
    context.ui.slot({
      append: "sidebar.content",
      render: (input) => <PerformancePanel context={context} sessionID={input.sessionID} />,
    })
    context.ui.slot({
      append: "sidebar.content",
      render: () => <SystemPanel context={context} system={live.system} />,
    })
    context.ui.slot({
      append: "sidebar.content",
      render: (input) => <ProviderUsagePanel context={context} sessionID={input.sessionID} usage={live.usage} />,
    })
    context.ui.slot({
      append: "sidebar.content",
      render: (input) => <AgentTreePanel context={context} sessionID={input.sessionID} mesh={live.mesh} />,
    })
    context.ui.slot({
      append: "sidebar.content",
      render: () => <CodegraphPanel context={context} codegraph={live.codegraph} />,
    })
    context.ui.slot({
      append: "sidebar.content",
      render: () => <CodegraphIntelPanel context={context} intel={live.intel} />,
    })
    context.ui.slot({
      append: "sidebar.content",
      render: (input) => <IntelTracePanel context={context} sessionID={input.sessionID} intel={live.intel} />,
    })
    context.ui.slot({
      append: "sidebar.content",
      render: () => <ToolUsagePanel context={context} usage={live.usage} codegraph={live.codegraph} />,
    })

    // --- status surfaces ---------------------------------------------------
    // v1 app_top status pills → prompt.footer.status in a session,
    // home.footer.status on the home screen.
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => (
        <StatusPills context={context} sessionID={input.sessionID} codegraph={live.codegraph} mesh={live.mesh} />
      ),
    })
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => (
        <Show when={input.sessionID}>
          {(sessionID) => <SessionStatus context={context} sessionID={sessionID()} />}
        </Show>
      ),
    })
    context.ui.slot({
      append: "home.footer.status",
      render: () => <StatusPills context={context} codegraph={live.codegraph} mesh={live.mesh} />,
    })

    // v1 floating codegraph overlay → v2 composer rail.
    context.ui.slot({
      append: "session.composer.top",
      render: (input) => <CodegraphProgress context={context} codegraph={live.codegraph} />,
    })

    // v1 inspector + tab views → one panel with a left rail.
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={PANEL_NAMES.has(panel.name)}>
          <InspectorPanel context={context} live={live} panel={panel} />
        </Show>
      ),
    })

    for (const item of RAIL) {
      context.ui.router.register({
        name: item.name,
        render: ({ data }) => <InspectorPage context={context} live={live} data={data} />,
      })
    }

    // --- commands ----------------------------------------------------------
    const notify = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ message, variant })

    const report = (result: { ok: boolean; message?: string }, success: string) => {
      if (result.ok) notify(success, "success")
      else notify(result.message ?? "BanyanCode RPC is not available on this server", "warning")
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "codegraph.build",
          title: "Codegraph: build index",
          description: "Index the workspace code graph",
          group: "Codegraph",
          palette: true,
          async run() {
            report(await live.codegraph.start(), "Codegraph build started")
          },
        },
        {
          id: "codegraph.cancel",
          title: "Codegraph: cancel build",
          description: "Cancel the in-flight codegraph build",
          group: "Codegraph",
          palette: true,
          slash: { name: "codegraph-cancel" },
          async run() {
            report(await live.codegraph.cancel(), "Codegraph build cancelled")
          },
        },
        {
          id: "codegraph.remove",
          title: "Codegraph: remove index",
          description: "Clear the codegraph index for this workspace",
          group: "Codegraph",
          palette: true,
          slash: { name: "codegraph-remove" },
          async run() {
            report(await live.codegraph.remove(false), "Codegraph index removed")
          },
        },
        {
          id: "codegraph.force-kill",
          title: "Codegraph: force-kill a wedged build",
          description: "Force-kill the server hosting a hung codegraph build",
          group: "Codegraph",
          slash: { name: "codegraph-force-kill" },
          async run() {
            const result = await live.codegraph.forceKill()
            if (result.ok) notify(result.value.message, result.value.ok ? "success" : "warning")
            else notify(result.message, "warning")
          },
        },
        {
          id: "codegraph.open",
          title: "Codegraph: open graph explorer",
          group: "Codegraph",
          palette: true,
          run() {
            openView(context, PANEL.graph)
          },
        },
        {
          id: "agent.tree",
          title: "Agent tree",
          description: "Show the session's subagent tree",
          group: "BanyanCode",
          palette: true,
          slash: { name: "agent-tree" },
          run() {
            openView(context, PANEL.agents)
          },
        },
        {
          id: "banyancode.sessions",
          title: "BanyanCode: sessions",
          group: "BanyanCode",
          palette: true,
          run() {
            openView(context, PANEL.sessions)
          },
        },
        {
          id: "banyancode.details",
          title: "BanyanCode: agent details",
          group: "BanyanCode",
          palette: true,
          run() {
            openView(context, PANEL.details)
          },
        },
        {
          id: "banyancode.todos",
          title: "BanyanCode: todo list",
          group: "BanyanCode",
          palette: true,
          run() {
            openView(context, PANEL.todos)
          },
        },
        {
          id: "banyancode.pending",
          title: "BanyanCode: pending actions",
          group: "BanyanCode",
          palette: true,
          run() {
            openView(context, PANEL.pending)
          },
        },
        {
          id: "banyancode.trace",
          title: "BanyanCode: intel trace",
          group: "BanyanCode",
          palette: true,
          run() {
            openView(context, PANEL.trace)
          },
        },
        {
          id: "banyancode.usage",
          title: "BanyanCode: provider usage",
          group: "BanyanCode",
          palette: true,
          run() {
            openView(context, PANEL.usage)
          },
        },
        {
          id: "banyancode.system",
          title: "BanyanCode: system status",
          group: "BanyanCode",
          palette: true,
          run() {
            openView(context, PANEL.system)
          },
        },
        {
          id: "usage.refresh",
          title: "Refresh provider usage",
          group: "BanyanCode",
          palette: true,
          async run() {
            await live.usage.refreshProviders(true)
            notify("Provider usage refreshed", "success")
          },
        },
      ],
    }))

    return () => live.dispose()
  },
})

export { createLive }
export type { Live }
