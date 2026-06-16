import { createSignal, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { Spinner } from "../component/spinner"

interface EmbeddingSettingsFields {
  baseUrl: string
  model: string
  apiKeyEnvVar: string
  dimensions?: number
  batchSize: number
}

interface DialogEmbeddingSettingsProps {
  initial?: Partial<EmbeddingSettingsFields>
  onSave?: (settings: EmbeddingSettingsFields) => void
  onTest?: (settings: EmbeddingSettingsFields) => Promise<{ ok: boolean; message: string }>
}

export function DialogEmbeddingSettings(props: DialogEmbeddingSettingsProps) {
  const dialog = useDialog()
  const { theme } = useTheme()

  const [baseUrl, setBaseUrl] = createSignal(props.initial?.baseUrl ?? "https://api.openai.com/v1")
  const [model, setModel] = createSignal(props.initial?.model ?? "")
  const [apiKeyEnvVar, setApiKeyEnvVar] = createSignal(props.initial?.apiKeyEnvVar ?? "BANYANCODE_EMBEDDING_API_KEY")
  const [dimensions, setDimensions] = createSignal<string>(props.initial?.dimensions?.toString() ?? "")
  const [batchSize, setBatchSize] = createSignal(props.initial?.batchSize ?? 64)
  const [testing, setTesting] = createSignal(false)
  const [testResult, setTestResult] = createSignal<{ ok: boolean; message: string } | null>(null)

  function getFields(): EmbeddingSettingsFields {
    return {
      baseUrl: baseUrl(),
      model: model(),
      apiKeyEnvVar: apiKeyEnvVar(),
      dimensions: dimensions() ? parseInt(dimensions(), 10) : undefined,
      batchSize: batchSize(),
    }
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const result = props.onTest ? await props.onTest(getFields()) : { ok: true, message: "Test not implemented" }
      setTestResult(result)
    } catch (err) {
      setTestResult({ ok: false, message: String(err) })
    } finally {
      setTesting(false)
    }
  }

  function handleSave() {
    props.onSave?.(getFields())
    dialog.clear()
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Embedding Settings
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <box gap={1} paddingTop={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textMuted}>Base URL</text>
        </box>
        <input
          value={baseUrl()}
          onInput={(e: string) => setBaseUrl(e)}
          placeholder="https://api.openai.com/v1"
          focusedBackgroundColor={theme.backgroundPanel}
          cursorColor={theme.primary}
          focusedTextColor={theme.text}
        />
      </box>

      <box gap={1} paddingTop={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textMuted}>Model</text>
        </box>
        <input
          value={model()}
          onInput={(e: string) => setModel(e)}
          placeholder="text-embedding-3-small"
          focusedBackgroundColor={theme.backgroundPanel}
          cursorColor={theme.primary}
          focusedTextColor={theme.text}
        />
      </box>

      <box gap={1} paddingTop={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textMuted}>API Key Env Var</text>
        </box>
        <input
          value={apiKeyEnvVar()}
          onInput={(e: string) => setApiKeyEnvVar(e)}
          placeholder="BANYANCODE_EMBEDDING_API_KEY"
          focusedBackgroundColor={theme.backgroundPanel}
          cursorColor={theme.primary}
          focusedTextColor={theme.text}
        />
      </box>

      <box gap={1} paddingTop={1} flexDirection="row">
        <box flexGrow={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.textMuted}>Dimensions (optional)</text>
          </box>
          <input
            value={dimensions()}
            onInput={(e: string) => setDimensions(e)}
            placeholder="1536"
            focusedBackgroundColor={theme.backgroundPanel}
            cursorColor={theme.primary}
            focusedTextColor={theme.text}
          />
        </box>
        <box flexGrow={1} paddingLeft={2}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.textMuted}>Batch Size</text>
          </box>
          <input
            value={batchSize().toString()}
            onInput={(e: string) => setBatchSize(parseInt(e, 10) || 64)}
            placeholder="64"
            focusedBackgroundColor={theme.backgroundPanel}
            cursorColor={theme.primary}
            focusedTextColor={theme.text}
          />
        </box>
      </box>

      <Show when={testResult()}>
        {(result) => (
          <box paddingTop={1}>
            <text fg={result().ok ? theme.success : theme.error}>{result().message}</text>
          </box>
        )}
      </Show>

      <box flexDirection="row" justifyContent="space-between" paddingTop={2} paddingBottom={1}>
        <box flexDirection="row" gap={1}>
          <box paddingLeft={1} paddingRight={1} onMouseUp={handleTest}>
            <Show when={!testing()} fallback={<Spinner color={theme.textMuted}>testing...</Spinner>}>
              <text fg={theme.primary}>Test connection</text>
            </Show>
          </box>
        </box>
        <box flexDirection="row" gap={1}>
          <box paddingLeft={1} paddingRight={1} onMouseUp={() => dialog.clear()}>
            <text fg={theme.textMuted}>Cancel</text>
          </box>
          <box paddingLeft={1} paddingRight={1} backgroundColor={theme.primary} onMouseUp={handleSave}>
            <text fg={theme.selectedListItemText}>Save</text>
          </box>
        </box>
      </box>
    </box>
  )
}
