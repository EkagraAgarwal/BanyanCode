import { Plugin } from "@opencode/plugin/tui"
import { Goal } from "@opencode/schema/goal"
import { Show } from "solid-js"
import { PANEL, PANEL_NAMES, PLUGIN_ID, RAIL } from "./constants"
import { createLive, type Live } from "./data/live"
import { CodegraphProgress } from "./components/status/codegraph-progress"
import { StatusPills } from "./components/status/pills"
import { SessionStatus } from "./components/status/session-status"
import { AttentionStrip } from "./components/status/attention"
import { AgentsPanel } from "./components/sidebar/agents"
import { AgentTreePanel } from "./components/sidebar/agent-tree"
import { CodebaseTreePanel } from "./components/sidebar/codebase-tree"
import { ContextBreakdownPanel } from "./components/sidebar/context-breakdown"
import { ModifiedFilesPanel } from "./components/sidebar/files"
import { CodegraphIntelPanel } from "./components/sidebar/codegraph-intel-panel"
import { CodegraphPanel } from "./components/sidebar/codegraph-panel"
import { IntelTracePanel } from "./components/sidebar/intel-trace-panel"
import { PerformancePanel } from "./components/sidebar/performance"
import { ProviderUsagePanel } from "./components/sidebar/provider-usage"
import { SystemPanel } from "./components/sidebar/system-status"
import { ToolUsagePanel } from "./components/sidebar/tool-usage"
import { InspectorPage, InspectorPanel } from "./components/panels/inspector"
import { closeView, cycleView, openView } from "./components/panels/nav"
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
    // v1 showed the token breakdown and the session's changed files in the
    // sidebar; the host's Context panel only carries the total, so both are
    // ported here as additive panels (they render nothing without data).
    context.ui.slot({
      append: "sidebar.content",
      render: (input) => <ContextBreakdownPanel context={context} sessionID={input.sessionID} />,
    })
    context.ui.slot({
      append: "sidebar.content",
      render: (input) => <ModifiedFilesPanel context={context} sessionID={input.sessionID} />,
    })
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

    // v1 attention strip. The host replaces the prompt (and with it the
    // prompt footer) while a permission or question is pending, so this slot
    // is the only surface that can carry the attention count at that moment.
    context.ui.slot({
      append: "session.composer.top",
      render: (input) => <AttentionStrip context={context} sessionID={input.sessionID} />,
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

    // Parses the on/off/toggle argument these commands share. Undefined means it was not understood, and has been said so.
    const switchTo = (input: string | undefined, current: boolean, usage: string) => {
      const arg = (input ?? "").trim().toLowerCase()
      if (arg === "" || arg === "toggle") return !current
      if (arg === "on" || arg === "true") return true
      if (arg === "off" || arg === "false") return false
      notify(`Unknown argument "${arg}". Usage: ${usage}`, "warning")
      return undefined
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "banyancode.panel.close",
          title: "Close BanyanCode panel",
          bind: "escape",
          enabled: () => context.ui.panel.current() !== undefined || context.ui.router.current().type === "plugin",
          run() {
            closeView(context)
          },
        },
        // v1 tab bar keys: ctrl+] / ctrl+[ cycle CHAT → SESSIONS → AGENTS → CONFIG.
        {
          id: "tabs.next",
          title: "Next tab",
          description: "Next view",
          group: "Tabs",
          bind: "ctrl+]",
          palette: true,
          // The views belong to a session. On the home screen there's nothing to show them for.
          enabled: () => context.ui.router.current().type !== "home",
          async run() {
            cycleView(context, 1)
          },
        },
        {
          id: "tabs.previous",
          title: "Previous tab",
          description: "Previous view",
          group: "Tabs",
          bind: "ctrl+[",
          palette: true,
          enabled: () => context.ui.router.current().type !== "home",
          async run() {
            cycleView(context, -1)
          },
        },
        {
          id: "codegraph.build",
          title: "Codegraph: build index",
          group: "Codegraph",
          palette: true,
          slash: { name: "codegraph-build", arguments: true, optionalArguments: true },
          async run(input) {
            const force = /(^|\s)--force(\s|$)/.test(input ?? "")
            report(await live.codegraph.start({ force }), "Codegraph build started")
          },
        },
        {
          id: "codegraph.cancel",
          title: "Codegraph: cancel build",
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
          group: "Codegraph",
          palette: true,
          slash: { name: "codegraph-remove", arguments: true, optionalArguments: true },
          async run(input) {
            const dropFile = /(^|\s)--drop-file(\s|$)/.test(input ?? "")
            report(await live.codegraph.remove(dropFile), "Codegraph index removed")
          },
        },
        {
          id: "codegraph.force-kill",
          title: "Codegraph: force-kill a wedged build",
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
          group: "Codegraph",
          palette: true,
          run() {
            openView(context, PANEL.canvas)
          },
        },
        {
          id: "banyancode.config",
          title: "BanyanCode: agent config",
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
          description: "Steer or kill subagents",
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
          description: "Subagent tree panel",
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
          group: "BanyanCode",
          palette: true,
          slash: { name: "yolo", arguments: true, optionalArguments: true },
          async run(input) {
            if (live.system.yoloAvailability() === "unknown") await live.system.refreshYolo()
            const next = switchTo(input, live.system.yolo() === true, "/yolo <on|off|toggle>")
            if (next === undefined) return
            report(await live.system.setYolo(next), `YOLO mode ${next ? "enabled" : "disabled"}`)
          },
        },
        {
          // v1 `swarm.toggle`.
          id: "swarm.toggle",
          title: "Toggle swarm mode",
          group: "BanyanCode",
          palette: true,
          slash: { name: "swarm", arguments: true, optionalArguments: true },
          async run(input) {
            if (live.mesh.limits() === undefined) await live.mesh.refreshLimits()
            const next = switchTo(input, live.mesh.swarmMode() === true, "/swarm <on|off|toggle>")
            if (next === undefined) return
            report(await live.mesh.setLimits({ swarmMode: next }), `Swarm mode ${next ? "enabled" : "disabled"}`)
          },
        },
        {
          // v1 `subagents.max_subagents`.
          id: "subagents.max_subagents",
          title: "Set max concurrent subagents",
          group: "BanyanCode",
          palette: true,
          slash: { name: "max-subagents", arguments: true, optionalArguments: true },
          async run(input) {
            const text = (input ?? "").trim()
            if (text === "") {
              await openMaxSubagents(context, live)
              return
            }
            const value = Number(text)
            if (!Number.isInteger(value) || value < 1 || value > 20) {
              notify(`Max subagents must be a whole number from 1 to 20, got "${text}"`, "warning")
              return
            }
            report(await live.mesh.setLimits({ maxSubagents: value }), `Max subagents set to ${value}`)
          },
        },
        {
          id: "lsp.toggle",
          title: "Toggle LSP",
          group: "BanyanCode",
          palette: true,
          slash: { name: "lsp", arguments: true, optionalArguments: true },
          async run(input) {
            await live.system.refreshLsp()
            const next = switchTo(input, live.system.lsp()?.enabled === true, "/lsp <on|off|toggle>")
            if (next === undefined) return
            report(await live.core.update({ banyancode_lsp: next }), `LSP ${next ? "on" : "off"}`)
            await live.system.refreshLsp()
          },
        },
        {
          // Setting a goal is the server's /goal. Asking about one must not start a model turn.
          id: "goal.status",
          title: "Goal status",
          group: "BanyanCode",
          slash: { name: "goal", arguments: true },
          run(input) {
            const text = (input ?? "").trim()
            if (text === "") {
              notify("Usage: /goal <objective> | status | pause | resume | clear")
              return
            }
            if (text !== "status") return false
            const route = context.ui.router.current()
            if (route.type !== "session") {
              notify("No active goal")
              return
            }
            return context.client
              .rpc(Goal.Definition)
              .get({ sessionID: route.sessionID })
              .then(
                (goal) => notify(goal ? `Goal (${goal.status}): ${goal.objective}` : "No active goal"),
                () => notify("No active goal"),
              )
          },
        },
        {
          // v1 `/thinking` (`/variant` and `/reasoning` are aliases).
          id: "thinking.set",
          title: "Set reasoning variant",
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
