import { createMemo, createSignal, createResource } from "solid-js"
import { useLocal } from "../context/local"
import { map, pipe, filter, sortBy, take } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useData } from "../context/data"
import { useSDK } from "../context/sdk"

export interface ModelPickerProps {
  mode?: "model" | "embedding"
  providerID?: string
  current?: { providerID: string; modelID: string }
  title?: string
  onSelect: (providerID: string, modelID: string) => void
}

export function ModelPicker(props: ModelPickerProps) {
  const local = useLocal()
  const data = useData()
  const dialog = useDialog()
  const sdk = useSDK()
  const [query, setQuery] = createSignal("")

  const mode = createMemo(() => props.mode ?? "model")
  const connected = useConnected()
  const providers = createDialogProviderOptions()

  const [banyanConfig] = createResource(async () => {
    if (mode() !== "embedding") return undefined
    try {
      const res = await sdk.client.global.banyanConfig.get()
      return res.data
    } catch {
      return undefined
    }
  })

  const showExtra = createMemo(() => connected() && !props.providerID)

  const options = createMemo(() => {
    const needle = query().trim()

    if (mode() === "embedding") {
      const builtInList = BUILT_IN_EMBEDDING_MODELS

      const customEndpoints = banyanConfig()?.banyancode_openai_compatible_endpoints ?? []
      const customList = customEndpoints.flatMap((endpoint) => {
        const models = endpoint.models ?? []
        return models.map((modelName) => ({
          providerID: endpoint.name,
          modelID: modelName,
          name: modelName,
          category: `Custom: ${endpoint.name}`
        }))
      })

      const allEmbeds = [...builtInList, ...customList].map((model) => ({
        value: { providerID: model.providerID, modelID: model.modelID },
        title: model.name,
        category: model.category,
        footer: "dim" in model && typeof model.dim === "number" ? `${model.dim}d` : undefined,
        onSelect() {
          props.onSelect(model.providerID, model.modelID)
        }
      }))

      if (needle) {
        return fuzzysort.go(needle, allEmbeds, { keys: ["title", "category"] }).map((x) => x.obj)
      }
      return allEmbeds
    }
    // Favorites/recents are chat-model shortcuts; only surface them in model mode.
    const showSections = mode() === "model" && showExtra() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const provider = data.location.provider.list()?.find((provider) => provider.id === item.providerID)
        if (!provider) return []
        const model = data.location.model
          .list()
          ?.find((model) => model.providerID === item.providerID && model.id === item.modelID)
        if (!model) return []
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title: model.name,
            description: provider.name,
            category,
            disabled: provider.id === "opencode" && model.id.includes("-nano"),
            footer: model.cost[0]?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect: () => {
              props.onSelect(provider.id, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const providerOptions = pipe(
      data.location.model.list() ?? [],
      filter((model) => model.status !== "deprecated"),
      filter((model) => (props.providerID ? model.providerID === props.providerID : true)),
      sortBy(
        (model) => model.providerID !== "opencode",
        (model) => data.location.provider.list()?.find((provider) => provider.id === model.providerID)?.name ?? "",
        [(model) => model.time.released, "desc"],
      ),
      map((model) => ({
        value: { providerID: model.providerID, modelID: model.id },
        title: model.name,
        releaseDate: model.time.released,
        description:
          mode() === "model" &&
          favorites.some((item) => item.providerID === model.providerID && item.modelID === model.id)
            ? "(Favorite)"
            : undefined,
        category: connected()
          ? data.location.provider.list()?.find((provider) => provider.id === model.providerID)?.name
          : undefined,
        disabled: !model.enabled || (model.providerID === "opencode" && model.id.includes("-nano")),
        footer: model.cost[0]?.input === 0 && model.providerID === "opencode" ? "Free" : undefined,
        onSelect() {
          props.onSelect(model.providerID, model.id)
        },
      })),
      filter((option) => {
        if (!showSections) return true
        if (
          favorites.some((item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID)
        )
          return false
        if (
          recents.some((item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID)
        )
          return false
        return true
      }),
      (options) => sortModelOptions(options, props.providerID !== undefined),
    )

    const popularProviders = !connected()
      ? pipe(
          providers(),
          map((option) => ({
            ...option,
            category: "Popular providers",
          })),
          take(6),
        )
      : []

    if (needle) {
      return [
        ...fuzzysort.go(needle, providerOptions, { keys: ["title", "category"] }).map((x) => x.obj),
        ...fuzzysort.go(needle, popularProviders, { keys: ["title"] }).map((x) => x.obj),
      ]
    }

    return [...favoriteOptions, ...recentOptions, ...providerOptions, ...popularProviders]
  })

  const provider = createMemo(() =>
    props.providerID ? data.location.provider.list()?.find((item) => item.id === props.providerID) : null,
  )

  const title = createMemo(() => {
    if (props.title) return props.title
    const value = provider()
    if (!value) return "Select model"
    return value.name
  })

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      actions={[
        {
          command: "model.dialog.provider",
          title: connected() ? "Connect provider" : "View all providers",
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          command: "model.dialog.favorite",
          title: "Favorite",
          hidden: mode() !== "model" || !connected(),
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={props.current}
    />
  )
}

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const dialog = useDialog()

  function onSelect(providerID: string, modelID: string) {
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.selected()
    if (cur === "default" || (cur && list.includes(cur))) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  return <ModelPicker providerID={props.providerID} current={local.model.current()} onSelect={onSelect} />
}

// Each entry is the model identifier NIM / OpenAI / Cohere actually accepts
// as the `model` field on the /embeddings request. For NVIDIA NIM this is the
// full namespaced form (e.g. "nvidia/llama-nemotron-embed-1b-v2"); for OpenAI
// and Cohere it's the bare model name and the embedding-provider prepends
// providerID/. dim is shown in the picker so the user sees what they're
// committing to before the embedding table is recreated at a different
// F32_BLOB(N).
export interface BuiltInEmbeddingModel {
  readonly providerID: string
  readonly modelID: string
  readonly name: string
  readonly dim: number
  readonly category: string
}

export const BUILT_IN_EMBEDDING_MODELS: readonly BuiltInEmbeddingModel[] = [
  // OpenAI — bare model name; the embed plugin prepends providerID/.
  { providerID: "openai", modelID: "text-embedding-3-small", name: "Text Embedding 3 Small", dim: 1536, category: "OpenAI" },
  { providerID: "openai", modelID: "text-embedding-3-large", name: "Text Embedding 3 Large", dim: 3072, category: "OpenAI" },
  { providerID: "openai", modelID: "text-embedding-ada-002", name: "Text Embedding Ada 002", dim: 1536, category: "OpenAI" },

  // NVIDIA NIM — namespaced model identifier as NIM expects on the wire.
  // Verified live against https://integrate.api.nvidia.com/v1/embeddings.
  { providerID: "nvidia", modelID: "nvidia/llama-nemotron-embed-1b-v2", name: "Llama Nemotron Embed 1B v2", dim: 2048, category: "NVIDIA" },
  { providerID: "nvidia", modelID: "nvidia/nv-embedqa-e5-v5", name: "NV EmbedQA E5 v5", dim: 1024, category: "NVIDIA" },
  { providerID: "nvidia", modelID: "nvidia/nv-embed-v1", name: "NV Embed v1 (Mistral)", dim: 4096, category: "NVIDIA" },
  { providerID: "nvidia", modelID: "nvidia/nv-embedcode-7b-v1", name: "NV EmbedCode 7B v1", dim: 4096, category: "NVIDIA" },
  { providerID: "nvidia", modelID: "nvidia/llama-nemotron-embed-vl-1b-v2", name: "Llama Nemotron Embed VL 1B v2", dim: 2048, category: "NVIDIA" },

  // BAAI — proxied by NIM under the baai/ namespace.
  { providerID: "nvidia", modelID: "baai/bge-m3", name: "BGE-M3 (Multilingual)", dim: 1024, category: "NVIDIA" },

  // Cohere — bare model name; routed via openai-embed with the cohere provider.
  { providerID: "cohere", modelID: "embed-english-v3.0", name: "Embed English v3.0", dim: 1024, category: "Cohere" },
  { providerID: "cohere", modelID: "embed-multilingual-v3.0", name: "Embed Multilingual v3.0", dim: 1024, category: "Cohere" },
]

export function sortModelOptions<T extends { footer?: string; releaseDate: string | number; title: string }>(
  options: T[],
  newestFirst: boolean,
) {
  if (newestFirst) return sortBy(options, [(option) => option.releaseDate, "desc"], (option) => option.title)
  return sortBy(
    options,
    (option) => option.footer !== "Free",
    (option) => option.title,
  )
}
