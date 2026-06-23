import { createMemo, createResource } from "solid-js"
import { ModelPicker } from "./dialog-model"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { parseModel } from "../context/local"
import { useToast } from "../ui/toast"

export function DialogEmbeddingModel() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  const [config] = createResource(async () => {
    const result = await sdk.client.global.banyanConfig.get()
    return result.data as { banyancode_embedding_model?: string } | undefined
  })

  const current = createMemo(() => {
    const model = config()?.banyancode_embedding_model
    return model ? parseModel(model) : undefined
  })

  async function onSelect(providerID: string, modelID: string) {
    const fullModel = modelID.startsWith(`${providerID}/`) ? modelID : `${providerID}/${modelID}`
    // Save the previous model name so we can roll back the config if the
    // apply call fails after the config has already been updated. Without
    // this, picking an unavailable model leaves the config in a stuck state
    // until the user manually opens the dialog again.
    const previous = config()?.banyancode_embedding_model
    try {
      await sdk.client.global.banyanConfig.update({
        config: { banyancode_embedding_model: fullModel },
        scope: "global",
      })
      await sdk.client.global.embedding.model.apply({})
      dialog.clear()
    } catch (err: any) {
      const message = err?.message ?? String(err)
      // Best-effort rollback. If the rollback itself fails, the user will
      // see the original error and can pick another model to recover.
      if (previous !== undefined) {
        try {
          await sdk.client.global.banyanConfig.update({
            config: { banyancode_embedding_model: previous },
            scope: "global",
          })
        } catch {
          // ignore
        }
      }
      toast.show({
        message: `Failed to set embedding model: ${message}`,
        variant: "error",
      })
    }
  }

  return <ModelPicker mode="embedding" title="Select embedding model" current={current()} onSelect={onSelect} />
}

