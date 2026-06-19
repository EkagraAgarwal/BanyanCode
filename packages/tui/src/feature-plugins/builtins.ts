import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import HomeFooter from "./home/footer"
import HomeTips from "./home/tips"
import SidebarContext from "./sidebar/context"
import SidebarFiles from "./sidebar/files"
import SidebarFooter from "./sidebar/footer"
import SidebarLsp from "./sidebar/lsp"
import SidebarMcp from "./sidebar/mcp"
import SidebarAgentTree from "./sidebar/agent-tree"
import SidebarSystemStatus from "./sidebar/system-status"
import SidebarTodo from "./sidebar/todo"
import InspectorAgentDetails from "./inspector/agent-details"
import InspectorGraphExplorer from "./inspector/graph-explorer"
import InspectorPendingActions from "./inspector/pending-actions"
import SidebarCodegraphLayers from "./sidebar/codegraph-layers"
import SidebarCodegraphOverview from "./sidebar/codegraph-overview"
import HeaderBrand from "./header/brand"
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

export type BuiltinTuiPlugin = Omit<TuiPluginModule, "id"> & {
  id: string
  tui: TuiPlugin
  enabled?: boolean
}

export function createBuiltinPlugins(options: { experimentalEventSystem: boolean }): BuiltinTuiPlugin[] {
  return [
    HomeFooter,
    HomeTips,
    SidebarContext,
    SidebarSystemStatus,
    SidebarCodegraphLayers,
    SidebarCodegraphOverview,
    SidebarMcp,
    SidebarAgentTree,
    SidebarLsp,
    SidebarTodo,
    InspectorAgentDetails,
    InspectorGraphExplorer,
    InspectorPendingActions,
    SidebarFiles,
    SidebarFooter,
    HeaderBrand,
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
    TabSettings,
  ]
}
