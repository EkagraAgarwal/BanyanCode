import type { Context } from "@opencode/plugin/tui/context"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { ChildState } from "../../src/data/mesh"
import type { MeshLive } from "../../src/data/live"
import type { MeshNode } from "../../src/data/pending-rpc"
import { context, meshLive, meshNode, session } from "../harness"

/**
 * Fixture agents for the Grove render tests. Every field a pane reads is real
 * data in the production shape: sessions, messages, mesh nodes.
 */
export interface GroveSpec {
  readonly id: string
  readonly agent?: string
  readonly title?: string
  readonly state: ChildState
  readonly tokens?: number
  readonly cost?: number
  readonly created?: number
  readonly model?: string
  readonly tools?: ReadonlyArray<{
    readonly name: string
    readonly args?: string
    readonly status: "running" | "completed" | "error" | "pending"
  }>
  readonly output?: readonly string[]
  readonly summary?: string
  readonly parentID?: string
  readonly killed?: boolean
}

export interface GroveFixture {
  readonly context: Context
  readonly mesh: MeshLive
  readonly sessions: readonly SessionInfo[]
  readonly messages: Readonly<Record<string, readonly SessionMessageInfo[]>>
  readonly root: MeshNode
}

const tokens = (total: number) => ({
  input: total,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
})

function meshState(state: ChildState): MeshNode["state"] {
  if (state === "running" || state === "waiting") return "running"
  if (state === "failed") return "failed"
  return "idle"
}

function toolItem(spec: GroveSpec, index: number, tool: NonNullable<GroveSpec["tools"]>[number]): SessionMessageInfo {
  const input = tool.args === undefined ? {} : { filePath: tool.args }
  const state =
    tool.status === "completed"
      ? { status: "completed" as const, input, content: [{ type: "text" as const, text: "" }] }
      : tool.status === "running"
        ? { status: "running" as const, input, metadata: {} }
        : tool.status === "error"
          ? {
              status: "error" as const,
              input,
              error: { type: "test", message: "failed" },
              content: [{ type: "text" as const, text: "" }],
            }
          : { status: "streaming" as const, input: tool.args ?? "" }
  return {
    type: "tool",
    id: `${spec.id}_tool_${index}`,
    name: tool.name,
    state,
    time: { created: 1_000 + index, ...(tool.status === "completed" ? { completed: 1_100 + index } : {}) },
  } as unknown as SessionMessageInfo
}

function messages(spec: GroveSpec): SessionMessageInfo[] {  const body = (spec.tools ?? []).map((tool, index) => toolItem(spec, index, tool))
  const text = [...(spec.output ?? []), ...(spec.summary === undefined ? [] : [spec.summary])]
  if (text.length > 0) body.push({ type: "text" as const, text: text.join("\n") } as never)
  const done = spec.state === "done" || spec.state === "failed"
  return [
    { id: `${spec.id}_user`, type: "user", time: { created: spec.created ?? 1_000 }, text: "do the thing" },
    {
      id: `${spec.id}_assistant`,
      type: "assistant",
      time: { created: (spec.created ?? 1_000) + 10, ...(done ? { completed: 9_000 } : {}) },
      agent: spec.agent ?? "explore",
      model: { providerID: "provider", id: spec.model ?? "deepseek-v4.1-flash" },
      content: body,
    } as unknown as SessionMessageInfo,
  ]
}

export function groveFixture(input: {
  readonly specs: readonly GroveSpec[]
  readonly running?: ReadonlySet<string>
  readonly animations?: boolean
  readonly killed?: readonly string[]
  readonly pending?: () => ReadonlySet<string>
  readonly forms?: () => ReadonlySet<string>
}): GroveFixture {
  const root = session({ id: "ses_root", agent: "build", title: "orchestrate the installer fix", time: { created: 900, updated: 2_000 } })
  const sessions: SessionInfo[] = [root]
  const record: Record<string, readonly SessionMessageInfo[]> = {}
  const nodes = new Map<string, MeshNode>()

  for (const spec of input.specs) {
    const total = spec.tokens ?? 0
    sessions.push(
      session({
        id: spec.id,
        parentID: spec.parentID ?? "ses_root",
        agent: spec.agent ?? "explore",
        title: spec.title,
        cost: spec.cost ?? 0,
        tokens: tokens(total),
        model: { providerID: "provider", id: spec.model ?? "deepseek-v4.1-flash" },
        time: { created: spec.created ?? 1_000, updated: 2_000 },
      }),
    )
    record[spec.id] = messages(spec)
  }

  const build = (spec: GroveSpec): MeshNode =>
    meshNode({
      sessionID: spec.id,
      agent: spec.agent ?? "explore",
      title: spec.title,
      state: meshState(spec.state),
      cost: spec.cost ?? 0,
      tokens: tokens(spec.tokens ?? 0),
      createdAt: spec.created ?? 1_000,
      children: input.specs.filter((child) => child.parentID === spec.id).map(build),
    })
  for (const spec of input.specs) nodes.set(spec.id, build(spec))

  const rootNode = meshNode({
    sessionID: "ses_root",
    agent: "build",
    title: root.title,
    state: "running",
    createdAt: 900,
    children: input.specs
      .filter((spec) => spec.parentID === undefined || spec.parentID === "ses_root")
      .map((spec) => nodes.get(spec.id)!),
  })

  const base = context({
    sessions,
    messages: record,
    running: input.running ?? new Set(),
    animations: input.animations ?? false,
  })
  const pending = input.pending ?? (() => new Set<string>())
  const forms = input.forms ?? (() => new Set<string>())
  const value = {
    ...base,
    data: {
      ...base.data,
      session: {
        ...base.data.session,
        permission: {
          ...base.data.session.permission,
          list: (sessionID: string) => (pending().has(sessionID) ? ([{ id: "permission" }] as never) : []),
        },
        form: {
          ...base.data.session.form,
          list: (sessionID: string) => (forms().has(sessionID) ? ([{ id: "form" }] as never) : []),
        },
      },
    },
  } as Context

  return {
    context: value,
    mesh: meshLive({ root: rootNode, killed: input.killed }),
    sessions,
    messages: record,
    root: rootNode,
  }
}

/** A mesh in which the root has no children yet. */
export function emptyGrove(animations = true) {
  const root = session({ id: "ses_root", agent: "build", title: "root" })
  const base = context({ sessions: [root], animations })
  return { context: base, mesh: meshLive({ root: meshNode({ sessionID: "ses_root", state: "running" }) }) }
}
