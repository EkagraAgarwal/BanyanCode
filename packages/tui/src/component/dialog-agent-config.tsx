/** @jsxImportSource @opentui/solid */
import { createSignal, onMount, Show } from "solid-js"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { toHex } from "../util/color"
import { useBindings } from "../keymap"
import { useLocal } from "../context/local"
import { DialogMultiSelect, type MultiSelectGroup } from "../ui/dialog-multi-select"
import { DialogModel } from "./dialog-model"

export interface AgentConfigInput {
  name?: string
  description?: string
  model?: { providerID: string; modelID: string }
  tools?: string[]
}

export interface AgentConfigResult {
  name: string
  description: string
  model: { providerID: string; modelID: string } | undefined
  tools: string[]
  enabled: boolean
}

const TOOL_DESCRIPTIONS: Record<string, string> = {
  read: "Read file contents",
  glob: "Find files by pattern",
  grep: "Search file contents",
  write: "Write file contents",
  edit: "Edit file by string match",
  bash: "Run shell commands",
  task: "Spawn subagent",
  webfetch: "Fetch a URL",
  websearch: "Web search",
  websearch_free: "Free web search",
  code_find: "Search the codegraph",
  code_emit: "Emit code to graph",
  codegraph_build: "Rebuild the codegraph index",
  codegraph_remove: "Remove the codegraph index",
  codegraph_status: "Show codegraph index status",
  repository_query: "Semantic repository search",
  repository_explain: "Explain a symbol",
  repository_trace: "Trace a symbol's callers",
  repository_impact: "Impact analysis by file",
  repository_tests: "Find tests for a symbol",
  memory_store: "Save to memory",
  memory_recall: "Read from memory",
  memory_search: "Search memory",
  memory_list: "List memory entries",
  memory_forget: "Delete a memory entry",
  systeminfo: "System status",
  blast_radius: "Blast radius of a symbol",
  preflight: "Preflight edit report",
  safe_rename: "Plan a symbol rename",
  edit_plan: "Plan an edit before applying",
}

// Static fallback used when the registry fetch fails or returns empty.
const FALLBACK_TOOLS = Object.entries(TOOL_DESCRIPTIONS).map(([id, description]) => ({ id, description }))

// Built-ins get explicit buckets; everything else is bucketed by prefix.
const BUILTIN_GROUP: Record<string, string> = {
  read: "Read",
  glob: "Read",
  grep: "Read",
  code_find: "Read",
  code_emit: "Read",
  systeminfo: "Read",
  write: "Write",
  edit: "Write",
  bash: "Execute",
  task: "Execute",
  webfetch: "Web",
  websearch: "Web",
  websearch_free: "Web",
}

const PREFIX_GROUP: { prefix: string; category: string }[] = [
  { prefix: "codegraph_", category: "Codegraph" },
  { prefix: "repository_", category: "Repository" },
  { prefix: "memory_", category: "Memory" },
  { prefix: "banyan_", category: "BanyanCode" },
  { prefix: "banyancode_", category: "BanyanCode" },
]

const GROUP_ORDER = ["Read", "Write", "Execute", "Web", "Codegraph", "Repository", "Memory", "BanyanCode", "Other"]

function groupTools(tools: { id: string; description?: string }[]): MultiSelectGroup[] {
  const buckets = new Map<string, { id: string; description?: string }[]>()
  const push = (category: string, tool: { id: string; description?: string }) => {
    const list = buckets.get(category) ?? []
    list.push(tool)
    buckets.set(category, list)
  }
  for (const tool of tools) {
    const explicit = BUILTIN_GROUP[tool.id]
    const prefix = PREFIX_GROUP.find((p) => tool.id.startsWith(p.prefix))
    push(explicit ?? prefix?.category ?? "Other", tool)
  }
  return Array.from(buckets.entries())
    .sort((a, b) => {
      const ai = GROUP_ORDER.indexOf(a[0])
      const bi = GROUP_ORDER.indexOf(b[0])
      return (ai === -1 ? GROUP_ORDER.length : ai) - (bi === -1 ? GROUP_ORDER.length : bi)
    })
    .map(([category, list]) => ({
      category,
      options: list
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((tool) => ({
          value: tool.id,
          label: tool.id,
          description: tool.description ?? TOOL_DESCRIPTIONS[tool.id] ?? "Agent tool",
        })),
    }))
}

