import { createMemo, Show } from "solid-js"
import { RGBA, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useCodegraphBuild } from "./codegraph-progress"

interface CodegraphStatusProps {
  onOpenSettings?: () => void
}

function formatTime(timestamp: number | undefined): string {
  if (!timestamp) return "(none)"
  const diff = Date.now() - timestamp
  if (diff < 60000) return "just now"
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return new Date(timestamp).toLocaleDateString()
}

function stateLabel(status: string): string {
  return {
    not_indexed: "Not indexed",
    stale: "Stale",
    indexing: "Indexing",
    ready: "Ready",
    embeddings_missing: "Embeddings missing",
    embedding_stale: "Embedding stale",
    failed: "Failed",
  }[status] ?? status
}

function stateColor(status: string, theme: ReturnType<typeof useTheme>["theme"]): RGBA {
  switch (status) {
    case "indexing":
      return theme.info
    case "ready":
      return theme.success
    case "failed":
      return theme.error
    case "stale":
    case "embedding_stale":
    case "embeddings_missing":
      return theme.warning
    default:
      return theme.textMuted
  }
}

export function CodegraphStatus(props: CodegraphStatusProps) {
  const build = useCodegraphBuild()
  const { theme } = useTheme()

  const fileCount = createMemo(() => build.state.total)
  const nodeCount = createMemo(() => build.state.result?.indexed ?? 0)
  const embeddingModel = createMemo(() => build.state.embeddingModel ?? "(none)")
  const lastBuildTime = createMemo(() => formatTime(build.state.lastBuildTime))

  return (
    <box
      flexDirection="column"
      gap={1}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      onMouseUp={() => props.onOpenSettings?.()}
    >
      <box flexDirection="row" justifyContent="space-between" alignItems="center">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Codegraph
        </text>
        <text fg={stateColor(build.state.status, theme)} attributes={TextAttributes.BOLD}>
          {stateLabel(build.state.status)}
        </text>
      </box>

      <box flexDirection="row" gap={2}>
        <text fg={theme.textMuted}>
          files: <span style={{ fg: theme.text }}>{fileCount()}</span>
        </text>
        <text fg={theme.textMuted}>
          nodes: <span style={{ fg: theme.text }}>{nodeCount()}</span>
        </text>
      </box>

      <text fg={theme.textMuted}>
        embedding: <span style={{ fg: theme.text }}>{embeddingModel()}</span>
      </text>

      <text fg={theme.textMuted}>
        last build: <span style={{ fg: theme.text }}>{lastBuildTime()}</span>
      </text>

      <Show when={build.state.status === "embeddings_missing" || build.state.status === "embedding_stale" || !build.state.embeddingModel}>
        <text fg={theme.primary} marginTop={1}>
          [configure embeddings]
        </text>
      </Show>
    </box>
  )
}
