/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useEvent } from "../../context/event"
import { toHex } from "../../util/color"

const id = "internal:sidebar-codebase-tree"

interface TreeNode {
  path: string
  name: string
  kind: "file" | "directory"
  children?: TreeNode[]
}

const COLLAPSED_BY_DEFAULT = new Set([".git", "node_modules", "dist", "build", ".banyancode", ".opencode", "target", "__pycache__", ".next", ".nuxt", ".cache"])
const RELOAD_DEBOUNCE_MS = 250

function TreeRow(props: { node: TreeNode; depth: number; theme: any }) {
  const theme = () => props.theme
  const isDir = () => props.node.kind === "directory"
  const defaultCollapsed = () => isDir() && COLLAPSED_BY_DEFAULT.has(props.node.name)
  const [open, setOpen] = createSignal(!defaultCollapsed())

  const indent = createMemo(() => "  ".repeat(props.depth))
  const icon = createMemo(() => (isDir() ? (open() ? "▾" : "▸") : "•"))
  const color = createMemo(() => (isDir() ? toHex(theme().text) : toHex(theme().textMuted)))

  return (
    <box flexDirection="column">
      <box
        flexDirection="row"
        gap={0}
        onMouseDown={() => isDir() && setOpen((x) => !x)}
      >
        <text fg={color()}>
          {indent()}{icon()} {props.node.name}
        </text>
      </box>
      <Show when={isDir() && open() && (props.node.children?.length ?? 0) > 0}>
        <For each={props.node.children ?? []}>
          {(child) => <TreeRow node={child} depth={props.depth + 1} theme={theme()} />}
        </For>
      </Show>
    </box>
  )
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const ev = useEvent()
  const [tree, setTree] = createSignal<TreeNode | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(true)

  const rootPath = createMemo(() => props.api.state.path.directory)

  const loadTree = async () => {
    try {
      setError(null)
      const root = rootPath()
      const result = await props.api.client.file.tree({ path: root, depth: String(3) })
      if (result?.data) {
        setTree(result.data as TreeNode)
      } else {
        setTree(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Filesystem service unavailable")
      setTree(null)
    } finally {
      setLoading(false)
    }
  }

  void loadTree()

  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  const unsub = ev.on("file.watcher.updated" as any, () => {
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      void loadTree()
    }, RELOAD_DEBOUNCE_MS)
  })
  onCleanup(() => {
    unsub()
    if (reloadTimer) clearTimeout(reloadTimer)
  })

  const displayRoot = createMemo(() => {
    const parts = rootPath().split(/[/\\]/)
    return parts.at(-1) ?? rootPath()
  })

  return (
    <box flexDirection="column" gap={0}>
      <text fg={toHex(theme().primary)}>
        <b>CODEBASE</b> {displayRoot()}
      </text>
      <Show when={error()}>
        <text fg={toHex(theme().error)} marginTop={0}>
          {error()}
        </text>
      </Show>
      <Show when={!error() && loading()}>
        <text fg={toHex(theme().textMuted)} marginTop={0}>
          Loading…
        </text>
      </Show>
      <Show when={!error() && !loading() && (tree()?.children?.length ?? 0) === 0}>
        <text fg={toHex(theme().textMuted)} marginTop={0}>
          No files
        </text>
      </Show>
      <Show when={!error() && !loading() && (tree()?.children?.length ?? 0) > 0}>
        <box flexDirection="column" marginTop={0}>
          <For each={tree()?.children ?? []}>
            {(node) => <TreeRow node={node} depth={0} theme={theme()} />}
          </For>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 80,
    slots: {
      sidebar_content(_ctx, _props) {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }
export default plugin