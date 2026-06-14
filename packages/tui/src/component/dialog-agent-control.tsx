import { createMemo, createSignal, For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useSync } from "../context/sync"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"
import { Locale } from "../util/locale"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"

interface SubagentInfo {
  sessionID: string
  agent: string
  status: "active" | "idle" | "disconnected"
  lastSeenAt: number
  lastCheckpoint?: { summary: string; todos: unknown }
}

export function DialogAgentControl() {
  const sync = useSync()
  const sdk = useSDK()
  const route = useRoute()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()

  const currentSessionID = createMemo(() => {
    if (route.data.type === "session") return route.data.sessionID
    return sync.data.session.find((s) => !s.parentID)?.id
  })

  const children = createMemo(() => sync.data.session.filter((s) => s.parentID === currentSessionID()))

  const [selectedAgent, setSelectedAgent] = createSignal<SubagentInfo | null>(null)
  const [action, setAction] = createSignal<"view-plan" | "steer" | "kill" | null>(null)
  const [steerInput, setSteerInput] = createSignal("")

  const options = createMemo<DialogSelectOption<string>[]>(() =>
    children().map((child) => ({
      value: child.id,
      title: child.title,
      description: `Session: ${Locale.truncateMiddle(child.id, 24)}`,
    })),
  )

  async function handleSteer(sessionID: string, instruction: string) {
    const mesh = (sdk.client as any).session?.mesh
    if (!mesh?.steer) {
      toast.show({ title: "SDK method not available", message: "mesh.steer not found - SDK regeneration needed", variant: "error" })
      return
    }
    try {
      await mesh.steer({
        parentSessionID: currentSessionID() ?? "",
        targetAgent: children().find((c) => c.id === sessionID)?.title ?? "",
        instruction,
      })
      toast.show({ title: "Steer sent", message: `Instruction sent to ${sessionID}`, variant: "info" })
      dialog.clear()
    } catch (err) {
      toast.show({ title: "Steer failed", message: String(err), variant: "error" })
    }
  }

  async function handleKill(sessionID: string) {
    const mesh = (sdk.client as any).session?.mesh
    if (!mesh?.kill) {
      toast.show({ title: "SDK method not available", message: "mesh.kill not found - SDK regeneration needed", variant: "error" })
      return
    }
    const confirmed = await DialogConfirm.show(dialog, "Kill subagent", `Are you sure you want to kill this subagent?`)
    if (!confirmed) return
    try {
      await mesh.kill({
        parentSessionID: currentSessionID() ?? "",
        targetAgent: children().find((c) => c.id === sessionID)?.title ?? "",
        reason: "User requested kill",
      })
      toast.show({ title: "Kill sent", message: `Kill signal sent to ${sessionID}`, variant: "info" })
      dialog.clear()
    } catch (err) {
      toast.show({ title: "Kill failed", message: String(err), variant: "error" })
    }
  }

  function handleViewPlan(sessionID: string) {
    const mesh = (sdk.client as any).session?.mesh
    if (!mesh?.planFor) {
      toast.show({ title: "SDK method not available", message: "mesh.planFor not found - SDK regeneration needed", variant: "error" })
      return
    }
    toast.show({ title: "View plan", message: "Plan viewer not yet implemented", variant: "info" })
  }

  if (action() === "steer" && selectedAgent()) {
    return (
      <box gap={1} paddingBottom={1} flexGrow={1}>
        <box paddingLeft={4} paddingRight={4}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>Steer: {selectedAgent()!.agent}</text>
            <text fg={theme.textMuted} onMouseUp={() => setAction(null)}>esc</text>
          </box>
          <text fg={theme.textMuted} paddingTop={1}>Session: {Locale.truncateMiddle(selectedAgent()!.sessionID, 24)}</text>
        </box>
        <box flexGrow={1} flexShrink={1} paddingLeft={4} paddingRight={4}>
          <input
            onInput={(e: string) => setSteerInput(e)}
            value={steerInput()}
            placeholder="Enter instruction for this subagent..."
            focusedBackgroundColor={theme.backgroundPanel}
            cursorColor={theme.primary}
            focusedTextColor={theme.textMuted}
            ref={(r) => {
              setTimeout(() => r?.focus(), 1)
            }}
          />
        </box>
        <box paddingRight={2} paddingLeft={4} flexDirection="row" justifyContent="flex-end" flexShrink={0}>
          <box paddingLeft={1} paddingRight={1} onMouseUp={() => setAction(null)}>
            <text fg={theme.textMuted}>Cancel</text>
          </box>
          <box paddingLeft={1} paddingRight={1} backgroundColor={theme.primary} onMouseUp={() => handleSteer(selectedAgent()!.sessionID, steerInput())}>
            <text fg={theme.selectedListItemText}>Send</text>
          </box>
        </box>
      </box>
    )
  }

  if (action() === "kill" && selectedAgent()) {
    return (
      <box gap={1} paddingBottom={1} flexGrow={1}>
        <box paddingLeft={4} paddingRight={4}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>Kill: {selectedAgent()!.agent}</text>
            <text fg={theme.textMuted} onMouseUp={() => setAction(null)}>esc</text>
          </box>
          <text fg={theme.textMuted} paddingTop={1}>Session: {Locale.truncateMiddle(selectedAgent()!.sessionID, 24)}</text>
        </box>
        <box flexGrow={1} flexShrink={1} paddingLeft={4} paddingRight={4}>
          <text fg={theme.textMuted}>Are you sure you want to kill this subagent? This action cannot be undone.</text>
        </box>
        <box paddingRight={2} paddingLeft={4} flexDirection="row" justifyContent="flex-end" flexShrink={0}>
          <box paddingLeft={1} paddingRight={1} onMouseUp={() => setAction(null)}>
            <text fg={theme.textMuted}>Cancel</text>
          </box>
          <box paddingLeft={1} paddingRight={1} backgroundColor={theme.error} onMouseUp={() => handleKill(selectedAgent()!.sessionID)}>
            <text fg={theme.selectedListItemText}>Kill</text>
          </box>
        </box>
      </box>
    )
  }

  return (
    <DialogSelect
      title="Agent tree"
      options={options()}
      onSelect={(option) => {
        const child = children().find((c) => c.id === option.value)
        if (child) {
          setSelectedAgent({
            sessionID: child.id,
            agent: child.title,
            status: "active",
            lastSeenAt: child.time.updated,
          })
        }
      }}
      actions={[
        {
          command: "agent.tree.view_plan",
          title: "View plan",
          side: "right",
          onTrigger: (option) => {
            handleViewPlan(option.value)
          },
        },
        {
          command: "agent.tree.steer",
          title: "Steer",
          side: "right",
          onTrigger: (option) => {
            const child = children().find((c) => c.id === option.value)
            if (child) {
              setSelectedAgent({
                sessionID: child.id,
                agent: child.title,
                status: "active",
                lastSeenAt: child.time.updated,
              })
              setAction("steer")
            }
          },
        },
        {
          command: "agent.tree.kill",
          title: "Kill",
          side: "right",
          onTrigger: (option) => {
            const child = children().find((c) => c.id === option.value)
            if (child) {
              setSelectedAgent({
                sessionID: child.id,
                agent: child.title,
                status: "active",
                lastSeenAt: child.time.updated,
              })
              setAction("kill")
            }
          },
        },
      ]}
      footerHints={[
        { title: "View plan", label: "" },
        { title: "Steer", label: "" },
        { title: "Kill", label: "" },
      ]}
    />
  )
}
