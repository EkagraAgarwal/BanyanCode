import { createMemo, createSignal } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useData } from "../context/data"
import { useSDK } from "../context/sdk"
import * as fuzzysort from "fuzzysort"

export function DialogEmbeddingModel() {
  const dialog = useDialog()
  const data = useData()
  const sdk = useSDK()
  const [query, setQuery] = createSignal("")

  const currentModel = createMemo(() => {
    const models = data.location.model.list() ?? []
    return models.find((m) => m.enabled)?.id ?? undefined
  })

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
      title="Select embedding model"
      current={currentModel()}
      options={options().map((model) => {
        const provider = data.location.provider.list()?.find((p) => p.id === model.providerID)
        return {
          value: model.id,
          title: model.name,
          description: provider?.name ?? model.providerID,
          onSelect: async () => {
            const modelID = model.id
            const providerID = model.providerID
            const fullModel = `${providerID}/${modelID}`
            await (sdk.client as any).banyan?.config?.update?.({
              config: { banyancode_embedding_model: fullModel },
            })
            await sdk.client.global.embedding.model.apply({})
            dialog.clear()
          },
        }
      })}
      onFilter={setQuery}
      skipFilter={true}
    />
  )
}
