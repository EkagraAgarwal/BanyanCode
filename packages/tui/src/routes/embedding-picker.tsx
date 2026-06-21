import { createMemo, createResource, For, Show } from "solid-js"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"

interface Endpoint {
  name: string
  base_url: string
  api_key?: string
  models?: string[]
}

interface BanyanConfigFull {
  banyancode_embedding_model?: string
  banyancode_embedding_dim?: number
  banyancode_embedding_type?: string
  banyancode_openai_compatible_endpoints?: Endpoint[]
  banyancode_yolo_mode?: boolean
  banyancode_disable_websearch?: boolean
  banyancode_telegram_enabled?: boolean
  banyancode_telegram_bot_token?: string
  banyancode_telegram_webhook_secret?: string
  banyancode_telegram_default_session?: string
}

export function EmbeddingPickerView() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  const [config, { refetch }] = createResource(async () => {
    const result = await sdk.client.global.banyanConfig.get()
    return result.data as BanyanConfigFull | undefined
  })

  const endpoints = createMemo(() => config()?.banyancode_openai_compatible_endpoints ?? [])
  const currentModel = createMemo(() => config()?.banyancode_embedding_model)
  const currentDim = createMemo(() => config()?.banyancode_embedding_dim)

  const onSelect = async (modelName: string) => {
    try {
      await sdk.client.global.banyanConfig.update({
        banyanConfig: { banyancode_embedding_model: modelName } as any,
      })
      await sdk.client.global.embedding.model.apply({})
      toast.show({
        message: `Model set to ${modelName}. Run /codegraph-build to rebuild.`,
        variant: "success",
      })
      dialog.clear()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.show({
        title: "Failed to set model",
        message: msg,
        variant: "error",
      })
    }
  }

  return (
    <box flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box paddingBottom={1}>
        <text>
          <b>Embedding Model</b>
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg="gray">
          Current: {currentModel() ?? "(none)"}
          {currentDim() ? ` · ${currentDim()} dims` : ""}
        </text>
      </box>
      <Show
        when={endpoints().length > 0}
        fallback={
          <box paddingTop={1}>
            <text fg="yellow">
              No OpenAI-compatible endpoints configured.
            </text>
            <text fg="gray">
              Add banyancode_openai_compatible_endpoints to ~/.config/banyancode/banyancode.json
            </text>
          </box>
        }
      >
        <For each={endpoints()}>
          {(endpoint) => (
            <box paddingTop={1}>
              <text>
                <b>{endpoint.name}</b>
              </text>
              <text fg="gray" paddingLeft={2}>
                {endpoint.base_url}
              </text>
              <Show
                when={(endpoint.models?.length ?? 0) > 0}
                fallback={<text fg="gray" paddingLeft={2}>No models listed</text>}
              >
                <For each={endpoint.models}>
                  {(model) => (
                    <box
                      paddingLeft={2}
                      paddingTop={0}
                      paddingBottom={0}
                      onMouseDown={async (e) => {
                        if (e.button === 0) {
                          await onSelect(model)
                        }
                      }}
                    >
                      <text
                        fg={model === currentModel() ? "green" : undefined}
                      >
                        {model === currentModel() ? "▶ " : "  "}
                        {model}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
          )}
        </For>
      </Show>
      <box paddingTop={2}>
        <text fg="gray">
          Click a model to select it
        </text>
      </box>
    </box>
  )
}
