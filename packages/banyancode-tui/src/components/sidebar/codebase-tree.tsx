import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import type { CodegraphLive } from "../../data/live"
import { palette } from "../../theme"

export interface TreeNode {
  readonly name: string
  readonly path: string
  readonly kind: "file" | "directory"
  readonly children?: readonly TreeNode[]
}

const COLLAPSED_BY_DEFAULT = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".banyancode",
  ".opencode",
  "target",
  "__pycache__",
  ".next",
  ".nuxt",
  ".cache",
])

/** Build a depth-limited directory tree from codegraph-indexed file paths. */
export function buildFileTree(
  files: ReadonlyArray<{ readonly path: string }>,
  maxDepth = 3,
  root?: string,
): readonly TreeNode[] {
  interface Mutable {
    readonly name: string
    readonly path: string
    readonly kind: "file" | "directory"
    readonly children: Map<string, Mutable>
  }
  const top = new Map<string, Mutable>()
  for (const file of files) {
    const normalized = file.path.replaceAll("\\", "/")
    const rootPrefix = root?.replaceAll("\\", "/").replace(/\/$/, "")
    const relative = rootPrefix !== undefined && normalized.startsWith(`${rootPrefix}/`) ? normalized.slice(rootPrefix.length + 1) : normalized
    const segments = relative.split("/").filter(Boolean)
    if (segments.length === 0) continue
    let level = top
    let prefix = ""
    for (let index = 0; index < Math.min(segments.length, maxDepth); index++) {
      const name = segments[index]!
      prefix = prefix ? `${prefix}/${name}` : name
      const isFile = index === segments.length - 1 || index === maxDepth - 1
      const existing = level.get(name)
      if (existing) {
        if (!isFile) level = existing.children
        continue
      }
      const node: Mutable = { name, path: prefix, kind: isFile ? "file" : "directory", children: new Map() }
      level.set(name, node)
      if (!isFile) level = node.children
    }
  }
  const freeze = (nodes: ReadonlyMap<string, Mutable>): TreeNode[] =>
    [...nodes.values()]
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1))
      .map((node) => ({
        name: node.name,
        path: node.path,
        kind: node.kind,
        ...(node.children.size === 0 ? {} : { children: freeze(node.children) }),
      }))
  return freeze(top)
}

function TreeRow(props: { readonly node: TreeNode; readonly depth: number; readonly context: Context }) {
  const theme = () => palette(props.context.theme)
  const [open, setOpen] = createSignal(!(props.node.kind === "directory" && COLLAPSED_BY_DEFAULT.has(props.node.name)))
  const indent = () => "  ".repeat(props.depth)
  const icon = () => (props.node.kind === "directory" ? (open() ? "▾" : "▸") : "•")
  return (
    <box flexDirection="column">
      <box flexDirection="row" onMouseDown={() => props.node.kind === "directory" && setOpen((value) => !value)}>
        <text fg={props.node.kind === "directory" ? theme().text : theme().muted}>
          {indent()}
          {icon()} {props.node.name}
        </text>
      </box>
      <Show when={props.node.kind === "directory" && open() && (props.node.children?.length ?? 0) > 0}>
        <For each={props.node.children ?? []}>
          {(child) => <TreeRow node={child} depth={props.depth + 1} context={props.context} />}
        </For>
      </Show>
    </box>
  )
}

/**
 * v1's `sidebar/codebase-tree.tsx` used the v1 `file.tree` HTTP endpoint, which
 * v2's client does not publish. This port renders the codegraph's indexed file
 * table instead (same visual tree, real data), and says so in the header.
 */
export function CodebaseTreePanel(props: { readonly context: Context; readonly codegraph: CodegraphLive }) {
  const theme = () => palette(props.context.theme)

  onMount(() => {
    void props.codegraph.ensureFiles()
  })

  const tree = createMemo(() => buildFileTree(props.codegraph.files() ?? [], 3, props.context.location?.directory))
  const root = createMemo(() => {
    const directory = props.context.location?.directory
    if (!directory) return "workspace"
    return directory.split(/[/\\]/).filter(Boolean).at(-1) ?? directory
  })
  const unavailable = createMemo(() => props.codegraph.filesAvailability() === "unavailable")
  const loading = createMemo(
    () => props.codegraph.filesAvailability() === "unknown" && props.codegraph.files() === undefined,
  )

  return (
    <box flexDirection="column" gap={0}>
      <text fg={theme().primary}>
        <b>CODEBASE</b> {root()}
      </text>
      <Show when={unavailable()}>
        <text fg={theme().muted}>Indexed file list is not available on this server.</text>
      </Show>
      <Show when={!unavailable() && loading()}>
        <text fg={theme().muted}>Loading…</text>
      </Show>
      <Show when={!unavailable() && !loading() && tree().length === 0}>
        <text fg={theme().muted}>No indexed files</text>
      </Show>
      <Show when={!unavailable() && tree().length > 0}>
        <box flexDirection="column">
          <For each={tree()}>{(node) => <TreeRow node={node} depth={0} context={props.context} />}</For>
        </box>
      </Show>
    </box>
  )
}
