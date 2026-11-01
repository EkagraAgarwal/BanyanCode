/**
 * Command ids, panel names, and route names. Stable strings: palette
 * bindings, keybind config, and route navigation all key off them.
 */

export const PLUGIN_ID = "banyancode.tui"

export const PANEL = {
  details: "banyancode.details",
  todos: "banyancode.todos",
  graph: "banyancode.graph",
  canvas: "banyancode.canvas",
  pending: "banyancode.pending",
  sessions: "banyancode.sessions",
  agents: "banyancode.agents",
  config: "banyancode.config",
  trace: "banyancode.trace",
  usage: "banyancode.usage",
  system: "banyancode.system",
} as const

export type PanelName = (typeof PANEL)[keyof typeof PANEL]

export const PANEL_NAMES: ReadonlySet<string> = new Set(Object.values(PANEL))

export interface RailItem {
  readonly name: PanelName
  readonly label: string
  readonly title: string
}

/**
 * Left rail order mirrors v1's tab bar minus MEMORY (dropped): CHAT is the
 * session itself, SESSIONS/AGENTS/CONFIG are the first-class views, and the
 * inspector/tab surfaces v1 mounted through `session_inspector` follow.
 */
export const RAIL: readonly RailItem[] = [
  { name: PANEL.details, label: "Details", title: "Agent details" },
  { name: PANEL.todos, label: "Todo", title: "Session todo list" },
  { name: PANEL.graph, label: "Graph", title: "Codegraph explorer" },
  { name: PANEL.canvas, label: "Canvas", title: "Codegraph canvas" },
  { name: PANEL.pending, label: "Pending", title: "Pending actions" },
  { name: PANEL.sessions, label: "Sessions", title: "Sessions" },
  { name: PANEL.agents, label: "Agents", title: "Agent tree" },
  { name: PANEL.config, label: "Config", title: "Agent config" },
  { name: PANEL.trace, label: "Trace", title: "Intel trace" },
  { name: PANEL.usage, label: "Usage", title: "Provider usage" },
  { name: PANEL.system, label: "System", title: "System status" },
]

/**
 * Router pages use the same stable names as panels: `openView` either opens
 * the session panel or navigates to the page of the same name.
 */
