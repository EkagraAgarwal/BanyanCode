/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"

export type ActiveTab = "chat" | "sessions" | "agents" | "config" | "memory"
const [activeTab, setActiveTab] = createSignal<ActiveTab>("chat")
export { activeTab, setActiveTab }
