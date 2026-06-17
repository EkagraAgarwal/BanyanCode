import { createContext, useContext, type ParentProps, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { SplitBorder } from "../ui/border"
import { TextAttributes } from "@opentui/core"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { DialogEmbeddingModel } from "./dialog-embedding-model"

export type CodegraphBuildStatus = "idle" | "running" | "completed" | "failed" | "cancelled" | "not_indexed" | "stale" | "embeddings_missing" | "embedding_stale"

export type CodegraphBuildState = {
  status: CodegraphBuildStatus
  phase?: "indexing" | "embedding"
  root?: string
  done: number
  total: number
  currentFile?: string
  result?: { 
    indexed: number; 
    skipped: number; 
    embedded?: number;
    failed?: number;
    duration_ms: number 
  }
  error?: string
  embeddingModel?: string
  embeddedCount?: number
  staleEmbeddingCount?: number
  staleEmbeddingsCleaned?: number
  lastBuildTime?: number
}

function init() {
  const [store, setStore] = createStore({
    state: { status: "not_indexed", done: 0, total: 0 } as CodegraphBuildState,
  })
  return {
    get state() {
      return store.state
    },
    set: (s: CodegraphBuildState) => setStore("state", s),
  }
}

export type CodegraphBuildContext = ReturnType<typeof init>
const ctx = createContext<CodegraphBuildContext>()

export function CodegraphBuildProvider(props: ParentProps) {
  const value = init()
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useCodegraphBuild() {
  const v = useContext(ctx)
  if (!v) throw new Error("useCodegraphBuild must be used within CodegraphBuildProvider")
  return v
}

const BAR_WIDTH = 18

function bar(done: number, total: number): string {
  if (total === 0) return "[-" + "-".repeat(BAR_WIDTH - 2) + "-]"
  const pct = Math.min(1, done / total)
  const filled = Math.round(pct * (BAR_WIDTH - 2))
  const empty = BAR_WIDTH - 2 - filled
  return "[#" + "#".repeat(filled) + "-".repeat(empty) + "]"
}

function labelFor(state: CodegraphBuildState): string {
  if (state.status === "running") {
    return state.phase === "embedding" ? "Embedding" : "Indexing"
  }
  return {
    idle: "Idle",
    running: "Running",
    completed: "Ready",
    cancelled: "Cancelled",
    not_indexed: "Not indexed",
    stale: "Stale",
    ready: "Ready",
    embeddings_missing: "Embeddings missing",
    embedding_stale: "Embedding stale",
    failed: "Failed",
  }[state.status] || state.status
}

function borderColorFor(status: CodegraphBuildStatus): "info" | "success" | "warning" | "error" {
  if (status === "running") return "info"
  if (status === "completed") return "success"
  if (status === "failed") return "error"
  if (status === "stale" || status === "embedding_stale") return "warning"
  if (status === "embeddings_missing") return "warning"
  return "info"
}

interface QuickActionProps {
  label: string
  onClick: () => void
}

function QuickAction(props: QuickActionProps) {
  const { theme } = useTheme()
  return (
    <box paddingLeft={1} paddingRight={1} onMouseUp={props.onClick}>
      <text fg={theme.primary}>{props.label}</text>
    </box>
  )
}

export function CodegraphProgress() {
  const build = useCodegraphBuild()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const sdk = useSDK()
  const route = useRoute()
  const dialog = useDialog()
  const toast = useToast()

  const onBuild = () => {
    if (route.data.type !== "session") {
      toast.show({ message: "Start a session first", variant: "warning" })
      return
    }
    void sdk.client.session.command({
      sessionID: route.data.sessionID,
      command: "codegraph-build",
      arguments: "",
    })
  }

  const onEmbed = () => {
    if (route.data.type !== "session") {
      toast.show({ message: "Start a session first", variant: "warning" })
      return
    }
    void sdk.client.session.command({
      sessionID: route.data.sessionID,
      command: "code-embed",
      arguments: "",
    })
  }

  const onCancel = () => {
    void sdk.client.global.codegraph.cancel({}).catch(() => {})
  }

  const onConfigure = () => {
    dialog.replace(() => <DialogEmbeddingModel />)
  }

  return (
    <box
      position="absolute"
      bottom={2}
      right={2}
      maxWidth={Math.min(60, dimensions().width - 6)}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={theme.backgroundPanel}
      borderColor={theme[borderColorFor(build.state.status)]}
      border={["left", "right"]}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <text attributes={TextAttributes.BOLD} marginBottom={1} fg={theme.text}>
        Codegraph — {labelFor(build.state)}
      </text>
      <Show when={build.state.status === "not_indexed"}>
        <text fg={theme.textMuted}>Not indexed. Quick actions:</text>
        <box flexDirection="row" marginTop={1}>
          <QuickAction label="build" onClick={onBuild} />
          <QuickAction label="configure embeddings" onClick={onConfigure} />
        </box>
      </Show>
      <Show when={build.state.status === "stale"}>
        <text fg={theme.warning}>Previous build is stale. Quick actions:</text>
        <box flexDirection="row" marginTop={1}>
          <QuickAction label="build" onClick={onBuild} />
          <QuickAction label="configure embeddings" onClick={onConfigure} />
        </box>
      </Show>
      <Show when={build.state.status === "running"}>
        <text fg={theme.text}>
          {bar(build.state.done, build.state.total)} {build.state.done}/{build.state.total}
        </text>
        <Show when={build.state.currentFile}>
          {(file) => (
            <text fg={theme.textMuted} marginTop={1}>
              {build.state.phase === "embedding" ? "Embedding: " : "Indexing: "}{file()}
            </text>
          )}
        </Show>
        <box flexDirection="row" marginTop={1}>
          <QuickAction label="cancel" onClick={onCancel} />
        </box>
      </Show>
      <Show when={build.state.status === "completed"}>
        <text fg={theme.success}>Build complete. Quick actions:</text>
        <box flexDirection="row" marginTop={1}>
          <QuickAction label="embed" onClick={onEmbed} />
          <QuickAction label="configure embeddings" onClick={onConfigure} />
        </box>
      </Show>
      <Show when={build.state.status === "embeddings_missing"}>
        <text fg={theme.warning}>Embeddings not computed. Quick actions:</text>
        <box flexDirection="row" marginTop={1}>
          <QuickAction label="embed" onClick={onEmbed} />
          <QuickAction label="configure embeddings" onClick={onConfigure} />
        </box>
      </Show>
      <Show when={build.state.status === "embedding_stale"}>
        <text fg={theme.warning}>Embedding model changed. Quick actions:</text>
        <box flexDirection="row" marginTop={1}>
          <QuickAction label="embed" onClick={onEmbed} />
          <QuickAction label="configure embeddings" onClick={onConfigure} />
        </box>
      </Show>
      <Show when={build.state.status === "failed" && build.state.error}>
        {(err) => (
          <text fg={theme.error} marginTop={1} wrapMode="word" width="100%">
            {err()}
          </text>
        )}
        <box flexDirection="row" marginTop={1}>
          <QuickAction label="build" onClick={onBuild} />
          <QuickAction label="configure embeddings" onClick={onConfigure} />
        </box>
      </Show>
    </box>
  )
}