export function DialogAgentConfig(props: {
  initial?: AgentConfigInput
  onSave?: (result: AgentConfigResult) => void
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  const [step, setStep] = createSignal<"name" | "description" | "model" | "tools" | "review">("name")
  const [showModelPicker, setShowModelPicker] = createSignal(false)
  const [name, setName] = createSignal(props.initial?.name ?? "")
  const [description, setDescription] = createSignal(props.initial?.description ?? "")
  const [model, setModel] = createSignal<{ providerID: string; modelID: string } | undefined>(
    props.initial?.model,
  )
  const [tools, setTools] = createSignal<string[]>(props.initial?.tools ?? [])
  const [toolGroups, setToolGroups] = createSignal<MultiSelectGroup[]>(groupTools(FALLBACK_TOOLS))
  const [toolsLoading, setToolsLoading] = createSignal(true)

  const loadTools = async () => {
    try {
      let currentModel: { providerID: string; modelID: string } | undefined
      try {
        currentModel = useLocal().model.current()
      } catch {
        currentModel = undefined
      }
      let loaded: { id: string; description?: string }[] | undefined
      if (currentModel) {
        const res = await sdk.client.tool.list({
          provider: currentModel.providerID,
          model: currentModel.modelID,
        })
        if (res.data && res.data.length > 0) {
          loaded = res.data.map((tool) => ({ id: tool.id, description: tool.description }))
        }
      }
      if (!loaded || loaded.length === 0) {
        const res = await sdk.client.tool.ids()
        if (res.data && res.data.length > 0) {
          loaded = res.data.map((id) => ({ id }))
        }
      }
      if (loaded && loaded.length > 0) setToolGroups(groupTools(loaded))
    } catch {
      // Registry fetch failed — keep the static fallback list.
    } finally {
      setToolsLoading(false)
    }
  }

  onMount(() => {
    void loadTools()
  })

  const openModelPicker = () => {
    setShowModelPicker(true)
  }

  // Model step: enter skips to tools, space opens the model picker.
  // Bindings are gated off while the inline picker is open (it has its own
  // DialogSelect keymap).
  useBindings(() => ({
    enabled: step() === "model" && !showModelPicker(),
    priority: 1,
    commands: [
      {
        name: "dialog.agent-config.model.default",
        title: "Use default model",
        category: "Dialog",
        run: () => setStep("tools"),
      },
      {
        name: "dialog.agent-config.model.pick",
        title: "Open model picker",
        category: "Dialog",
        run: openModelPicker,
      },
    ],
    bindings: [
      { key: "enter", desc: "Use default model", group: "Dialog", cmd: () => setStep("tools") },
      { key: "space", desc: "Open model picker", group: "Dialog", cmd: openModelPicker },
    ],
  }))

  // Review step: enter saves, escape cancels.
  useBindings(() => ({
    enabled: step() === "review",
    priority: 1,
    commands: [
      {
        name: "dialog.agent-config.save",
        title: "Save agent",
        category: "Dialog",
        run: () => void save(),
      },
    ],
    bindings: [
      { key: "enter", desc: "Save agent", group: "Dialog", cmd: () => void save() },
      { key: "escape", desc: "Cancel", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

  const save = async () => {
    const finalName = name().trim()
    if (!finalName) {
      toast.show({ message: "Name is required", variant: "error" })
      return
    }
    try {
      const result: AgentConfigResult = {
        name: finalName,
        description: description().trim(),
        model: model(),
        tools: tools(),
        enabled: true,
      }

      const saveResult = await sdk.client.global.banyanAgent.save({
        name: result.name,
        description: result.description,
        model: result.model,
        tools: result.tools,
      })
      if (saveResult.error) {
        toast.show({ message: `Save failed: ${String(saveResult.error)}`, variant: "error" })
        return
      }

      if (props.onSave) props.onSave(result)
      toast.show({ message: `Saved agent "${finalName}"`, variant: "success" })
      dialog.clear()
    } catch (e) {
      toast.show({ message: `Save failed: ${String(e)}`, variant: "error" })
    }
  }

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={toHex(theme.background)}>
      <box flexDirection="row" paddingLeft={2} paddingTop={1}>
        <text fg={toHex(theme.primary)}>
          <b>New Agent</b>
        </text>
      </box>

      <Show when={step() === "name"}>
        <box flexDirection="column" paddingLeft={2} paddingTop={1}>
          <text fg={toHex(theme.textMuted)}>Step 1/4: Name</text>
          <text fg={toHex(theme.textMuted)}>lowercase, hyphens, no spaces</text>
          <input
            value={name()}
            onInput={setName}
            onSubmit={() => setStep("description")}
            placeholder="my-researcher"
            ref={(el) => { if (el) setTimeout(() => el.focus(), 0) }}
          />
        </box>
      </Show>

      <Show when={step() === "description"}>
        <box flexDirection="column" paddingLeft={2} paddingTop={1}>
          <text fg={toHex(theme.textMuted)}>Step 2/4: Description</text>
          <text fg={toHex(theme.textMuted)}>What does this agent do?</text>
          <input
            value={description()}
            onInput={setDescription}
            onSubmit={() => setStep("model")}
            ref={(el) => { if (el) setTimeout(() => el.focus(), 0) }}
          />
        </box>
      </Show>

      <Show when={step() === "model"}>
        <Show
          when={!showModelPicker()}
          fallback={
            <DialogModel
              preserveStack
              onSelect={(selectedModel) => {
                setModel(selectedModel)
                setShowModelPicker(false)
                setStep("tools")
              }}
            />
          }
        >
          <box flexDirection="column" paddingLeft={2} paddingTop={1}>
            <text fg={toHex(theme.textMuted)}>Step 3/4: Model (optional)</text>
            <text fg={toHex(theme.textMuted)}>Press enter to skip, or pick a model</text>
            <text fg={toHex(theme.text)}>
              Current:{" "}
              {model()
                ? `${model()!.providerID}/${model()!.modelID}`
                : "(default — inherits from parent)"}
            </text>
            <box flexDirection="row" gap={1} marginTop={1}>
              <text
                fg={toHex(theme.success)}
                onMouseUp={() => setStep("tools")}
              >
                [enter use default]
              </text>
              <text
                fg={toHex(theme.primary)}
                onMouseUp={openModelPicker}
              >
                [space picker]
              </text>
            </box>
          </box>
        </Show>
      </Show>

      <Show when={step() === "tools"}>
        <DialogMultiSelect
          title={`Step 4/4: Tools${toolsLoading() ? " (loading...)" : ""}`}
          groups={toolGroups()}
          selected={tools()}
          onConfirm={(selected) => {
            setTools(selected)
            setStep("review")
          }}
        />
      </Show>

      <Show when={step() === "review"}>
        <box flexDirection="column" paddingLeft={2} paddingTop={1}>
          <text fg={toHex(theme.text)}>
            <b>Review</b>
          </text>
          <text fg={toHex(theme.textMuted)}>Name: {name()}</text>
          <text fg={toHex(theme.textMuted)}>Description: {description()}</text>
          <text fg={toHex(theme.textMuted)}>
            Model: {model() ? `${model()!.providerID}/${model()!.modelID}` : "default"}
          </text>
          <text fg={toHex(theme.textMuted)}>Tools: {tools().join(", ") || "(none)"}</text>
          <box flexDirection="row" gap={1} marginTop={2}>
            <text
              fg={toHex(theme.success)}
              onMouseUp={save}
            >
              [enter save]
            </text>
            <text
              fg={toHex(theme.textMuted)}
              onMouseUp={() => dialog.clear()}
            >
              [esc cancel]
            </text>
          </box>
        </box>
      </Show>
    </box>
  )
}
