import { createSignal } from "solid-js"

export type ActiveTab = "chat" | "graph" | "memory" | "agents" | "settings"
const [activeTab, setActiveTab] = createSignal<ActiveTab>("chat")
export { activeTab, setActiveTab }
