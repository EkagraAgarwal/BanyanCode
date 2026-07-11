/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

const MODES = new Set(["build", "plan"])

export function DialogAgent() {
  const local = useLocal()
  const dialog = useDialog()

  const options = createMemo(() =>
    local.agent
      .list()
      .filter((item) => MODES.has(item.name))
      .map((item) => ({
        value: item.name,
        title: item.name === "plan" ? "Plan" : "Build",
        description: item.name === "plan"
          ? "Read-only. No file edits."
          : "Full access. Write and edit allowed.",
      })),
  )

  return (
    <DialogSelect
      title="Select mode"
      current={local.agent.current()?.name}
      options={options()}
      onSelect={(option) => {
        local.agent.set(option.value)
        dialog.clear()
      }}
    />
  )
}