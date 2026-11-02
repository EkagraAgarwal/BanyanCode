import { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import { PANEL, PANEL_NAMES, PLUGIN_ID, RAIL } from "./constants"
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
import { cycleView, openView } from "./components/panels/nav"
import { HomeStrip } from "./components/home/home-strip"
import {
  applyVariantCommand,
  openAgentControl,
  openAgentModel,
  openMaxSubagents,
} from "./components/dialogs/actions"

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
      // The home screen has its own row at home.footer.status; without this check it shows twice.
      render: (input) => (
        <Show when={input.sessionID}>
          <StatusPills
            context={context}
            sessionID={input.sessionID}
            codegraph={live.codegraph}
            mesh={live.mesh}
            system={live.system}
          />
        </Show>
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
      render: () => (
        <StatusPills context={context} codegraph={live.codegraph} mesh={live.mesh} system={live.system} />
      ),
    })

    // v1 home tip + progress overlay.
    context.ui.slot({
      append: "home.bottom",
      render: () => <HomeStrip context={context} codegraph={live.codegraph} />,
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
        // v1 tab bar keys: ctrl+] / ctrl+[ cycle CHAT → SESSIONS → AGENTS → CONFIG.
        {
          id: "tabs.next",
          title: "Next tab",
          description: "Switch to the next BanyanCode view",
          group: "Tabs",
          bind: "ctrl+]",
          palette: true,
          async run() {
            cycleView(context, 1)
          },
        },
        {
          id: "tabs.previous",
          title: "Previous tab",
          description: "Switch to the previous BanyanCode view",
          group: "Tabs",
          bind: "ctrl+[",
          palette: true,
          async run() {
            cycleView(context, -1)
          },
        },
        {
          id: "codegraph.build",
          title: "Codegraph: build index",
          description: "Index the workspace code graph",
          group: "Codegraph",
          palette: true,
          slash: { name: "codegraph-build" },
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
          id: "codegraph.canvas",
          title: "Codegraph: open canvas",
          description: "Open the layered codegraph canvas",
          group: "Codegraph",
          palette: true,
          run() {
            openView(context, PANEL.canvas)
          },
        },
        {
          id: "banyancode.config",
          title: "BanyanCode: agent config",
          description: "Edit agent models, thinking levels and prompts",
          group: "BanyanCode",
          palette: true,
          run() {
            openView(context, PANEL.config)
          },
        },
        {
          // v1 id + slash: the control dialog with steer/kill, not the tab.
          id: "agent.tree",
          title: "Agent tree",
          description: "Steer or kill a subagent in this session's tree",
          group: "BanyanCode",
          palette: true,
          slash: { name: "agent-tree" },
          async run() {
            await openAgentControl(context, live)
          },
        },
        {
          id: "agent.tree.panel",
          title: "Agent tree: full view",
          description: "Open the session's subagent tree panel",
          group: "BanyanCode",
          palette: true,
          run() {
            openView(context, PANEL.agents)
          },
        },
        {
          // v1 `agent.model` / `/agent-model`.
          id: "agent.model",
          title: "Pick model for orchestrator or subagent",
          description: "Choose the model that an agent uses",
          group: "BanyanCode",
          palette: true,
          slash: { name: "agent-model" },
          async run() {
            await openAgentModel(context, live)
          },
        },
        {
          // v1 `models.refresh`. v2 exposes no model-refresh RPC; re-syncing
          // the current location's host catalog is the available equivalent.
          id: "models.refresh",
          title: "Refresh models catalog",
          description: "Re-sync the model catalog for this location",
          group: "BanyanCode",
          palette: true,
          slash: { name: "refresh-models" },
          async run() {
            const location = context.location
            if (!location) {
              notify("No location is ready yet", "warning")
              return
            }
            await context.data.location.model.sync(location)
            notify("Models catalog refreshed", "success")
          },
        },
        {
          // v1 `yolo.toggle`.
          id: "yolo.toggle",
          title: "Toggle YOLO mode",
          description: "Turn BanyanCode YOLO mode on or off",
          group: "BanyanCode",
          palette: true,
          async run() {
            if (live.system.yoloAvailability() === "unknown") await live.system.refreshYolo()
            const next = live.system.yolo() !== true
            report(await live.system.setYolo(next), `YOLO mode ${next ? "enabled" : "disabled"}`)
          },
        },
        {
          // v1 `swarm.toggle`.
          id: "swarm.toggle",
          title: "Toggle swarm mode",
          description: "Turn BanyanCode swarm fan-out on or off",
          group: "BanyanCode",
          palette: true,
          async run() {
            if (live.mesh.limits() === undefined) await live.mesh.refreshLimits()
            const next = live.mesh.swarmMode() !== true
            report(await live.mesh.setLimits({ swarmMode: next }), `Swarm mode ${next ? "enabled" : "disabled"}`)
          },
        },
        {
          // v1 `subagents.max_subagents`.
          id: "subagents.max_subagents",
          title: "Set max concurrent subagents",
          description: "Open the 1-20 max-subagents dialog",
          group: "BanyanCode",
          palette: true,
          async run() {
            await openMaxSubagents(context, live)
          },
        },
        {
          // v1 `/thinking` (`/variant` and `/reasoning` are aliases).
          id: "thinking.set",
          title: "Set reasoning variant",
          description: "Read or set the current model's thinking variant",
          group: "BanyanCode",
          slash: { name: "thinking", aliases: ["variant", "reasoning"], arguments: true },
          run(input) {
            applyVariantCommand(context, input ?? "")
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
