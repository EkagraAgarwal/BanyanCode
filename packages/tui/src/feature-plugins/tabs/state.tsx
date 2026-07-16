/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"

<<<<<<< HEAD
export type ActiveTab = "chat" | "sessions" | "agents" | "memory" | "settings"
=======
export type ActiveTab = "chat" | "sessions" | "agents" | "memory"
>>>>>>> distribution-channels
const [activeTab, setActiveTab] = createSignal<ActiveTab>("chat")
export { activeTab, setActiveTab }
