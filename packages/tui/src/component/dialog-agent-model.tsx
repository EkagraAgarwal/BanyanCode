import { createMemo, createSignal } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useData } from "../context/data"
import * as fuzzysort from "fuzzysort"

export function DialogAgentModel(props: { agentName: string }) {
  const local = useLocal()
  const dialog = useDialog()
  const data = useData()
  const [query, setQuery] = createSignal("")

  const current = local.model.currentFor(props.agentName)()

  const options = createMemo(() => {
    const needle = query().trim()
    const models = data.location.model.list() ?? []

    const filtered = models.filter((m) => m.status !== "deprecated")

    if (needle) {
      return fuzzysort.go(needle, filtered, { keys: ["name", "providerID"] }).map((result) => result.obj)
    }

    return filtered
  })

  return (
    <DialogSelect
      title={`Select model for ${props.agentName}`}
      current={current}
      options={options().map((model) => {
        const provider = data.location.provider.list()?.find((p) => p.id === model.providerID)
        return {
          value: { providerID: model.providerID, modelID: model.id },
          title: model.name,
          description: provider?.name ?? model.providerID,
          footer: model.cost[0]?.input === 0 && model.providerID === "opencode" ? "Free" : undefined,
          onSelect: () => {
            local.model.setForAgent(props.agentName, { providerID: model.providerID, modelID: model.id }, { recent: true })
            dialog.clear()
          },
        }
      })}
      onFilter={setQuery}
      skipFilter={true}
    />
  )
}
