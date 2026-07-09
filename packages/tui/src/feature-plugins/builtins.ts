import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import HomeFooter from "./home/footer"
import HomeTips from "./home/tips"
import SidebarAgents from "./sidebar/agents"
import SidebarPerformance from "./sidebar/performance"
import SidebarContext from "./sidebar/context"
import SidebarFiles from "./sidebar/files"
import SidebarFooter from "./sidebar/footer"
import SidebarLsp from "./sidebar/lsp"
import SidebarMcp from "./sidebar/mcp"
import SidebarCodebaseTree from "./sidebar/codebase-tree"
import InspectorAgentDetails from "./inspector/agent-details"
import InspectorTodo from "./inspector/todo"
import InspectorAgentActivity from "./inspector/agent-activity"
import InspectorGraphExplorer from "./inspector/graph-explorer"
import InspectorPendingActions from "./inspector/pending-actions"
import SidebarCodegraphPanel from "./sidebar/codegraph-panel"
import SidebarCodegraphIntelPanel from "./sidebar/codegraph-intel-panel"
import SidebarSystemStatus from "./sidebar/system-status"
import SessionFooter from "./footer/session-footer"
import AttentionStrip from "../component/attention-strip"
import HeaderBrand from "./header/brand"
import HeaderSessionCost from "./header/session-cost"
import HeaderStatusPills from "./header/status-pills"
import HeaderKeybindingHints from "./header/keybinding-hints"
import DiffViewer from "./system/diff-viewer"
import Notifications from "./system/notifications"
import PluginManager from "./system/plugins"
import WhichKey from "./system/which-key"
import TabBar from "./tabs/tab-bar"
import TabGraph from "./tabs/tab-graph"
import TabMemory from "./tabs/tab-memory"
import TabAgents from "./tabs/tab-agents"
import TabSettings from "./tabs/tab-settings"
import TabSessions from "./tabs/tab-sessions"

export type BuiltinTuiPlugin = Omit<TuiPluginModule, "id"> & {
  id: string
  tui: TuiPlugin
  enabled?: boolean
}

export function createBuiltinPlugins(options: { experimentalEventSystem: boolean }): BuiltinTuiPlugin[] {
  return [
    HomeFooter,
    HomeTips,
    SidebarAgents,
    SidebarPerformance,
    SidebarContext,
    SidebarSystemStatus,
    SidebarCodebaseTree,
    SidebarCodegraphPanel,
    SidebarCodegraphIntelPanel,
    SidebarMcp,
    SidebarLsp,
    SidebarFiles,
    SidebarFooter,
    InspectorAgentDetails,
    InspectorTodo,
    InspectorAgentActivity,
    InspectorGraphExplorer,
    InspectorPendingActions,
    SessionFooter,
    AttentionStrip,
    HeaderBrand,
    HeaderSessionCost,
    HeaderStatusPills,
    HeaderKeybindingHints,
    Notifications,
    PluginManager,
    WhichKey,
    DiffViewer,
    TabBar,
    TabGraph,
    TabMemory,
    TabAgents,
    TabSessions,
    TabSettings,
  ]
}

