import { ModelPicker } from "./dialog-model"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useLocal } from "../context/local"
import { useToast } from "../ui/toast"

export function DialogEmbeddingModel() {
  const dialog = useDialog()
  const sdk = useSDK()
  const local = useLocal()
  const toast = useToast()

  function onSelect(providerID: string, modelID: string) {
    const fullModel = modelID.includes("/") ? modelID : `${providerID}/${modelID}`
    local.embeddingModel.set({ providerID, modelID })
    void sdk.client.global.banyanConfig
      .update({ config: { banyancode_embedding_model: fullModel }, scope: "global" })
      .catch((err: any) => {
        toast.show({
          message: `Embedding model saved locally but server apply failed: ${err?.message ?? String(err)}`,
          variant: "error",
        })
      })
    dialog.clear()
  }

  return <ModelPicker mode="embedding" title="Select embedding model" current={local.embeddingModel.current()} onSelect={onSelect} />
}
