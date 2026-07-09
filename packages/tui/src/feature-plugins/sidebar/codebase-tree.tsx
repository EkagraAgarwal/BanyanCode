/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useEvent } from "../../context/event"
import { toHex } from "../../util/color"

const id = "internal:sidebar-codebase-tree"

interface TreeNode {
  path: string
  name: string
  kind: "file" | "directory"
  children?: TreeNode[]
}

function renderNode(node: TreeNode, depth: number, theme: any): any {
  const indent = "  ".repeat(depth)
  const icon = node.kind === "directory" ? "▾" : "•"
  const color = node.kind === "directory" ? toHex(theme.text) : toHex(theme.textMuted)
  const rows = [
    <text fg={color}>
      {indent}{icon} {node.name}
    </text>,
  ]
  if (node.children) {
    for (const child of node.children) {
      rows.push(renderNode(child, depth + 1, theme))
    }
  }
  return rows
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const ev = useEvent()
  const [tree, setTree] = createSignal<TreeNode | null>(null)
  const [error, setError] = createSignal<string | null>(null)

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
    } catch {
      setError("Filesystem service unavailable")
      setTree(null)
    }
  }

  void loadTree()

  const unsub = ev.on("file.watcher.updated" as any, () => {
    void loadTree()
  })
  onCleanup(unsub)

  const displayRoot = createMemo(() => {
    const parts = rootPath().split(/[/\\]/)
    return parts.at(-1) ?? rootPath()
  })

  return (
    <box>
      <text fg={toHex(theme().primary)}>
        <b>CODEBASE</b> {displayRoot()}
      </text>
      <Show when={error()}>
        <text fg={toHex(theme().textMuted)} marginTop={0}>
          {error()}
        </text>
      </Show>
      <Show when={!error() && tree() === null}>
        <text fg={toHex(theme().textMuted)} marginTop={1}>
          Coming soon
        </text>
      </Show>
      <Show when={!error() && tree() !== null}>
        <box flexDirection="column" marginTop={1}>
          <Show
            when={!!tree()?.children?.length}
            fallback={
              <text fg={toHex(theme().textMuted)}>No files</text>
            }
          >
            <For each={tree()?.children ?? []}>
              {(node) => <>{renderNode(node, 0, theme())}</>}
            </For>
          </Show>
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
