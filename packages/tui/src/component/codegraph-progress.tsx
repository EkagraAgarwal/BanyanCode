import { createContext, useContext, type ParentProps, Show, createMemo, createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { SplitBorder } from "../ui/border"
import { TextAttributes } from "@opentui/core"

export type CodegraphBuildState = {
  status: "idle" | "running" | "completed" | "failed" | "cancelled"
  root?: string
  dbPath?: string
  done: number
  total: number
  currentFile?: string
  result?: { indexed: number; skipped: number; duration_ms: number }
  error?: string
}

export type CodeEmbedState = {
  status: "idle" | "running" | "completed" | "failed" | "cancelled"
  done: number
  total: number
  result?: { embedded: number; skipped: number }
  error?: string
}

function init() {
  const [store, setStore] = createStore({
    state: { status: "idle", done: 0, total: 0 } as CodegraphBuildState,
    embedState: { status: "idle", done: 0, total: 0 } as CodeEmbedState,
  })
  return {
    get state() {
      return store.state
    },
    get embedState() {
      return store.embedState
    },
    set: (s: CodegraphBuildState) => setStore("state", s),
    setEmbed: (s: CodeEmbedState) => setStore("embedState", s),
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

const BAR_WIDTH = 20

function bar(done: number, total: number): string {
  if (total === 0) return "░".repeat(BAR_WIDTH)
  const pct = Math.min(1, done / total)
  const filled = Math.round(pct * BAR_WIDTH)
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled)
}

function labelFor(status: CodegraphBuildState["status"]): string {
  return { idle: "Idle", running: "Running", completed: "Completed", failed: "Failed", cancelled: "Cancelled" }[status]
}

function borderColorForSingle(status: CodegraphBuildState["status"]): "info" | "success" | "warning" | "error" {
  if (status === "running") return "info"
  if (status === "completed") return "success"
  if (status === "failed") return "error"
  if (status === "cancelled") return "warning"
  return "info"
}

function borderColorFor(status: CodegraphBuildState["status"], embedStatus: CodeEmbedState["status"]): "info" | "success" | "warning" | "error" {
  if (status === "failed" || embedStatus === "failed") return "error"
  if (status === "running" || embedStatus === "running") return "info"
  if (status === "cancelled" || embedStatus === "cancelled") return "warning"
  if (status === "completed" && embedStatus === "completed") return "success"
  if (status !== "idle") return borderColorForSingle(status)
  return borderColorForSingle(embedStatus)
}

export function CodegraphProgress() {
  const build = useCodegraphBuild()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  createEffect(() => {
    const buildStatus = build.state.status
    if (buildStatus === "completed" || buildStatus === "cancelled") {
      const timer = setTimeout(() => {
        build.set({ status: "idle", done: 0, total: 0 })
      }, 5000)
      onCleanup(() => clearTimeout(timer))
    }
  })

  createEffect(() => {
    const embedStatus = build.embedState.status
    if (embedStatus === "completed" || embedStatus === "cancelled") {
      const timer = setTimeout(() => {
        build.setEmbed({ status: "idle", done: 0, total: 0 })
      }, 5000)
      onCleanup(() => clearTimeout(timer))
    }
  })

  const isVisible = createMemo(() => {
    return build.state.status !== "idle" || build.embedState.status !== "idle"
  })

  return (
    <Show when={isVisible()}>
      <box
        position="absolute"
        bottom={2}
        right={2}
        zIndex={2000}
        maxWidth={Math.min(60, dimensions().width - 6)}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        backgroundColor={theme.backgroundPanel}
        borderColor={theme[borderColorFor(build.state.status, build.embedState.status)]}
        border={["left", "right"]}
        customBorderChars={SplitBorder.customBorderChars}
      >
        <Show when={build.state.status !== "idle"}>
          <text attributes={TextAttributes.BOLD} marginBottom={1} fg={theme.text}>
            Codegraph Indexing — {labelFor(build.state.status)}
          </text>
          <text fg={theme.text}>
            {`${bar(build.state.done, build.state.total)} ${build.state.done}/${build.state.total}`}
          </text>
          <Show when={build.state.status === "running" && build.state.currentFile}>
            {(file) => (
              <text fg={theme.textMuted} marginTop={1}>
                Indexing: {file()}
              </text>
            )}
          </Show>
          <Show when={build.state.status === "completed" && build.state.result}>
            {(result) => (
              <text fg={theme.success} marginTop={1}>
                {`✓ ${result().indexed} indexed, ${result().skipped} skipped (${result().duration_ms}ms)`}
              </text>
            )}
          </Show>
          <Show when={build.state.status === "failed" && build.state.error}>
            {(err) => (
              <text fg={theme.error} marginTop={1} wrapMode="word" width="100%">
                {err()}
              </text>
            )}
          </Show>
          <Show when={build.state.dbPath}>
            {(p) => (
              <text fg={theme.textMuted} marginTop={1} wrapMode="word" width="100%">
                Index → {p()}
              </text>
            )}
          </Show>
          <Show when={build.state.status === "running"}>
            <text fg={theme.textMuted} marginTop={1}>
              Press Ctrl+C to cancel
            </text>
          </Show>
        </Show>

        <Show when={build.embedState.status !== "idle"}>
          <text attributes={TextAttributes.BOLD} marginTop={build.state.status !== "idle" ? 1 : 0} marginBottom={1} fg={theme.text}>
            Code Embeddings — {labelFor(build.embedState.status)}
          </text>
          <text fg={theme.text}>
            {`${bar(build.embedState.done, build.embedState.total)} ${build.embedState.done}/${build.embedState.total}`}
          </text>
          <Show when={build.embedState.status === "completed" && build.embedState.result}>
            {(result) => (
              <text fg={theme.success} marginTop={1}>
                {`✓ ${result().embedded} embedded, ${result().skipped} skipped`}
              </text>
            )}
          </Show>
          <Show when={build.embedState.status === "failed" && build.embedState.error}>
            {(err) => (
              <text fg={theme.error} marginTop={1} wrapMode="word" width="100%">
                {err()}
              </text>
            )}
          </Show>
        </Show>
      </box>
    </Show>
  )
}
