/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { toHex } from "../util/color"
import { DialogMultiSelect } from "../ui/dialog-multi-select"

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

const TOOL_GROUPS = [
  {
    category: "Read",
    options: [
      { value: "read", label: "read", description: "Read file contents" },
      { value: "glob", label: "glob", description: "Find files by pattern" },
      { value: "grep", label: "grep", description: "Search file contents" },
    ],
  },
  {
    category: "Write",
    options: [
      { value: "write", label: "write", description: "Write file contents" },
      { value: "edit", label: "edit", description: "Edit file by string match" },
    ],
  },
  {
    category: "Execute",
    options: [
      { value: "bash", label: "bash", description: "Run shell commands" },
      { value: "task", label: "task", description: "Spawn subagent" },
    ],
  },
  {
    category: "Web",
    options: [
      { value: "webfetch", label: "webfetch", description: "Fetch a URL" },
      { value: "websearch", label: "websearch", description: "Web search" },
      { value: "websearch_free", label: "websearch_free", description: "Free web search" },
    ],
  },
  {
    category: "Codegraph",
    options: [
      { value: "code_find", label: "code_find", description: "Search codegraph" },
      { value: "code_emit", label: "code_emit", description: "Emit code to graph" },
    ],
  },
  {
    category: "Memory",
    options: [
      { value: "memory_store", label: "memory_store", description: "Save to memory" },
      { value: "memory_recall", label: "memory_recall", description: "Read from memory" },
      { value: "memory_search", label: "memory_search", description: "Search memory" },
    ],
  },
  {
    category: "BanyanCode",
    options: [
      { value: "systeminfo", label: "systeminfo", description: "System status" },
      { value: "codegraph_build", label: "codegraph_build", description: "Rebuild codegraph" },
    ],
  },
]

export function DialogAgentConfig(props: {
  initial?: AgentConfigInput
  onSave?: (result: AgentConfigResult) => void
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  const [step, setStep] = createSignal<"name" | "description" | "model" | "tools" | "review">("name")
  const [name, setName] = createSignal(props.initial?.name ?? "")
  const [description, setDescription] = createSignal(props.initial?.description ?? "")
  const [model, setModel] = createSignal<{ providerID: string; modelID: string } | undefined>(
    props.initial?.model,
  )
  const [tools, setTools] = createSignal<string[]>(props.initial?.tools ?? [])

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

      // Save via SDK (handler will be added in server-side phase)
      const saveResult = await (sdk.client as any).global?.banyanAgent?.save?.({
        name: result.name,
        description: result.description,
        model: result.model,
        tools: result.tools,
        enabled: result.enabled,
      })

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
          />
        </box>
      </Show>

      <Show when={step() === "model"}>
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
              onMouseUp={() => {
                // TODO: open model picker dialog
                setStep("tools")
              }}
            >
              [space picker]
            </text>
          </box>
        </box>
      </Show>

      <Show when={step() === "tools"}>
        <DialogMultiSelect
          title="Step 4/4: Tools"
          groups={TOOL_GROUPS}
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
