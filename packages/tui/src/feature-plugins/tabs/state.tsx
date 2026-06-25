/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"

export type ActiveTab = "chat" | "sessions" | "agents" | "graph" | "memory" | "settings"
const [activeTab, setActiveTab] = createSignal<ActiveTab>("chat")
export { activeTab, setActiveTab }
