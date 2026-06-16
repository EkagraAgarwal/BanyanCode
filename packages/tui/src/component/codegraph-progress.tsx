import { createContext, useContext, type ParentProps, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { SplitBorder } from "../ui/border"
import { TextAttributes } from "@opentui/core"

export type CodegraphBuildStatus = "not_indexed" | "stale" | "indexing" | "ready" | "embeddings_missing" | "embedding_stale" | "failed"

export type CodegraphBuildState = {
  status: CodegraphBuildStatus
  root?: string
  done: number
  total: number
  currentFile?: string
  result?: { indexed: number; skipped: number; duration_ms: number }
  error?: string
  embeddingModel?: string
  embeddedCount?: number
  staleEmbeddingCount?: number
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

function labelFor(status: CodegraphBuildStatus): string {
  return {
    not_indexed: "Not indexed",
    stale: "Stale",
    indexing: "Indexing",
    ready: "Ready",
    embeddings_missing: "Embeddings missing",
    embedding_stale: "Embedding stale",
    failed: "Failed",
  }[status]
}

function borderColorFor(status: CodegraphBuildStatus): "info" | "success" | "warning" | "error" {
  if (status === "indexing") return "info"
  if (status === "ready") return "success"
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
        Codegraph — {labelFor(build.state.status)}
      </text>
      <Show when={build.state.status === "not_indexed"}>
        <text fg={theme.textMuted}>Not indexed. Quick actions:</text>
        <box flexDirection="row" marginTop={1}>
          <QuickAction label="build" onClick={() => {}} />
          <QuickAction label="configure embeddings" onClick={() => {}} />
          <QuickAction label="search" onClick={() => {}} />
        </box>
      </Show>
      <Show when={build.state.status === "stale"}>
        <text fg={theme.warning}>Previous build is stale. Quick actions:</text>
        <box flexDirection="row" marginTop={1}>
          <QuickAction label="build" onClick={() => {}} />
          <QuickAction label="configure embeddings" onClick={() => {}} />
          <QuickAction label="search" onClick={() => {}} />
        </box>
      </Show>
      <Show when={build.state.status === "indexing"}>
        <text fg={theme.text}>
          {bar(build.state.done, build.state.total)} {build.state.done}/{build.state.total}
        </text>
        <Show when={build.state.currentFile}>
          {(file) => (
            <text fg={theme.textMuted} marginTop={1}>
              Indexing: {file()}
            </text>
          )}
        </Show>
        <box flexDirection="row" marginTop={1}>
          <QuickAction label="cancel" onClick={() => {}} />
        </box>
      </Show>
      <Show when={build.state.status === "ready"}>
        <text fg={theme.success}>Build complete. Quick actions:</text>
        <box flexDirection="row" marginTop={1}>
          <QuickAction label="embed" onClick={() => {}} />
          <QuickAction label="configure embeddings" onClick={() => {}} />
          <QuickAction label="search" onClick={() => {}} />
        </box>
      </Show>
      <Show when={build.state.status === "embeddings_missing"}>
        <text fg={theme.warning}>Embeddings not computed. Quick actions:</text>
        <box flexDirection="row" marginTop={1}>
          <QuickAction label="embed" onClick={() => {}} />
          <QuickAction label="configure embeddings" onClick={() => {}} />
          <QuickAction label="search" onClick={() => {}} />
        </box>
      </Show>
      <Show when={build.state.status === "embedding_stale"}>
        <text fg={theme.warning}>Embedding model changed. Quick actions:</text>
        <box flexDirection="row" marginTop={1}>
          <QuickAction label="embed" onClick={() => {}} />
          <QuickAction label="configure embeddings" onClick={() => {}} />
          <QuickAction label="search" onClick={() => {}} />
        </box>
      </Show>
      <Show when={build.state.status === "failed" && build.state.error}>
        {(err) => (
          <text fg={theme.error} marginTop={1} wrapMode="word" width="100%">
            {err()}
          </text>
        )}
        <box flexDirection="row" marginTop={1}>
          <QuickAction label="build" onClick={() => {}} />
          <QuickAction label="configure embeddings" onClick={() => {}} />
          <QuickAction label="search" onClick={() => {}} />
        </box>
      </Show>
    </box>
  )
}
